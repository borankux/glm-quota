#!/usr/bin/env node

/**
 * GLM Coding Plan (Zhipu 智谱 / Z.ai) provider.
 *
 * Auth: ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (env, or ~/.claude/settings.json
 * when Claude Code is routed through GLM). The quota endpoint is derived from the
 * base URL origin, so domestic (open.bigmodel.cn) and international (api.z.ai)
 * both work.
 *
 * 2026-07-30: Zhipu launched V3 credit-based plans — limits come back with
 * type=CREDIT_LIMIT instead of TOKENS_LIMIT/TIME_LIMIT. We dispatch on
 * unit/number when present (unit=3,number=5 → 5h window; unit=6,number=1 →
 * weekly) and fall back to type strings for grandfathered V2 plans.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getJson, toNum } from './util.js';

export const GLM_PROVIDER = 'glm';

function loadConfig() {
  let env = {};
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    env = settings.env || {};
  } catch {
    // settings.json optional
  }
  return {
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || '',
    baseUrl: process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || '',
  };
}

// V3: usage=window credit pool, currentValue=used, remaining=left, percentage=used%
// V2 TIME_LIMIT: totol/usage=total, currentUsage/currentValue=used
function mapLimit(l) {
  const unit = toNum(l.unit);
  const number = toNum(l.number);
  let kind = null;
  if (unit === 3 && number === 5) kind = '5h';
  else if (unit === 6 && number === 1) kind = 'week';
  else if (l.type === 'TIME_LIMIT' || /MCP/i.test(l.type || '')) kind = 'month';
  else if (l.type === 'TOKENS_LIMIT' || /5\s*Hour/i.test(l.type || '')) kind = '5h';
  else if (kind === null && l.type === 'CREDIT_LIMIT') kind = '5h'; // unknown credit bucket
  if (!kind) return null;

  const total = toNum(l.usage) ?? toNum(l.totol);
  const used = toNum(l.currentValue) ?? toNum(l.currentUsage);
  const remaining = toNum(l.remaining);
  const usedPct = toNum(l.percentage);
  const resetsAt = l.nextResetTime ? Math.floor(toNum(l.nextResetTime) / 1000) : null;

  return {
    kind,
    label: kind,
    used_pct: usedPct,
    remaining_pct: usedPct == null ? null : 100 - usedPct,
    total,
    used,
    remaining,
    resets_at: resetsAt,
  };
}

export async function collectGlm() {
  const { authToken, baseUrl } = loadConfig();
  if (!authToken) throw new Error('no ANTHROPIC_AUTH_TOKEN (env or ~/.claude/settings.json)');
  if (!baseUrl) throw new Error('no ANTHROPIC_BASE_URL (env or ~/.claude/settings.json)');

  const origin = new URL(baseUrl).origin;
  const headers = {
    Authorization: authToken,
    'Accept-Language': 'en-US,en',
    'Content-Type': 'application/json',
  };

  const quota = await getJson(`${origin}/api/monitor/usage/quota/limit`, headers);
  const data = quota.data || quota;

  const windows = (data.limits || [])
    .map(mapLimit)
    .filter(Boolean)
    // display order: shortest window first
    .sort((a, b) => (a.kind === '5h' ? -1 : b.kind === '5h' ? 1 : 0));

  if (!windows.length) {
    throw new Error(`no recognizable limits in response: ${JSON.stringify(data.limits || data).slice(0, 200)}`);
  }

  // Optional context: model usage over the last ~24h (endpoint survived V3).
  let extra = null;
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const usage = await getJson(
      `${origin}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`,
      headers,
    );
    const totalUsage = usage?.data?.totalUsage || usage?.totalUsage;
    if (totalUsage) {
      extra = {
        tokens_24h: toNum(totalUsage.totalTokensUsage),
        calls_24h: toNum(totalUsage.totalModelCallCount),
        models: (usage?.data?.modelSummaryList || usage?.modelSummaryList || [])
          .map((m) => (typeof m === 'string' ? m : m.modelCode || m.code || m.model))
          .filter(Boolean),
      };
    }
  } catch {
    // model-usage is decorative; quota windows are the point
  }

  return {
    provider: GLM_PROVIDER,
    ok: true,
    platform: baseUrl.includes('api.z.ai') ? 'Z.ai' : 'Zhipu (智谱)',
    plan: data.level || 'unknown',
    windows,
    extra,
  };
}
