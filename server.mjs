#!/usr/bin/env node
// hermetric — exposes the Claude "Usage" screen numbers as REST + Prometheus.
//
// Data source: GET https://api.anthropic.com/api/oauth/usage — the same payload the
// claude.ai settings/usage screen renders (session %, weekly %, per-model weekly %),
// authenticated with a Claude Code-style OAuth bearer token.
//
// Commands:
//   node server.mjs           serve (default)
//   node server.mjs login     one-time interactive PKCE login, writes the token file
//   node server.mjs check     single fetch, print simplified JSON, exit

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline/promises';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Token/callback hosts follow what the current Claude Code binary uses; the old
// console.anthropic.com token URL 404s for claude-cli user agents.
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const SCOPES = 'org:create_api_key user:profile user:inference';
const BETA_HEADER = 'oauth-2025-04-20';
// The usage endpoint aggressively rate-limits clients it doesn't recognize
// (429, retry-after: 0, sometimes sticky) — see README. Present the official
// CLI's UA shape there by default; override with UPSTREAM_USER_AGENT. The OAuth
// endpoints get a plain UA — they route differently for claude-cli agents.
const USAGE_USER_AGENT = process.env.UPSTREAM_USER_AGENT ?? 'claude-cli/2.1.251 (external, cli)';
const OAUTH_USER_AGENT = 'hermetric/0.1';

const cfg = {
  port: Number(process.env.PORT ?? 8080),
  bind: process.env.BIND ?? '0.0.0.0',
  pollSeconds: Math.max(15, Number(process.env.POLL_INTERVAL_SECONDS ?? 180)),
  staticToken: process.env.CLAUDE_OAUTH_TOKEN || null,
  tokenFile: process.env.CLAUDE_TOKEN_FILE ?? '/data/token.json',
};

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

