require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const W3GReplay = require('w3gjs').default;
const axios = require('axios');
const { parseInProgressReplay } = require('./temp-replay-parser.js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ---------------------------------------------------------------------------
// Configuration (.env) — see .env.example
// ---------------------------------------------------------------------------
const TOKEN = process.env.TOKEN;
const REPLAYLOCATION = process.env.REPLAYLOCATION;
const PLAYERNAME = process.env.PLAYERNAME;
const TESTINGCHANNELID = process.env.TESTINGCHANNELID;
const REALCHANNELID = process.env.REALCHANNELID;

// Base URL of the live stats service (service/live-server.js in this repo,
// port 8080). Every profile lookup is fetched fresh from the running game —
// there is no cache.
const STATSURL = (process.env.STATSURL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

// TESTING=1 -> post to TESTINGCHANNELID instead of REALCHANNELID, and parse the
// existing replay at startup
const testing = process.env.TESTING === '1';
// DRYRUN=1 -> no Discord login; parse replays and print the embed to the console
const dryrun = process.env.DRYRUN === '1';

const channelId = testing ? TESTINGCHANNELID : REALCHANNELID;

if (!REPLAYLOCATION) {
  console.error('REPLAYLOCATION is not set — point it at your LastReplay.w3g (or replays folder) in .env');
  process.exit(1);
}
if (!dryrun && !TOKEN) {
  console.error('TOKEN is not set — put your Discord bot token in .env (or set DRYRUN=1 to test without Discord).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
let myTeam = null;
let numSessionGames = 0;
let totalSessionDuration = 0;
let longestGame = 0;
let avgSessionDuration = 0;
let numWins = 0;
let numLosses = 0;

// Replay writing lifecycle: when a match starts the game creates TempReplay.w3g
// (compressed data blocks, encrypted-looking but just zlib without the final
// header) and streams into it while the match runs. When the match ends it
// dumps a completed replay into LastReplay.w3g. Both files persist between
// games, so every event is deduplicated per file by size+mtime, and a
// "Game starting" post fires only for a genuinely new match: file creation
// ('add'), or an existing TempReplay that is actively growing.
let lastTempSig = null;     // temp content as of the last event we handled
let lastReplaySig = null;   // LastReplay content as of the last event we handled
let replayState = 'idle'; // 'idle' | 'in_game'
let endCheckTimer = null;
let lastChangeAtMs = 0;
let handlingReplay = false;
let pendingReplayPath = null;
let pendingReplayType = null;
let gameStartMessage = null;  // sent "Game starting" message, edited into the result at game end

const GAME_END_QUIET_MS = 15000;    // no writes for this long -> game is over
const GROWTH_CHECK_MS = 3000;       // re-stat after this long to detect live writing
const GIVE_UP_AFTER_MS = 180000;    // file quiet but unparseable -> give up eventually
const GAME_START_GIVE_UP_MS = 180000; // keep retrying the game-start post this long

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------
const thebot = dryrun ? null : new Client({ intents: [GatewayIntentBits.Guilds] });

if (dryrun) {
  console.log('[dry-run] Discord login skipped; output goes to the console.');
} else {
  thebot.login(TOKEN);
}

thebot?.on('ready', () => {
  console.log('Discord connected');
  if (channelId) thebot.channels.cache.get(channelId)?.send('Starting gaming session.');
  else console.log('No channel id configured; not sending the startup message.');

  watchReplays();
});

if (dryrun) watchReplays();

// ---------------------------------------------------------------------------
// Replay watching
// The game rewrites LastReplay.w3g after each game; depending on how the file
// is replaced we see add and/or change events for the same replay. Deduplicate
// by size+mtime so one write produces exactly one handling pass.
// ---------------------------------------------------------------------------
function fileSignature(p) {
  try {
    const st = fs.statSync(p);
    return `${p}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function watchReplays() {
  // Watch the DIRECTORY, not a single file: the game writes TempReplay.w3g
  // (encrypted, created the moment a match starts) and LastReplay.w3g (the
  // decrypted dump at game end). We react only to those two names.
  const watchDir = path.dirname(REPLAYLOCATION);
  const watched = new Set([path.basename(REPLAYLOCATION), 'TempReplay.w3g']);
  const watcher = chokidar.watch(watchDir, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 750,
      pollInterval: 200,
    },
  });
  const handler = (type) => (p) => { if (watched.has(path.basename(p))) onReplayEvent(p, type); };
  watcher.on('add', handler('add')).on('change', handler('change'));
  console.log(`Watching ${watchDir} for ${[...watched].join(' / ')} changes...`);

  // dry-run and testing parse the existing replay at startup (testing posts it);
  // an explicit file from argv overrides the watched path
  if (dryrun || testing) {
    const target = process.argv[2] || REPLAYLOCATION;
    if (fs.existsSync(target)) onReplayEvent(target);
    else console.log(`[startup] ${target} does not exist yet; waiting for the watcher.`);
  }
}

// chokidar can fire faster than we handle; collapse to the newest event
function onReplayEvent(p, type) {
  if (handlingReplay) {
    pendingReplayPath = p;
    pendingReplayType = type;
    return;
  }
  handlingReplay = true;
  handleReplayEvent(p, type)
    .catch((err) => console.log('Error handling replay event:', err.message))
    .finally(() => {
      handlingReplay = false;
      if (pendingReplayPath) {
        const next = pendingReplayPath;
        const nextType = pendingReplayType;
        pendingReplayPath = null;
        pendingReplayType = null;
        onReplayEvent(next, nextType);
      }
    });
}

async function handleReplayEvent(p, type) {
  const isTemp = path.basename(p).toLowerCase() === 'tempreplay.w3g';
  const sig = fileSignature(p);
  if (!sig) return;

  if (isTemp) {
    if (sig === lastTempSig) return; // no change since we handled it
    lastTempSig = sig;
  } else {
    if (sig === lastReplaySig) return;
    lastReplaySig = sig;
  }
  lastChangeAtMs = Date.now();

  if (replayState === 'in_game') {
    // A game is underway; only LastReplay.w3g ends it. TempReplay writes
    // during the match are just the compressed replay growing.
    if (!isTemp) armEndCheck(p);
    return;
  }

  if (isTemp) {
    // TempReplay.w3g is created the moment a match starts. Its data blocks are
    // compressed (not encrypted) — human battleTags can be extracted live, so
    // we can post everyone's stats before the game finishes.
    // A rewritten temp ('change', not 'add') only counts as a new match if the
    // file is actively growing — static menu-time touches don't count.
    if (type !== 'add') {
      const growing = await fileStillGrowing(p);
      if (!growing) return;
    }
    replayState = 'in_game';
    gameStartMessage = null; // a new game must not edit the previous game's message
    // Not awaited: postGameStart retries in the background until the temp
    // replay contains player records, so a slow stats fetch must not block
    // this handler (which also has to process the game-end event).
    postGameStart(p).catch((err) => console.log('Game-start post failed:', err.message));
    return;
  }

  // idle: LastReplay.w3g was written — the game dumps the completed replay
  // here when a game finishes. Parse it and post the summary.
  let parsed = null;
  try {
    parsed = await parseWithLeaves(p);
  } catch {
    parsed = null;
  }
  if (replayState !== 'idle') return;

  if (parsed && parsed.result.duration >= 30000) {
    await postGameEnd(p, parsed.result, parsed.leaves);
  } else {
    console.log('LastReplay changed but is not a parseable finished game; ignoring.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileStillGrowing(p) {
  const before = fileSignature(p);
  await sleep(GROWTH_CHECK_MS);
  const after = fileSignature(p);
  return Boolean(before && after && before !== after);
}

// While in a game: when the file has gone quiet, try the full parse. Quiet for
// GAME_END_QUIET_MS usually means the game finished and flushed the replay.
function armEndCheck(p) {
  clearTimeout(endCheckTimer);
  endCheckTimer = setTimeout(() => {
    checkForGameEnd(p).catch((err) => {
      console.log('End-of-game check failed:', err.message);
      armEndCheck(p);
    });
  }, GAME_END_QUIET_MS);
}

async function checkForGameEnd(p) {
  if (replayState !== 'in_game') return;
  const sig = fileSignature(p);
  if (sig && sig !== lastReplaySig) return; // still writing; next event re-arms

  let parsed = null;
  try {
    parsed = await parseWithLeaves(p);
  } catch {
    parsed = null;
  }
  if (parsed) {
    replayState = 'idle';
    clearTimeout(endCheckTimer);
    await postGameEnd(p, parsed.result, parsed.leaves);
  } else if (Date.now() - lastChangeAtMs > GIVE_UP_AFTER_MS) {
    replayState = 'idle';
    console.log('Game replay never became parseable; giving up on this game.');
  } else {
    armEndCheck(p); // still not parseable; keep waiting a bit longer
  }
}

// High-level parse plus the raw leave events (gamedatablock id 23), which the
// high-level result doesn't expose but winner detection needs.
function parseWithLeaves(p) {
  return new Promise((resolve, reject) => {
    const parser = new W3GReplay();
    const leaves = [];
    parser.on('gamedatablock', (b) => {
      if (b.id === 23) leaves.push(b);
    });
    parser.parse(p).then(
      (result) => resolve({ result, leaves }),
      (err) => reject(err),
    );
  });
}

// ---------------------------------------------------------------------------
// "Game starting" — fired when TempReplay.w3g appears (the moment a match
// starts). At that moment the file is usually still a stub: the game doesn't
// write player records until the loading screen finishes. So this is a
// background retry loop — re-read the temp replay every few seconds until the
// human battleTags are readable, then post each player's LIVE stats (fetched
// through the stats service). If the service keeps failing we post the table
// with "(offline)" cells; if the replay never yields players we say so after
// GAME_START_GIVE_UP_MS. If the game ends first, no post — the full result
// summary from postGameEnd supersedes it (it edits this message in place, so
// each game is exactly one Discord message).
// ---------------------------------------------------------------------------
async function postGameStart(tempPath) {
  const deadline = Date.now() + GAME_START_GIVE_UP_MS;
  let battleTags = null;
  let statsMap = null;
  let warnedStatsDown = false;

  while (replayState === 'in_game' && Date.now() < deadline) {
    try {
      const parsed = parseInProgressReplay(fs.readFileSync(tempPath));
      if (parsed.battleTags.length > 0) {
        battleTags = parsed.battleTags;
        try {
          statsMap = await fetchStatsBatch(parsed.battleTags);
          break;
        } catch (err) {
          if (!warnedStatsDown) {
            console.log('Game-start stats fetch failed; will keep retrying:', err.message);
            warnedStatsDown = true;
          }
        }
      }
    } catch {
      // temp replay is still a stub — player records aren't written yet
    }
    await sleep(GROWTH_CHECK_MS);
  }
  if (replayState !== 'in_game') return; // game ended first; the result post wins

  const embed = new EmbedBuilder().setTitle('Game starting').setColor(0x0099ff);
  if (!battleTags) {
    embed.setDescription('A match is underway (no human players detected in the replay yet).');
  } else {
    const rows = battleTags.map((tag) => {
      const s = statsMap ? statsEntry(statsMap, tag) : { kind: 'offline' };
      return [tag, careerCell(s), seasonCell(s)];
    });
    embed.addFields({
      name: 'Players (live records)',
      value: monoTable(['Player', 'Career', 'Season'], rows),
    });
  }

  if (dryrun) return printEmbed(embed, '(game start)');
  gameStartMessage = await sendToChannel(embed);
}

async function postGameEnd(p, result, leaves = []) {
  numSessionGames++;
  totalSessionDuration += result.duration;
  avgSessionDuration = totalSessionDuration / numSessionGames;
  longestGame = Math.max(result.duration, longestGame);

  for (const player of result.players) {
    if (namePart(player.name) === namePart(PLAYERNAME)) myTeam = player.teamid;
  }
  const iWon = myTeam !== null && winningTeam(result, leaves) === myTeam;
  if (myTeam !== null) {
    if (iWon) numWins++;
    else numLosses++;
  }

  const statsMap = await fetchStatsBatch(result.players.map((p) => p.name));
  const rows = result.players.map((pl) => [
    pl.name,
    raceCode(pl),
    String(pl.apm),
    careerCell(statsEntry(statsMap, pl.name)),
    seasonCell(statsEntry(statsMap, pl.name)),
  ]);

  const embed = new EmbedBuilder();
  if (myTeam === null) {
    embed.setTitle('Replay').setColor(0x808080);
  } else if (iWon) {
    embed.setTitle('Replay - Win').setColor(0x00ff00);
  } else {
    embed.setTitle('Replay - Loss').setColor(0xff0000);
  }

  embed.addFields({ name: 'Map', value: result.map.file });
  embed.addFields({ name: 'Players', value: monoTable(['Player', 'Race', 'APM', 'Career', 'Season'], rows) });
  embed.addFields(
    { name: 'Game Length', value: millisToMinutesAndSeconds(result.duration), inline: true },
    { name: 'Average', value: millisToMinutesAndSeconds(avgSessionDuration), inline: true },
    { name: 'Longest', value: millisToMinutesAndSeconds(longestGame), inline: true },
  );
  embed.addFields(
    { name: 'Session Time', value: `${numSessionGames} games, ${millisToMinutesAndSeconds(totalSessionDuration)}`, inline: true },
    { name: 'Session Record', value: myTeam === null ? 'n/a' : `${numWins}-${numLosses}`, inline: true },
  );

  if (dryrun) return printEmbed(embed, '(game end)');

  // One message per game: turn the "Game starting" post into the result. If
  // the message is gone (deleted, missing permissions), post a new one.
  const target = gameStartMessage;
  gameStartMessage = null;
  if (target) {
    try {
      await target.edit({ embeds: [embed] });
      console.log('Edited the game-start message into the result summary.');
      return;
    } catch (err) {
      console.log('Editing the game-start message failed; posting a new one:', err.message);
    }
  }
  await sendToChannel(embed);
}

// ---------------------------------------------------------------------------
// Discord send / print
// ---------------------------------------------------------------------------
async function sendToChannel(embed) {
  if (!channelId) {
    console.log('No channel id configured; skipping message.');
    return;
  }
  const channel = thebot.channels.cache.get(channelId);
  if (!channel) {
    console.log(`Channel ${channelId} not found — is the bot in that server?`);
    return;
  }
  const message = await channel.send({ embeds: [embed] });
  console.log(`Posted replay summary to channel ${channelId}`);
  return message;
}

function printEmbed(embed, label) {
  console.log(`\n=== Would post to Discord ${label} ===`);
  console.log(`# ${embed.toJSON().title}`);
  for (const f of embed.toJSON().fields || []) {
    console.log(`  ${f.name}: ${f.value.split('\n').join(' | ')}${f.inline ? '  (inline)' : ''}`);
  }
  console.log('=============================\n');
}

// Winner detection, most reliable first:
//
// 1. w3gjs reports winningTeamId on modern replays — but only for 1v1 games.
// 2. Team games: at game end the SURVIVING (winning) players each receive a
//    leave event with reason 0c000000 ("game over"), while eliminated players
//    left earlier with reason 010000000. Verified against replay leave dumps:
//    the 0c-leavers' team is the winner. (The result field of these events is
//    inconsistent — ignore it.)
// 3. If the replay ends at the recorder's own defeat, the winners never get to
//    leave at all: the team(s) with NO leave event won.
// 4. Last resort: the team whose players spent the most time in game.
function winningTeam(result, leaves = []) {
  if (result.winningTeamId !== undefined && result.winningTeamId !== -1) {
    return result.winningTeamId;
  }
  const playerById = (pid) => result.players.find((p) => String(p.id) === String(pid));

  const gameOverTeams = new Set();
  for (const L of leaves) {
    if (String(L.reason) !== '0c000000') continue;
    const pl = playerById(L.playerId);
    if (pl) gameOverTeams.add(pl.teamid);
  }
  if (gameOverTeams.size === 1) return Number([...gameOverTeams][0]);

  const leftTeams = new Set();
  for (const L of leaves) {
    const pl = playerById(L.playerId);
    if (pl) leftTeams.add(pl.teamid);
  }
  const neverLeftTeams = new Set(result.players.map((p) => p.teamid).filter((t) => !leftTeams.has(t)));
  if (neverLeftTeams.size === 1) return Number([...neverLeftTeams][0]);

  const teamTime = {};
  for (const p of result.players) {
    teamTime[p.teamid] = (teamTime[p.teamid] || 0) + (p.currentTimePlayed || 0);
  }
  let best = null;
  for (const team of Object.keys(teamTime)) {
    if (best === null || teamTime[team] > teamTime[best]) best = team;
  }
  return best === null ? -1 : Number(best);
}

// Replays carry either bare names or full battleTags ("azadismind#1665") and
// PLAYERNAME may be set either way — compare on the name part, case-insensitively.
function namePart(name) {
  return String(name).split('#')[0].toLowerCase();
}

// ---------------------------------------------------------------------------
// Player W/L stats — fetched LIVE from the running game via the stats service.
// No cache: every replay triggers fresh lookups for every player. All players
// go out in ONE batched request so the service talks to the game efficiently.
// ---------------------------------------------------------------------------

// Returns { <playerName>: { wl: {career, season}, ... } | { error, detail } }
async function fetchStatsBatch(names) {
  const tags = [...new Set(names.filter((n) => n.includes('#')))];
  if (tags.length === 0) return {};
  const res = await axios.get(`${STATSURL}/profiles`, {
    params: { tags: tags.join(',') },
    // One batch covers the whole game: the service may rescan the bridge
    // (memory scan) before answering, so allow a few minutes.
    timeout: 240000,
  });
  return (res.data && res.data.results) || {};
}

// Map a batch entry to the {kind} shape the cell formatters consume.
function statsEntry(statsMap, name) {
  if (!name.includes('#')) return { kind: 'none' }; // AI/"Computer" players
  if (!statsMap) return { kind: 'offline' };        // batch request failed
  const entry = statsMap[name];
  if (!entry) return { kind: 'error' };
  if (entry.wl && entry.wl.career) return { kind: 'ok', wl: entry.wl };
  const code = entry.error;
  if (code === 'player_not_found') return { kind: 'nogames' };
  if (code === 'bridge_unavailable') return { kind: 'offline' };
  if (code === 'fetch_timeout') return { kind: 'timeout' };
  return { kind: 'error' };
}

function wlCell({ wins, losses }) {
  const total = wins + losses;
  if (total === 0) return '0-0';
  return `${wins}-${losses} (${Math.round((wins / total) * 100)}%)`;
}

function careerCell(s) {
  if (!s) return '—';
  if (s.kind === 'ok') return wlCell(s.wl.career);
  if (s.kind === 'nogames') return 'no games';
  if (s.kind === 'offline') return '(offline)';
  if (s.kind === 'timeout') return '(timeout)';
  return '(error)';
}

function seasonCell(s) {
  if (!s || s.kind !== 'ok' || !s.wl.season) return '—';
  return wlCell(s.wl.season);
}

// compact race display for the table: HU/OC/NE/UD, "(R)" suffix when random
function raceCode(player) {
  const codes = { H: 'HU', O: 'OC', N: 'NE', U: 'UD' };
  const code = codes[player.race] || player.race;
  if (player.race === 'R') {
    return `${codes[player.raceDetected] || '??'} (R)`;
  }
  return code;
}

// A padded monospace table. Discord wraps long lines inside inline fields,
// which desyncs any multi-column layout — a code block never re-flows, so
// rows stay aligned no matter how long the content is.
function monoTable(headers, rows) {
  const width = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells
    .map((c, i) => String(c ?? '').padEnd(width[i]))
    .join('  ')
    .replace(/\s+$/, '');
  const text = [line(headers), ...rows.map(line)].join('\n');
  return '```\n' + text.slice(0, 1000) + '\n```';
}

const millisToMinutesAndSeconds = (millis) => {
  const minutes = Math.floor(millis / 60000);
  const seconds = ((millis % 60000) / 1000).toFixed(0);
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
};

process.on('unhandledRejection', (err) => console.log('Unhandled rejection:', err));
