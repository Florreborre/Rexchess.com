// Inställningar och konto, klubbar, admin, korrespondensschack, pågående partier och privata länkar.
import { h, state, api, go, titleEl, userLink, settings, saveSettings, BOARD_THEMES, playSound, REASONS, countrySelect, LANGUAGES } from './util.js';
import { net, send, on, disconnect } from './net.js';
import { GameScreen } from './game.js';
import { chatBox } from './chat.js';

const needLogin = (title, text) => ({ el: h('div.card.narrow', h('h2', title), h('p.muted', text), h('a.btn.primary', { href: '/login', onclick: () => { state.after = location.pathname; } }, 'Logga in / skapa konto')) });
const date = (ms) => new Date(ms).toLocaleDateString('sv-SE');

// ---------- Inställningar och konto ----------
export function settingsView(ctx) {
  const toggle = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: settings[key], onchange: (e) => { saveSettings({ [key]: e.target.checked }); if (key === 'sound') playSound('move'); } }), ' ', label);
  const look = h('div.card.wide',
    h('h2', 'Inställningar'),
    h('p.muted', 'Sparas i den här webbläsaren.'),
    h('h3', 'Utseende'),
    h('div.themes', [['light', 'Ljust'], ['dark', 'Mörkt'], ['auto', 'Följ systemet']].map(([key, name]) =>
      h('button' + (settings.theme === key ? '.active' : ''), { onclick: () => { saveSettings({ theme: key }); ctx.refresh(); } }, name))),
    h('h3', 'Språk'),
    h('div.themes', Object.entries(LANGUAGES).map(([key, name]) =>
      h('button' + (settings.lang === key ? '.active' : ''), { onclick: () => { saveSettings({ lang: key }); location.reload(); } }, name))),
    h('h3', 'Brädets färger'),
    h('div.themes', Object.entries(BOARD_THEMES).map(([key, [name, light, dark]]) =>
      h('button' + (settings.board === key ? '.active' : ''), { onclick: () => { saveSettings({ board: key }); ctx.refresh(); } },
        h('span.swatch', { style: { background: `linear-gradient(135deg, ${light} 50%, ${dark} 50%)` } }), name))),
    h('h3', 'Ljud'),
    toggle('sound', 'Spela ljud'),
    h('label.check', 'Volym ', h('input', { type: 'range', min: 0.1, max: 1, step: 0.1, value: settings.volume, onchange: (e) => { saveSettings({ volume: Number(e.target.value) }); playSound('move'); } })),
    h('h3', 'Bräde'),
    toggle('autoQueen', 'Förvandla alltid bonden till dam (utan att fråga)'),
    toggle('hints', 'Visa vart den valda pjäsen kan gå'),
    toggle('coords', 'Visa bokstäver och siffror på brädet'));
  if (!state.user) return { el: h('div.stack', look, h('div.card.wide', h('h2', 'Konto'), h('p.muted', 'Logga in för att byta lösenord eller hantera ditt konto.'), h('a.btn.primary', { href: '/login' }, 'Logga in'))) };

  const cur = h('input', { type: 'password', placeholder: 'Nuvarande lösenord', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', placeholder: 'Nytt lösenord (minst 6 tecken)', autocomplete: 'new-password', minlength: 6, required: true });
  const pwMsg = h('p.error');
  const delPw = h('input', { type: 'password', placeholder: 'Ditt lösenord', autocomplete: 'current-password', required: true });
  const delMsg = h('p.error');
  const blocked = h('div', h('p.muted', 'Laddar…'));
  const loadBlocks = () => api('/api/blocks').then(({ blocked: list }) => {
    blocked.replaceChildren(...(list.length ? list.map((name) => h('div.friend', userLink(name), h('span.spacer'),
      h('button.small', { onclick: () => api('/api/block/unblock', { username: name }).then(loadBlocks) }, 'Sluta blockera')))
      : [h('p.muted', 'Du har inte blockerat någon.')]));
  }).catch(() => {});
  loadBlocks();
  const account = h('div.card.wide',
    h('h2', 'Konto'),
    h('p', 'Inloggad som ', h('strong', state.user.username), '. ', state.user.admin && h('a', { href: '/admin' }, 'Öppna adminsidan')),
    h('h3', 'Land'),
    h('label.check', countrySelect(state.user.country || '', (e) => api('/api/account/country', { country: e.target.value }).then((r) => { state.user.country = r.country; }).catch(() => {}))),
    h('h3', 'Byt lösenord'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/account/password', { current: cur.value, next: next.value });
          cur.value = next.value = '';
          pwMsg.className = 'up';
          pwMsg.textContent = 'Lösenordet är bytt.';
        } catch (ex) { pwMsg.className = 'error'; pwMsg.textContent = ex.message; }
      },
    }, cur, next, pwMsg, h('button.primary', { type: 'submit' }, 'Byt lösenord')),
    h('p.muted', 'Det finns ingen e-post kopplad till kontot, så ett glömt lösenord går inte att återställa. Välj ett du kommer ihåg.'),
    h('h3', 'Blockerade spelare'), blocked,
    h('h3', 'Ta bort kontot'),
    h('p.muted', 'Kontot, vänlistan och dina prestationer tas bort för gott. Dina spelade partier finns kvar hos motståndarna.'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!confirm('Vill du verkligen ta bort ditt konto? Det går inte att ångra.')) return;
        try {
          await api('/api/account/delete', { password: delPw.value });
          state.user = null;
          disconnect();
          go('/play');
        } catch (ex) { delMsg.textContent = ex.message; }
      },
    }, delPw, delMsg, h('button', { type: 'submit' }, 'Ta bort mitt konto')));
  return { el: h('div.stack', look, account) };
}

