// Schack-TV, öppningsutforskaren, privata meddelanden, aviseringsklockan, delning av partier och lagmatcher.
import { Chess } from '/vendor/chess.js';
import { h, state, api, go, userLink, avatarImg, icon, playSound, moveSound } from './util.js';
import { Board, parseFen } from './board.js';
import { net, send, on } from './net.js';
import { watchView } from './game.js';
import { matchOpening, OPENINGS } from './openings.js';
import { gameGif, download } from './gif.js';

const when = (ms) => {
  const d = Date.now() - ms, min = Math.floor(d / 60000);
  if (min < 1) return 'nyss';
  if (min < 60) return `${min} min sedan`;
  if (min < 1440) return `${Math.floor(min / 60)} tim sedan`;
  return new Date(ms).toLocaleDateString('sv-SE');
};

// ---------- Schack-TV: visar alltid det högst rankade pågående partiet ----------
export function tvView(ctx) {
  const wrap = h('div.tv');
  const head = h('div.tvhead', h('span.tvlogo', icon('tv', 22), 'Schack-TV'), h('span.muted.tvsub', 'Det högst rankade partiet just nu, live.'));
  const stage = h('div');
  wrap.append(head, stage);
  let inner = null, current = null, alive = true, timer = null;
  const pick = async () => {
    if (!alive) return;
    const { games } = await api('/api/live').catch(() => ({ games: [] }));
    const best = games[0];
    if (!best) {
      if (current !== 'none') {
        inner?.destroy?.(); inner = null; current = 'none';
        stage.replaceChildren(h('div.card.narrow.center', h('h2', 'Inga partier just nu'), h('p.muted', 'Så fort någon börjar spela visas partiet här.'), h('a.btn.primary', { href: '/play' }, 'Spela själv')));
      }
      timer = setTimeout(pick, 8000);
      return;
    }
    if (best.id !== current) {
      inner?.destroy?.();
      current = best.id;
      inner = watchView(ctx, best.id);
      stage.replaceChildren(inner.el);
    }
    timer = setTimeout(pick, 8000);
  };
  // När partiet tar slut byter TV:n till nästa efter en kort stund.
  const off = on((m) => { if (m.t === 'watch' && m.game?.over && m.game.id === current) { clearTimeout(timer); timer = setTimeout(() => { current = null; pick(); }, 6000); } });
  if (!state.user) stage.append(h('div.card.narrow', h('p.muted', 'Logga in för att titta på partier live.'), h('a.btn.primary', { href: '/login' }, 'Logga in')));
  else pick();
  return { el: wrap, destroy() { alive = false; clearTimeout(timer); off(); inner?.destroy?.(); } };
}