function loadTokenFile() {
  try {
    return JSON.parse(readFileSync(cfg.tokenFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokenFile(tok) {
  mkdirSync(dirname(cfg.tokenFile), { recursive: true });
  const tmp = cfg.tokenFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(tok, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, cfg.tokenFile);
}

let refreshInFlight = null;

async function refreshToken(tok) {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': OAUTH_USER_AGENT },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: tok.refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status} ${await res.text()}`);
      const body = await res.json();
      const next = {
        ...tok,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? tok.refreshToken,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        refreshedAt: new Date().toISOString(),
      };
      saveTokenFile(next);
      console.log(`[token] refreshed, expires ${new Date(next.expiresAt).toISOString()}`);
      return next;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function getAccessToken({ forceRefresh = false } = {}) {
  if (cfg.staticToken) return cfg.staticToken;
  let tok = loadTokenFile();
  if (!tok?.accessToken) {
    throw new Error(
      `no credentials: set CLAUDE_OAUTH_TOKEN or run \`login\` to create ${cfg.tokenFile}`,
    );
  }
  const nearExpiry = tok.expiresAt && Date.now() > tok.expiresAt - 120_000;
  if ((forceRefresh || nearExpiry) && tok.refreshToken) tok = await refreshToken(tok);
  return tok.accessToken;
}

// ---------------------------------------------------------------------------
// Usage fetching
// ---------------------------------------------------------------------------

const state = {
  raw: null,
  fetchedAt: 0, // ms epoch of last success
  errorsTotal: 0,
  lastError: null,
  backoffUntil: 0,
};

async function fetchUsageOnce({ retryAuth = true } = {}) {
  const token = await getAccessToken();
  const res = await fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': BETA_HEADER,
      accept: 'application/json',
      'user-agent': USAGE_USER_AGENT,
    },
  });
  if ((res.status === 401 || res.status === 403) && retryAuth && !cfg.staticToken) {
    // Access token may have been revoked/expired early; refresh and retry once.
    await getAccessToken({ forceRefresh: true });
    return fetchUsageOnce({ retryAuth: false });
  }
  if (!res.ok) {
    const err = new Error(`usage fetch failed: HTTP ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function poll() {
  if (Date.now() < state.backoffUntil) return;
  try {
    state.raw = await fetchUsageOnce();
    state.fetchedAt = Date.now();
    trackWindows(normalizedLimits(state.raw));
    state.lastError = null;
    state.backoffUntil = 0;
  } catch (err) {
    state.errorsTotal += 1;
    state.lastError = String(err.message ?? err);
    // The endpoint's 429s come with retry-after: 0 and can be sticky, so cool
    // off hard on rate limiting; other failures back off more gently.
    const cooloffMs = err.status === 429 ? 900_000 : Math.min(600_000, cfg.pollSeconds * 1000 * 2);
    state.backoffUntil = Date.now() + cooloffMs;
    console.error(`[poll] ${state.lastError}`);
  }
}

// ---------------------------------------------------------------------------
// Session windows
// ---------------------------------------------------------------------------
// Claude's 5-hour session limit runs in windows that start on first use, so
// they don't sit on any clock grid. Prometheus can't group one gauge by
// another gauge's value, and Grafana can't invent bars for idle time, so the
// exporter keeps the ledger itself: peak utilization per window keyed by the
// window's start, plus synthetic 0% windows for every completed idle 5-hour
// stretch, so a "% used per 5-hour window" chart has exactly one bar per period.
const WINDOW_MS = 5 * 3600 * 1000;
const WINDOWS_KEEP = Number(process.env.WINDOWS_KEEP ?? 400);
const windowsFile = process.env.CLAUDE_WINDOWS_FILE ?? join(dirname(cfg.tokenFile), 'windows.json');
const windows = loadWindows(); // Map<startMs, { peak, synthetic? }>

function loadWindows() {
  try {
    const obj = JSON.parse(readFileSync(windowsFile, 'utf8'));
    return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
  } catch {
    return new Map();
  }
}

function saveWindows() {
  const keep = [...windows.keys()].sort((a, b) => a - b).slice(-WINDOWS_KEEP);
  for (const k of windows.keys()) if (!keep.includes(k)) windows.delete(k);
  const obj = Object.fromEntries(keep.map((k) => [k, windows.get(k)]));
  try {
    mkdirSync(dirname(windowsFile), { recursive: true });
    const tmp = `${windowsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj) + '\n');
    renameSync(tmp, windowsFile);
  } catch (err) {
    console.error(`[windows] cannot persist ${windowsFile}: ${err.message}`);
  }
}

// Fill completed idle 5-hour periods between the last known window's end and `until`.
function fillIdleWindows(until) {
  if (windows.size === 0) return;
  let t = Math.max(...windows.keys()) + WINDOW_MS;
  while (t + WINDOW_MS <= until) {
    if (!windows.has(t)) windows.set(t, { peak: 0, synthetic: true });
    t += WINDOW_MS;
  }
}

function trackWindows(limits) {
  const session = limits.find((l) => l.limit === 'session');
  if (session?.resetsAt) {
    // The upstream reset stamp jitters by a second either side of a minute boundary.
    const resetMs = Math.round(Date.parse(session.resetsAt) / 60_000) * 60_000;
    const start = resetMs - WINDOW_MS;
    fillIdleWindows(start);
    const w = windows.get(start) ?? { peak: 0 };
    w.peak = Math.max(w.peak, session.percent ?? 0);
    delete w.synthetic;
    windows.set(start, w);
  } else {
    fillIdleWindows(Date.now());
  }
  saveWindows();
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

// Normalize the upstream payload's limits into one flat list:
// {limit: "session"|"weekly_all"|"weekly_model", model?, surface?, percent, resetsAt, isActive, severity}
function normalizedLimits(raw) {
  const out = [];
  for (const l of raw?.limits ?? []) {
    const entry = {
      limit: l.kind === 'weekly_scoped' ? 'weekly_model' : l.kind,
      percent: l.percent,
      resetsAt: l.resets_at ?? null,
      isActive: Boolean(l.is_active),
      severity: l.severity ?? null,
    };
    if (l.scope?.model?.display_name) entry.model = l.scope.model.display_name;
    if (l.scope?.surface) entry.surface = l.scope.surface;
    out.push(entry);
  }
  if (out.length === 0) {
    // Fallback if the limits[] array ever disappears from the payload.
    if (raw?.five_hour?.utilization != null)
      out.push({ limit: 'session', percent: raw.five_hour.utilization, resetsAt: raw.five_hour.resets_at, isActive: false, severity: null });
    if (raw?.seven_day?.utilization != null)
      out.push({ limit: 'weekly_all', percent: raw.seven_day.utilization, resetsAt: raw.seven_day.resets_at, isActive: false, severity: null });
  }
  return out;
}

function simplified(raw) {
  const limits = normalizedLimits(raw);
  const spend = raw?.spend ?? null;
  const money = (m) => (m ? m.amount_minor / 10 ** m.exponent : null);
  return {
    updated_at: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
    session: limits.find((l) => l.limit === 'session') ?? null,
    weekly: limits.find((l) => l.limit === 'weekly_all') ?? null,
    weekly_models: limits.filter((l) => l.limit === 'weekly_model'),
    extra_usage: spend
      ? {
          enabled: Boolean(spend.enabled),
          percent: spend.percent ?? null,
          used_dollars: money(spend.used),
          limit_dollars: money(spend.limit),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Prometheus
// ---------------------------------------------------------------------------

function promEscape(v) {
  return String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labels(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}="${promEscape(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function renderMetrics() {
  const lines = [];
  const push = (name, help, type, samples) => {
    if (samples.length === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [lab, val] of samples) lines.push(`${name}${labels(lab)} ${val}`);
  };

  const lims = state.raw ? normalizedLimits(state.raw) : [];
  const lab = (l) => ({ limit: l.limit, model: l.model, surface: l.surface });

  push('claude_usage_percent', 'Utilization percent (0-100) of a Claude plan limit, as shown on the claude.ai usage screen', 'gauge',
    lims.filter((l) => l.percent != null).map((l) => [lab(l), l.percent]));
  push('claude_usage_resets_at_seconds', 'Unix time when this limit window resets', 'gauge',
    lims.filter((l) => l.resetsAt).map((l) => [lab(l), Math.floor(Date.parse(l.resetsAt) / 1000)]));
  push('claude_usage_limit_active', 'Whether this limit is currently the binding one (1/0)', 'gauge',
    lims.map((l) => [lab(l), l.isActive ? 1 : 0]));

  const windowRows = [...windows.entries()].sort((a, b) => a[0] - b[0]);
  push('claude_session_window_peak_percent', 'Peak session utilization (0-100) reached in each 5-hour window, keyed by window start; idle 5-hour stretches appear as 0', 'gauge',
    windowRows.map(([start, w]) => [{ window_start: Math.floor(start / 1000) }, w.peak]));
  push('claude_session_window_start_seconds', 'Unix time the window started (same value as its window_start label, for range filtering in queries)', 'gauge',
    windowRows.map(([start]) => [{ window_start: Math.floor(start / 1000) }, Math.floor(start / 1000)]));

  // Spend and cap are independent upstream: a seat can have extra-usage spend
  // with no monthly cap configured (limit: null). Export what exists rather
  // than requiring both, otherwise an uncapped seat's real spend vanishes and
  // dashboards read the absence as $0.
  const spend = state.raw?.spend;
  const money = (m) => m.amount_minor / 10 ** m.exponent;
  if (spend?.used) {
    push('claude_usage_credits_used_dollars', 'Extra-usage credits spent this month', 'gauge', [[{}, money(spend.used)]]);
  }
  if (spend?.limit) {
    push('claude_usage_credits_limit_dollars', 'Extra-usage credits monthly cap', 'gauge', [[{}, money(spend.limit)]]);
    push('claude_usage_credits_percent', 'Extra-usage credits utilization percent', 'gauge', [[{}, spend.percent ?? 0]]);
  }

  push('claude_usage_fetch_success_timestamp_seconds', 'Unix time of last successful upstream fetch', 'gauge',
    state.fetchedAt ? [[{}, Math.floor(state.fetchedAt / 1000)]] : []);
  push('claude_usage_fetch_errors_total', 'Count of failed upstream fetches since start', 'counter', [[{}, state.errorsTotal]]);
  push('claude_usage_up', 'Whether the last upstream fetch attempt succeeded (1/0)', 'gauge',
    [[{}, state.raw && !state.lastError ? 1 : 0]]);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function isStale() {
  const maxAge = Math.max(3 * cfg.pollSeconds, 300) * 1000;
  return !state.fetchedAt || Date.now() - state.fetchedAt > maxAge;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2) + '\n');
  };

  try {
    if (url.pathname === '/usage' || url.pathname === '/raw') {
      if (url.searchParams.has('fresh') || !state.raw) await poll();
      if (!state.raw) return json(503, { error: 'no data yet', last_error: state.lastError });
      const body = url.pathname === '/raw' ? state.raw : simplified(state.raw);
      return json(200, { ...body, stale: isStale() || undefined });
    }
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      return res.end(renderMetrics());
    }
    if (url.pathname === '/healthz') {
      return json(isStale() ? 503 : 200, {
        ok: !isStale(),
        last_success: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
        last_error: state.lastError,
      });
    }
    if (url.pathname === '/') {
      return json(200, { service: 'hermetric', endpoints: ['/usage', '/raw', '/metrics', '/healthz'] });
    }
    json(404, { error: 'not found' });
  } catch (err) {
    json(500, { error: String(err.message ?? err) });
  }
}

// ---------------------------------------------------------------------------
// Interactive login (PKCE) — run once, writes the token file
// ---------------------------------------------------------------------------

async function login() {
  const b64url = (buf) => buf.toString('base64url');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authState = b64url(crypto.randomBytes(32));

  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', authState);

  console.log('\nOpen this URL in a browser where you are logged into claude.ai:\n');
  console.log(u.toString());
  console.log('\nApprove, then paste the code shown on the callback page below.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question('\nCode: ')).trim();
  rl.close();

  const [code, returnedState] = pasted.split('#');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': OAUTH_USER_AGENT },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: returnedState ?? authState,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  saveTokenFile({
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scopes: body.scope?.split(' ') ?? SCOPES.split(' '),
    createdAt: new Date().toISOString(),
  });
  console.log(`\nSaved ${cfg.tokenFile}. Verifying...`);
  const raw = await fetchUsageOnce({ retryAuth: false });
  console.log(JSON.stringify(simplified({ ...raw }), null, 2));
  console.log('\nLogin OK.');
}

// ---------------------------------------------------------------------------

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'login') {
  await login();
} else if (cmd === 'check') {
  state.raw = await fetchUsageOnce();
  state.fetchedAt = Date.now();
  console.log(JSON.stringify(simplified(state.raw), null, 2));
} else {
  await poll();
  setInterval(poll, cfg.pollSeconds * 1000);
  http.createServer(handler).listen(cfg.port, cfg.bind, () => {
    console.log(`hermetric listening on ${cfg.bind}:${cfg.port}, polling every ${cfg.pollSeconds}s`);
    if (state.lastError) console.error(`[startup] first fetch failed: ${state.lastError}`);
  });
}
