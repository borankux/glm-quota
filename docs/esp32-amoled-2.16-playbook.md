# ESP32-S3-Touch-AMOLED-2.16 交互实战手册

> 把 Waveshare ESP32-S3-Touch-AMOLED-2.16 打造成桌面额度屏（Quota-Desk）过程中踩过的坑和验证过的结论。
> 面向"下次再玩这块板子 / 换一块同系列板子"的场景，按踩坑顺序组织。
> 配套固件：`firmware/quota_desk/`；运行状态速查：`session-handoff.md`。

## 1. 先确认你手里是哪块板

Waveshare 这个系列有 2.06 和 2.16 两款，外观几乎一样，但触摸芯片不同、引脚定义不同，固件不通用。**不要信卖家标题，上电扫 I2C**：

```
0x5A = CST9220 触摸 → 2.16 寸（本项目）
0x38 = FT3168 触摸 → 2.06 寸
其他常驻地址：0x34 AXP2101 电源管理 / 0x51 RTC / 0x6B QMI8658 IMU
```

2.16 寸关键参数：

| 项目 | 值 |
|---|---|
| 屏幕 | 480×480 AMOLED，CO5300 驱动，QSPI 接口 |
| QSPI 引脚 | SIO0-3 = 4/5/6/7，SCLK = 38，CS = 12，RST = 39 |
| I2C | SDA = 15，SCL = 14 |
| 触摸 | CST9220，INT = 11，RST = 40 |
| 亮度 | `gfx->setBrightness(0~255)`，走 CO5300 寄存器 0x51，**没有背光 GPIO** |

## 2. 显示：最大的坑——小颗粒 QSPI 写不可靠

这是整个项目耗时间最多的问题，现象非常有迷惑性：

- 官方 LVGL demo 显示**完全正常** → 会让你以为硬件和驱动没问题
- 自己用 Arduino_GFX 画 UI 时：大面积填充（fillRect / fillScreen）正常，但**文字字形是坏的**——M/H 显示成乱码、数字像"蜘蛛爬过"、1px 高的横线直接消失
- 换字体、换字号、换颜色都没用，甚至会怀疑字体文件本身坏了

**根因**：这套 CO5300 + QSPI 栈（Arduino_GFX 的 `Arduino_ESP32QSPI` + `Arduino_CO5300`）在**小颗粒写**时丢数据。用"原语二分探针"实测验证：逐个测试 `writePixel` / `writeFastHLine` / `writeFillRect(h=1)` / `fillRect(大块)` / `pushColor bitmap`，结论是小写消失、大写正常。LVGL demo 能用，恰恰因为 LVGL 的 flush 永远是大块推送。

**解法：PSRAM canvas 架构**。所有绘制进一块放在 8MB OPI PSRAM 里的 480×480×2 字节帧缓冲（~460KB），画完一次性 `canvas->flush()` 整帧推屏：

```cpp
// 伪代码
PsramCanvas canvas(gfx);           // 内部用 ps_malloc 分配帧缓冲
canvas.draw...();                  // 所有原语画到内存，不碰屏幕
canvas.flush();                    // 一次性 gfx->draw16bitRGBBitmap 整帧
```

代价是整帧刷新慢一点（人眼无感），换来的是**绝对可靠**。教训：**在这块板子上，永远不要直接对小区域 `gfx->` 写像素**。

### 诊断方法值得复用：原语二分探针

遇到"显示乱但 demo 正常"类问题，别猜，写一个最小 sketch，把图形原语按粒度从小到大逐个画出来，目视/拍照确认哪一级开始坏。探针留在 `~/Documents/Arduino/probe_216/` 和 `probe_font/`。这比读驱动源码快得多。

## 3. 字体：GFXfont 在这块板子上必坏，用 u8g2 路径

- Adafruit GFXfont 的渲染路径会产生大量 1px 级小写 → 撞上上面的小写 bug，字形必坏。**别换回去**。
- 可行方案：从 u8g2 的 `u8g2_fonts.c` 里抽取需要的字体（项目用 helvB24 / helvB18 / helvR14 / helvR10），存成 `fonts/u8g2_fonts_pick.h`，配合 `U8g2_for_Adafruit_GFX` 库画进 canvas。
- **改名防冲突**：抽出来的字体符号改成 `qd_font_*` 前缀，否则和 U8g2 库本体的全局符号重定义。
- **include 顺序有讲究**：`#include <U8g2lib.h>` 必须放在 Arduino_GFX 之前，否则 `__has_include` 检测失败，`setFont(const uint8_t*)` 这个重载根本不存在，编译报错信息完全看不出原因。
- u8g2 的 `setCursor(x, y)` 里 **y 是字形基线，不是顶边**，排版时记得加 ascent。

## 4. BLE：稳定性的三条铁律

