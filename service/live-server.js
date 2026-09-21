// live-server.js — WC3 profile HTTP service, no cache.
//
// Every GET /profile/{battleTag} is fetched LIVE from the running game's local
// webui bridge websocket and returned fresh. Nothing is persisted, nothing is
// served from disk except bridge.json (the game's websocket endpoint, produced
// by find-bridge.ps1 — a memory scan, so it has to stay PowerShell).
//
//   node live-server.js [--port 8080] [--bridge-json ..\bridge.json]
//                       [--find-bridge ..\find-bridge.ps1]
//
// Endpoints:
//   GET /health                — bridge state, counters (never does a fetch)
//   GET /profile/{battleTag}   — LIVE profile + computed W/L summary
//                                (# must be %23-encoded; full tag Name#12345)
// Errors: 400 bad_battleTag · 404 player_not_found · 503 game_not_running /
// bridge_unavailable · 504 fetch_timeout
//
// Politeness rules toward the game (shared with its own embedded UI): one
// websocket connection per request burst, one GetProfile in flight at a time,
// small pause between players. Concurrent callers asking for the same player
// share one fetch (coalescing, not caching).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// --------------------------------------------------------------------- config
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(argOf('--port', process.env.PORT || 8080));
const SERVICE_DIR = __dirname;
const BRIDGE_JSON = path.resolve(SERVICE_DIR, argOf('--bridge-json', 'bridge.json'));
const FIND_BRIDGE = path.resolve(SERVICE_DIR, argOf('--find-bridge', 'find-bridge.ps1'));

const FIRST_EVENT_TIMEOUT_MS = 6000; // wait for UpdateProfileData
const QUIET_MS = 1200;               // after last profile event, wait this long for stragglers
const INTER_PLAYER_PAUSE_MS = 250;   // pacing between GetProfile requests
const RESCAN_MIN_INTERVAL_MS = 20 * 1000;

// ------------------------------------------------------------------ state
const stats = {
  startedAtUtc: new Date().toISOString(),
  totalFetches: 0,
  okFetches: 0,
  failures: 0,
  lastFetchAtUtc: null,
  lastRescanAtUtc: null,
  bridge: null,           // parsed bridge.json
  lastError: null,
};
let rescanPromise = null;
let lastRescanAt = 0;
// queue serializes all bridge work; one in-flight game request at all times
let bridgeQueue = Promise.resolve();
// coalescing: tag -> in-flight fetch promise (shared across concurrent callers)
const inFlight = new Map();

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

// ------------------------------------------------------------------ bridge.json
function readBridge() {
  try {
    stats.bridge = JSON.parse(fs.readFileSync(BRIDGE_JSON, 'utf8'));
    return stats.bridge;
  } catch {
    stats.bridge = null;
    return null;
  }
}

function rescan(reason) {
  const now = Date.now();
  if (rescanPromise) return rescanPromise;
  if (now - lastRescanAt < RESCAN_MIN_INTERVAL_MS) return Promise.resolve(false);
  lastRescanAt = now;
  log(`rescanning bridge endpoint (${reason})...`);
  rescanPromise = new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FIND_BRIDGE, '-OutFile', BRIDGE_JSON],
      { timeout: 180000 }, (err, stdout) => {
        rescanPromise = null;
        stats.lastRescanAtUtc = new Date().toISOString();
        if (err) {
          stats.lastError = `find-bridge failed: ${err.message}`;
          log(stats.lastError);
          resolve(false);
        } else {
          readBridge();
          log('rescan ok:', stats.bridge ? `port=${stats.bridge.port}` : 'no bridge.json written');
          resolve(Boolean(stats.bridge));
        }
      });
  });
  return rescanPromise;
}

// ------------------------------------------------------------------ websocket
function connectBridge(port, guid, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/webui-socket/${guid}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`connect timeout to ${url}`));
    }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket error (game not running or stale bridge.json)'));
    });
  });
}

