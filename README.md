# hermetric

The exact usage percentages from Claude's **Settings → Usage** screen, served as a
small REST API and Prometheus exporter. No headless browser, no cookies, no scraping.

*Hermes — god of messengers, boundary-crossings, and thieves — plus metrics: numbers
gleaned through a not-entirely-official channel, delivered hermetically sealed.*

## How it works

The claude.ai usage screen is just a poller over
`GET https://claude.ai/api/organizations/{org}/usage` (no WebSocket). The same
payload — including the `limits[]` array with session %, weekly-all %, and per-model
weekly % — is available from:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer sk-ant-oat01-...
anthropic-beta: oauth-2025-04-20
```

which accepts **Claude Code OAuth tokens** and is not behind the Cloudflare bot wall
(claude.ai itself challenges non-browser clients). So this service just polls that
endpoint on an interval and caches the result.

## Endpoints

| Path       | What                                                                 |
|------------|----------------------------------------------------------------------|
| `/usage`   | Simplified JSON: session, weekly, per-model weekly, extra-usage $    |
| `/raw`     | The upstream payload verbatim                                        |
| `/metrics` | Prometheus text format                                               |
| `/healthz` | 200 while data is fresh, 503 when stale                              |

Add `?fresh=1` to `/usage` or `/raw` to force an immediate upstream fetch.

`/usage` looks like:

```json
{
  "updated_at": "2026-08-26T18:25:00.000Z",
  "session":  { "limit": "session",    "percent": 3,  "resetsAt": "...", "isActive": false, "severity": "normal" },
  "weekly":   { "limit": "weekly_all", "percent": 7,  "resetsAt": "...", "isActive": false, "severity": "normal" },
  "weekly_models": [
    { "limit": "weekly_model", "model": "Fable", "percent": 11, "resetsAt": "...", "isActive": true, "severity": "normal" }
  ],
  "extra_usage": { "enabled": true, "percent": 0, "used_dollars": 0, "limit_dollars": 100 }
}
```

Prometheus series: `claude_usage_percent{limit="session"|"weekly_all"|"weekly_model",model=...}`,
`claude_usage_resets_at_seconds`, `claude_usage_limit_active`, `claude_usage_credits_*`,
plus `claude_usage_up` / `claude_usage_fetch_*` scrape health.

## Auth

The supported path is the built-in interactive login. (The service checks
`CLAUDE_OAUTH_TOKEN` first, then the token file.)

### Interactive login — own token pair with auto-refresh

One-time interactive login (PKCE, same OAuth client Claude Code uses). Run it inside
the container so the token lands on the `/data` volume:

```sh
./login.sh                          # local
DOCKER_CONTEXT=truenas ./login.sh   # deployed instance
```

Open the printed URL in a browser where you're logged into claude.ai, approve, paste
the code back. The script restarts the service afterwards if it's running. The service then refreshes the access token itself (~8 h lifetime)
using the refresh token, and persists rotations to `/data/token.json`.

**Do not** seed `/data/token.json` from `~/.claude/.credentials.json`: refresh tokens
rotate, and two clients sharing one would log each other out. The whole point of
`login` is giving the container its own independent pair.

### Static token (`CLAUDE_OAUTH_TOKEN`) — testing only

Accepts any working bearer token, with no refresh logic. Note that `claude
setup-token` tokens **do not work** here: they're scoped to model requests only and
the usage endpoint rejects them (tried 2026-08-26). This mode is mainly useful for
quick tests with the short-lived access token from an existing Claude Code login.

## Config

| Env                     | Default            | Notes                        |
|-------------------------|--------------------|------------------------------|
| `PORT`                  | `8080`             |                              |
| `BIND`                  | `0.0.0.0`          |                              |
| `POLL_INTERVAL_SECONDS` | `180`              | min 15; backs off on errors  |
| `CLAUDE_OAUTH_TOKEN`    | –                  | static token mode (testing)  |
| `CLAUDE_TOKEN_FILE`     | `/data/token.json` | refresh-token mode           |
| `UPSTREAM_USER_AGENT`   | `claude-cli/...`   | UA sent to the usage endpoint |

## Run

```sh
docker compose up -d --build
curl localhost:8089/usage
```

Prometheus scrape config:

```yaml
- job_name: hermetric
  static_configs: [{ targets: ["truenas:8089"] }]
```

Local dev without Docker: `CLAUDE_TOKEN_FILE=./token.json node server.mjs` (or
`node server.mjs check` for a one-shot fetch).

## Grafana dashboard

`grafana/claude-usage.json` is a ready-made dashboard for these metrics:
gauges for the session / weekly / per-model weekly limits with reset
countdowns, which limit is currently binding, extra-usage spend, exporter
freshness, and utilization over time. Import it via **Dashboards → Import**
and pick the Prometheus datasource that scrapes hermetric when prompted.

## Notes

- The upstream payload is full of in-flight experiment fields (`tangelo`,
  `iguana_necktie`, `cinder_cove`, ...). `/raw` passes everything through, so nothing
  is lost when Anthropic adds windows; `limits[]` is the stable-looking part and is
  what `/usage` and `/metrics` are built from.
- The endpoint is unofficial (rediscovered here by watching the usage screen's own
  traffic; a number of community widgets and statuslines use it too) and could change
  without notice.
- **Rate limiting**: the endpoint 429s aggressively for clients it doesn't recognize —
  with `retry-after: 0` and sometimes a sticky blocked state (see
  anthropics/claude-code#30930, #31021, #31637). Hence the defaults: the official
  CLI's User-Agent shape, a 3-minute poll, and a 15-minute cool-off after any 429.
  Resist the urge to poll faster; the numbers barely move minute-to-minute anyway.

### Session windows

Claude's 5-hour session windows start on first use, so they sit on no clock grid,
and Prometheus can't group a gauge by another gauge's value. hermetric therefore
keeps a small ledger (`/data/windows.json`, next to the token): the peak session
utilization per window keyed by the window's start (reset stamp rounded to the
minute minus 5 h), plus synthetic 0% entries for every completed idle 5-hour
stretch. Exported as:

- `claude_session_window_peak_percent{window_start="<unix>"}` — peak % in that window
- `claude_session_window_start_seconds{window_start="<unix>"}` — the start as a value, for range filtering

Keeps the last `WINDOWS_KEEP` (default 400) windows. `tools/backfill-windows.py <prometheus-url> [days]`
rebuilds the ledger from scraped `claude_usage_*` history (write its output to `/data/windows.json`
before starting the exporter).
