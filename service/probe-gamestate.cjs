// Diagnostic: connects to the game's webui bridge and dumps the raw responses
// to game-state messages. Purpose: find out whether any of them expose the
// CURRENT match (players/game state) — which would let the bot post stats at
// game start (the replay file only appears at game end).
//
// Run any time the game is open (especially while IN a match):
//   node service\probe-gamestate.cjs
const fs = require('fs');
const path = require('path');

const bridge = JSON.parse(fs.readFileSync(path.join(__dirname, 'bridge.json'), 'utf8'));
const MESSAGES = ['GetGameInfo', 'GetLastGameLaunched', 'GetMatchResults'];

const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/webui-socket/${bridge.guid}`);
ws.addEventListener('open', () => {
  console.log('connected to port', bridge.port);
  for (const m of MESSAGES) {
    console.log('>>', m);
    ws.send(JSON.stringify({ type: 'webui', message: m, payload: {} }));
  }
});
ws.addEventListener('message', (ev) => {
  const s = String(ev.data);
  console.log('<<', s.length > 3000 ? s.slice(0, 3000) + ` …(+${s.length - 3000} bytes)` : s);
});
ws.addEventListener('error', () => {
  console.log('websocket error — stale bridge.json, or the game is closed/not logged in.');
  console.log('fix: trigger any stats fetch (or run find-bridge.ps1) to refresh the endpoint.');
  process.exit(1);
});
setTimeout(() => process.exit(0), 8000);