// Ordered endpoint candidates: the last working one first, then everything
// bridge.json recorded (longest guid first — chunk artifacts are prefixes).
// The memory scan also reads BlizzardBrowser, which keeps stale endpoint
// strings from previous game sessions, so ANY single candidate can be dead.
let workingEndpoint = null;

function orderedCandidates(bridge) {
  const list = [];
  const seen = new Set();
  const push = (port, guid) => {
    const key = `${port}|${guid}`;
    if (!port || !guid || seen.has(key)) return;
    seen.add(key);
    list.push({ port: Number(port), guid: String(guid) });
  };
  if (workingEndpoint) push(workingEndpoint.port, workingEndpoint.guid);
  if (bridge) {
    for (const c of bridge.candidates || []) {
      const [p, g] = String(c).split('|');
      push(Number(p), g);
    }
    push(bridge.port, bridge.guid);
  }
  list.sort((a, b) => (a.port - b.port) || (b.guid.length - a.guid.length));
  // keep the known-working endpoint at the front after sorting
  if (workingEndpoint) {
    const i = list.findIndex((c) => c.port === workingEndpoint.port && c.guid === workingEndpoint.guid);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}

async function openBridge() {
  const attempt = async (candidates) => {
    let lastErr = null;
    for (const c of candidates) {
      try {
        const ws = await connectBridge(c.port, c.guid);
        workingEndpoint = c;
        return ws;
      } catch (e) {
        if (workingEndpoint && workingEndpoint.port === c.port && workingEndpoint.guid === c.guid) {
          workingEndpoint = null; // it died
        }
        lastErr = e;
        log(`connect failed ${c.port}/${String(c.guid).slice(0, 10)}…: ${e.message}`);
      }
    }
    throw lastErr || new Error('no candidates');
  };

  let candidates = orderedCandidates(readBridge());
  try {
    return await attempt(candidates);
  } catch {
    const ok = await rescan('connect failed on all endpoints');
    candidates = orderedCandidates(readBridge());
    if (!candidates.length) {
      throw Object.assign(new Error('no bridge endpoint found (is Warcraft III running and logged in?)'), { code: 'bridge_unavailable' });
    }
    try {
      return await attempt(candidates);
    } catch (e) {
      throw Object.assign(new Error('cannot reach game bridge (is Warcraft III running and logged in?)'), { code: 'bridge_unavailable' });
    }
  }
}

function send(ws, message, payload) {
  ws.send(JSON.stringify({ type: 'webui', message, payload }));
}

// One battleTag, one already-open websocket. Resolves with collected events.
function fetchOne(ws, battleTag) {
  return new Promise((resolve) => {
    const events = [];
    let gotProfileData = false;
    let gotToonStats = false;
    let quietTimer = null;
    let hardTimer = null;

    const finish = (reason) => {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      resolve({ events, reason });
    };
    const onClose = () => {
      if (!gotProfileData) finish('socket_closed');
    };
    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), QUIET_MS);
    };
    const onMessage = (ev) => {
      let obj;
      try { obj = JSON.parse(ev.data); } catch { return; }
      const batch = Array.isArray(obj) ? obj : [obj];
      for (const m of batch) {
        if (!m || !m.messageType) continue;
        if (m.messageType === 'UpdateProfileData') gotProfileData = true;
        if (m.messageType === 'UpdateProfileDataWithToonStats') gotToonStats = true;
        if (gotProfileData || gotToonStats) {
          events.push(m);
          if (gotProfileData && gotToonStats) armQuiet();
          else armQuiet();
        }
      }
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    hardTimer = setTimeout(() => finish(gotProfileData ? 'quiet' : 'no_response'), FIRST_EVENT_TIMEOUT_MS);

    send(ws, 'GetProfile', { battleTag, gatewayId: 0, clanTags: '' });
  });
}

// Extract {profile, toonStats, rankedSeasonStats} from collected events
function pickPayloads(events) {
  const out = {};
  for (const e of events) {
    if (e.messageType === 'UpdateProfileData' && !out.profile) out.profile = e.payload && e.payload.details;
    if (e.messageType === 'UpdateProfileDataWithToonStats' && !out.toonStats) out.toonStats = e.payload && e.payload.details;
    if (e.messageType === 'RankedSeasonStatsUpdate' && !out.rankedSeasonStats) out.rankedSeasonStats = e.payload;
  }
  return out;
}

