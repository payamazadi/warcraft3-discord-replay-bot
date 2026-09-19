require('dotenv').config();
const fs = require('fs');
const chokidar = require('chokidar');
const W3GReplay = require('w3gjs').default;
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ---------------------------------------------------------------------------
// Configuration (.env) — see .env.example
// ---------------------------------------------------------------------------
const TOKEN = process.env.TOKEN;
const REPLAYLOCATION = process.env.REPLAYLOCATION;
const PLAYERNAME = process.env.PLAYERNAME;
const TESTINGCHANNELID = process.env.TESTINGCHANNELID;
const REALCHANNELID = process.env.REALCHANNELID;

// Base URL of the live stats service (wc3-re service/live-server.js, port 8080).
// Every profile lookup is fetched fresh from the running game — there is no cache.
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
let numWins = 0;
let numLosses = 0;
let lastSignature = null;

// Replay writing lifecycle: the game (re)creates LastReplay.w3g when a game
// starts and keeps appending to it until the game finishes. So a change event
// mid-game means the file is a partial replay — enough to read the header
// (players, teams, races) but not to summarize. We post a "Game starting"
// message with live W/L for every player right away, then wait for writes to
// go quiet and post the full summary.
let replayState = 'idle'; // 'idle' | 'in_game'
let endCheckTimer = null;
let lastChangeAtMs = 0;
let handlingReplay = false;
let pendingReplayPath = null;

const GROWTH_CHECK_MS = 4000;       // re-stat after this long to detect live writing
const GAME_END_QUIET_MS = 15000;    // no writes for this long -> game is over
const GIVE_UP_AFTER_MS = 180000;    // file quiet but unparseable -> give up eventually
const HEADER_PARSE_TIMEOUT_MS = 15000;

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
  const watcher = chokidar.watch(REPLAYLOCATION, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });
  watcher.on('add', onReplayEvent).on('change', onReplayEvent);
  console.log(`Watching ${REPLAYLOCATION} for new replays...`);

  // dry-run and testing parse the existing replay at startup (testing posts it);
  // an explicit file from argv overrides the watched path
  if (dryrun || testing) {
    const target = process.argv[2] || REPLAYLOCATION;
    if (fs.existsSync(target)) onReplayEvent(target);
    else console.log(`[startup] ${target} does not exist yet; waiting for the watcher.`);
  }
}

// chokidar can fire faster than we handle; collapse to the newest event
function onReplayEvent(p) {
  if (handlingReplay) {
    pendingReplayPath = p;
    return;
  }
  handlingReplay = true;
  handleReplayEvent(p)
    .catch((err) => console.log('Error handling replay event:', err.message))
    .finally(() => {
      handlingReplay = false;
      if (pendingReplayPath) {
        const next = pendingReplayPath;
        pendingReplayPath = null;
        onReplayEvent(next);
      }
    });
}

async function handleReplayEvent(p) {
  const sig = fileSignature(p);
  if (!sig || sig === lastSignature) return;
  lastSignature = sig;
  lastChangeAtMs = Date.now();

  if (replayState === 'in_game') {
    // replay is growing; the end-check timer posts when writes stop
    armEndCheck(p);
    return;
  }

  // idle: a replay appeared. Full parse succeeding + no further writes means
  // it's a finished replay (or a copy of one). Otherwise it's a game in
  // progress — announce it with live stats.
  let result = null;
  try {
    result = await new W3GReplay().parse(p);
  } catch {
    result = null; // partial replay — expected for a game in progress
  }
  if (replayState !== 'idle') return; // re-entered while we were parsing

  const growing = await fileStillGrowing(p);
  if (growing) {
    replayState = 'in_game';
    await postGameStart(p);
    armEndCheck(p);
  } else if (result) {
    await postGameEnd(p, result);
  } else {
    console.log('Replay file is truncated and no longer being written; ignoring it.');
  }
}

async function fileStillGrowing(p) {
  const before = fileSignature(p);
  await sleep(GROWTH_CHECK_MS);
  const after = fileSignature(p);
  return Boolean(before && after && before !== after);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (sig && sig !== lastSignature) return; // still writing; next event re-arms

  let result = null;
  try {
    result = await new W3GReplay().parse(p);
  } catch {
    result = null;
  }
  if (result) {
    replayState = 'idle';
    clearTimeout(endCheckTimer);
    await postGameEnd(p, result);
  } else if (Date.now() - lastChangeAtMs > GIVE_UP_AFTER_MS) {
    replayState = 'idle';
    console.log('Game replay never became parseable; giving up on this game.');
  } else {
    armEndCheck(p); // still not parseable; keep waiting a bit longer
  }
}

