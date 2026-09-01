# glm-quota

Unified coding-plan quota CLI — one zero-dependency command for every coding agent's subscription:

| Provider | Plan source | Windows reported |
|---|---|---|
| `glm` | GLM Coding Plan (智谱 open.bigmodel.cn / international api.z.ai) — **also covers Claude Code while it routes through GLM** | 5h + weekly credit pool (V3), TOKENS/MCP limits on grandfathered V2 |
| `codex` | OpenAI Codex CLI (ChatGPT Plus/Pro) | whatever the plan currently exposes (Codex Pro is a single 7-day window since 2026-08) |
| `kimi` | Kimi Code CLI (Moonshot, Kimi for Coding) | 5h rolling + weekly (monthly total is not exposed by the API) |

```console
$ glm-quota
  Coding Plan Quotas  · 3/3 providers  · 9/1/2026, 6:15:26 PM
  ────────────────────────────────────────────────────────
  👑  GLM Coding Plan · Zhipu (智谱)  max
     5h      ██████░░░░░░░░░░░░░░░░░░░░░░░░  8%  resets 31m
           2.5K / 28.0K
     week    █████░░░░░░░░░░░░░░░░░░░░░░░░░  6%  resets 4d 9h
           8.9K / 140.0K
     · 24h 39.5M tokens · 561 calls

  🤖  Codex · OpenAI  pro
     week    █████████████████████████░░░░  83%  resets 5d 16h
     · models: codex_bengalfox

  🦁  Kimi Code · Moonshot AI  Advanced
     5h      ███░░░░░░░░░░░░░░░░░░░░░░░░░░░  5%  resets 21m
           5 / 100
     week    ████████████████░░░░░░░░░░░░░  51%  resets 4d 16h
           51 / 100
     · parallel 1/30
```

## Install / run

```bash
npx glm-quota            # once published
# or from a clone:
node bin.js
```

No dependencies; Node ≥ 18.

## Auth (all local, nothing to configure if you already use these CLIs)

- **glm** — reads `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` from the env or
  `~/.claude/settings.json` (the same config Claude Code uses when routed through GLM).
  Works for both domestic (bigmodel.cn) and international (z.ai) keys.
- **codex** — reads the OAuth access token from `~/.codex/auth.json`. If it expired,
  run `codex` once to refresh. `chatgpt.com` is reached via `HTTPS_PROXY` env or the
  macOS system proxy (automatic fallback).
- **kimi** — reads `~/.kimi-code/credentials/kimi-code.json`, auto-refreshes the
  15-minute access token via auth.kimi.com and writes rotated tokens back.
  Alternatively `export KIMI_API_KEY=sk-kimi-...` (console key, no refresh needed).

## Options

```text
--provider <list>   subset, e.g. --provider glm,codex
--json              normalized JSON for scripts
--desk-status <p>   codex_desk_status.v1-shaped JSON for one provider (ESP32 bridge)
--no-color          strip ANSI
```

`--json` shape (per provider): `{provider, ok, platform, plan, windows: [{kind, used_pct, remaining_pct, total, used, remaining, resets_at}], extra}`.

## ESP32 desk display

`--desk-status <provider>` emits the same schema the [esp-stuff](https://github.com/ALL-IN-Tech-Media) codex-desk-status
pipeline renders on ATX/Waveshare ESP32 AMOLED displays (`used_percent` carries the
remaining percentage — it drives the on-screen bar fill; `raw_used_percent` the real usage).
A rotation bridge lives in esp-stuff: `tools/quota_desk_push.py` collects all providers
every 60s, rotates the displayed provider every 60s, and pushes over BLE every 15s.

## API notes (verified 2026-09)

- GLM V3 plans return `limits[].type = CREDIT_LIMIT`; dispatch on `unit/number`
  (3/5 → 5h, 6/1 → weekly) with `TOKENS_LIMIT`/`TIME_LIMIT` fallback for V2.
- Codex usage comes from the CLI's own status endpoint
  `chatgpt.com/backend-api/wham/usage` — undocumented; label windows from
  `limit_window_seconds`, never assume 5h exists.
- Kimi usage endpoint `api.kimi.com/coding/v1/usages` (official kimi-cli source);
  refresh endpoint/client_id are community-discovered.

MIT © Frank (borankux)
