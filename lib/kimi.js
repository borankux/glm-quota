#!/usr/bin/env node

/**
 * Kimi Code (Moonshot AI) provider — Kimi for Coding subscription.
 *
 * Endpoint: GET https://api.kimi.com/coding/v1/usages (official, used by the
 * kimi CLI itself). Two payload shapes seen in the wild:
 *   - legacy: `limits[]` rolling windows + top-level `usage` weekly window,
 *     percentage strings
 *   - 2026-09: `usages` map with used_ratio floats — limit_5h, and the two
 *     monthly gates limit_month_code / limit_month_total (全额度: when the
 *     total gate is exhausted, every other window is unusable even if it
 *     still shows remaining)
 *
 * Auth: ~/.kimi-code/credentials/kimi-code.json holds a short-lived (15min)
 * access token; refresh via auth.kimi.com and write the rotated tokens back.
 * Set KIMI_API_KEY (sk-kimi-... console key) to skip token management entirely.
 */

import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { request, isoToEpoch, toNum } from './util.js';

export const KIMI_PROVIDER = 'kimi';

const CREDS_PATH = join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
const USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const REFRESH_URL = 'https://auth.kimi.com/api/oauth/token';
// Community-discovered public client_id of the kimi CLI (tokscale/kimi-code-usage).
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

function tokenUsable(creds) {
  if (!creds?.access_token) return false;
  const expiresAt = toNum(creds.expires_at);
  if (!expiresAt) return true; // unknown expiry — try and fall back to refresh on 401
  const skew = 60; // refresh a minute early
  return expiresAt > Date.now() / 1000 + skew;
}

async function refreshToken(creds) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token || '',
    client_id: CLIENT_ID,
  }).toString();
  const res = await request(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`token refresh failed (HTTP ${res.status}) — run \`kimi\` once to re-login`);
  }
  const next = JSON.parse(res.text);
  const updated = {
    ...creds,
    access_token: next.access_token || creds.access_token,
    refresh_token: next.refresh_token || creds.refresh_token,
    expires_at: toNum(next.expires_at) ?? Math.floor(Date.now() / 1000) + (toNum(next.expires_in) ?? 900),
    expires_in: toNum(next.expires_in) ?? creds.expires_in,
  };
  try {
    writeFileSync(CREDS_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch {
    // read-only creds file: keep working with in-memory token
  }
  return updated.access_token;
}

async function fetchUsage(bearer) {
  const res = await request(USAGE_URL, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
  });
  return { status: res.status, text: res.text };
}

function prettyLevel(level) {
  if (!level) return 'unknown';
  return String(level)
    .replace(/^LEVEL_/, '')
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_, s, ch) => (s ? ' ' : '') + ch.toUpperCase());
}

export async function collectKimi() {
  let bearer = process.env.KIMI_API_KEY || '';
  let creds = null;

  if (!bearer) {
    try {
      creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    } catch {
      throw new Error('~/.kimi-code/credentials/kimi-code.json not readable — run `kimi` once, or set KIMI_API_KEY');
    }
    if (!tokenUsable(creds)) {
      creds = { ...creds, access_token: await refreshToken(creds) };
    }
    bearer = creds.access_token;
  }

  let res = await fetchUsage(bearer);
  if (res.status === 401 && creds) {
    // token raced to expiry — refresh once and retry
    creds = { ...creds, access_token: await refreshToken(creds) };
    bearer = creds.access_token;
    res = await fetchUsage(bearer);
  }
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} from api.kimi.com/coding/v1/usages`);
  }

  const data = JSON.parse(res.text);
  const windows = [];

  // 2026-09 shape: `usages` map with used_ratio floats
  const usages = data.usages || {};
  const USAGE_KINDS = {
    limit_5h: { kind: '5h', label: '5h' },
    limit_month_code: { kind: 'month', label: 'month' },
    limit_month_total: { kind: 'month_total', label: 'TOTAL' },
  };
  for (const [key, meta] of Object.entries(USAGE_KINDS)) {
    const u = usages[key];
    const ratio = toNum(u?.used_ratio);
    if (u == null || ratio == null) continue;
    const used = Math.round(ratio * 100);
    windows.push({
      kind: meta.kind,
      label: meta.label,
      used_pct: used,
      remaining_pct: 100 - used,
      total: null, // ratios only — the API does not expose absolute amounts
      used: null,
      remaining: null,
      resets_at: isoToEpoch(u.reset_time),
    });
  }

  // legacy shape: rolling windows; duration=300 TIME_UNIT_MINUTE is the 5h one
  for (const l of data.limits || []) {
    const w = l.window || {};
    const minutes = toNum(w.duration) * (/TIME_UNIT_HOUR/.test(w.timeUnit || '') ? 60 : 1);
    if (!minutes) continue;
    const kind = minutes === 300 ? '5h' : minutes === 10080 ? 'week' : minutes % 1440 === 0 ? `${minutes / 1440}d` : `${minutes}m`;
    if (windows.some((x) => x.kind === kind)) continue; // `usages` map already covered it
    const d = l.detail || {};
    const used = toNum(d.used);
    windows.push({
      kind,
      label: minutes === 300 ? '5h' : minutes === 10080 ? 'week' : `${minutes}m`,
      used_pct: used,
      remaining_pct: used == null ? null : 100 - used,
      total: toNum(d.limit),
      used,
      remaining: toNum(d.remaining),
      resets_at: isoToEpoch(d.resetTime),
    });
  }

  // top-level `usage` is the weekly window
  const weekly = data.usage;
  if (weekly && (weekly.limit != null || weekly.used != null)) {
    const used = toNum(weekly.used);
    const wk = {
      kind: 'week',
      label: 'week',
      used_pct: used,
      remaining_pct: used == null ? null : 100 - used,
      total: toNum(weekly.limit),
      used,
      remaining: toNum(weekly.remaining),
      resets_at: isoToEpoch(weekly.resetTime),
    };
    if (!windows.some((w) => w.kind === 'week')) windows.push(wk);
    else if (!windows.some((w) => w.kind === 'week' && w.used_pct != null)) Object.assign(windows.find((w) => w.kind === 'week'), wk);
  }

  if (!windows.length) throw new Error('no usage windows in response');

  windows.sort((a, b) => (a.kind === '5h' ? -1 : b.kind === '5h' ? 1 : 0));

  const parallel = data.parallel || {};
  const booster = data.booster_wallet || data.boosterWallet || {};

  return {
    provider: KIMI_PROVIDER,
    ok: true,
    platform: 'Moonshot AI',
    plan: prettyLevel(data.user?.membership?.level),
    windows,
    extra: {
      parallel_used: (parallel.details || []).length,
      parallel_limit: toNum(parallel.limit),
      booster_balance: booster.balance?.amount ?? null,
    },
  };
}
