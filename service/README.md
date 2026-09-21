# WC3 Live Stats Service

A dependency-free Node HTTP service that serves player stats **fetched live from the
running game** — no cache, nothing persisted. Every request connects to the game's
local webui websocket bridge and asks it for the profile right then.

## Run

```bat
node live-server.js [--port 8080] [--bridge-json bridge.json] [--find-bridge find-bridge.ps1]
```

Requires **Warcraft III running and logged in**. Binds to `127.0.0.1` only.

## Endpoints

| Endpoint | Result |
|---|---|
| `GET /health` | bridge state, fetch counters |
| `GET /profile/{battleTag}` | fresh profile + `wl` summary (`#` must be `%23`) |
| `GET /profiles?tags=A%231,B%232` | same, for up to 12 players in one call (recommended for a game's worth of players) |

Per-player entries carry a computed summary:

```json
{ "battleTag": "Name#1234", "fetchedAtUtc": "...",
  "wl": { "career": {"wins": 3407, "losses": 392}, "season": {"wins": 102, "losses": 17, "seasonId": 9} } }
```

`wl: null` means the account has no matchmade games. Errors: `400 bad_battleTag`
(full tag required), `404 player_not_found`, `503 bridge_unavailable` (game closed or
restarting), `504 fetch_timeout`.

## How the bridge endpoint is found

The game hosts its webui websocket on a random port with a random GUID, re-randomized
every launch. `find-bridge.ps1` (PowerShell, read-only memory scan of the game process)
discovers it and writes `bridge.json`. The service:

- re-scans automatically when a connection fails (first request after a game restart
  may take up to a minute; the rest are ~2s per player),
- tries **all** scanned candidates (memory reads can yield torn or glued strings) and
  remembers whichever connects,
- serializes game access (one profile request in flight, small pacing pauses) and
  coalesces duplicate concurrent requests.

`bridge.json` is runtime state — not committed.
