// Gör en animerad GIF av ett parti: varje ställning ritas på en canvas och kodas som en bildruta.
// GIF-kodaren (LZW) är skriven här, så att inga externa bibliotek behövs.

// LZW-komprimering enligt GIF-standarden (variabel kodlängd 9–12 bitar).
function lzw(pixels, minCode = 8) {
  const CLEAR = 1 << minCode, EOI = CLEAR + 1;
  let nBits = minCode + 1, maxcode = (1 << nBits) - 1, free = CLEAR + 2, clearFlag = false;
  const out = [], dict = new Map();
  let acc = 0, accBits = 0;
  const output = (code) => {
    acc |= code << accBits;
    accBits += nBits;
    while (accBits >= 8) { out.push(acc & 255); acc >>>= 8; accBits -= 8; }
    if (free > maxcode || clearFlag) {
      if (clearFlag) { nBits = minCode + 1; maxcode = (1 << nBits) - 1; clearFlag = false; }
      else { nBits++; maxcode = nBits === 12 ? 4096 : (1 << nBits) - 1; }
    }
  };
  output(CLEAR);
  let ent = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i], key = (ent << 8) | c, hit = dict.get(key);
    if (hit !== undefined) { ent = hit; continue; }
    output(ent);
    ent = c;
    if (free < 4096) dict.set(key, free++);
    else { dict.clear(); free = CLEAR + 2; clearFlag = true; output(CLEAR); }
  }
  output(ent);
  output(EOI);
  if (accBits > 0) out.push(acc & 255);
  return out;
}

// Väljer 256 färger utifrån några av bildrutorna och översätter varje bildpunkt till närmaste färg.
function buildPalette(samples) {
  const counts = new Map();
  for (const data of samples) {
    for (let i = 0; i < data.length; i += 4) {
      const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => k);
  const pal = keys.map((k) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4]);
  while (pal.length < 256) pal.push([0, 0, 0]);
  const cache = new Int16Array(32768).fill(-1);
  const index = (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (cache[k] >= 0) return cache[k];
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return (cache[k] = best);
  };
  return { pal, index };
}

export function encodeGif(frames, width, height) { // frames: [{ data: Uint8ClampedArray (RGBA), delay: hundradelar }]
  const sample = [frames[0].data, frames[Math.floor(frames.length / 2)].data, frames.at(-1).data];
  const { pal, index } = buildPalette(sample);
  const bytes = [];
  const word = (n) => bytes.push(n & 255, (n >> 8) & 255);
  const str = (s) => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };
  str('GIF89a'); word(width); word(height); bytes.push(0xf7, 0, 0);
  for (const [r, g, b] of pal) bytes.push(r, g, b);
  bytes.push(0x21, 0xff, 11); str('NETSCAPE2.0'); bytes.push(3, 1, 0, 0, 0); // spela om och om igen
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0, f.delay & 255, (f.delay >> 8) & 255, 0, 0);
    bytes.push(0x2c); word(0); word(0); word(width); word(height); bytes.push(0);
    const px = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < px.length; i++, j += 4) px[i] = index(f.data[j], f.data[j + 1], f.data[j + 2]);
    const data = lzw(px);
    bytes.push(8);
    for (let i = 0; i < data.length; i += 255) { const chunk = data.slice(i, i + 255); bytes.push(chunk.length, ...chunk); }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

// Pjäsbilderna ur sajtens sprite, som separata bilder att rita på canvas.
let pieceImgs = null;
async function loadPieces() {
  if (pieceImgs) return pieceImgs;
  const text = await (await fetch('/vendor/pieces.svg')).text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  pieceImgs = {};
  await Promise.all(['wk', 'wq', 'wr', 'wb', 'wn', 'wp', 'bk', 'bq', 'br', 'bb', 'bn', 'bp'].map(async (code) => {
    const g = doc.getElementById(code);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="80" height="80">${g.outerHTML}</svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    pieceImgs[code] = img;
  }));
  return pieceImgs;
}

// Ritar en ställning (FEN) på en canvas. Färgerna tas från sajtens brädinställning.
function drawPosition(ctx, fen, size, lastMove, orientation, colors) {
  const sq = size / 8, files = 'abcdefgh';
  const rows = fen.split(' ')[0].split('/');
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const [f, r] = orientation === 'w' ? [x, 7 - y] : [7 - x, y];
      const name = files[f] + (r + 1);
      ctx.fillStyle = (x + y) % 2 ? colors.dark : colors.light;
      ctx.fillRect(x * sq, y * sq, sq, sq);
      if (lastMove && (name === lastMove.from || name === lastMove.to)) { ctx.fillStyle = 'rgba(220, 178, 58, .5)'; ctx.fillRect(x * sq, y * sq, sq, sq); }
    }
  }
  rows.forEach((row, ri) => {
    let fi = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { fi += Number(ch); continue; }
      const code = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toLowerCase();
      const [x, y] = orientation === 'w' ? [fi, ri] : [7 - fi, 7 - ri];
      ctx.drawImage(pieceImgs[code], x * sq, y * sq, sq, sq);
      fi++;
    }
  });
}

// steps: [{ fen, from?, to? }]. Returnerar en GIF-blob.
export async function gameGif(steps, { size = 360, orientation = 'w', title = '' } = {}) {
  await loadPieces();
  const css = getComputedStyle(document.documentElement);
  const colors = { light: css.getPropertyValue('--light-sq').trim() || '#f1e7cf', dark: css.getPropertyValue('--dark-sq').trim() || '#b07f56' };
  const band = title ? 28 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size + band;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frames = [];
  steps.forEach((s, i) => {
    ctx.fillStyle = '#2a1d14'; ctx.fillRect(0, 0, size, size + band);
    if (title) { ctx.fillStyle = '#e6c878'; ctx.font = '600 14px Georgia, serif'; ctx.textBaseline = 'middle'; ctx.fillText(title, 10, size + band / 2, size - 20); }
    drawPosition(ctx, s.fen, size, s.from && { from: s.from, to: s.to }, orientation, colors);
    frames.push({ data: ctx.getImageData(0, 0, size, size + band).data, delay: i === 0 ? 120 : i === steps.length - 1 ? 400 : 90 });
  });
  return encodeGif(frames, size, size + band);
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
