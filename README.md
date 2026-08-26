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
- The endpoint is unofficial (rediscovered here by watching the usage screen's own
  traffic; a number of community widgets and statuslines use it too) and could change
  without notice.
- **Rate limiting**: the endpoint 429s aggressively for clients it doesn't recognize —
  with `retry-after: 0` and sometimes a sticky blocked state (see
  anthropics/claude-code#30930, #31021, #31637). Hence the defaults: the official
  CLI's User-Agent shape, a 3-minute poll, and a 15-minute cool-off after any 429.
  Resist the urge to poll faster; the numbers barely move minute-to-minute anyway.
