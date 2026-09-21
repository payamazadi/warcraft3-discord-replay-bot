# War3 Replay Bot

A Node application that watches your Warcraft III `LastReplay.w3g` file and, every time
a game finishes, posts a summary to Discord: players and races, APM, game length, and a
running session summary (games played, total time, W/L record). Player W/L stats are
**fetched live from the running game** through the local stats service — there is no
cache; if the game isn't running the embed says so instead of showing old numbers.

![Bot output](discord-screenshot.PNG)

## How it works

1. [chokidar](https://github.com/paulmillr/chokidar) watches the replay file the game
   rewrites after every match.
2. The replay is parsed with PBug90's [w3gjs](https://github.com/PBug90/w3gjs) replay
   parser (actively maintained, supports current Reforged patches — tested here on
   replays from 1.32 through 3.00).
3. The winner is taken from the parser's `winningTeamId` when the replay reports it
   (ladder 1v1s). For team games it falls back to the classic heuristic: the team whose
   players spent the most time in game was on the winning side.
4. Every player's W/L record is fetched live — the local stats service
   (`service/live-server.js` in this repo) connects to the game's own websocket bridge and
   asks it for each player's profile right now — and the embed is posted to Discord.

## Requirements

- Node.js >= 20 (installed via `winget install --id OpenJS.NodeJS.LTS -e` if missing)
- The live stats service running (see below) — it needs Warcraft III running and
  logged in; without it the bot still posts, with "(stats offline)" per player
- A Discord bot token (free: https://discordpy.readthedocs.io/en/latest/discord.html —
  create the app, open the "Bot" tab, reveal/copy the TOKEN)

## Setup

1. `npm install`
2. `copy .env.example .env` and fill it in:

   | Variable | Meaning |
   |---|---|
   | `TOKEN` | Discord bot token |
   | `PLAYERNAME` | your name, `azadismind` or full battleTag `azadismind#1665` |
   | `REPLAYLOCATION` | path to `LastReplay.w3g` (see below) |
   | `STATSURL` | base URL of the stats service, default `http://127.0.0.1:8080` |
   | `TESTINGCHANNELID` / `REALCHANNELID` | right-click a channel in Discord → Copy ID (Developer Mode on) |

   Reforged saves the last replay under
   `Documents\Warcraft III\BattleNet\<account folder>\Replays\LastReplay.w3g`
   (check the timestamps to find your live account folder).

3. Start the live stats service — it ships in this repo:

   ```bat
   cd service
   node live-server.js
   ```

   Warcraft III must be running and logged in — every stats lookup goes to the game
   right then. The service auto-rescans the game's bridge endpoint when the game
   restarts. Details in `service/README.md`.

4. `node main.js`

## Testing without Discord (no token needed)

```bat
set DRYRUN=1
node main.js "C:\path\to\some replay.w3g"
```

In dry-run the bot skips the Discord login, parses the given replay (or the watched
`REPLAYLOCATION`), and prints the exact embed it would post. When you have a token:

- set `TESTING=1` to post to `TESTINGCHANNELID` and auto-parse the existing replay at
  startup,
- set `TESTING=0` for normal operation (only new games are posted).

## Fetching stats for any player

The service fetches straight from the game every call — nothing is stored. Any player
works as long as **Warcraft III is running and logged in**:

```bat
curl "http://127.0.0.1:8080/profile/SomePlayer%231234"
```

The response carries the fresh `wl` summary (career + current season) plus the raw
profile payloads the game returned. A full battleTag (`Name#12345`) is required — WC3
replays always contain full battleTags, so the bot never needs name-only resolution.
Accounts with no matchmade games return `wl: null` (the bot shows "(no ladder games)").

If the game was restarted, the service detects the dead endpoint and re-runs the
memory scan (`find-bridge.ps1`) automatically — the first request after a restart may
take up to a minute, the rest are fast.

## Notes

- One game produces exactly one message (file size+mtime deduplication; the watcher
  also waits for the file to stop changing before parsing).
- Replays only contain what the game recorded: player battleTags, races, APM and the
  leave events. There is no game-by-game W/L history in a replay — the session record
  counts wins/losses of the watched player since the bot started.
- The old `profile.w3booster.com` lookup (dead service) has been replaced by the local
  stats service.

## Discord Server Setup

1. Setup your Discord bot https://discordpy.readthedocs.io/en/latest/discord.html. Then, click on "Bot" on the left side of the development portal. Next to the icon, it says "TOKEN", with a link to reveal the token, and one to copy it. This is the token you will need for your .env file in step 6.
2. Turn on Developer Mode in Discord: Settings > Appearance > Developer Mode (on the bottom)
3. Fill in the .env file. Here's what mine looks like. To get the channel IDs, right click on the channel in Discord and click "Copy ID" (this is what step 5 was for). ![env file](env-screenshot.PNG)
4. For testing, set `TESTING=1` in your .env file. This will make it so that the last replay is automatically parsed when you start the program, and sends messages to your test channel.