// ---------------------------------------------------------------------------
// "Game starting" — read players from the replay header only
// ---------------------------------------------------------------------------
function headerPlayers(p) {
  return new Promise((resolve, reject) => {
    // W3GReplay extends the low-level parser and emits basic_replay_information
    // once the header is read — before block parsing hits the end of a partial
    // (in-progress) replay file.
    const parser = new W3GReplay();
    const timer = setTimeout(() => {
      reject(new Error('header parse timeout'));
    }, HEADER_PARSE_TIMEOUT_MS);
    parser.on('basic_replay_information', (info) => {
      clearTimeout(timer);
      const byId = {};
      for (const rec of info.metadata.playerRecords || []) byId[rec.playerId] = { ...rec };
      for (const extra of info.metadata.reforgedPlayerMetadata || []) {
        if (byId[extra.playerId]) byId[extra.playerId].playerName = extra.name;
        else byId[extra.playerId] = { playerId: extra.playerId, playerName: extra.name };
      }
      const players = [];
      for (const slot of info.metadata.slotRecords || []) {
        if (slot.slotStatus <= 1) continue; // empty slot
        players.push({
          id: slot.playerId,
          name: (byId[slot.playerId] && byId[slot.playerId].playerName) || 'Computer',
          teamid: slot.teamId,
          race: raceLetter(slot.raceFlag),
        });
      }
      resolve({ players, map: (info.metadata && info.metadata.map) || (info.map) || null });
    });
    parser.parse(p).catch((err) => {
      clearTimeout(timer);
      // the header event usually fired before block parsing hits a partial file
      reject(err);
    });
  });
}

// mirror of w3gjs raceFlagFormatter (kept inline to avoid deep-import drift)
function raceLetter(flag) {
  switch (flag) {
    case 0x01:
    case 0x41: return 'H';
    case 0x02:
    case 0x42: return 'O';
    case 0x04:
    case 0x44: return 'N';
    case 0x08:
    case 0x48: return 'U';
    default: return 'R';
  }
}

async function postGameStart(p) {
  const header = await headerPlayers(p);

  const rows = [];
  for (const pl of header.players) {
    const s = pl.name.includes('#') ? await statsFor(pl.name) : { kind: 'none' };
    rows.push([pl.name, raceCode(pl), careerCell(s), seasonCell(s)]);
  }

  const embed = new EmbedBuilder()
    .setTitle('Game starting')
    .setColor(0x0099ff)
    .addFields({ name: 'Map', value: safeValue(header.map && (header.map.file || header.map)) })
    .addFields({ name: 'Players', value: monoTable(['Player', 'Race', 'Career', 'Season'], rows) });

  if (dryrun) return printEmbed(embed, '(game start)');
  await sendToChannel(embed);
}

async function postGameEnd(p, result) {
  numSessionGames++;
  totalSessionDuration += result.duration;
  avgSessionDuration = totalSessionDuration / numSessionGames;
  longestGame = Math.max(result.duration, longestGame);

  for (const player of result.players) {
    if (namePart(player.name) === namePart(PLAYERNAME)) myTeam = player.teamid;
  }
  const iWon = myTeam !== null && winningTeam(result) === myTeam;
  if (myTeam !== null) {
    if (iWon) numWins++;
    else numLosses++;
  }

  const stats = await Promise.all(result.players.map((pl) => (pl.name.includes('#') ? statsFor(pl.name) : { kind: 'none' })));
  const rows = result.players.map((pl, i) => [
    pl.name,
    raceCode(pl),
    String(pl.apm),
    careerCell(stats[i]),
    seasonCell(stats[i]),
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
  await channel.send({ embeds: [embed] });
  console.log(`Posted replay summary to channel ${channelId}`);
}

function printEmbed(embed, label) {
  console.log(`\n=== Would post to Discord ${label} ===`);
  console.log(`# ${embed.toJSON().title}`);
  for (const f of embed.toJSON().fields || []) {
    console.log(`  ${f.name}: ${f.value.split('\n').join(' | ')}${f.inline ? '  (inline)' : ''}`);
  }
  console.log('=============================\n');
}

// w3gjs reports the winning team directly on modern replays. For odd games
// where it can't be determined (-1), fall back to the old heuristic: the team
// whose players spent the most time in game was on the winning side.
function winningTeam(result) {
  if (result.winningTeamId !== undefined && result.winningTeamId !== -1) {
    return result.winningTeamId;
  }
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

function safeValue(v) {
  const s = String(v || 'unknown');
  return s.length > 1024 ? s.slice(0, 1021) + '...' : s;
}

// ---------------------------------------------------------------------------
// Player W/L stats — fetched LIVE from the running game via the stats service.
// No cache: every replay triggers fresh lookups for every player.
// ---------------------------------------------------------------------------

// Returns { kind: 'ok', wl: {career, season} } | { kind: 'nogames' | 'offline' |
// 'timeout' | 'error' | 'none' }
async function statsFor(name) {
  if (!name.includes('#')) return { kind: 'none' }; // AI/"Computer" players
  let res;
  try {
    // Generous timeout: the service talks to the game serially, and if the
    // game was just restarted its first request may include a bridge rescan.
    res = await axios.get(`${STATSURL}/profile/${encodeURIComponent(name)}`, { timeout: 90000 });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) return { kind: 'nogames' };
    if (status === 503) return { kind: 'offline' };
    if (status === 504) return { kind: 'timeout' };
    console.log(`Stats lookup failed for ${name}: ${err.message}`);
    return { kind: 'error' };
  }
  const wl = res.data && res.data.wl;
  if (!wl || !wl.career) return { kind: 'nogames' };
  return { kind: 'ok', wl };
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
