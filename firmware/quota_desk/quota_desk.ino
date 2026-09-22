// quota_desk — BLE-driven quota display for ESP32-S3-Touch-AMOLED-2.16.
//
// Receives codex_desk_status.v1 JSON (see glm-quota `bin.js --desk-status`)
// over Nordic UART BLE and renders provider quota windows. Also implements
// the legacy canvas command set (clear/txt/rect) so the original esp-stuff
// push tools keep working.
//
// Field semantics (bin.js): slot.used_percent carries the REMAINING percent
// (drives bar fill), raw_used_percent carries actual used.
//
// Multi-provider (v3): every provider state is cached in its own page.
// The pusher feeds providers round-robin; short tap switches to the next
// page that has data, long press (~1.2s) cycles brightness.
//
// Bar/pct color is pace-based: remaining quota fraction vs remaining time
// fraction of the window. ratio >= 1 cyan (on pace), >= 0.85 yellow,
// below that red; remaining <= 10% is always red.
//
// BLE notes:
// - the macOS helper waits for a TX notify after every command — always ack
// - the RX callback only enqueues; all parsing/rendering happens in loop().
//   Blocking the BLE task with QSPI rendering caused supervision-timeout
//   disconnects and watchdog reboots in v1.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <esp_heap_caps.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <U8g2lib.h>  // must precede Arduino_GFX: enables its U8G2_FONT_SUPPORT path
#include "Arduino_GFX_Library.h"
#include "fonts/u8g2_fonts_pick.h"
#include "TouchDrvCSTXXX.hpp"
#include "quota_slot.h"

// u8g2 fonts (renamed qd_* to avoid colliding with the U8g2 library's own
// font objects). setCursor y is the BASELINE; sizes are baked into the font.
// NOTE: the Adafruit GFXfont path corrupts glyphs on this CO5300 build —
// do not switch back.
#define FONT_TITLE (qd_font_helvB24_tf)
#define FONT_LABEL (qd_font_helvB18_tf)
#define FONT_SMALL (qd_font_helvR14_tf)
#define FONT_TINY (qd_font_helvR10_tf)

// ── board: ESP32-S3-Touch-AMOLED-2.16 (480x480 CO5300 + CST9220) ──

#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 38
#define LCD_CS 12
#define LCD_RESET 39
#define SCREEN_W 480
#define SCREEN_H 480

#define IIC_SDA 15
#define IIC_SCL 14
#define TP_INT 11
#define TP_RST 40

#define BLE_NAME "Quota-Desk"
#define FW_VERSION "3.4"

static const char *SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
static const char *RX_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
static const char *TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

// ── colors (RGB565) ──

static uint16_t colorByName(const char *name) {
  if (!strcmp(name, "black")) return 0x0000;
  if (!strcmp(name, "white")) return 0xFFFF;
  if (!strcmp(name, "cyan")) return 0x07FF;
  if (!strcmp(name, "red")) return 0xF800;
  if (!strcmp(name, "yellow")) return 0xFFE0;
  if (!strcmp(name, "green")) return 0x07E0;
  if (!strcmp(name, "blue")) return 0x001F;
  if (!strcmp(name, "gray")) return 0x4208;
  if (!strcmp(name, "muted")) return 0x7BEF;
  return 0xFFFF;
}

static const uint16_t COL_CYAN = 0x07FF;
static const uint16_t COL_MUTED = 0x7BEF;
static const uint16_t COL_WHITE = 0xFFFF;
static const uint16_t COL_GRAY = 0x4208;
static const uint16_t COL_RED = 0xF800;
static const uint16_t COL_YELLOW = 0xFFE0;

// ── display ──