// Compute the W/L summary. Two shapes exist:
//  - own profile: profile.matchmaked_stats[] (season_id 0 = career; sum duplicates)
//  - other players: toonStats.seasons[] (season 0 = career; per-race win/loss sums)
function computeWl(picked) {
  const mm = picked.profile && picked.profile.matchmaked_stats;
  if (Array.isArray(mm) && mm.length > 0) {
    const career = { wins: 0, losses: 0 };
    let maxSeason = 0;
    for (const e of mm) {
      if (typeof e.wins !== 'number' || typeof e.losses !== 'number') continue;
      if (e.season_id === 0) { career.wins += e.wins; career.losses += e.losses; }
      else if (e.season_id > maxSeason) maxSeason = e.season_id;
    }
    let season = null;
    if (maxSeason > 0) {
      season = { wins: 0, losses: 0, seasonId: maxSeason };
      for (const e of mm) if (e.season_id === maxSeason) { season.wins += e.wins || 0; season.losses += e.losses || 0; }
    }
    return { career, season };
  }
  const seasons = picked.toonStats && picked.toonStats.seasons;
  if (Array.isArray(seasons) && seasons.length > 0) {
    const sumRaces = (s) => {
      const out = { wins: 0, losses: 0 };
      for (const race of s.races || []) {
        for (const st of race.stats || []) {
          if (st.statName === 'wins') out.wins += st.sum || 0;
          if (st.statName === 'losses') out.losses += st.sum || 0;
        }
      }
      return out;
    };
    const careerSeason = seasons.find((s) => s.season === 0);
    const numbered = seasons.filter((s) => typeof s.season === 'number' && s.season > 0);
    const maxSeason = numbered.reduce((m, s) => Math.max(m, s.season), 0);
    const career = careerSeason ? sumRaces(careerSeason) : null;
    const season = maxSeason > 0 ? { ...sumRaces(numbered.find((s) => s.season === maxSeason)), seasonId: maxSeason } : null;
    if (career || season) return { career: career || season, season };
  }
  return null;
}

// The whole live fetch for one tag, run on the queue with a fresh connection
// per burst (a burst = one HTTP /profile call, possibly with several tags in
// the future; today each request is one tag).
function liveFetch(battleTag) {
  return new Promise((resolve, reject) => {
    const pause = () => new Promise((r) => setTimeout(r, INTER_PLAYER_PAUSE_MS));
    bridgeQueue = bridgeQueue
      .then(async () => {
        let ws = null;
        try {
          ws = await openBridge();

          const { events, reason } = await fetchOne(ws, battleTag);
          const picked = pickPayloads(events);
          if (!picked.profile) {
            const err = new Error(
              reason === 'socket_closed'
                ? 'game closed the bridge connection mid-fetch'
                : `no profile returned for ${battleTag}`,
            );
            err.code = reason === 'socket_closed' ? 'bridge_unavailable' : 'player_not_found';
            throw err;
          }
          const tag = picked.profile.battle_tag_full || battleTag;
          resolve({
            battleTag: tag,
            fetchedAtUtc: new Date().toISOString(),
            wl: computeWl(picked),          // null => account has no matchmade games
            profile: picked.profile,
            toonStats: picked.toonStats || null,
            rankedSeasonStats: picked.rankedSeasonStats || null,
          });
        } catch (err) {
          reject(err);
        } finally {
          try { if (ws) ws.close(); } catch {}
        }
      })
      .then(pause, pause); // pacing gap before the next queued game request
  });
}