// ---------- Öppningsutforskaren ----------
export function explorerView() {
  let chess = new Chess(), line = [], orientation = 'w', token = 0;
  const board = new Board({
    movableColor: () => chess.turn(),
    targets: (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to),
    onMove(from, to, promotion) { try { const m = chess.move({ from, to, promotion }); line.push(m.san); playSound(moveSound(m)); } catch { return; } refresh(); },
  });
  const side = h('div.side.flat.explorer');
  const bookNext = () => { // drag som finns i öppningsboken efter den här ställningen
    const out = new Set();
    for (const o of OPENINGS) if (o.moves.length > line.length && line.every((s, i) => s.replace(/[+#]/g, '') === o.moves[i].replace(/[+#]/g, ''))) out.add(o.moves[line.length]);
    return out;
  };
  const bar = (s) => {
    const n = s.n || 1, w = (100 * s.w) / n, d = (100 * s.d) / n, b = 100 - w - d;
    return h('div.wdl', h('span.w', { style: { width: w + '%' } }, w >= 12 ? `${Math.round(w)}%` : ''), h('span.d', { style: { width: d + '%' } }, d >= 12 ? `${Math.round(d)}%` : ''),
      h('span.b', { style: { width: b + '%' } }, b >= 12 ? `${Math.round(b)}%` : ''));
  };
  function play(san) { const m = chess.move(san); line.push(m.san); playSound(moveSound(m)); refresh(); }
  async function refresh() {
    const last = chess.history({ verbose: true }).at(-1);
    board.set({ fen: chess.fen(), orientation, lastMove: last && { from: last.from, to: last.to }, animate: true });
    const my = ++token, name = matchOpening(line).name;
    const pgn = line.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + s).join(' ');
    side.replaceChildren(h('h2', 'Öppningsutforskare'), h('p.opening-name', name || (line.length ? 'Okänd öppning' : 'Utgångsställningen')), h('p.pgnline', pgn || 'Gör ett drag på brädet eller välj ett nedan.'), h('p.muted', 'Laddar…'));
    const data = await api(`/api/explorer?moves=${encodeURIComponent(line.join(' '))}`).catch(() => null);
    if (my !== token || !data) return;
    const book = bookNext();
    const rows = data.moves.map((m) => h('tr', { onclick: () => play(m.san) }, h('td', h('strong', m.san), book.has(m.san) ? h('span.booktag', 'teori') : ''), h('td', m.n), h('td.wdlcell', bar(m))));
    for (const san of book) if (!data.moves.some((m) => m.san === san)) rows.push(h('tr.bookonly', { onclick: () => play(san) }, h('td', h('strong', san), h('span.booktag', 'teori')), h('td', '0'), h('td', h('span.muted', 'Inte spelat här än'))));
    side.replaceChildren(
      h('h2', 'Öppningsutforskare'),
      h('p.opening-name', name || (line.length ? 'Okänd öppning' : 'Utgångsställningen')),
      h('p.pgnline', pgn || 'Gör ett drag på brädet eller välj ett nedan.'),
      h('div.btnrow.left',
        h('button.icon', { title: 'Tillbaka ett drag', disabled: !line.length, onclick: () => { chess.undo(); line.pop(); refresh(); } }, icon('prev')),
        h('button.icon', { title: 'Börja om', disabled: !line.length, onclick: () => { chess = new Chess(); line = []; refresh(); } }, icon('first')),
        h('button.icon', { title: 'Vänd brädet', onclick: () => { orientation = orientation === 'w' ? 'b' : 'w'; refresh(); } }, icon('flip'))),
      h('p.muted', `${data.here.n} partier på sajten har nått den här ställningen.`),
      data.here.n > 0 && bar(data.here),
      rows.length ? h('div.tablewrap', h('table.explore', h('thead', h('tr', ['Drag', 'Partier', 'Vit · Remi · Svart'].map((t) => h('th', t)))), h('tbody', rows)))
        : h('p.muted', 'Inga fler drag spelade härifrån ännu.'),
      data.games.length > 0 && h('h3', 'Partier från ställningen'),
      data.games.length > 0 && h('div.tgames', data.games.map((g) => h('a', { href: `/review/${g.id}` }, `${g.white} – ${g.black}`, h('span', g.result)))));
  }
  refresh();
  return { el: h('div.game-layout', h('div.board-col.solo', board.el), side), destroy() { token++; } };
}

// ---------- Privata meddelanden ----------
export function messagesView(ctx, user) {
  if (!state.user) return { el: h('div.card.narrow', h('h2', 'Meddelanden'), h('p.muted', 'Logga in för att skicka och läsa meddelanden.'), h('a.btn.primary', { href: '/login' }, 'Logga in')) };
  const list = h('div.convlist'), pane = h('div.convpane');
  const el = h('div.card.wide.messages', h('h2', 'Meddelanden'), h('div.msggrid', list, pane));
  let alive = true;
  const loadList = () => api('/api/messages').then(({ conversations }) => {
    if (!alive) return;
    list.replaceChildren(...(conversations.length ? conversations.map((c) => h('a.conv' + (c.username === user ? '.active' : ''), { href: `/messages/${encodeURIComponent(c.username)}` },
      c.avatar ? avatarImg(c.avatar, 34) : h('span.pfp-ph', c.username[0].toUpperCase()),
      h('span.convtext', h('strong', c.username), h('small', (c.mine ? 'Du: ' : '') + c.text.slice(0, 60))),
      c.unread ? h('span.badge-n', c.unread) : null))
      : [h('p.muted', 'Inga samtal ännu. Skriv till någon från deras profil.')]));
  }).catch(() => {});
  const loadThread = () => api(`/api/messages/${encodeURIComponent(user)}`).then(({ with: other, messages }) => {
    if (!alive) return;
    const log = h('div.thread', messages.map((m) => h('div.bubble' + (m.mine ? '.mine' : ''), h('p', m.text), h('small', when(m.at)))));
    const input = h('textarea', { rows: 2, placeholder: `Skriv till ${other.username}…`, maxlength: 1000 });
    const err = h('p.error');
    const sendMsg = async () => {
      const text = input.value.trim();
      if (!text) return;
      try { await api(`/api/messages/${encodeURIComponent(other.username)}`, { text }); input.value = ''; loadThread(); loadList(); } catch (e) { err.textContent = e.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
    pane.replaceChildren(h('div.convhead', other.avatar ? avatarImg(other.avatar, 30) : null, userLink(other.username)),
      messages.length ? log : h('p.muted.empty', 'Inga meddelanden än. Säg hej!'), h('div.compose', input, h('button.primary', { onclick: sendMsg }, 'Skicka')), err);
    log.scrollTop = log.scrollHeight;
    refreshBadges();
  }).catch((e) => pane.replaceChildren(h('p.error', e.message)));
  loadList();
  if (user) loadThread(); else pane.replaceChildren(h('p.muted.empty', 'Välj ett samtal till vänster.'));
  const off = on((m) => { if (m.t === 'dm') { loadList(); if (user && (m.from === user || m.to === user)) loadThread(); } });
  return { el, destroy() { alive = false; off(); } };
}

// ---------- Sidhuvudet: kuvert och klocka med antal olästa ----------
const badges = { messages: 0, notes: 0 };
// Ett klick utanför aviseringspanelen stänger den.
document.addEventListener('click', (e) => { for (const p of document.querySelectorAll('.notepanel')) if (!p.contains(e.target)) p.hidden = true; });
let badgeEls = null;
export function refreshBadges() {
  if (!state.user) return;
  api('/api/notifications').then((r) => { badges.messages = r.unreadMessages; badges.notes = r.unread; paintBadges(); }).catch(() => {});
}
function paintBadges() {
  if (!badgeEls) return;
  badgeEls.mail.textContent = badges.messages || ''; badgeEls.mail.hidden = !badges.messages;
  badgeEls.bell.textContent = badges.notes || ''; badgeEls.bell.hidden = !badges.notes;
}
export function headerIcons() {
  if (!state.user) return [];
  const mailN = h('span.badge-n'), bellN = h('span.badge-n'), panel = h('div.notepanel', { hidden: true });
  badgeEls = { mail: mailN, bell: bellN };
  paintBadges();
  const bell = h('button.small.iconbtn.bellbtn', {
    title: 'Aviseringar',
    onclick: async (e) => {
      e.stopPropagation();
      if (!panel.hidden) { panel.hidden = true; return; }
      panel.hidden = false;
      panel.replaceChildren(h('p.muted', 'Laddar…'));
      const r = await api('/api/notifications').catch(() => ({ items: [] }));
      panel.replaceChildren(h('div.notehead', h('strong', 'Aviseringar')),
        ...(r.items.length ? r.items.map((n) => h(n.link ? 'a.note' : 'div.note', { href: n.link || undefined, class: n.read ? '' : 'unread', onclick: () => { panel.hidden = true; } },
          icon({ friend: 'users', corr: 'clock', achievement: 'medal', tournament: 'trophy', club: 'shield' }[n.kind] || 'bell', 16), h('span', n.text), h('small', when(n.created_at))))
          : [h('p.muted', 'Inga aviseringar ännu.')]));
      if (r.unread) { api('/api/notifications/read', {}).catch(() => {}); badges.notes = 0; paintBadges(); }
    },
  }, icon('bell', 16), bellN);
  return [h('a.btn.small.iconbtn.bellbtn', { href: '/messages', title: 'Meddelanden' }, icon('mail', 16), mailN), h('span.bellwrap', bell, panel)];
}
on((m) => {
  if (m.t === 'notify') { badges.notes = m.unread; paintBadges(); }
  if (m.t === 'dm' && m.from) { badges.messages = m.unreadMessages; paintBadges(); }
  if (m.t === 'conn' && net.connected) refreshBadges();
});

// ---------- Dela ett parti: länk, PGN och animerad GIF ----------
export function shareBar(src, steps, orientation) {
  const msg = h('span.muted.sharemsg');
  const pgn = () => {
    if (src.pgn) return src.pgn;
    const head = [['Event', 'Schack Online'], ['White', src.white?.name || '?'], ['Black', src.black?.name || '?'], ['Result', src.result || '*']];
    if (src.startFen) head.push(['Variant', 'Chess960'], ['SetUp', '1'], ['FEN', src.startFen]);
    const body = src.moves.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + s).join(' ');
    return head.map(([k, v]) => `[${k} "${v}"]`).join('\n') + `\n\n${body} ${src.result || '*'}`;
  };
  const fileBase = `${src.white?.name || 'vit'}-${src.black?.name || 'svart'}`.replace(/[^\wåäöÅÄÖ-]+/g, '_');
  return h('div.sharebar', h('span.sharelabel', icon('share', 16), 'Dela partiet'),
    h('div.btnrow.left',
      src.id && h('button.small', { onclick: () => navigator.clipboard?.writeText(`${location.origin}/review/${src.id}`).then(() => { msg.textContent = 'Länken är kopierad.'; }) }, icon('link', 15), ' Kopiera länk'),
      h('button.small', { onclick: () => download(new Blob([pgn()], { type: 'application/x-chess-pgn' }), `${fileBase}.pgn`) }, icon('download', 15), ' PGN'),
      h('button.small', {
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true; msg.textContent = 'Skapar bilden…';
          try {
            const title = `${src.white?.name || 'Vit'} – ${src.black?.name || 'Svart'}${src.result ? '  ' + src.result : ''}`;
            download(await gameGif(steps, { orientation, title }), `${fileBase}.gif`);
            msg.textContent = '';
          } catch (ex) { msg.textContent = 'Bilden kunde inte skapas.'; console.error(ex); }
          b.disabled = false;
        },
      }, icon('film', 15), ' GIF')),
    msg);
}

// ---------- Lagmatcher på klubbsidan ----------
export function clubMatchesCard(club, isOwner) {
  const el = h('div.card.wide', h('h2', 'Lagmatcher'), h('p.muted', 'Laddar…'));
  async function load() {
    const [{ matches }, { clubs }] = await Promise.all([api(`/api/clubs/${club.id}/matches`), isOwner ? api('/api/clubs') : Promise.resolve({ clubs: [] })]).catch(() => [{ matches: [] }, { clubs: [] }]);
    const act = (id, a) => api(`/api/matches/${id}/${a}`, {}).then(load).catch((e) => alert(e.message));
    const status = (m) => (m.status === 'proposed' ? (m.incoming ? 'Utmaning till er' : 'Väntar på svar') : m.status === 'open' ? 'Startar snart' : m.status === 'running' ? 'Pågår' : 'Avslutad');
    const rows = matches.map((m) => h('div.friend', h('strong', m.name), h('span.muted', ` · ${m.tc} · ${m.duration} min · ${status(m)}`), h('span.spacer'),
      m.status === 'proposed' && isOwner && m.incoming && h('button.small.primary', { onclick: () => act(m.id, 'accept') }, 'Anta'),
      m.status === 'proposed' && isOwner && h('button.small', { onclick: () => act(m.id, 'decline') }, m.incoming ? 'Avböj' : 'Dra tillbaka'),
      m.status !== 'proposed' && h('a.btn.small', { href: `/tournament/${m.id}` }, 'Öppna')));
    const others = clubs.filter((c) => c.id !== club.id);
    const form = isOwner && others.length > 0 && (() => {
      const opp = h('select', others.map((c) => h('option', { value: c.id }, `${c.name} (${c.members})`)));
      const tc = h('select', ['3+0', '3+2', '5+0', '5+3', '10+0', '10+5'].map((t) => h('option', { value: t, selected: t === '5+3' }, t)));
      const dur = h('select', [20, 30, 45, 60, 90].map((d) => h('option', { value: d, selected: d === 45 }, `${d} min`)));
      const start = h('select', [[10, 'om 10 min'], [30, 'om 30 min'], [60, 'om 1 tim'], [180, 'om 3 tim'], [1440, 'i morgon']].map(([v, l]) => h('option', { value: v, selected: v === 60 }, l)));
      const err = h('p.error');
      return h('div', h('h3', 'Utmana en annan klubb'),
        h('p.muted', 'En arena där era medlemmar bara möter den andra klubbens. Alla poäng räknas ihop per lag. Den andra klubbens ledare måste anta utmaningen.'),
        h('div.formrow', h('label', 'Motståndare ', opp), h('label', 'Betänketid ', tc), h('label', 'Längd ', dur), h('label', 'Start ', start)),
        err, h('button.primary', { onclick: () => api(`/api/clubs/${club.id}/challenge`, { opponent: opp.value, tc: tc.value, duration: Number(dur.value), startsIn: Number(start.value) }).then(load).catch((e) => { err.textContent = e.message; }) }, 'Skicka utmaning'));
    })();
    el.replaceChildren(h('h2', 'Lagmatcher'), ...(rows.length ? rows : [h('p.muted', 'Klubben har inte spelat några lagmatcher än.')]), form || (isOwner ? h('p.muted', 'Det behövs minst en klubb till för att kunna utmana.') : null));
  }
  load();
  return el;
}

// Steg (ställningar) för ett parti, för GIF-bilden.
export function stepsFor(moves, startFen, ChessClass = Chess) {
  const c = startFen ? new ChessClass(startFen) : new ChessClass(), steps = [{ fen: c.fen() }];
  for (const san of moves) { const m = c.move(san); steps.push({ fen: c.fen(), from: m.from, to: m.to }); }
  return steps;
}
export { parseFen };
