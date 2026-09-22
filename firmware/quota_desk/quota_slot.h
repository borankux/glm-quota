#pragma once

#include <Arduino.h>

struct QuotaSlot {
  String label;
  int remainingPct = -1;   // slot.used_percent (drives the bar)
  int rawUsedPct = -1;
  long resetsAt = 0;       // epoch seconds, 0 = unknown
  int windowMinutes = 0;   // slot.window_minutes (pace coloring)
  long total = -1;         // absolute pool size, -1 = not reported (Codex)
  long used = -1;          // absolute used amount, -1 = not reported
  bool valid = false;
};

// One cached provider page. The pusher feeds providers round-robin; each
// end_state lands in its own ProviderState and the UI only re-renders when
// the visible page's data changes (tap switches pages).
struct ProviderState {
  const char *id;          // "glm" / "codex" / "kimi"
  char planType[24] = "";
  char rateLimitType[32] = "";
  QuotaSlot slots[3];      // windows from the desk-status `windows` array
  int slotCount = 0;
  long generatedAt = 0;          // epoch seconds from the pusher
  unsigned long syncMillis = 0;  // millis() when its end_state landed
  bool hasData = false;

  long nowEstimate() const {
    if (!generatedAt) return 0;
    return generatedAt + (long)((millis() - syncMillis) / 1000);
  }

  unsigned long syncAgeSec() const {
    return hasData ? (millis() - syncMillis) / 1000 : 0;
  }
};