Arduino_DataBus *bus = new Arduino_ESP32QSPI(
    LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
Arduino_CO5300 *gfx = new Arduino_CO5300(
    bus, LCD_RESET, 0 /* rotation */, SCREEN_W, SCREEN_H, 0, 0, 0, 0);

// All drawing goes through a PSRAM-backed canvas: small/1px QSPI writes are
// unreliable on this CO5300 stack (1px-high fillRect runs vanish, GFXfont
// single-pixel glyphs garble), while full-frame bitmap flushes work — same
// reason the official LVGL demos are fine. Text renders into RAM, then the
// whole frame goes out as one big draw16bitRGBBitmap.
class PsramCanvas : public Arduino_Canvas {
 public:
  using Arduino_Canvas::Arduino_Canvas;
  bool begin(int32_t speed = GFX_NOT_DEFINED) override {
    if (!_framebuffer) {
      _framebuffer = (uint16_t *)heap_caps_malloc(
          (size_t)_width * _height * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (!_framebuffer) return false;
    }
    return Arduino_Canvas::begin(GFX_SKIP_OUTPUT_BEGIN);
  }
};
PsramCanvas *canvas = new PsramCanvas(SCREEN_W, SCREEN_H, gfx);

static const uint8_t BRIGHTNESS_STEPS[] = {200, 120, 50};
static uint8_t brightnessIdx = 1;

// ── touch ──

TouchDrvCST92xx touch;
volatile bool touchPending = false;
void IRAM_ATTR onTouchInterrupt() { touchPending = true; }

// ── per-provider state pages ──

static ProviderState providers[] = {{"glm"}, {"codex"}, {"kimi"}};
static const int NPROVIDERS = sizeof(providers) / sizeof(providers[0]);
static int currentPage = -1;         // index into providers, -1 = none yet
static bool canvasMode = false;      // legacy txt/rect commands take over
static String stateBuffer;
static bool bleConnected = false;

static ProviderState *findProvider(const char *id) {
  for (int i = 0; i < NPROVIDERS; i++)
    if (!strcmp(providers[i].id, id)) return &providers[i];
  return nullptr;
}

static int providerIndex(const ProviderState *p) {
  return p ? (int)(p - providers) : -1;
}

static int providerCount() {
  int n = 0;
  for (int i = 0; i < NPROVIDERS; i++) n += providers[i].hasData ? 1 : 0;
  return n;
}

// ── pace coloring ──

static uint16_t paceColor(const ProviderState &p, const QuotaSlot &slot) {
  int pct = slot.remainingPct;
  if (pct < 0) return COL_MUTED;
  if (pct <= 10) return COL_RED;
  long now = p.nowEstimate();
  long windowSec = (long)slot.windowMinutes * 60;
  if (!slot.resetsAt || !now || windowSec <= 0) {
    if (pct <= 15) return COL_RED;
    if (pct <= 40) return COL_YELLOW;
    return COL_CYAN;
  }
  long remainSec = slot.resetsAt - now;
  if (remainSec < 0) remainSec = 0;
  float timeFrac = (float)remainSec / (float)windowSec;
  if (timeFrac > 1.0f) timeFrac = 1.0f;
  float ratio = (pct / 100.0f) / (timeFrac < 0.02f ? 0.02f : timeFrac);
  if (ratio >= 1.0f) return COL_CYAN;
  if (ratio >= 0.85f) return COL_YELLOW;
  return COL_RED;
}

// ── incremental rendering ──

// bar zone tops: 2 windows spread out, 3 windows packed (Kimi: 5h+month+TOTAL)
static int barY(int i, int count) {
  return count >= 3 ? 110 + i * 95 : 130 + i * 120;
}
static const int BAR_X = 34, BAR_W = 412, BAR_H = 18;

static void text(const uint8_t *font, uint16_t color, int x, int baseline, const char *str) {
  canvas->setFont(font);
  canvas->setTextSize(1);
  canvas->setTextColor(color, 0);
  canvas->setCursor(x, baseline);
  canvas->print(str);
}

static void fmtCount(long v, char *out, size_t len) {
  if (v < 0) snprintf(out, len, "?");
  else if (v >= 1000000) snprintf(out, len, "%.1fM", v / 1000000.0);
  else if (v >= 100000) snprintf(out, len, "%ldK", v / 1000);
  else if (v >= 1000) snprintf(out, len, "%.1fK", v / 1000.0);
  else snprintf(out, len, "%ld", v);
}

static void fmtCountdown(const ProviderState &p, long resetsAt, char *out, size_t len) {
  long now = p.nowEstimate();
  if (!resetsAt || !now) {
    snprintf(out, len, "reset --:--");
    return;
  }
  long delta = resetsAt - now;
  if (delta < 0) delta = 0;
  long days = delta / 86400;
  long hours = (delta % 86400) / 3600;
  long minutes = (delta % 3600) / 60;
  if (days) snprintf(out, len, "reset %ldd %ldh", days, hours);
  else snprintf(out, len, "reset %02ld:%02ld", hours, minutes);
}

// last-rendered values; repaint only on change
static int shownPct[3] = {-2, -2, -2};
static uint16_t shownColor[3] = {0, 0, 0};
static char shownReset[3][24] = {"", "", ""};
static char shownNumbers[3][32] = {"", "", ""};
static char shownBottom[48] = "";
static int shownSlotCount = -1;
static bool shownBle = false;
static bool shownStale = false;

static void drawSlotStatic(const ProviderState &p, int i) {
  const QuotaSlot &slot = p.slots[i];
  int y = barY(i, p.slotCount);
  canvas->fillRect(0, y, SCREEN_W, 76, 0);
  if (!slot.valid || slot.remainingPct < 0) {
    char line[32];
    snprintf(line, sizeof(line), "%s --", slot.label.c_str());
    text(FONT_LABEL, COL_MUTED, BAR_X, y + 26, line);
    return;
  }
  text(FONT_LABEL, COL_WHITE, BAR_X, y + 26, slot.label.c_str());
  canvas->fillRect(BAR_X, y + 34, BAR_W, BAR_H, COL_GRAY);
}

static void updateSlotDynamic(const ProviderState &p, int i, bool force) {
  const QuotaSlot &slot = p.slots[i];
  if (!slot.valid || slot.remainingPct < 0) return;
  int y = barY(i, p.slotCount);
  int pct = constrain(slot.remainingPct, 0, 100);
  uint16_t color = paceColor(p, slot);

  if (force || pct != shownPct[i] || color != shownColor[i]) {
    char pctStr[8];
    snprintf(pctStr, sizeof(pctStr), "%d%%", pct);
    canvas->fillRect(140, y + 2, 120, 26, 0);
    text(FONT_LABEL, color, 140, y + 26, pctStr);
    int fill = BAR_W * pct / 100;
    canvas->fillRect(BAR_X, y + 34, BAR_W, BAR_H, COL_GRAY);
    if (fill > 0) canvas->fillRect(BAR_X, y + 34, fill, BAR_H, color);
    shownPct[i] = pct;
    shownColor[i] = color;
  }

  char reset[24];
  fmtCountdown(p, slot.resetsAt, reset, sizeof(reset));
  if (force || strcmp(reset, shownReset[i])) {
    canvas->fillRect(280, y + 4, 166, 20, 0);
    text(FONT_SMALL, COL_MUTED, 280, y + 22, reset);
    strlcpy(shownReset[i], reset, sizeof(shownReset[i]));
  }

  char numbers[32] = "";
  if (slot.total >= 0 && slot.used >= 0) {
    char usedStr[12], totalStr[12];
    fmtCount(slot.used, usedStr, sizeof(usedStr));
    fmtCount(slot.total, totalStr, sizeof(totalStr));
    snprintf(numbers, sizeof(numbers), "%s / %s", usedStr, totalStr);
  }
  if (force || strcmp(numbers, shownNumbers[i])) {
    canvas->fillRect(BAR_X, y + 56, 260, 20, 0);
    if (numbers[0]) text(FONT_SMALL, COL_MUTED, BAR_X, y + 72, numbers);
    strlcpy(shownNumbers[i], numbers, sizeof(shownNumbers[i]));
  }
}

static void updateBottom(const ProviderState &p, bool force) {
  unsigned long age = p.syncAgeSec();
  bool stale = age > 600;
  char bottom[48];
  if (stale) snprintf(bottom, sizeof(bottom), "STALE %lum - waiting for sync", age / 60);
  else snprintf(bottom, sizeof(bottom), "synced %02d:%02d:%02d",
                (int)((p.nowEstimate() % 86400) / 3600), (int)((p.nowEstimate() % 3600) / 60),
                (int)(p.nowEstimate() % 60));
  if (force || stale != shownStale || strcmp(bottom, shownBottom)) {
    canvas->fillRect(0, 386, SCREEN_W, 16, 0);
    text(FONT_TINY, stale ? COL_YELLOW : COL_MUTED, 34, 400, bottom);
    strlcpy(shownBottom, bottom, sizeof(shownBottom));
    shownStale = stale;
  }
  if (force || bleConnected != shownBle) {
    canvas->fillRect(0, 438, SCREEN_W, 16, 0);
    char line[64];
    snprintf(line, sizeof(line), "BLE %s | %d/%d tap=page hold=dim",
             bleConnected ? "connected" : "waiting", currentPage + 1, NPROVIDERS);
    text(FONT_TINY, COL_MUTED, 34, 450, line);
    shownBle = bleConnected;
  }
}

static void renderFull(const ProviderState &p) {
  canvasMode = false;
  canvas->fillScreen(0);

  String title = String(p.id);
  title.toUpperCase();
  text(FONT_TITLE, COL_CYAN, 34, 62, title.c_str());

  char page[8];
  snprintf(page, sizeof(page), "%d/%d", currentPage + 1, NPROVIDERS);
  text(FONT_SMALL, COL_MUTED, 412, 52, page);

  if (p.rateLimitType[0]) {
    char line[48];
    snprintf(line, sizeof(line), "LIMIT %s", p.rateLimitType);
    text(FONT_SMALL, COL_RED, 34, 94, line);
  } else {
    char line[48];
    snprintf(line, sizeof(line), "%s CODING PLAN", p.planType[0] ? p.planType : "quota");
    text(FONT_SMALL, COL_MUTED, 34, 94, line);
  }

  for (int i = 0; i < p.slotCount; i++) drawSlotStatic(p, i);
  for (int i = 0; i < 3; i++) shownPct[i] = -2, shownReset[i][0] = 0, shownNumbers[i][0] = 1, shownNumbers[i][1] = 0;
  shownBottom[0] = 0;
  shownBle = !bleConnected;  // force repaint
  for (int i = 0; i < p.slotCount; i++) updateSlotDynamic(p, i, true);
  updateBottom(p, true);
  shownSlotCount = p.slotCount;
  canvas->flush();
}

// Per-second tick: countdowns + stale flag on the visible page only.
static void tickDynamic() {
  if (currentPage < 0 || canvasMode) return;
  const ProviderState &p = providers[currentPage];
  for (int i = 0; i < p.slotCount; i++) updateSlotDynamic(p, i, false);
  updateBottom(p, false);
  canvas->flush();
}

static void nextPage() {
  if (currentPage < 0) return;
  for (int step = 1; step <= NPROVIDERS; step++) {
    int next = (currentPage + step) % NPROVIDERS;
    if (providers[next].hasData) {
      currentPage = next;
      renderFull(providers[currentPage]);
      return;
    }
  }
}

// ── state application ──

static void applyState() {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, stateBuffer);
  if (err) {
    Serial.printf("state json error: %s\n", err.c_str());
    return;
  }
  const char *id = doc["provider"] | "";
  ProviderState *p = findProvider(id);
  if (!p) {
    Serial.printf("unknown provider page: %s\n", id);
    return;
  }

  strlcpy(p->planType, doc["plan_type"] | "", sizeof(p->planType));
  strlcpy(p->rateLimitType, doc["status"]["rate_limit_reached_type"] | "", sizeof(p->rateLimitType));

  auto readSlot = [](JsonObject obj, QuotaSlot &slot, const char *fallback) {
    slot.label = String(obj["label"] | fallback);
    slot.remainingPct = obj["used_percent"] | -1;
    slot.rawUsedPct = obj["raw_used_percent"] | -1;
    slot.resetsAt = obj["resets_at"] | 0L;
    slot.windowMinutes = obj["window_minutes"] | 0;
    slot.total = obj["total"] | -1L;
    slot.used = obj["used"] | -1L;
    slot.valid = !obj.isNull();
  };
  JsonArray arr = doc["windows"].as<JsonArray>();
  int n = 0;
  if (!arr.isNull()) {
    for (JsonObject obj : arr) {
      if (n >= 3) break;
      readSlot(obj, p->slots[n], "?");
      n++;
    }
  } else {
    readSlot(doc["primary"], p->slots[0], "5h");
    readSlot(doc["secondary"], p->slots[1], "week");
    n = 2;
  }
  p->slotCount = n;

  p->generatedAt = doc["generated_at"] | 0L;
  p->syncMillis = millis();
  p->hasData = true;

  if (currentPage < 0) currentPage = providerIndex(p);
  if (providerIndex(p) != currentPage) return;  // cached silently

  if (canvasMode || p->slotCount != shownSlotCount) {
    renderFull(*p);
    return;
  }
  for (int i = 0; i < p->slotCount; i++) {
    const QuotaSlot &slot = p->slots[i];
    // slot became valid/invalid -> redraw its static part
    if ((slot.valid && slot.remainingPct >= 0) != (shownPct[i] > -2)) drawSlotStatic(*p, i);
  }
  for (int i = 0; i < p->slotCount; i++) updateSlotDynamic(*p, i, false);
  updateBottom(*p, false);
  canvas->flush();
}

// ── BLE command handling (runs in loop, never in the BLE callback) ──

BLECharacteristic *txChar = nullptr;

static void ack(const char *msg) {
  if (!txChar || !bleConnected) return;
  txChar->setValue((uint8_t *)msg, strlen(msg));
  txChar->notify();
}

static void handleStatus() {
  char reply[160];
  char pages[48] = "";
  for (int i = 0; i < NPROVIDERS; i++) {
    if (!providers[i].hasData) continue;
    if (pages[0]) strlcat(pages, ",", sizeof(pages));
    strlcat(pages, providers[i].id, sizeof(pages));
  }
  snprintf(reply, sizeof(reply),
           "quota-desk fw=%s board=amoled-2.16 up=%lus page=%s pages=%s bright=%u",
           FW_VERSION, millis() / 1000,
           currentPage >= 0 ? providers[currentPage].id : "none",
           pages[0] ? pages : "none", BRIGHTNESS_STEPS[brightnessIdx]);
  ack(reply);
}

static void handleCommand(const char *cmd) {
  if (!strcmp(cmd, "status")) {
    handleStatus();
    return;
  }
  if (!strncmp(cmd, "page ", 5)) {
    ProviderState *p = findProvider(cmd + 5);
    if (p && p->hasData) {
      currentPage = providerIndex(p);
      renderFull(*p);
    }
    ack("ok");
    return;
  }
  if (!strcmp(cmd, "begin_state")) {
    stateBuffer = "";
    stateBuffer.reserve(2048);
    ack("ok");
    return;
  }
  if (!strncmp(cmd, "chunk ", 6)) {
    stateBuffer += cmd + 6;
    ack("ok");
    return;
  }
  if (!strcmp(cmd, "end_state")) {
    applyState();
    ack("ok");
    return;
  }
  if (!strncmp(cmd, "clear", 5)) {
    canvasMode = true;
    canvas->fillScreen(colorByName(cmd + 6));
    canvas->flush();
    ack("ok");
    return;
  }
  if (!strncmp(cmd, "rect ", 5)) {
    canvasMode = true;
    int x, y, w, h;
    char color[16];
    if (sscanf(cmd, "rect %d %d %d %d %15s", &x, &y, &w, &h, color) == 5) {
      canvas->fillRect(x, y, w, h, colorByName(color));
      canvas->flush();
    }
    ack("ok");
    return;
  }
  if (!strncmp(cmd, "txt ", 4)) {
    canvasMode = true;
    int x, y, size;
    char color[16];
    int consumed = 0;
    if (sscanf(cmd, "txt %d %d %d %15s%n", &x, &y, &size, color, &consumed) == 4) {
      const char *text = cmd + consumed;
      while (*text == ' ') text++;
      canvas->setFont((const GFXfont *)NULL);
      canvas->setTextSize(size);
      canvas->setTextColor(colorByName(color), 0);
      canvas->setCursor(x, y);
      canvas->print(text);
      canvas->flush();
    }
    ack("ok");
    return;
  }
  ack("ok");  // unknown commands still need an ack for flow control
}

// ── command queue: BLE callback enqueues, loop() drains ──

#define CMD_QUEUE_LEN 8
#define CMD_MAX_LEN 200
static char cmdQueue[CMD_QUEUE_LEN][CMD_MAX_LEN];
static volatile int cmdHead = 0;
static volatile int cmdTail = 0;

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    int next = (cmdHead + 1) % CMD_QUEUE_LEN;
    if (next == cmdTail) return;  // queue full: drop, pusher will time out and retry
    String value = ch->getValue();
    value.trim();
    strlcpy(cmdQueue[cmdHead], value.c_str(), CMD_MAX_LEN);
    cmdHead = next;
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleConnected = true; }
  void onDisconnect(BLEServer *server) override {
    bleConnected = false;
    server->getAdvertising()->start();
  }
};

