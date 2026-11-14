// Små hjälpfunktioner som delas av hela klienten.
export const state = { user: null, review: null, training: null, after: null };

// Inställningar som sparas i webbläsaren (per enhet).
export const BOARD_THEMES = {
  marmor: ['Marmor', '#f1e7cf', '#b07f56'], oliv: ['Oliv', '#ecebd0', '#7d9a5f'], hav: ['Hav', '#e6ebf0', '#6f8fad'],
  sten: ['Sten', '#e6e3dc', '#8f8a80'], valnot: ['Valnöt', '#e9cfa6', '#9c6a3c'],
};
export const settings = { board: 'marmor', sound: true, volume: 0.8, autoQueen: false, hints: true, coords: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('settings') || '{}')); } catch { /* standardvärden */ }
export function applySettings() {
  const [, light, dark] = BOARD_THEMES[settings.board] || BOARD_THEMES.marmor;
  document.documentElement.style.setProperty('--light-sq', light);
  document.documentElement.style.setProperty('--dark-sq', dark);
  document.body.classList.toggle('nocoords', !settings.coords);
}
export function saveSettings(change) {
  Object.assign(settings, change);
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* går inte att spara */ }
  applySettings();
}

export function h(tag, props, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props != null && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
export function pieceSvg(code) {
  return svg('svg', { viewBox: '0 0 40 40', class: 'piece' }, svg('use', { href: `/vendor/pieces.svg#${code}` }));
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Något gick fel.');
  return data;
}

export function fmtClock(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  if (ms < 20000) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const REASONS = {
  checkmate: 'schackmatt', resign: 'uppgivet', timeout: 'tiden tog slut', stalemate: 'patt',
  insufficient: 'otillräckligt material', repetition: 'trefaldig upprepning', fifty: '50-dragsregeln',
  agreement: 'överenskommelse', aborted: 'partiet avbröts',
};

// Byter sida utan omladdning (adressen blir t.ex. /play i stället för /#/play).
export function go(path) {
  if (path !== location.pathname) history.pushState(null, '', path);
  setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate')));
}

// Spelarnamn som länk till spelarens profil.
export function userLink(name) {
  return h('a.user', { href: `/profile/${encodeURIComponent(name)}` }, name);
}

// Litet märke med spelarens titel (Tiro, Miles, Decurio …).
export function titleEl(title) {
  return title ? h('span.title', { title: 'Titel' }, title) : null;
}

export function roman(n) {
  let out = '';
  for (const [v, s] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}

// Ljud: görs direkt i webbläsaren. Ett drag låter som en träpjäs som sätts ner på brädet –
// en kort brusstöt genom ett filter (själva "klacket") plus en dov ton (brädets resonans).
let audio, noise;
function audioCtx() {
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}
function knock(t, { freq = 950, gain = 0.55, decay = 0.055, thump = 150 } = {}) {
  const a = audioCtx();
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.25), a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource(), band = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noise;
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = 2.2;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  src.connect(band).connect(g).connect(a.destination);
  src.start(t, Math.random() * 0.1);
  src.stop(t + decay + 0.02);
  const o = a.createOscillator(), og = a.createGain();
  o.frequency.setValueAtTime(thump * 1.7, t);
  o.frequency.exponentialRampToValueAtTime(thump, t + 0.045);
  og.gain.setValueAtTime(gain * 0.8, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(og).connect(a.destination);
  o.start(t);
  o.stop(t + 0.11);
}
function chime(t, freq, dur, gain = 0.09) {
  const a = audioCtx(), o = a.createOscillator(), g = a.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
// Inspelade pjäsljud (Lichess ljuduppsättning "sfx", se public/sounds/LICENSE.txt).
const SOUND_FILES = {
  move: 'Move', castle: 'Move', promote: 'Move', capture: 'Capture', check: 'Check', start: 'GenericNotify',
  victory: 'Victory', defeat: 'Defeat', draw: 'Draw', end: 'Draw', lowtime: 'LowTime', challenge: 'NewChallenge',
};
const soundCache = {};
// kind: move | capture | castle | check | promote | start | victory | defeat | draw | lowtime | challenge
export function playSound(kind = 'move') {
  if (!settings.sound) return;
  try {
    const wood = WOOD[SOUND_FILES[kind]];
    if (wood && canOgg()) {
      // Drag och slag: en träpjäs som sätts ner. Fem inspelningar var, slumpvis vald så att det inte låter likadant varje gång.
      const knock = (delay) => setTimeout(() => play(`${wood}${1 + Math.floor(Math.random() * 5)}.ogg`, 0.65, kind), delay);
      knock(0);
      if (kind === 'castle') knock(120); // kung och torn
      return;
    }
    play(`${SOUND_FILES[kind] || 'Move'}.mp3`, 0.8, kind);
  } catch { synth(kind); }
}
const WOOD = { Move: 'move', Capture: 'capture' };
let oggOk = null;
const canOgg = () => (oggOk ??= !!new Audio().canPlayType('audio/ogg; codecs="vorbis"'));
function play(file, volume, kind) {
  const a = (soundCache[file] ??= new Audio(`/sounds/${file}`)).cloneNode();
  a.volume = Math.max(0, Math.min(1, volume * (settings.volume / 0.8)));
  a.play().catch(() => synth(kind)); // går filen inte att spela används det inbyggda reservljudet
}
// Ljudet när partiet är slut, ur spelarens synvinkel.
export function endSound(over, myColor) {
  if (over.result === '1/2-1/2' || over.result === '*') return 'draw';
  return (over.result === '1-0') === (myColor === 'w') ? 'victory' : 'defeat';
}

// Reservljud som görs direkt i webbläsaren.
function synth(kind = 'move') {
  try {
    const t = audioCtx().currentTime + 0.005;
    if (kind === 'capture') { // två pjäser som slår ihop: ett vasst klack följt av ett tyngre
      knock(t, { freq: 1500, gain: 0.7, decay: 0.04, thump: 190 });
      knock(t + 0.05, { freq: 750, gain: 0.6, decay: 0.08, thump: 115 });
    } else if (kind === 'castle') { // kung och torn: två drag i följd
      knock(t);
      knock(t + 0.12, { freq: 1050, thump: 135 });
    } else if (kind === 'check') {
      knock(t, { freq: 1150, gain: 0.65 });
      chime(t + 0.03, 1320, 0.22, 0.05);
    } else if (kind === 'promote') {
      knock(t);
      chime(t + 0.04, 784, 0.15, 0.06);
      chime(t + 0.13, 1175, 0.3, 0.06);
    } else if (kind === 'start') {
      knock(t, { freq: 800 });
      knock(t + 0.14, { freq: 1000 });
    } else if (['end', 'victory', 'defeat', 'draw', 'lowtime', 'challenge'].includes(kind)) { // dov klocka
      knock(t, { freq: 600, gain: 0.5, decay: 0.09, thump: 100 });
      chime(t + 0.02, 392, 1.1, 0.09);
      chime(t + 0.02, 587, 0.9, 0.05);
    } else knock(t);
  } catch { /* ljud är inte viktigt */ }
}

// Ljudet för ett drag, utifrån chess.js dragobjekt.
export function moveSound(mv) {
  if (/[+#]/.test(mv.san)) return 'check';
  if (mv.san.startsWith('O-O')) return 'castle';
  if (mv.promotion) return 'promote';
  return mv.captured ? 'capture' : 'move';
}
