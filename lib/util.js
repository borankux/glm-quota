#!/usr/bin/env node

/**
 * Shared helpers: HTTP, colors, progress bars, formatting.
 * Zero-dependency on purpose — glm-quota ships as a single npm package.
 */

import https from 'https';
import net from 'net';
import tls from 'tls';
import { execSync } from 'child_process';

// ── HTTP ──

// Proxy detection: env first, then macOS system proxy (chatgpt.com is not
// directly reachable from CN networks). Cached after first lookup.
let cachedProxy;
function detectProxy() {
  if (cachedProxy !== undefined) return cachedProxy;
  cachedProxy = null;
  const envUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      cachedProxy = { host: u.hostname, port: Number(u.port) || 443 };
    } catch {
      // ignore malformed env
    }
  }
  if (!cachedProxy && process.platform === 'darwin') {
    try {
      const out = execSync('scutil --proxy', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const enable = /HTTPSEnable\s*:\s*(\d)/.exec(out);
      const host = /HTTPSProxy\s*:\s*([\w.\-]+)/.exec(out);
      const port = /HTTPSPort\s*:\s*(\d+)/.exec(out);
      if (enable?.[1] === '1' && host) {
        cachedProxy = { host: host[1], port: Number(port?.[1]) || 443 };
      }
    } catch {
      // scutil unavailable
    }
  }
  return cachedProxy;
}

// HTTP CONNECT tunnel through a local proxy (clash/mihomo/surge etc.)
function connectViaProxy(proxy, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port }, () => {
      socket.write(`CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n\r\n`);
    });
    let head = '';
    socket.on('data', function onData(chunk) {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      const statusLine = head.split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT failed: ${statusLine}`));
      }
      const tlsSock = tls.connect({ socket, servername: destHost }, () => resolve(tlsSock));
      tlsSock.once('error', reject);
    });
    socket.once('error', reject);
  });
}

function isNetworkError(err) {
  const code = err?.code || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ||
    /timeout after/i.test(err?.message || '');
}

function httpRequest(u, { method, headers, body, timeout }, createConnection) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        createConnection,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function request(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  const u = new URL(url);
  const opts = { method, headers, body, timeout };
  try {
    return await httpRequest(u, opts);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    const proxy = detectProxy();
    if (!proxy) {
      err.message = err.message || err.code || 'connect failed';
      throw err;
    }
    // direct route blocked — retry once through the local proxy
    const socket = await connectViaProxy(proxy, u.hostname, Number(u.port) || 443);
    return httpRequest(u, opts, () => socket);
  }
}

export async function getJson(url, headers = {}) {
  const res = await request(url, { headers });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
}

// ── Color state (respects --no-color / non-TTY) ──

let colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

export function setColor(enabled) {
  colorEnabled = enabled;
}

export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(code, text) {
  return colorEnabled ? `${code}${text}${c.reset}` : text;
}

export const paintc = {
  bold: (t) => paint(c.bold, t),
  dim: (t) => paint(c.dim, t),
  red: (t) => paint(c.red, t),
  green: (t) => paint(c.green, t),
  yellow: (t) => paint(c.yellow, t),
  cyan: (t) => paint(c.cyan, t),
  magenta: (t) => paint(c.magenta, t),
};

// ── Progress bar (truecolor, falls back gracefully) ──

const bg = (r, g, b) => (colorEnabled ? `\x1b[48;2;${r};${g};${b}m` : '');

export function bar(percentage, width = 32) {
  const pct = Math.max(0, Math.min(100, Math.round(percentage ?? 0)));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;

  let rgb;
  if (pct >= 90) rgb = { r: 239, g: 68, b: 68 };      // red
  else if (pct >= 70) rgb = { r: 245, g: 158, b: 11 }; // amber
  else if (pct >= 40) rgb = { r: 234, g: 179, b: 8 };  // yellow
  else rgb = { r: 34, g: 197, b: 94 };                 // green

  const pctText = `${String(pct).padStart(3)}%`;
  const pctColored = pct >= 90 ? paintc.red(pctText) : pct >= 70 ? paintc.yellow(pctText) : paintc.green(pctText);
  const filledBar = bg(rgb.r, rgb.g, rgb.b) + ' '.repeat(filled) + (colorEnabled ? c.reset : '');
  const emptyBar = bg(40, 40, 40) + ' '.repeat(empty) + (colorEnabled ? c.reset : '');
  return `${filledBar}${emptyBar} ${pctColored}`;
}

// ── Formatting ──

export function fmtCount(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

export function countdown(epochSeconds, now = Date.now() / 1000) {
  if (!epochSeconds) return 'unknown';
  const delta = epochSeconds - now;
  if (delta <= 0) return 'now';
  const days = Math.floor(delta / 86400);
  const hours = Math.floor((delta % 86400) / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function isoToEpoch(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
