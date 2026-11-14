// Små hjälpfunktioner som delas av hela klienten.
export const state = { user: null, review: null };

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

export function roman(n) {
  let out = '';
  for (const [v, s] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}

let audio;
export function playSound(kind = 'move') {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'triangle';
    o.frequency.value = kind === 'capture' ? 190 : kind === 'end' ? 520 : 300;
    g.gain.setValueAtTime(0.18, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (kind === 'end' ? 0.5 : 0.09));
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.5);
  } catch { /* ljud är inte viktigt */ }
}