// ---------- Klubbar ----------
export function clubsView(ctx, id) {
  const el = h('div.stack', h('div.card.wide', h('p.muted', 'Laddar…')));
  let chat = null, alive = true;
  if (id) {
    const load = () => api(`/api/clubs/${encodeURIComponent(id)}`).then(({ club, members, owner, member }) => {
      if (!alive) return;
      const act = (a) => api(`/api/clubs/${club.id}/${a}`, {}).then(() => (a === 'leave' && members.length === 1 ? go('/clubs') : load())).catch((e) => alert(e.message));
      chat ??= chatBox(`club:${club.id}`);
      el.replaceChildren(h('div.card.wide',
        h('div.revhead', h('h2', club.name), h('a.btn.small', { href: '/clubs' }, 'Alla klubbar')),
        club.description && h('p', club.description),
        h('p.muted', `Grundad ${date(club.created_at)} · ledare: ${owner} · ${members.length} ${members.length === 1 ? 'medlem' : 'medlemmar'}`),
        !state.user ? h('a.btn.primary', { href: '/login' }, 'Logga in för att gå med')
          : member ? h('button', { onclick: () => act('leave') }, 'Lämna klubben') : h('button.primary', { onclick: () => act('join') }, 'Gå med'),
        h('h3', 'Medlemmar'),
        h('div.tablewrap', h('table', h('thead', h('tr', ['#', 'Spelare', 'Rating', ''].map((t) => h('th', t)))),
          h('tbody', members.map((m, i) => h('tr', h('td', i + 1), h('td', titleEl(m.title), ' ', userLink(m.username)), h('td', m.rating),
            h('td', h('span.presence' + (m.online ? '.online' : ''))))))))),
      h('div.card.wide', chat.el));
    }).catch((e) => el.replaceChildren(h('div.card.narrow', h('h2', 'Klubb'), h('p.error', e.message), h('a.btn', { href: '/clubs' }, 'Alla klubbar'))));
    load();
    return { el, destroy() { alive = false; chat?.destroy(); } };
  }
  const name = h('input', { placeholder: 'Klubbens namn', maxlength: 30, required: true });
  const desc = h('input', { placeholder: 'Kort beskrivning (valfritt)', maxlength: 300 });
  const err = h('p.error');
  api('/api/clubs').then(({ clubs, mine }) => {
    if (!alive) return;
    el.replaceChildren(...[
      h('div.card.wide', h('h2', 'Klubbar'),
        h('p.muted', 'En klubb är ett lag. I turneringar räknas klubbens fyra bästa spelares poäng ihop till en lagställning. Man kan vara med i en klubb i taget.'),
        mine && h('p', 'Din klubb: ', h('a', { href: `/clubs/${mine.id}` }, h('strong', mine.name))),
        clubs.length ? h('div.tablewrap', h('table', h('thead', h('tr', ['Klubb', 'Medlemmar', 'Snittrating', ''].map((t) => h('th', t)))),
          h('tbody', clubs.map((c) => h('tr', h('td', h('strong', c.name), c.description && h('span.muted', ` – ${c.description.slice(0, 60)}`)), h('td', c.members), h('td', c.avg ?? '–'),
            h('td', h('a.btn.small', { href: `/clubs/${c.id}` }, 'Öppna')))))))
          : h('p.muted', 'Det finns inga klubbar ännu. Starta den första!')),
      state.user && !mine && h('div.card.wide', h('h2', 'Starta en klubb'),
        h('form', {
          onsubmit: async (e) => {
            e.preventDefault();
            try { go(`/clubs/${(await api('/api/clubs', { name: name.value, description: desc.value })).id}`); } catch (ex) { err.textContent = ex.message; }
          },
        }, name, desc, err, h('button.primary', { type: 'submit' }, 'Starta klubb')))].filter(Boolean));
  }).catch(() => {});
  return { el, destroy() { alive = false; } };
}