static void setupBle() {
  BLEDevice::init(BLE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *service = server->createService(SERVICE_UUID);

  txChar = service->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  BLECharacteristic *rxChar = service->createCharacteristic(
      RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxChar->setCallbacks(new RxCallbacks());

  service->start();
  BLEAdvertising *advertising = server->getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
}

// ── touch ──

static void setupTouch() {
  touch.setPins(TP_RST, TP_INT);
  if (!touch.begin(Wire, CST92XX_SLAVE_ADDRESS, IIC_SDA, IIC_SCL)) {
    Serial.println("touch not online, continuing without it");
    return;
  }
  Serial.printf("touch: %s\n", touch.getModelName());
  touch.setMaxCoordinates(SCREEN_W, SCREEN_H);
  touch.setSwapXY(true);
  touch.setMirrorXY(true, false);
  pinMode(TP_INT, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TP_INT), onTouchInterrupt, FALLING);
}

// short tap = next provider page, long press (~1.2s) = brightness
static void pollTouch() {
  if (!touchPending) return;
  touchPending = false;
  int16_t x[5], y[5];
  if (!touch.getPoint(x, y, touch.getSupportTouchPoint())) return;

  unsigned long pressStart = millis();
  bool held = false;
  while (millis() - pressStart < 1300) {
    delay(50);
    if (!touch.getPoint(x, y, touch.getSupportTouchPoint())) break;  // released
    if (millis() - pressStart >= 1200) {
      held = true;
      break;
    }
  }

  if (held) {
    brightnessIdx = (brightnessIdx + 1) % (sizeof(BRIGHTNESS_STEPS) / sizeof(BRIGHTNESS_STEPS[0]));
    gfx->setBrightness(BRIGHTNESS_STEPS[brightnessIdx]);
  } else if (!canvasMode) {
    nextPage();
  }
}

// ── arduino ──

void setup() {
  Serial.begin(115200);
  Wire.begin(IIC_SDA, IIC_SCL);

  if (!gfx->begin()) {
    Serial.println("gfx->begin() failed");
    while (1) delay(1000);
  }
  if (!canvas->begin()) {
    Serial.println("canvas->begin() failed (PSRAM framebuffer)");
    while (1) delay(1000);
  }
  canvas->fillScreen(0);
  gfx->setBrightness(BRIGHTNESS_STEPS[brightnessIdx]);

  canvas->setTextColor(COL_CYAN, 0);
  canvas->setTextSize(4);
  canvas->setCursor(34, 200);
  canvas->print("QUOTA DESK");
  canvas->setTextSize(2);
  canvas->setTextColor(COL_MUTED, 0);
  canvas->setCursor(34, 260);
  canvas->printf("BLE name: %s", BLE_NAME);
  canvas->setCursor(34, 290);
  canvas->print("waiting for sync...");
  canvas->flush();

  setupTouch();
  setupBle();
  Serial.println("quota-desk up");
}

void loop() {
  while (cmdTail != cmdHead) {
    handleCommand(cmdQueue[cmdTail]);
    cmdTail = (cmdTail + 1) % CMD_QUEUE_LEN;
  }

  pollTouch();

  static unsigned long lastTick = 0;
  unsigned long now = millis();
  if (now - lastTick >= 1000) {
    lastTick = now;
    tickDynamic();
  }
  delay(10);
}
