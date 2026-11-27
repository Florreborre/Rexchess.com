// Snabbtest av meddelanden, aviseringar, utforskaren och lagmatcher mot en tillfällig server.
// Användning: node tools/test-features2.mjs
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const PORT = 3917, dir = path.resolve('data/test-f2');
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dir, TURSO_DATABASE_URL: 'file:' + path.join(dir, 'mirror.db'), TURSO_AUTH_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 100; i++) { try { await fetch(base + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FEL  ') + msg); if (!cond) fails++; };
async function user(name) {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'testlosen1' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (p, body) => { const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, ...(await res.json()) }; };
  return { name, call, ...(await r.json()).user };
}
try {
  const [a, b, c, d] = await Promise.all(['Anna_t', 'Bertil_t', 'Cecilia_t', 'David_t'].map(user));
  // Meddelanden
  let r = await a.call('/api/messages/Bertil_t', { text: 'Hej Bertil!' });
  ok(r.status === 200, 'skicka meddelande');
  r = await a.call('/api/messages/Anna_t', { text: 'själv' });
  ok(r.status === 400, 'kan inte skriva till sig själv');
  r = await b.call('/api/notifications');
  ok(r.unreadMessages === 1, 'Bertil har ett oläst meddelande');
  r = await b.call('/api/messages');
  ok(r.conversations.length === 1 && r.conversations[0].username === 'Anna_t' && r.conversations[0].unread === 1, 'samtalslista');
  r = await b.call('/api/messages/Anna_t');
  ok(r.messages.length === 1 && !r.messages[0].mine, 'tråden');
  r = await b.call('/api/notifications');
  ok(r.unreadMessages === 0, 'läst efter öppnad tråd');
  // Vänförfrågan ger avisering
  r = await a.call('/api/friends/request', { username: 'Bertil_t' });
  r = await b.call('/api/notifications');
  ok(r.items.some((n) => n.kind === 'friend'), 'avisering om vänförfrågan (' + r.items.map((n) => n.kind).join(',') + ')');
  await b.call('/api/notifications/read', {});
  r = await b.call('/api/notifications');
  ok(r.unread === 0, 'aviseringar markerade som lästa');
  // Utforskaren
  r = await (await fetch(base + '/api/explorer?moves=e4')).json();
  ok(r.here && Array.isArray(r.moves), 'utforskaren svarar');
  // Klubbar och lagmatch
  const ka = await a.call('/api/clubs', { name: 'Klubb Alfa' }), kb = await c.call('/api/clubs', { name: 'Klubb Beta' });
  await b.call(`/api/clubs/${ka.id}/join`, {}); await d.call(`/api/clubs/${kb.id}/join`, {});
  r = await b.call(`/api/clubs/${ka.id}/challenge`, { opponent: kb.id, tc: '3+0', duration: 20, startsIn: 0 });
  ok(r.status === 403, 'bara ledaren kan utmana');
  r = await a.call(`/api/clubs/${ka.id}/challenge`, { opponent: kb.id, tc: '3+0', duration: 20, startsIn: 0 });
  ok(r.status === 200 && r.id, 'utmaning skickad');
  const mid = r.id;
  r = await c.call(`/api/clubs/${kb.id}/matches`);
  ok(r.matches.length === 1 && r.matches[0].incoming && r.matches[0].status === 'proposed', 'utmaningen syns hos Beta');
  r = await c.call('/api/notifications');
  ok(r.items.some((n) => n.kind === 'club'), 'Betas ledare fick avisering');
  r = await a.call(`/api/matches/${mid}/accept`, {});
  ok(r.status === 403, 'utmanaren kan inte anta själv');
  for (const u of [a, b, c, d]) await u.call(`/api/tournaments/${mid}/join`, {});
  const outsider = await user('Erik_t');
  r = await outsider.call(`/api/tournaments/${mid}/join`, {});
  ok(r.status === 403, 'utomstående kan inte gå med');
  r = await c.call(`/api/matches/${mid}/accept`, {});
  ok(r.status === 200, 'Beta antar');
  // Spelarna måste vara uppkopplade för att paras; anslut via websocket.
  const games = [];
  const sockets = await Promise.all([a, b, c, d].map(async (u) => {
    const cookie = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.name, password: 'testlosen1' }) })).headers.get('set-cookie').split(';')[0];
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { cookie } });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'game') { const o = m.game.you === 'w' ? m.game.black : m.game.white; games.push([u.name, o?.username || o?.name]); } };
    await new Promise((res) => (ws.onopen = res));
    return ws;
  }));
  await new Promise((res) => setTimeout(res, 4000));
  for (const ws of sockets) ws.send(JSON.stringify({ t: 'tready', id: mid }));
  await new Promise((res) => setTimeout(res, 3000));
  r = await a.call(`/api/tournaments/${mid}`);
  ok(r.tournament.status === 'running', 'lagmatchen har startat (' + r.tournament.status + ')');
  ok(r.match && r.match.a.name === 'Klubb Alfa' && r.match.b.players === 2, 'ställning per lag');
  const pairs = games;
  const club = { Anna_t: 'A', Bertil_t: 'A', Cecilia_t: 'B', David_t: 'B' };
  ok(pairs.length > 0 && pairs.every(([w, bl]) => club[w] !== club[bl]), 'bara parning mellan klubbarna: ' + JSON.stringify(pairs));
  for (const ws of sockets) ws.close();
} catch (e) { console.log('FEL  undantag', e); fails++; }
srv.kill();
if (fails) console.log(log.slice(-3000));
console.log(fails ? `${fails} fel` : 'Alla test gick igenom');
process.exit(fails ? 1 : 0);