协议用 Nordic UART（UUID 6E400001 / …2 / …3），广播名 `Quota-Desk`，和老工具链兼容。

1. **每条命令必须 notify ack**。Mac 端（Swift / Python bleak）逐条发、逐条等回复。不发 ack 看起来也能工作，但吞吐一高就丢包，而且无法排查。
2. **RX 回调里只入队，不做任何解析和渲染**。v1 在回调里直接渲染，结果是 supervision-timeout 断开 + 看门狗重启。正确姿势：回调 `queue.push()`，`loop()` 里消费。
3. **大 JSON 分块传**：`begin_state` → 若干 `chunk` → `end_state`，单条 ATT MTU 装不下完整的 desk-status JSON。

协议一览：`status`（设备自查）/ `begin_state`+`chunk`+`end_state` / `page <id>` 强制切页 / 兼容旧 `clear/txt/rect`。

设备自查命令（不依赖固件版本记忆）：

```bash
python3 ~/esp-stuff/tools/codex_status_ble_push.py --device-status --target Quota-Desk
# 返回 fw=3.4 board=amoled-2.16 ... pages=glm,codex,kimi
```

## 5. 固件结构的两个小但关键的点

- **struct 定义必须放头文件**（`quota_slot.h`）：`.ino` 文件会被 Arduino 预处理做函数原型提升，在 `.ino` 里定义的 struct 作为函数参数类型时会报"未声明"。
- **多 provider 缓存**：每个 provider 一页 `ProviderState` 固定槽位，`end_state` 只更新对应页，可见页才重渲染，其余静默缓存——这样 BLE 推任意 provider 都不会闪屏。

## 6. 触屏与交互

CST9220 走 SensorLib。当前手势约定：

- **点按** = 切换 provider 页（只在有数据的页间循环，没数据的页跳过）
- **长按 ~1.2s** = 亮度循环 200 → 120 → 50

触摸中断脚 INT=11，注意和 RST=40 配对初始化，少一个都会"触摸没反应但不报错"。

## 7. 工具链与环境坑（重装系统 / 换电脑必读）

```bash
# 编译烧录（FQBN 选项一个都不能少）
arduino-cli compile -b esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi firmware/quota_desk
arduino-cli upload  -b <同上> -p /dev/cu.usbmodem11201 firmware/quota_desk
```

- **esp32 core 用 3.3.11**；依赖库在 `~/Documents/Arduino/libraries/`：GFX_Library_for_Arduino 1.6.4、SensorLib、XPowersLib、Mylibrary（都来自 Waveshare 官方仓库 `waveshareteam/ESP32-S3-Touch-AMOLED-2.16` 的 `examples/arduino/libraries`，直接拷贝）、U8g2、U8g2_for_Adafruit_GFX、ArduinoJson。
- **arduino-cli 下载工具链会超时**：它的 Go 下载器对 GitHub 发 HEAD 请求，直连和代理都犯病。解法：`curl -x http://127.0.0.1:7897` 或 ghfast.top 镜像手动下 tarball 到 `~/Library/Arduino15/staging/packages/`，再跑 install；装完删 staging（约 1.6G）。
- **磁盘常年 99% 满**：装工具链前先 `df -h`；`~/Library/Caches/go-build` 清过一次腾出 1.7G。
- **Mac 蓝牙可能被关**：`blueutil -p 1`。
- **重启 Mac 后一键恢复推送服务**：`~/esp-stuff/tools/quota_desk_restart.sh`（开蓝牙 + 重建 tmux 会话 `quota-desk`，15s 轮推三个 provider）。此脚本已写进各 CLI 的全局指令文件，任何 agent 都能接力。

## 8. 数据协议（固件 ↔ Mac 端）

改协议时**两边一起动**（本仓库 `bin.js` 的 desk-status 输出 ↔ `firmware/quota_desk/`）：

- slot 的 `used_percent` 是**剩余**百分比（驱动进度条），`raw_used_percent` 才是已用——命名有历史包袱，别搞反
- slot 还带 `total` / `used` 绝对量（Codex 接口只有百分比，恒 null）
- `windows[]` 数组最多 3 窗口；`primary` / `secondary` 字段保留兼容
- 进度条颜色是 pace-based：剩余额度% ÷ 剩余时间%，≥1 青、≥0.85 黄、否则红，剩余 ≤10% 恒红
- reset 倒计时由固件本地每秒递减，不依赖每分钟推送

## 9. 已验证可行的下一步方向

AXP2101（电池页）、QMI8658（拿起亮屏）驱动库都已在依赖里，屏保防烧屏（AMOLED 长期显示静态界面值得做）、LVGL 美化 UI、多账号。2.06 寸老板子（广播名 `Codex-Desk-Status`）的固件源码在 Phalcon 盘上，需要时挂载找回。
