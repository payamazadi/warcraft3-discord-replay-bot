// Minimal parser for an IN-PROGRESS Warcraft III replay (TempReplay.w3g).
//
// The game writes this file while the match is being played: a chain of
// Reforged data blocks ([blockSize u16][2 skipped][dSize u16][6 skipped]
// [zlib data of blockSize bytes]) starting at offset 68, WITHOUT the final
// header (the plaintext "Warcraft III recorded game" header + subheader are
// only written into LastReplay.w3g when the game ends). w3gjs cannot read
// this file because its header search fails and the last block is torn.
//
// What we need (human player battleTags) lives in the INFLATED stream as
// protobuf player records: marker 0x38/0x39, subtype 0x03, u32 length, then a
// protobuf payload containing {08 <playerId> 12 <len> "Name#12345"}. We scan
// every candidate record and validate the battleTag pattern, which is robust
// to custom-game metadata layout differences.
const zlib = require('zlib');
const { constants } = zlib;

const TEMP_BLOCK_START = 68; // observed: 68 zero bytes then the block stream

function inflateBlockChain(buf) {
  let off = TEMP_BLOCK_START;
  const inflated = [];
  let total = 0;
  while (off + 12 <= buf.length && inflated.length < 4096) {
    const bSize = buf.readUInt16LE(off);
    if (bSize === 0) break;
    if (off + 12 + bSize > buf.length) break; // torn tail — still being written
    const content = buf.subarray(off + 12, off + 12 + bSize);
    try {
      const out = zlib.inflateSync(content, { finishFlush: constants.Z_SYNC_FLUSH });
      inflated.push(out);
      total += out.length;
    } catch (e) {
      inflated.push(Buffer.alloc(0));
    }
    off += 12 + bSize;
  }
  return Buffer.concat(inflated);
}

// find "08 <playerId varint> 12 <tagLen> <battleTag#12345>" patterns in a
// protobuf payload; battleTags contain '#' and end in digits
function scanBattleTagsIn(payload) {
  const out = [];
  for (let j = 0; j + 4 <= payload.length; j++) {
    if (payload[j] !== 0x08 || payload[j + 2] !== 0x12) continue;
    const id = payload[j + 1];
    const tagLen = payload[j + 3];
    if (tagLen < 3 || tagLen > 32 || j + 4 + tagLen > payload.length) continue;
    const tag = payload.toString('utf8', j + 4, j + 4 + tagLen);
    if (!tag.includes('#') || !/\d$/.test(tag)) continue;
    out.push({ id, battleTag: tag });
    j += 4 + tagLen;
  }
  return out;
}

// Scan the inflated stream for protobuf player records. Returns
// [{ id, battleTag }] — human players only.
function scanPlayerRecords(data) {
  const players = [];
  const seen = new Set();
  for (let i = 0; i + 8 <= data.length; i++) {
    const marker = data[i];
    if (marker !== 0x38 && marker !== 0x39) continue;
    if (data[i + 1] !== 0x03) continue; // subtype 3 = player record
    const len = data.readUInt32LE(i + 2);
    if (len === 0 || len > 300 || i + 6 + len > data.length) continue;
    const payload = data.subarray(i + 6, i + 6 + len);
    for (const { id, battleTag } of scanBattleTagsIn(payload)) {
      if (seen.has(battleTag)) continue;
      seen.add(battleTag);
      players.push({ id, battleTag });
      if (players.length >= 12) break;
    }
    if (players.length >= 12) break;
  }
  return players;
}

// Returns { battleTags: ['Name#1234', ...] } for the match in progress.
function parseInProgressReplay(buf) {
  const data = inflateBlockChain(buf);
  if (data.length < 64) throw new Error('temp replay has no readable data yet');
  return { battleTags: scanPlayerRecords(data).map((p) => p.battleTag) };
}

module.exports = { parseInProgressReplay, inflateBlockChain, scanPlayerRecords };
