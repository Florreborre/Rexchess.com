// WebSocket-anslutning till servern för onlinepartier.
import { state } from './util.js';

// games: alla partier spelaren är med i just nu (man kan spela flera samtidigt), id -> parti.
export const net = { games: new Map(), seeking: null, seekingVariant: null, connected: false };
const listeners = new Set();
let ws = null, retry = null;

export function connect() {
  if (!state.user || (ws && ws.readyState <= 1)) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let openedAt = 0;
  ws.onopen = () => { openedAt = performance.now(); net.connected = true; emit({ t: 'conn' }); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    // Partier som servern skickar direkt vid anslutning är sådana som redan pågick (t.ex. efter omladdning).
    if (m.t === 'game') { m.restored = performance.now() - openedAt < 1500; m.game.at = performance.now(); net.games.set(m.game.id, m.game); }
    if (m.t === 'seeking') { net.seeking = m.tc; net.seekingVariant = m.variant || null; }
    if (m.t === 'watch' && m.game) m.game.at = performance.now();
    emit(m);
  };
  ws.onclose = () => {
    ws = null; net.connected = false; net.seeking = null;
    emit({ t: 'conn' });
    clearTimeout(retry);
    if (state.user) retry = setTimeout(connect, 1500);
  };
}
export function disconnect() {
  clearTimeout(retry);
  net.games.clear(); net.seeking = null;
  ws?.close();
}
export function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}
export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(m) {
  for (const fn of [...listeners]) fn(m);
}
