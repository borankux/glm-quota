#!/usr/bin/env node

/**
 * OpenAI Codex CLI provider (ChatGPT Plus/Pro plans).
 *
 * Endpoint: GET https://chatgpt.com/backend-api/wham/usage with the OAuth
 * access token from ~/.codex/auth.json. This is the same status call the
 * Codex CLI itself makes every 60s (community-discovered, undocumented).
 *
 * Window semantics have shifted over 2026 (5h suspended in July, reinstated
 * for Plus only in August) — always label windows from
 * limit_window_seconds, never hardcode which comes first.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getJson, toNum } from './util.js';

export const CODEX_PROVIDER = 'codex';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function windowFromSeconds(seconds, usedPercent, resetAt) {
  if (!seconds) return null;
  const kind =
    seconds === 18000 ? '5h' : seconds === 604800 ? 'week' : seconds % 86400 === 0 ? `${seconds / 86400}d` : `${Math.round(seconds / 3600)}h`;
  const used = toNum(usedPercent);
  return {
    kind,
    label: kind,
    used_pct: used,
    remaining_pct: used == null ? null : 100 - used,
    total: null,
    used: null,
    remaining: null,
    resets_at: toNum(resetAt),
  };
}

export async function collectCodex() {
  let auth;
  try {
    auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
  } catch {
    throw new Error('~/.codex/auth.json not readable — run `codex login` first');
  }
  const token = auth?.tokens?.access_token;
  if (!token) throw new Error('no access_token in ~/.codex/auth.json — run `codex login` first');

  let data;
  try {
    data = await getJson(USAGE_URL, { Authorization: `Bearer ${token}` });
  } catch (e) {
    if (/HTTP 401/.test(e.message)) {
      throw new Error('401 from wham/usage — token expired, run `codex` once to refresh auth.json');
    }
    throw e;
  }

  const rl = data.rate_limit || {};
  let windows = [rl.primary_window, rl.secondary_window]
    .map((w) => (w ? windowFromSeconds(w.limit_window_seconds, w.used_percent, w.reset_at) : null))
    .filter(Boolean);

  // Fallback: some plans only expose per-model buckets.
  if (!windows.length && Array.isArray(data.additional_rate_limits)) {
    const first = data.additional_rate_limits.find((l) => l.primary_window || l.secondary_window);
    if (first) {
      windows = [first.primary_window, first.secondary_window]
        .map((w) => (w ? windowFromSeconds(w.limit_window_seconds, w.used_percent, w.reset_at) : null))
        .filter(Boolean);
    }
  }

  if (!windows.length) throw new Error('no rate limit windows in wham/usage response');

  // display order: shortest window first
  windows.sort((a, b) => a.label.localeCompare(b.label));

  const credits = data.credits || {};

  return {
    provider: CODEX_PROVIDER,
    ok: true,
    platform: 'OpenAI',
    plan: data.plan_type || 'unknown',
    windows,
    extra: {
      models: (data.additional_rate_limits || []).map((m) => m.name || m.metered_feature).filter(Boolean),
      credits_balance: credits.balance ?? null,
      has_credits: !!credits.has_credits,
      limit_reached: !!data.limit_reached,
    },
  };
}
