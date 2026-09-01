# session-handoff — glm-quota v2

*更新: 2026-09-01 晚（v2 统一重写完成）*

## 当前状态：✅ 完成，系统运行中

glm-quota v2.0.0 统一三池额度 CLI（GLM / Codex / Kimi）已完成并本地提交（`30fe7a8`）。
ESP32 桥接在 tmux 会话 `quota-desk-status` 中运行（60s 采集 / 60s 轮换 / 15s BLE 推送），
日志 `~/.codex/codex-desk-status/quota_pusher.log` 已验证 codex→glm→kimi 完整轮换无错。

## 架构速览

- `bin.js` — CLI 入口：pretty / `--json` / `--desk-status <provider>` / `--provider a,b`
- `lib/glm.js` — bigmodel.cn 配额；V3 `CREDIT_LIMIT` 按 unit/number 分派（3/5=5h，6/1=周），V2 类型兜底；凭据读 `~/.claude/settings.json`（Claude Code 走 GLM 同池）
- `lib/codex.js` — chatgpt.com `wham/usage`；窗口按 `limit_window_seconds` 动态标注（Pro 现为单 7 天窗口）
- `lib/kimi.js` — api.kimi.com `coding/v1/usages`；15min token 自动刷新写回（0o600）；备选 `KIMI_API_KEY`
- `lib/util.js` — 零依赖 HTTP + 代理兜底（env → macOS scutil → CONNECT 隧道，chatgpt.com 必需）

## 下一步（待 Frank 决定）

1. **push GitHub（borankux/glm-quota）/ 发 npm v2.0.0** — 代码只在本地 commit，等发话
2. 屏幕页眉标签写死 CODEX/KIMI：GLM 数据落 codex 页（数字对、标题不对）；要独立 GLM 页或改标题需刷固件（源码在 Phalcon 盘 `/Volumes/Phalcon/01-Mac-Cold-Archive/2026-08-14-Old-Documents-Projects/`）
3. 可选：Claude Code 官方 Max 的 statusline 采集器（仅当切回官方 API 才需要）

## 注意事项

- **不要把 `~/.claude/settings.json` 的 token 写进任何文件** — 运行时读取即可
- Kimi 凭据文件会被自动轮换写回，保持 `~/.kimi-code/credentials/kimi-code.json` 0o600
- 重启 Mac 后恢复推送：`tmux new -d -s quota-desk-status 'python3 ~/esp-stuff/tools/quota_desk_push.py --watch >> ~/.codex/codex-desk-status/quota_pusher.log 2>&1'`（先确认蓝牙开）
- 桥接脚本在 `~/esp-stuff/tools/quota_desk_push.py`（不在本仓库）
- 60s 轮询各家接口均安全（Codex CLI 自身就 60s；GLM/Kimi 无 429 风险记录，Codex 5h 窗口已停用无影响）