// ---------- Admin ----------
export function adminView() {
  if (!state.user?.admin) return { el: h('div.card.narrow', h('h2', 'Admin'), h('p.muted', 'Den här sidan är bara för administratörer.')) };
  const el = h('div.stack', h('div.card.wide', h('p.muted', 'Laddar…')));
  const name = h('input', { placeholder: 'Användarnamn', maxlength: 20, required: true });
  const msg = h('p.error');
  const act = (action, body) => api(`/api/admin/${action}`, body).then(load).catch((e) => { msg.textContent = e.message; });
  const ban = (username) => confirm(`Stänga av ${username}? Kontot loggas ut och kan inte logga in igen.`) && act('ban', { username });
  function load() {
    api('/api/admin').then(({ reports, flags, banned }) => {
      el.replaceChildren(
        h('div.card.wide', h('h2', 'Rapporter'),
          reports.length ? reports.map((r) => h('div.friend', h('span', userLink(r.reporter_name), ' rapporterade ', userLink(r.target_name), h('span.muted', ` · ${date(r.created_at)}`), h('br'), r.reason),
            h('span.spacer'), h('button.small', { onclick: () => ban(r.target_name) }, 'Stäng av'), h('button.small.primary', { onclick: () => act('resolve', { id: r.id }) }, 'Klar')))
            : h('p.muted', 'Inga olösta rapporter.')),
        h('div.card.wide', h('h2', 'Misstänkt fusk'),
          h('p.muted', 'Konton flaggas automatiskt när träffsäkerheten är orimligt hög i flera längre partier i rad. En flagga är en varning, inget bevis – titta på partierna innan du gör något.'),
          flags.length ? flags.map((f) => h('div.friend', h('span', userLink(f.username), h('span.muted', ` · ${date(f.created_at)}`), h('br'), f.reason),
            h('span.spacer'), h('button.small', { onclick: () => ban(f.username) }, 'Stäng av'), h('button.small.primary', { onclick: () => act('unflag', { username: f.username }) }, 'Ta bort flaggan')))
            : h('p.muted', 'Inga flaggade konton.')),
        h('div.card.wide', h('h2', 'Avstängda konton'),
          banned.length ? banned.map((b) => h('div.friend', h('strong', b.username), h('span.prating', ` (${b.rating})`), h('span.spacer'),
            h('button.small', { onclick: () => act('unban', { username: b.username }) }, 'Häv avstängningen')))
            : h('p.muted', 'Inga avstängda konton.'),
          h('h3', 'Stäng av ett konto'),
          h('form.inline', { onsubmit: (e) => { e.preventDefault(); msg.textContent = ''; ban(name.value.trim()); } }, name, h('button', { type: 'submit' }, 'Stäng av')), msg));
    }).catch((e) => el.replaceChildren(h('div.card.narrow', h('p.error', e.message))));
  }
  load();
  return { el };
}

// ---------- Pågående partier ----------
export function liveView() {
  const el = h('div.card.wide', h('h2', 'Pågående partier'), h('p.muted', 'Laddar…'));
  const load = () => api('/api/live').then(({ games }) => {
    el.replaceChildren(h('h2', 'Pågående partier'),
      games.length ? h('div.tablewrap', h('table', h('thead', h('tr', ['Vit', 'Svart', 'Tid', 'Drag', ''].map((t) => h('th', t)))),
        h('tbody', games.map((g) => h('tr',
          h('td', titleEl(g.white.title), ' ', userLink(g.white.name), h('span.prating', ` (${g.white.rating})`)),
          h('td', titleEl(g.black.title), ' ', userLink(g.black.name), h('span.prating', ` (${g.black.rating})`)),
          h('td', g.tc, g.tournament && h('span.muted', ' · turnering')), h('td', Math.ceil(g.plies / 2)),
          h('td', h('a.btn.small.primary', { href: `/watch/${g.id}` }, 'Titta')))))))
        : h('p.muted', 'Inga partier spelas just nu.'));
  }).catch(() => {});
  load();
  const timer = setInterval(load, 5000);
  return { el, destroy() { clearInterval(timer); } };
}

