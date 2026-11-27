// png-squeeze: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
// Strategy (written from scratch for this competition):
//   1. Decode the stored input PNG (inflate + unfilter).
//   2. Analyse the image: opaque? grey? at most 256 colours? one transparent key value?
//   3. Screen every lossless form the image admits (palette by count / by luminance,
//      grey / grey+alpha / RGB / RGBA, plus a tRNS key instead of an alpha channel when
//      every non-opaque pixel shares one transparent value), each under several
//      per-row filter choices (fixed 0-4, minimum-sum-of-signed-bytes, fewest-distinct-
//      byte-pairs), weighing each by zlib level 6 + PLTE/tRNS chunk overhead.
//   4. Write the winner's filtered data with the smallest of a few zlib level-9 streams.
// Deterministic: no clock, no randomness, fixed iteration order; two runs are identical.

import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32 / PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function ihdrOf(width, height, colourType) {
  const b = new Uint8Array(13);
  const v = new DataView(b.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  b[8] = 8; // bit depth
  b[9] = colourType;
  b[10] = 0; // compression
  b[11] = 0; // filter method
  b[12] = 0; // interlace
  return b;
}

function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

// ---------------------------------------------------------------- decode

function paeth(left, above, upLeft) {
  const p = left + above - upLeft;
  const pl = Math.abs(p - left);
  const pa = Math.abs(p - above);
  const pu = Math.abs(p - upLeft);
  if (pl <= pa && pl <= pu) return left;
  if (pa <= pu) return above;
  return upLeft;
}

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let bitDepth = 8;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      bitDepth = buf[pos + 16];
      colourType = buf[pos + 17];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(pos + 8, pos + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colourType !== 6) throw new Error(`input is colour type ${colourType} bit depth ${bitDepth}, expected 6/8`);
  const raw = inflateSync(Buffer.concat(idat));
  const ch = 4;
  const stride = width * ch;
  const rgba = new Uint8Array(width * height * ch);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= ch && prev ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) v = (v + paeth(a, b, c)) & 255;
      cur[x] = v;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- filters

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = x >= bpp && prev ? prev[x - bpp] : 0;
    let v = cur[x];
    if (type === 1) v = (v - a) & 255;
    else if (type === 2) v = (v - b) & 255;
    else if (type === 3) v = (v - ((a + b) >> 1)) & 255;
    else if (type === 4) v = (v - paeth(a, b, c)) & 255;
    out[x] = v;
  }
}

// Sum of absolute values of the bytes read as signed (-128..127).
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v > 127 ? 256 - v : v;
  }
  return s;
}

// How many distinct pairs of neighbouring bytes a filtered row holds.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- analyse

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = r * 0x1000000 + g * 0x10000 + b * 0x100 + a;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else {
        counts.set(key, k + 1);
      }
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((key) => ({
        rgba: [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255],
        word: key,
        count: counts.get(key),
      }));
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no
// opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------- palette

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const key = rgba[d] * 0x1000000 + rgba[d + 1] * 0x10000 + rgba[d + 2] * 0x100 + rgba[d + 3];
    indices[i] = index.get(key);
  }
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- screening

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Filtered data of `samples` (height rows of width*bpp), each row behind its
// filter byte, by `choice`: a fixed filter 0-4, or 'minsum' / 'pairs' / 'brute'
// per-row choice (lowest filter type wins a tie).
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const FILTERS = {
  palette: [0],
  paletteByLuminance: [0, 'minsum', 'brute'],
  channels: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
};

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The winner form + filter choice, weighed by zlib level 6; the top three
// candidates then re-deflated at level 9 under two strategies, smallest kept
// (the level-6 stream is carried as a third candidate: level 9 is not always
// smaller than level 6 on the same filtered data).
function squeeze(rgba, width, height) {
  const top = [];
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const z6 = deflateSync(data, SCREEN);
      const bytes = z6.length + chunks;
      const cand = { form, choice, data, z6, bytes };
      let idx = top.findIndex((c) => bytes < c.bytes);
      if (idx === -1) idx = top.length;
      top.splice(idx, 0, cand);
      if (top.length > 3) spare = top.pop().data;
    }
  }
  // Final round: each of the top three under level 9 (default + filtered
  // strategies), plus its level-6 stream, smallest total file wins.
  let bestFile = null;
  for (const cand of top) {
    const streams = [cand.z6];
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      streams.push(deflateSync(cand.data, { level: 9, memLevel: 9, strategy }));
    }
    for (const z of streams) {
      const total = z.length + chunkBytes(cand.form);
      if (bestFile === null || total < bestFile.total) bestFile = { form: cand.form, idat: z, total };
    }
  }
  const chunks = [['IHDR', ihdrOf(width, height, bestFile.form.colourType)]];
  if (bestFile.form.plte !== null) chunks.push(['PLTE', bestFile.form.plte]);
  if (bestFile.form.trns !== null) chunks.push(['tRNS', bestFile.form.trns]);
  chunks.push(['IDAT', new Uint8Array(bestFile.idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------- main

for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(readFileSync(join(I, id, 'image.png')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(rgba, width, height));
}
