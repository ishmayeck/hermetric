# claude-usage-exporter

The exact usage percentages from Claude's **Settings → Usage** screen, served as a
small REST API and Prometheus exporter. No headless browser, no cookies, no scraping.

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

Two options; the service checks `CLAUDE_OAUTH_TOKEN` first, then the token file.

### Option A — own token pair with auto-refresh (recommended, fully unattended)

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

### Option B — static long-lived token

`claude setup-token` mints a **one-year** OAuth access token for headless use (access
token only — no refresh token, so no auto-renewal is possible; mint a new one when it
expires). Put it in the environment as `CLAUDE_OAUTH_TOKEN`.

Caveat: the Claude Code docs describe setup-token tokens as limited to model requests,
and it's unverified whether they can hit the usage endpoint. Test with
`node server.mjs check` before relying on it; Option A uses the exact client + scopes
this project was verified with.

## Config

| Env                     | Default            | Notes                        |
|-------------------------|--------------------|------------------------------|
| `PORT`                  | `8080`             |                              |
| `BIND`                  | `0.0.0.0`          |                              |
| `POLL_INTERVAL_SECONDS` | `60`               | min 15; backs off on errors  |
| `CLAUDE_OAUTH_TOKEN`    | –                  | static token mode            |
| `CLAUDE_TOKEN_FILE`     | `/data/token.json` | refresh-token mode           |

## Run

```sh
docker compose up -d --build
curl localhost:8089/usage
```

Prometheus scrape config:

```yaml
- job_name: claude-usage
  static_configs: [{ targets: ["truenas:8089"] }]
```

Local dev without Docker: `CLAUDE_TOKEN_FILE=./token.json node server.mjs` (or
`node server.mjs check` for a one-shot fetch).

## Notes

- The upstream payload is full of in-flight experiment fields (`tangelo`,
  `iguana_necktie`, `cinder_cove`, ...). `/raw` passes everything through, so nothing
  is lost when Anthropic adds windows; `limits[]` is the stable-looking part and is
  what `/usage` and `/metrics` are built from.
- Endpoint discovered 2026-08-26 by watching the usage screen's own traffic; it is
  unofficial and could change without notice.