function profileFor(battleTag) {
  const key = battleTag.toLowerCase();
  stats.totalFetches++;
  let p = inFlight.get(key);
  if (!p) {
    p = liveFetch(battleTag).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

// ------------------------------------------------------------------ http
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const rawPath = (req.url || '/').split('?')[0];
  if (rawPath === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      mode: 'live-fetch (no cache)',
      uptimeSeconds: Math.round((Date.now() - Date.parse(stats.startedAtUtc)) / 1000),
      bridge: stats.bridge ? { port: stats.bridge.port, scannedAt: stats.bridge.scannedAt } : null,
      lastRescanAtUtc: stats.lastRescanAtUtc,
      totalFetches: stats.totalFetches,
      okFetches: stats.okFetches,
      failures: stats.failures,
      lastFetchAtUtc: stats.lastFetchAtUtc,
      lastError: stats.lastError,
      inFlight: inFlight.size,
    });
    return;
  }
  const m = rawPath.match(/^\/profile\/(.+)$/);
  if (m) {
    let tag;
    try { tag = decodeURIComponent(m[1]).trim(); } catch { tag = ''; }
    if (!tag) return sendJson(res, 400, { error: 'bad_battleTag', hint: 'GET /profile/Name%2312345' });
    if (!tag.includes('#')) {
      return sendJson(res, 400, { error: 'bad_battleTag', detail: 'full battleTag required: Name#12345', got: tag });
    }
    log(`GET /profile/${tag}`);
    profileFor(tag).then(
      (result) => {
        stats.okFetches++;
        stats.lastFetchAtUtc = result.fetchedAtUtc;
        sendJson(res, 200, result);
      },
      (err) => {
        stats.failures++;
        stats.lastError = `${tag}: ${err.message}`;
        log(`fetch failed for ${tag}: ${err.message}`);
        const status = err.code === 'bridge_unavailable' ? 503
          : err.code === 'player_not_found' ? 404
          : err.code === 'fetch_timeout' ? 504 : 500;
        sendJson(res, status, { error: err.code || 'internal_error', detail: err.message, battleTag: tag });
      },
    );
    return;
  }
  if (rawPath === '/profiles') {
    // batch: one HTTP call for a whole game's players. The queue still talks
    // to the game serially, but a rescan happens at most once for the batch.
    let tags = [];
    try {
      const u = new URL(req.url, 'http://localhost');
      tags = (u.searchParams.get('tags') || '')
        .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
    } catch { tags = []; }
    if (tags.length === 0) {
      return sendJson(res, 400, { error: 'no_tags', hint: 'GET /profiles?tags=Name%231234,Other%235678' });
    }
    log(`GET /profiles (${tags.length} tags)`);
    Promise.all(tags.map((t) =>
      profileFor(t).then(
        (r) => { stats.okFetches++; stats.lastFetchAtUtc = r.fetchedAtUtc; return [t, r]; },
        (e) => {
          stats.failures++;
          stats.lastError = `${t}: ${e.message}`;
          log(`fetch failed for ${t}: ${e.message}`);
          return [t, { error: e.code || 'internal_error', detail: e.message, battleTag: t }];
        },
      )))
      .then((entries) => {
        const results = {};
        for (const [t, r] of entries) results[t] = r;
        sendJson(res, 200, { fetchedAtUtc: new Date().toISOString(), results });
      })
      .catch(() => sendJson(res, 500, { error: 'internal_error' }));
    return;
  }
  if (rawPath === '/' || rawPath === '') {
    return sendJson(res, 200, {
      service: 'wc3-live-stats',
      mode: 'live-fetch (no cache)',
      endpoints: ['/health', '/profile/{battleTag}'],
      note: 'every /profile call is fetched live from the running game; # must be %23-encoded',
    });
  }
  sendJson(res, 404, { error: 'not_found' });
});

readBridge();
server.listen(PORT, '127.0.0.1', () => {
  log(`wc3 live stats service listening on http://127.0.0.1:${PORT} (no cache — every fetch is live)`);
  log(`bridge.json: ${BRIDGE_JSON} ${stats.bridge ? `(port ${stats.bridge.port}, scanned ${stats.bridge.scannedAt})` : '(missing — will rescan on first fetch)'}`);
  if (!stats.bridge) rescan('startup with no bridge.json');
});
