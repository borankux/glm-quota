#!/usr/bin/env node

/**
 * glm-quota — unified coding-plan quota CLI.
 *
 * v1 checked the GLM Coding Plan only; v2 turned it into one zero-dependency
 * CLI over every coding agent this machine runs:
 *
 *   glm   — GLM Coding Plan (Zhipu / Z.ai), also covers Claude Code while
 *           ANTHROPIC_BASE_URL routes through GLM
 *   codex — OpenAI Codex CLI (ChatGPT Plus/Pro)
 *   kimi  — Kimi Code CLI (Moonshot Kimi for Coding)
 *
 * Output modes:
 *   glm-quota                      pretty console (all providers)
 *   glm-quota --json               normalized JSON (scripts)
 *   glm-quota --desk-status glm    codex_desk_status.v1-shaped JSON for the
 *                                  ESP32 BLE bridge (esp-stuff tools)
 *   glm-quota --provider glm,codex subset
 *
 * NOTE: window semantics differ per plan (Codex Pro is currently a single
 * 7-day window; Kimi hides its monthly total). Renderers never assume a
 * window exists — they label whatever the provider reports.
 */

import { paintc, bar, countdown, fmtCount, setColor } from './lib/util.js';
import { collectGlm, GLM_PROVIDER } from './lib/glm.js';
import { collectCodex, CODEX_PROVIDER } from './lib/codex.js';
import { collectKimi, KIMI_PROVIDER } from './lib/kimi.js';

const PROVIDERS = {
  [GLM_PROVIDER]: { collect: collectGlm, name: 'GLM Coding Plan', icon: '👑' },
  [CODEX_PROVIDER]: { collect: collectCodex, name: 'Codex', icon: '🤖' },
  [KIMI_PROVIDER]: { collect: collectKimi, name: 'Kimi Code', icon: '🦁' },
};

// ── args ──

