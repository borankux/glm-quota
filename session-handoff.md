# session-handoff — glm-quota v2 + Quota-Desk 固件

*更新: 2026-09-23 早（固件 v3.4：PSRAM canvas 架构修复小写屏 bug，文字正常）*

## 当前状态：✅ GLM / Codex / Kimi 三页额度屏运行中

- Mac 服务：tmux 会话 `quota-desk`，15s 轮推 glm→codex→kimi（每 provider ~45s 一轮），
  日志 `~/.codex/codex-desk-status/quota_pusher.log`
- **恢复命令（服务挂了/重启 Mac 后）：`~/esp-stuff/tools/quota_desk_restart.sh`**
  （自动开蓝牙 + 重建 tmux）；已写进 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.kimi-code/AGENTS.md` 全局指令
- 设备：ESP32-S3-Touch-AMOLED-2.16（480×480 CO5300 + CST9220 触摸，I2C 扫描确认：0x5A 触摸 / 0x34 AXP2101 / 0x51 RTC / 0x6B IMU，无 0x38 → 不是 2.06）
- 屏幕：每 provider 一页（标题 + plan、最多 3 条剩余量进度条 + **used / total 绝对量数字**（Codex 只有百分比不显示；Kimi 月度窗只有比率也没有绝对量）、pace 变色、reset 倒计时本地每秒递减、同步时间/BLE 状态、页码 n/3）
- **Kimi 三窗口（2026-09 接口改版）**：`usages` map（snake_case）→ `limit_5h` / `limit_month_code`（month）/ `limit_month_total`（TOTAL 全额度闸，耗尽则其他窗口归零也不能用）；旧 `limits[]`+`usage` 解析留作兜底但按 kind 去重
- desk-status 协议新增 `windows[]` 数组（完整窗口列表，固件 v3.2 渲染最多 3 条，3 条时压缩行距）；`primary`/`secondary` 保留兼容
- 字体：**u8g2 字体路径**（`fonts/u8g2_fonts_pick.h`，从 u8g2 `u8g2_fonts.c` 抽取 helvB24/helvB18/helvR14/helvR10 并改名 `qd_font_*` 防止和 U8g2 库本体符号冲突）；
  必须 `#include <U8g2lib.h>` 在 Arduino_GFX 之前（否则 `__has_include` 检测不到，`setFont(const uint8_t*)` 重载不存在）；setCursor y 是**基线**不是顶边
- **显示架构：所有绘制走 PSRAM canvas（`PsramCanvas`，460KB 帧缓冲在 8MB OPI PSRAM），画完 `canvas->flush()` 整帧推屏**。
  根因（原语二分探针实测）：这套 CO5300/QSPI 栈**小颗粒写不可靠**——`writeFillRect(h=1)` 直接消失、GFXfont 的 1px 写乱码（M/H/数字"蜘蛛爬"）；
  大块写（fillRect/fillScreen/整帧 bitmap）正常，官方 LVGL demo 能用就是因为 LVGL 只做大块 flush。**别在固件里直接对小区域 gfx-> 写像素**
- 触屏：**点按 = 切 provider 页**（只在有数据的页间循环）；**长按 ~1.2s = 亮度循环** 200/120/50
- 设备自查：`python3 ~/esp-stuff/tools/codex_status_ble_push.py --device-status --target Quota-Desk`
  （返回 `fw=3 ... page=glm pages=glm,codex,kimi`）

## 固件（本仓库 `firmware/quota_desk/`，当前 v3）

- `quota_desk.ino` + `quota_slot.h`（`QuotaSlot` + `ProviderState`，struct 必须放头文件，否则 .ino 原型提升报错）
- BLE 广播名 **Quota-Desk**（Nordic UART UUID 与老工具一致；**每条命令必须 notify ack**，Swift 端逐条等回复）
- 协议：`status` / `begin_state`+`chunk`+`end_state`（codex_desk_status.v1 JSON）/ `page <id>` 强制切页 / 兼容旧 canvas 命令 `clear/txt/rect`
- **desk-status slot 还带 `total`/`used` 绝对量**（bin.js 从 windows 透传；Codex 恒 null）——改协议时两边一起动
- **多 provider 缓存**：每个 provider 一页 `ProviderState`（glm/codex/kimi 固定三槽）；end_state 只更新对应页，可见页才重渲染，其余静默缓存
- 字段语义：slot `used_percent` 是**剩余**百分比（驱动进度条），`raw_used_percent` 才是实际已用；
  bar 颜色是 pace-based（剩余额度% / 剩余时间%：≥1 青、≥0.85 黄、否则红，≤10% 恒红）
- **BLE RX 回调只入队**，解析/渲染全在 loop()（v1 在回调里渲染会 supervision-timeout 断开 + 看门狗重启）
- 编译烧录（FQBN 选项一个都不能少）：
  ```
  arduino-cli compile -b esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi firmware/quota_desk
  arduino-cli upload  -b <同上> -p /dev/cu.usbmodem11201 firmware/quota_desk
  ```
- 依赖：esp32 core **3.3.11**；库在 `~/Documents/Arduino/libraries/`（GFX_Library_for_Arduino 1.6.4、SensorLib 0.3.3、XPowersLib、Mylibrary，均来自 Waveshare 官方仓库 `waveshareteam/ESP32-S3-Touch-AMOLED-2.16` 的 examples/arduino/libraries，直接拷贝）+ `ArduinoJson`（arduino-cli lib install）
- 2.16 引脚：QSPI SIO0-3=4/5/6/7、SCLK=38、CS=12、RST=39；I2C SDA=15/SCL=14；触摸 INT=11/RST=40；亮度走 `gfx->setBrightness(0~255)`（寄存器 0x51，无背光 GPIO）

## 环境坑（重装时必读）

- arduino-cli 的 Go 下载器对 GitHub 发 HEAD 会超时（直连和代理都犯病）→ 用 `curl -x http://127.0.0.1:7897` 或 ghfast.top 镜像手动下载工具链 tarball 到 `~/Library/Arduino15/staging/packages/` 再 install；装完删掉 staging（1.6G）
- **磁盘常年 99% 满**：本次清 `~/Library/Caches/go-build`（1.7G）才腾出空间；装工具链前先 `df -h`
- Mac 蓝牙可能被关：`blueutil -p 1` 打开
- 重启 Mac 后恢复：**`~/esp-stuff/tools/quota_desk_restart.sh`**（内含蓝牙开启 + tmux 重建，三 provider 轮推）

## glm-quota CLI（未改动，前面验证过仍然有效）

- GLM 走 `/api/monitor/usage/quota/limit`（V3 CREDIT_LIMIT 按 unit/number 分派 3/5=5h、6/1=week）
- 凭据读 `~/.claude/settings.json` 的 ANTHROPIC_AUTH_TOKEN/BASE_URL——**不要写进任何文件**
- Kimi 凭据文件自动轮换写回，保持 `~/.kimi-code/credentials/kimi-code.json` 0o600

## 下一步（待 Frank 决定）

1. UI 迭代：LVGL 精美界面、多账号、电池页（AXP2101 现成）、拿起亮屏（QMI8658）、屏保防烧屏
2. push GitHub（borankux/glm-quota）/ 发 npm（含 firmware/ 目录）
3. 老设备（2.06，`Codex-Desk-Status`）固件源码仍在 Phalcon 盘，需要时挂载找回
