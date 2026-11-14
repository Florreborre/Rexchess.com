// WebSocket-anslutning till servern för onlinepartier.
import { state } from './util.js';

export const net = { game: null, seeking: null, connected: false };
const listeners = new Set();
let ws = null, retry = null;

export function connect() {
  if (!state.user || (ws && ws.readyState <= 1)) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { net.connected = true; emit({ t: 'conn' }); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'game') { net.game = m.game; net.game.at = performance.now(); net.seeking = null; }
    if (m.t === 'seeking') net.seeking = m.tc;
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
  net.game = null; net.seeking = null;
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