// ---------- Privat länk till ett parti ----------
export function joinView(ctx, id) {
  if (!state.user) return needLogin('Du är inbjuden till ett parti', 'Logga in eller skapa ett konto, så börjar partiet direkt.');
  const el = h('div.card.narrow', h('p.muted', 'Laddar…'));
  let off = () => {};
  api(`/api/invites/${encodeURIComponent(id)}`).then(({ tc, host, mine }) => {
    if (mine) {
      const url = `${location.origin}/join/${id}`, link = h('input', { value: url, readonly: true, onclick: (e) => e.target.select() });
      const copied = h('span.up');
      el.replaceChildren(h('h2', 'Utmana via länk'), h('p', `Skicka länken till den du vill spela mot (${tc}). Partiet börjar när den öppnas.`), link,
        h('div.btnrow', h('button.primary', { onclick: () => navigator.clipboard?.writeText(url).then(() => { copied.textContent = ' Kopierad!'; }) }, 'Kopiera länken'), copied),
        h('div.seeking', h('span.spinner'), 'Väntar på motståndare… Stanna kvar på sidan. Länken gäller i 30 minuter.'));
    } else {
      el.replaceChildren(h('h2', 'Parti via länk'), h('p', h('strong', host), ` har bjudit in dig till ett parti (${tc}).`), h('div.seeking', h('span.spinner'), 'Startar partiet…'));
      const join = () => send({ t: 'join_invite', id });
      off = on((m) => { if (m.t === 'conn' && net.connected) join(); });
      join();
    }
  }).catch((e) => el.replaceChildren(h('h2', 'Parti via länk'), h('p.error', e.message), h('a.btn', { href: '/play' }, 'Till startsidan')));
  return { el, destroy() { off(); } };
}

