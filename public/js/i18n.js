// Språkbyte. Sajten är skriven på svenska; när ett annat språk är valt översätts all text som hamnar på sidan
// med hjälp av en ordlista (lang-en.js, lang-de.js, lang-es.js, lang-fr.js). Det sker på ett ställe, här, så att resten av koden inte behöver ändras.
import { settings } from './util.js';

let dict = null, templates = [];
const cache = new Map();
const HAS_WORD = /[A-Za-zÅÄÖåäö]{2}/;

// Översätter en text. Okända texter (namn, drag, siffror) lämnas som de är.
export function tr(s) {
  if (!dict || typeof s !== 'string') return s;
  const core = s.trim();
  if (cache.has(s)) return cache.get(s);
  let out = dict[core];
  if (out === undefined && (core.length < 2 || !HAS_WORD.test(core))) return s;
  if (out === undefined) { // text med ifyllda värden, t.ex. "Söker motståndare (5+0)…"
    for (const t of templates) {
      const m = core.match(t.re);
      if (m) { out = t.out.replace(/\{(\d)\}/g, (_, n) => tr(m[t.order.indexOf(Number(n)) + 1])); break; }
    }
  }
  if (out === undefined && core.startsWith('· ')) { // delar som börjar med en skiljepunkt, t.ex. "· svårighet 1200"
    const rest = tr(core.slice(2));
    if (rest !== core.slice(2)) out = '· ' + rest;
  }
  if (out === undefined) { // sammansatta rader som "5+0 · rankat · din tur": översätt varje del för sig
    for (const sep of [' · ', ' – ']) {
      if (!core.includes(sep)) continue;
      const parts = core.split(sep), done = parts.map((p) => tr(p));
      if (done.some((p, i) => p !== parts[i])) { out = done.join(sep); break; }
    }
  }
  const start = s.indexOf(core);
  const res = out === undefined ? s : s.slice(0, start) + out + s.slice(start + core.length);
  if (cache.size > 4000) cache.clear();
  cache.set(s, res);
  return res;
}

const SKIP = 'script, style, textarea, .chatlog p:not(.muted), a.user, .mv, .pname';
function translateNode(node) {
  if (node.nodeType === 3) {
    if (node.parentElement?.closest(SKIP)) return;
    const t = tr(node.nodeValue);
    if (t !== node.nodeValue) node.nodeValue = t;
  } else if (node.nodeType === 1) {
    if (node.matches(SKIP)) return;
    for (const a of ['placeholder', 'title']) {
      const v = node.getAttribute(a);
      if (v) { const t = tr(v); if (t !== v) node.setAttribute(a, t); }
    }
    for (const c of node.childNodes) translateNode(c);
  }
}

export async function initI18n() {
  if (!['en', 'de', 'es', 'fr'].includes(settings.lang)) return; // svenska är originalet
  try { dict = (await import(`./lang-${settings.lang}.js`)).default; } catch { return; }
  templates = Object.entries(dict).filter(([k]) => /\{\d\}/.test(k)).map(([k, v]) => ({
    re: new RegExp('^' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d\\\}/g, '(.+?)') + '$'),
    order: [...k.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1])), out: v, literal: k.replace(/\{\d\}/g, '').length,
  })).sort((a, b) => b.literal - a.literal); // den mest specifika mallen först
  document.title = tr(document.title);
  translateNode(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(translateNode);
      else translateNode(m.target);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] });
  for (const fn of ['alert', 'confirm', 'prompt']) { // även rutor som webbläsaren visar
    const orig = window[fn].bind(window);
    window[fn] = (msg, ...rest) => orig(tr(String(msg ?? '')), ...rest);
  }
}