function parseArgs(argv) {
  const args = { json: false, deskStatus: null, providers: null, noColor: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--desk-status') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.deskStatus = next;
        i++;
      } else {
        args.deskStatus = '*';
      }
    } else if (a === '--provider' || a === '-p') {
      args.providers = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--no-color') args.noColor = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`glm-quota — unified coding-plan quota CLI (GLM / Codex / Kimi)

Usage:
  glm-quota [options]

Options:
  --provider <list>   comma-separated subset: glm,codex,kimi (default: all)
  --json              normalized JSON to stdout (for scripts)
  --desk-status <p>   codex_desk_status.v1-shaped JSON for one provider,
                      consumed by the ESP32 BLE bridge (esp-stuff)
  --no-color          strip ANSI colors
  -h, --help          this help
`);
}

async function collectAll(names) {
  const entries = await Promise.all(
    names.map(async (name) => {
      const p = PROVIDERS[name];
      try {
        return [name, await p.collect()];
      } catch (e) {
        return [name, { provider: name, ok: false, error: e.message }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

// ── codex_desk_status.v1 slot builder ──
// Field semantics follow the existing collector: `used_percent` carries the
// REMAINING percentage (it drives the on-screen bar fill), `raw_used_percent`
// carries actual used. Slots are fixed: primary=5h, secondary=week.

function unavailableSlot(label, minutes) {
  return { label, used_percent: -1, remaining_percent: -1, raw_used_percent: null, window_minutes: minutes, resets_at: null };
}

function slotFor(w, label, minutes) {
  if (!w) return unavailableSlot(label, minutes);
  return {
    label,
    used_percent: w.remaining_pct ?? -1,
    remaining_percent: w.remaining_pct ?? -1,
    raw_used_percent: w.used_pct,
    window_minutes: minutes,
    resets_at: w.resets_at,
  };
}

function deskStatusFor(result) {
  if (!result.ok) {
    return {
      schema: 'codex_desk_status.v1',
      provider: result.provider,
      plan_type: null,
      limit_id: result.provider,
      primary: unavailableSlot('5h', 300),
      secondary: unavailableSlot('week', 10080),
      status: { rate_limit_reached_type: null, collector_state: 'error', quota_timestamp: new Date().toISOString() },
      error: result.error,
    };
  }
  const five = result.windows.find((w) => w.kind === '5h');
  const week = result.windows.find((w) => w.kind === 'week');
  return {
    schema: 'codex_desk_status.v1',
    provider: result.provider,
    plan_type: String(result.plan || '').toLowerCase() || null,
    limit_id: result.provider,
    primary: slotFor(five, '5h', 300),
    secondary: slotFor(week, 'week', 10080),
    status: { rate_limit_reached_type: null, collector_state: 'ok', quota_timestamp: new Date().toISOString() },
  };
}

// ── pretty renderer ──

function renderProvider(result, meta) {
  const lines = [];
  if (!result.ok) {
    lines.push(`  ${paintc.red('✖')} ${paintc.bold(meta.name)}  ${paintc.dim(result.error || 'failed')}`);
    return lines;
  }

  const platform = result.platform ? paintc.dim(` · ${result.platform}`) : '';
  lines.push(`  ${meta.icon}  ${paintc.cyan(paintc.bold(meta.name))}${platform}  ${paintc.bold(String(result.plan))}`);

  for (const w of result.windows) {
    if (w.used_pct == null) {
      lines.push(`     ${paintc.dim(`${w.label.padEnd(5)} ─ unknown`)}`);
      continue;
    }
    const reset = w.resets_at ? countdown(w.resets_at) : 'unknown';
    const parts = [];
    if (w.total != null && w.used != null) {
      parts.push(`${paintc.dim(`${fmtCount(w.used)} / ${fmtCount(w.total)}`)}`);
    }
    lines.push(`     ${w.label.padEnd(5)} ${bar(w.used_pct)}  ${paintc.dim(`resets ${reset}`)}`);
    if (parts.length) lines.push(`           ${parts.join(' ')}`);
  }

  const extraBits = [];
  const extra = result.extra || {};
  if (extra.tokens_24h != null) extraBits.push(`24h ${fmtCount(extra.tokens_24h)} tokens · ${fmtCount(extra.calls_24h)} calls`);
  if (extra.parallel_limit != null) extraBits.push(`parallel ${extra.parallel_used}/${extra.parallel_limit}`);
  if (extra.credits_balance != null && extra.has_credits) extraBits.push(`credits ${extra.credits_balance}`);
  if (extra.models?.length) extraBits.push(paintc.dim(`models: ${extra.models.join(', ')}`));
  if (extraBits.length) lines.push(`     ${paintc.dim('·')} ${extraBits.join(`  ${paintc.dim('·')} `)}`);
  return lines;
}

function renderPretty(results) {
  const names = Object.keys(results);
  const okCount = names.filter((n) => results[n].ok).length;
  console.log('');
  console.log(
    `  ${paintc.bold('Coding Plan Quotas')}  ${paintc.dim(`· ${okCount}/${names.length} providers`)}  ${paintc.dim(`· ${new Date().toLocaleString()}`)}`,
  );
  console.log(`  ${paintc.dim('─'.repeat(56))}`);
  for (const name of names) {
    for (const line of renderProvider(results[name], PROVIDERS[name])) console.log(line);
    console.log('');
  }
}

// ── main ──

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }
  setColor(!args.noColor && process.stdout.isTTY);

  const names = args.providers?.length ? args.providers : Object.keys(PROVIDERS);
  for (const n of names) {
    if (!PROVIDERS[n]) {
      console.error(`unknown provider: ${n} (known: ${Object.keys(PROVIDERS).join(', ')})`);
      return 2;
    }
  }

  const results = await collectAll(names);

  if (args.deskStatus) {
    const wanted = args.deskStatus === '*' ? names : [args.deskStatus];
    if (args.deskStatus !== '*' && !PROVIDERS[args.deskStatus]) {
      console.error(`unknown provider for --desk-status: ${args.deskStatus}`);
      return 2;
    }
    const out = wanted.length === 1 ? deskStatusFor(results[wanted[0]]) : wanted.map((n) => deskStatusFor(results[n]));
    console.log(JSON.stringify(out, null, args.noColor ? 0 : 2));
    return out.error ? 1 : 0;
  }

  if (args.json) {
    console.log(JSON.stringify({ generated_at: Math.floor(Date.now() / 1000), providers: results }, null, 2));
  } else {
    renderPretty(results);
  }

  return names.every((n) => results[n].ok) ? 0 : names.some((n) => results[n].ok) ? 0 : 1;
}

process.exit(await main());