// ---------- Korrespondensschack ----------
function timeLeft(deadline) {
  const ms = deadline - Date.now();
  if (ms <= 0) return 'tiden är ute';
  const hours = Math.floor(ms / 3600000);
  return hours >= 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : hours >= 1 ? `${hours} h` : `${Math.max(1, Math.floor(ms / 60000))} min`;
}
export function corrView(ctx, id) {
  if (!state.user) return needLogin('Korrespondensschack', 'Du behöver ett konto för att spela korrespondenspartier.');
  return id ? corrGame(id) : corrList();
}
function corrList() {
  const el = h('div.stack', h('div.card.wide', h('p.muted', 'Laddar…')));
  const days = h('select', [1, 2, 3, 7].map((d) => h('option', { value: d, selected: d === 2 }, `${d} ${d === 1 ? 'dag' : 'dagar'} per drag`)));
  const err = h('p.error');
  const me = state.user.id;
  function load() {
    api('/api/corr').then(({ games, open }) => {
      const mine = games.filter((g) => g.status === 'open'), active = games.filter((g) => g.status === 'active'), done = games.filter((g) => g.status === 'finished');
      const row = (g) => {
        const white = g.white.id === me, opp = white ? g.black.name : g.white.name, myTurn = g.status === 'active' && (g.turn === 'w') === white;
        return h('tr', h('td', h('span.avatar.' + (white ? 'white' : 'black')), ' ', userLink(opp)), h('td', `${Math.ceil(g.moves.length / 2)} drag`),
          h('td', g.status === 'active' ? h('span.' + (myTurn ? 'gold' : 'muted'), myTurn ? `Din tur – ${timeLeft(g.deadline)} kvar` : 'Motståndarens tur') : `${g.result} (${REASONS[g.reason] || g.reason})`),
          h('td', h('a.btn.small' + (myTurn ? '.primary' : ''), { href: `/corr/${g.id}` }, 'Öppna')));
      };
      const table = (list) => h('div.tablewrap', h('table', h('thead', h('tr', ['Motståndare', 'Längd', 'Läge', ''].map((t) => h('th', t)))), h('tbody', list.map(row))));
      el.replaceChildren(...[
        h('div.card.wide', h('h2', 'Korrespondensschack'),
          h('p.muted', 'Partier utan klocka. Varje spelare har ett visst antal dagar på sig per drag; den som inte hinner förlorar på tid. Partierna är orankade och sparas bland dina partier när de är slut.'),
          h('h3', 'Dina pågående partier'), active.length ? table(active) : h('p.muted', 'Du har inga pågående korrespondenspartier.')),
        h('div.card.wide', h('h2', 'Hitta motståndare'),
          h('div.btnrow', days, h('button.primary', { onclick: () => api('/api/corr', { days: Number(days.value) }).then(load).catch((e) => { err.textContent = e.message; }) }, 'Skapa inbjudan')), err,
          mine.map((g) => h('div.friend', `Din inbjudan (${g.days} d per drag) väntar på en motståndare.`, h('span.spacer'),
            h('button.small', { onclick: () => api(`/api/corr/${g.id}/cancel`, {}).then(load) }, 'Ta bort'))),
          h('h3', 'Öppna inbjudningar'),
          open.length ? open.map((g) => h('div.friend', userLink(g.hostName), h('span.prating', ` (${g.hostRating})`), h('span.muted', ` · ${g.days} d per drag`), h('span.spacer'),
            h('button.small.primary', { onclick: () => api(`/api/corr/${g.id}/accept`, {}).then(() => go(`/corr/${g.id}`)).catch((e) => { err.textContent = e.message; }) }, 'Anta')))
            : h('p.muted', 'Inga öppna inbjudningar just nu.')),
        done.length > 0 && h('div.card.wide', h('h2', 'Avslutade'), table(done))].filter(Boolean));
    }).catch((e) => el.replaceChildren(h('div.card.narrow', h('p.error', e.message))));
  }
  load();
  const off = on((m) => { if (m.t === 'corr') load(); });
  return { el, destroy: off };
}
function corrGame(id) {
  const me = state.user.id;
  let game = null, alive = true, busy = false;
  const wrap = h('div', h('div.card.narrow', h('p.muted', 'Laddar partiet…')));
  const post = (action, body = {}) => api(`/api/corr/${id}/${action}`, body).then((r) => { if (r.game) { game = r.game; refresh(); } else load(); }).catch((e) => { alert(e.message); load(); });
  const screen = new GameScreen({
    onMove(from, to, promotion) {
      if (busy) return;
      busy = true;
      try { game.moves = [...game.moves, screen.chess.move({ from, to, promotion }).san]; game.turn = game.turn === 'w' ? 'b' : 'w'; refresh(); } catch { busy = false; return; }
      post('move', { from, to, promotion }).finally(() => { busy = false; });
    },
  });
  function refresh() {
    const g = game;
    if (!g?.white) return wrap.replaceChildren(h('div.card.narrow', h('h2', 'Korrespondensparti'), h('p.muted', 'Inbjudan har inte antagits ännu.'), h('a.btn', { href: '/corr' }, 'Tillbaka')));
    const color = g.white.id === me ? 'w' : g.black.id === me ? 'b' : null, opp = color === 'w' ? 'b' : 'w';
    const P = { w: { name: g.white.name, color: 'w' }, b: { name: g.black.name, color: 'b' } };
    const active = g.status === 'active', myTurn = active && color === g.turn;
    const view = color || 'w';
    screen.update({
      moves: g.moves, orientation: view, movable: myTurn ? color : null, top: P[view === 'w' ? 'b' : 'w'], bottom: P[view], clocks: null,
      status: !active ? `Partiet är slut: ${g.result} (${REASONS[g.reason] || g.reason})`
        : `Korrespondens · ${g.days} d per drag · ${myTurn ? `din tur, ${timeLeft(g.deadline)} kvar` : `${P[g.turn].name} är vid draget (${timeLeft(g.deadline)} kvar)`}`,
      panel: [
        active && color && g.drawOffer === opp && h('div.offer', 'Motståndaren erbjuder remi.', h('div.btnrow', h('button.primary', { onclick: () => post('draw') }, 'Acceptera'))),
        active && color && h('div.btnrow',
          g.drawOffer !== opp && h('button', { disabled: g.drawOffer === color, onclick: () => post('draw') }, g.drawOffer === color ? 'Remi erbjuden' : 'Erbjud remi'),
          h('button', { onclick: () => confirm('Vill du ge upp partiet?') && post('resign') }, 'Ge upp')),
        !active && g.moves.length >= 2 && h('a.btn.primary', { href: `/review/${g.id}` }, 'Analysera partiet'),
        h('a.btn', { href: '/corr' }, 'Alla korrespondenspartier'),
      ],
    });
    if (!wrap.contains(screen.el)) wrap.replaceChildren(screen.el);
  }
  function load() {
    if (busy) return;
    api(`/api/corr/${encodeURIComponent(id)}`).then((r) => { if (alive) { game = r.game; refresh(); } })
      .catch((e) => wrap.replaceChildren(h('div.card.narrow', h('h2', 'Korrespondensparti'), h('p.error', e.message), h('a.btn', { href: '/corr' }, 'Tillbaka'))));
  }
  load();
  const off = on((m) => { if (m.t === 'corr' && m.id === id) load(); });
  const timer = setInterval(load, 20000);
  return { el: wrap, destroy() { alive = false; off(); clearInterval(timer); screen.destroy(); } };
}
