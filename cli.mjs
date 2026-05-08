#!/usr/bin/env node

/**
 * GLM Coding Plan Quota Checker
 * Uses ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL to query quota limits
 * and displays beautified progress bars.
 */

import https from 'https';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Read from Claude Code settings.json, fall back to env vars
function loadConfig() {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw);
    const env = settings.env || {};
    return {
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || '',
    };
  } catch {
    return {
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL || '',
    };
  }
}

const { baseUrl, authToken } = loadConfig();

if (!authToken) {
  console.error('\n  \x1b[31mError:\x1b[0m No API token found');
  console.error('  Set ANTHROPIC_AUTH_TOKEN env or configure in ~/.claude/settings.json\n');
  process.exit(1);
}
if (!baseUrl) {
  console.error('\n  \x1b[31mError:\x1b[0m No base URL found');
  console.error('  Set ANTHROPIC_BASE_URL env or configure in ~/.claude/settings.json\n');
  process.exit(1);
}

const parsedBaseUrl = new URL(baseUrl);
const baseDomain = `${parsedBaseUrl.protocol}//${parsedBaseUrl.host}`;

// ── Color helpers ──
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bg: (r, g, b) => `\x1b[48;2;${r};${g};${b}m`,
  fg: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
};

// ── Progress bar renderer ──
function bar(percentage, width = 30) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;

  let color;
  if (percentage >= 90) color = { r: 239, g: 68, b: 68 };      // red
  else if (percentage >= 70) color = { r: 245, g: 158, b: 11 }; // amber
  else if (percentage >= 40) color = { r: 234, g: 179, b: 8 };  // yellow
  else color = { r: 34, g: 197, b: 94 };                        // green

  const filledBar = c.bg(color.r, color.g, color.b) + ' '.repeat(filled) + c.reset;
  const emptyBar = c.dim + c.bg(40, 40, 40) + ' '.repeat(empty) + c.reset;
  const pctColor = percentage >= 90 ? c.red : percentage >= 70 ? c.yellow : c.green;

  return `${filledBar}${emptyBar} ${pctColor}${String(percentage).padStart(3)}%${c.reset}`;
}

// ── Fetch quota limit ──
function fetchQuota() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseDomain}/api/monitor/usage/quota/limit`);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': authToken,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const json = JSON.parse(data);
          resolve(json.data || json);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Fetch model usage (last 5h summary) ──
function fetchModelUsage() {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);

    const fmt = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const qs = `?startTime=${encodeURIComponent(fmt(startDate))}&endTime=${encodeURIComponent(fmt(endDate))}`;
    const url = new URL(`${baseDomain}/api/monitor/usage/model-usage`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + qs,
      method: 'GET',
      headers: {
        'Authorization': authToken,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data).data || JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Format tokens ──
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── Main ──
async function main() {
  const platform = baseUrl.includes('api.z.ai') ? 'Z.ai' : 'Zhipu (智谱)';

  // Header
  console.log('');
  console.log(`  ${c.cyan}${c.bold}GLM Coding Plan${c.reset}  ${c.dim}·${c.reset}  ${c.dim}${platform}${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(48)}${c.reset}`);

  let quotaData, usageData;
  try {
    [quotaData, usageData] = await Promise.all([fetchQuota(), fetchModelUsage()]);
  } catch (e) {
    console.error(`\n  ${c.red}Request failed:${c.reset} ${e.message}\n`);
    process.exit(1);
  }

  if (!quotaData || !quotaData.limits) {
    console.error(`\n  ${c.red}No quota data returned${c.reset}\n`);
    process.exit(1);
  }

  const level = quotaData.level || 'unknown';
  const levelIcon = level === 'max' ? '👑' : level === 'pro' ? '⭐' : '📦';
  const levelName = level === 'max' ? 'Max' : level === 'pro' ? 'Pro' : level;
  console.log(`  ${levelIcon}  Plan: ${c.bold}${levelName}${c.reset}`);

  // 5h token limit
  const tokensLimit = quotaData.limits.find(l => l.type === 'TOKENS_LIMIT' || l.type === 'Token usage(5 Hour)');
  if (tokensLimit) {
    const pct = tokensLimit.percentage ?? 0;
    console.log('');
    console.log(`  ${c.bold}⏱  Token Usage (5h rolling window)${c.reset}`);
    console.log(`  ${bar(pct, 40)}`);
    if (usageData?.totalUsage) {
      const total = usageData.totalUsage.totalTokensUsage;
      console.log(`  ${c.dim}   ${fmtTokens(total)} tokens used across ${usageData.totalUsage.totalModelCallCount} calls${c.reset}`);
    }
  }

  // Monthly MCP limit
  const timeLimit = quotaData.limits.find(l => l.type === 'TIME_LIMIT' || l.type === 'MCP usage(1 Month)');
  if (timeLimit) {
    const pct = timeLimit.percentage ?? 0;
    const current = timeLimit.currentUsage ?? timeLimit.currentValue ?? 0;
    const total = timeLimit.totol ?? timeLimit.usage ?? 0;

    console.log('');
    console.log(`  ${c.bold}🔧  MCP Usage (monthly)${c.reset}`);
    console.log(`  ${bar(pct, 40)}`);
    console.log(`  ${c.dim}   ${current} / ${total} calls used${c.reset}`);

    if (timeLimit.usageDetails?.length) {
      console.log(`  ${c.dim}   ├─${c.reset}`);
      for (const detail of timeLimit.usageDetails) {
        const name = detail.modelCode || detail.code;
        const usage = detail.usage || detail.count || 0;
        const detailPct = total > 0 ? Math.round((usage / total) * 100) : 0;
        console.log(`  ${c.dim}   ${c.dim}├${c.reset} ${c.cyan}${name.padEnd(16)}${c.reset} ${usage.toString().padStart(5)} calls ${c.dim}(${detailPct}%)${c.reset}`);
      }
    }
  }

  console.log('');
  console.log(`  ${c.dim}${'─'.repeat(48)}${c.reset}`);
  const now = new Date();
  console.log(`  ${c.dim}Updated ${now.toLocaleString()}${c.reset}`);
  console.log('');
}

main();
