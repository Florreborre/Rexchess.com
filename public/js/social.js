// Vänlista, turneringar, veckans parti och topplistekort.
import { Chess } from '/vendor/chess.js';
import { h, state, api, REASONS, go, titleEl, userLink, crownEl, icon } from './util.js';
import { Board } from './board.js';
import { net, send, on } from './net.js';
const gameIn = (tid) => [...net.games.values()].find((g) => !g.over && g.tournament === tid);
import { chatBox } from './chat.js';

const TCS = ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10'];
const select = (options, value) => h('select', options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
// Fält för turneringens tider: betänketid (minuter + sekunder per drag), längd och ev. minuter till start.
function timeFields(init, withStart = true) {
  const num = (value, min, max) => h('input.num', { type: 'number', min, max, value, required: true });
  const [m, i] = init.tc.split('+');
  const min = num(m, 1, 60), inc = num(i, 0, 30), dur = num(init.duration, 5, 240), start = num(init.startsIn, 0, 1440);
  return {
    row: h('div.formrow',
      h('label', 'Betänketid ', min, ' min + ', inc, ' s per drag'),
      h('label', 'Längd ', dur, ' min'),
      withStart && h('label', 'Startar om ', start, ' min')),
    values: () => ({ tc: `${Number(min.value)}+${Number(inc.value)}`, duration: Number(dur.value), startsIn: Number(start.value) }),
  };
}
const loginPrompt = (title, text) => h('div.card.narrow', h('h2', title), h('p.muted', text), h('a.btn.primary', { href: '/login' }, 'Logga in / skapa konto'));

// ---------- Veckans parti ----------
export function gotwCard() {
  const title = h('h2', 'Veckans parti');
  const el = h('div.card.gotw', title, h('p.muted', 'Laddar…'));
  api('/api/gotw').then(({ game: g }) => {
    if (!g) {
      return el.replaceChildren(title, h('p.muted', 'Inget rankat parti har kvalat in de senaste sju dagarna. Spela ett – det bäst spelade partiet hamnar här för alla att se.'));
    }
    const c = new Chess();
    const sans = g.moves.split(' ');
    for (const san of sans) c.move(san);
    const board = new Board({});
    board.set({ fen: c.fen() });
    el.replaceChildren(title, h('div.gotwrow',
      h('div.miniboard', board.el),
      h('div.gotwinfo',
        h('p', userLink(g.white_name), h('span.prating', ` (${g.white_rating})`), ' mot ', userLink(g.black_name), h('span.prating', ` (${g.black_rating})`)),
        h('p', `${g.result} · ${REASONS[g.reason] || g.reason} · ${Math.ceil(sans.length / 2)} drag`),
        h('p.muted', `Träffsäkerhet: ${g.white_acc.toFixed(1)} / ${g.black_acc.toFixed(1)}`),
        h('a.btn.primary', { href: `/review/${g.id}` }, 'Se partiet'))));
  }).catch(() => {});
  return el;
}

export function topCard() {
  const title = h('h2', 'Topplista');
  const el = h('div.card', title, h('p.muted', 'Laddar…'));
  api('/api/leaderboard').then(({ players }) => {
    el.replaceChildren(title,
      players.length ? h('ol.toplist', players.slice(0, 5).map((p) => h('li', userLink(p.username), h('span', p.rating))))
        : h('p.muted', 'Inga spelare ännu.'),
      h('a.btn', { href: '/top' }, 'Hela listan'));
  }).catch(() => {});
  return el;
}

// ---------- Vänner ----------
export function friendsView() {
  if (!state.user) return { el: loginPrompt('Vänner', 'Du behöver ett konto för att ha en vänlista.') };
  const name = h('input', { placeholder: 'Användarnamn', maxlength: 20 });
  const msg = h('p.error');
  const lists = h('div.stack');
  const tc = select(TCS.map((t) => [t, t]), '5+0');
  const act = (action, username) => api(`/api/friends/${action}`, { username }).then(load).catch((e) => { msg.textContent = e.message; });

  function row(f, buttons) {
    return h('div.friend',
      h('span.presence' + (f.online ? '.online' : ''), { title: f.online ? 'Online' : 'Offline' }),
      titleEl(f.title), userLink(f.username), h('span.prating', ` (${f.rating})`),
      f.playing && h('span.muted', ' · spelar'),
      h('span.spacer'), buttons);
  }
  function load() {
    return api('/api/friends').then(({ friends, incoming, outgoing }) => {
      lists.replaceChildren(...[
        incoming.length && h('div', h('h3', 'Vänförfrågningar'), incoming.map((f) => row(f, [
          h('button.small.primary', { onclick: () => act('accept', f.username) }, 'Acceptera'),
          h('button.small', { onclick: () => act('remove', f.username) }, 'Avböj')]))),
        h('div', h('h3', `Vänner (${friends.length})`),
          friends.length ? friends.map((f) => row(f, [
            h('button.small.primary', { disabled: !f.online || f.playing, onclick: () => send({ t: 'challenge', to: f.username, tc: tc.value }) }, 'Utmana'),
            h('button.small', { onclick: () => act('remove', f.username) }, 'Ta bort')]))
            : h('p.muted', 'Du har inga vänner ännu. Lägg till någon med användarnamnet ovan.')),
        outgoing.length && h('div', h('h3', 'Skickade förfrågningar'), outgoing.map((f) => row(f, [
          h('button.small', { onclick: () => act('remove', f.username) }, 'Ångra')]))),
      ].filter(Boolean));
    }).catch(() => {});
  }
  const el = h('div.card.wide',
    h('h2', 'Vänner'),
    h('form.inline', {
      onsubmit: (e) => {
        e.preventDefault();
        msg.textContent = '';
        if (name.value.trim()) act('request', name.value.trim()).then(() => { name.value = ''; });
      },
    }, name, h('button.primary', { type: 'submit' }, 'Lägg till vän')),
    msg,
    h('label.depth', 'Betänketid för utmaningar: ', tc),
    lists);
  load();
  const off = on((m) => { if (m.t === 'friends' || m.t === 'game') load(); });
  const timer = setInterval(load, 10000);
  return { el, destroy() { off(); clearInterval(timer); } };
}

// ---------- Turneringar ----------
function statusText(t, now) {
  const mins = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  };
  if (t.status === 'proposed') return 'Väntar på svar';
  if (t.status === 'open') return `Startar om ${mins(t.starts_at - now)}`;
  if (t.status === 'running') return t.format && t.format !== 'arena' ? `Pågår – runda ${t.round}${t.format === 'swiss' ? ` av ${t.rounds}` : ''}` : `Pågår – ${mins(t.ends_at - now)} kvar`;
  return 'Avslutad';
}

export function tournamentsView(ctx, showForm) {
  const list = h('div.card.wide', h('h2', 'Turneringar'), h('p.muted', 'Laddar…'));
  const stack = h('div.stack');
  if (showForm) {
    if (!state.user) stack.append(loginPrompt('Skapa en turnering', 'Du behöver ett konto för att skapa en turnering.'));
    else {
      const name = h('input', { placeholder: 'Turneringens namn', maxlength: 40, value: `${state.user.username}s arena` });
      const fields = timeFields({ tc: '3+2', duration: 30, startsIn: 5 });
      const format = select([['arena', 'Arena'], ['swiss', 'Schweizer'], ['knockout', 'Utslagning']], 'arena');
      const rounds = h('input.num', { type: 'number', min: 2, max: 9, value: 5 });
      const err = h('p.error');
      stack.append(h('div.card.wide',
        h('h2', 'Skapa en turnering'),
        h('p.muted', 'Arena: alla anmälda paras ihop om och om igen under turneringstiden. Vinst ger 1 poäng, remi ½. Partierna är rankade.'),
        h('form', {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const { id } = await api('/api/tournaments', { name: name.value, ...fields.values(), format: format.value, rounds: Number(rounds.value) });
              go(`/tournament/${id}`);
            } catch (ex) { err.textContent = ex.message; }
          },
        },
        name,
        h('div.formrow', h('label', 'Format ', format), h('label', 'Rundor (schweizer) ', rounds)),
        h('p.muted', 'Schweizer: alla spelar ett fast antal rundor mot motståndare med liknande poäng. Utslagning: förloraren åker ut, och vid remi går svart vidare. I båda startar nästa runda när alla partier är klara, och längden nedan används inte.'),
        fields.row,
        h('p.muted', 'Skriv 0 vid "Startar om" för att starta direkt. Du kan också starta i förtid eller ändra tiderna på turneringens sida.'),
        err,
        h('button.primary.big', { type: 'submit' }, 'Skapa en turnering'))));
    }
  }
  stack.append(list);

  function load() {
    api('/api/tournaments').then(({ tournaments, now }) => {
      list.replaceChildren(
        h('div.revhead', h('h2', 'Turneringar'), !showForm && h('a.btn.primary', { href: '/tournaments/new' }, 'Skapa en turnering')),
        tournaments.length ? h('div.tablewrap', h('table',
          h('thead', h('tr', ['Namn', 'Tid', 'Längd', 'Spelare', 'Status', ''].map((t) => h('th', t)))),
          h('tbody', tournaments.map((t) => h('tr',
            h('td', t.weekly ? h('span.weeklytag', icon('crown', 14)) : null, h('strong', t.name), h('span.muted', ` av ${t.creator_name}`)), h('td', t.tc), h('td', `${t.duration} min`), h('td', t.players),
            h('td', h('span.' + (t.status === 'running' ? 'up' : t.status === 'open' ? 'gold' : 'muted'), statusText(t, now))),
            h('td', h('a.btn.small', { href: `/tournament/${t.id}` }, 'Öppna')))))))
          : h('p.muted', 'Det finns inga turneringar ännu. Skapa den första!'));
    }).catch(() => {});
  }
  load();
  const off = on((m) => { if (m.t === 'tournament') load(); });
  const timer = setInterval(load, 15000);
  return { el: stack, destroy() { off(); clearInterval(timer); } };
}

export function tournamentView(ctx, id) {
  const el = h('div.card.wide', h('p.muted', 'Laddar turneringen…'));
  let data = null, offset = 0, alive = true, editForm = null, chat = null;
  const status = h('p.tstatus');

  const tick = () => { if (data) status.textContent = statusText(data.tournament, Date.now() + offset); };
  const ready = () => {
    if (data?.tournament.status === 'running' && data.joined && !gameIn(id)) send({ t: 'tready', id });
  };
  function load() {
    api(`/api/tournaments/${encodeURIComponent(id)}`).then((d) => {
      if (!alive) return;
      data = d;
      offset = d.now - Date.now();
      draw();
      ready();
    }).catch((e) => el.replaceChildren(h('h2', 'Turnering'), h('p.error', e.message), h('a.btn', { href: '/tournaments' }, 'Alla turneringar')));
  }
  function draw() {
    const { tournament: t, players, games, joined } = data;
    const act = (action) => api(`/api/tournaments/${t.id}/${action}`, {}).then(load).catch((e) => alert(e.message));
    const playing = gameIn(t.id);
    // Skaparen kan ändra tiderna: allt före start, betänketid och längd under spel.
    const openEdit = () => {
      const fields = timeFields({ tc: t.tc, duration: t.duration, startsIn: Math.max(0, Math.round((t.starts_at - (Date.now() + offset)) / 60000)) }, t.status === 'open');
      const err = h('p.error');
      editForm = h('form.editbox', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api(`/api/tournaments/${t.id}/edit`, fields.values());
            editForm = null;
            load();
          } catch (ex) { err.textContent = ex.message; }
        },
      },
      h('h3', 'Ändra tider'), fields.row,
      t.status === 'running' && h('p.muted', 'Ny betänketid gäller partier som startar efter ändringen. Längden räknas från turneringens start.'),
      err,
      h('div.btnrow', h('button.primary', { type: 'submit' }, 'Spara'), h('button', { type: 'button', onclick: () => { editForm = null; draw(); } }, 'Avbryt')));
      draw();
    };
    const canEdit = state.user?.id === t.creator_id && t.status !== 'finished';
    let action;
    if (!state.user) action = h('a.btn.primary', { href: '/login' }, 'Logga in för att delta');
    else if (t.status === 'finished') action = null;
    else if (!joined) action = h('button.primary', { onclick: () => act('join') }, 'Gå med');
    else if (t.status === 'open') action = h('div.btnrow', h('span.gold', icon('check', 16), ' Du är anmäld'), h('button', { onclick: () => act('leave') }, 'Lämna'));
    else if (playing) action = h('a.btn.primary', { href: `/game/${playing.id}` }, 'Till ditt parti');
    else if (t.format !== 'arena') action = h('div.seeking', h('span.spinner'), 'Nästa runda startar automatiskt när alla partier är klara. Du skickas till ditt parti.');
    else action = h('div.seeking', h('span.spinner'), 'Väntar på motståndare – du paras ihop automatiskt. Stanna kvar på sidan.');
    tick();
    el.replaceChildren(...[
      h('div.revhead', h('h2', t.name), h('a.btn.small', { href: '/tournaments' }, 'Alla turneringar')),
      h('p.muted', `${{ arena: 'Arena', swiss: `Schweizer, ${t.rounds} rundor`, knockout: 'Utslagning' }[t.format] || 'Arena'} · ${t.tc}${t.format === 'arena' ? ` · ${t.duration} min` : ''} · skapad av ${t.creator_name}`),
      status,
      t.status === 'finished' && players[0]?.games > 0 && h('p.winner', icon('trophy', 20), ' ', `Segrare: ${players[0].username} med ${players[0].score} poäng`),
      data.match && h('div.matchscore',
        h('div', h('a.user', { href: `/clubs/${data.match.a.id}` }, data.match.a.name), h('strong', String(data.match.a.score)), h('small', `${data.match.a.players} spelare`)),
        h('span.vs', 'mot'),
        h('div', h('a.user', { href: `/clubs/${data.match.b.id}` }, data.match.b.name), h('strong', String(data.match.b.score)), h('small', `${data.match.b.players} spelare`))),
      t.status === 'proposed' && h('p.muted', 'Lagmatchen väntar på att den utmanade klubbens ledare antar den. Medlemmar i de två klubbarna kan redan anmäla sig.'),
      action,
      canEdit && (editForm || h('div.btnrow',
        t.status === 'open' && h('button.primary', {
          onclick: () => api(`/api/tournaments/${t.id}/edit`, { tc: t.tc, duration: t.duration, startsIn: 0 }).then(load).catch((e) => alert(e.message)),
        }, 'Starta nu'),
        h('button', { onclick: openEdit }, 'Ändra tider'))),
      h('h3', `Ställning (${players.length} spelare)`),
      players.length ? h('div.tablewrap', h('table',
        h('thead', h('tr', ['#', 'Spelare', 'Poäng', 'Partier', 'V / R / F'].map((x) => h('th', x)))),
        h('tbody', players.map((p, i) => h('tr' + (p.id === state.user?.id ? '.me' : '') + (p.out ? '.out' : ''),
          h('td', i + 1), h('td', titleEl(p.title), ' ', crownEl(p.crown), userLink(p.username), h('span.prating', ` (${p.rating})`)), h('td', h('strong', p.score)),
          h('td', p.games), h('td', `${p.wins} / ${p.draws} / ${p.losses}`))))))
        : h('p.muted', 'Inga anmälda ännu.'),
      games.length && h('h3', 'Senaste partierna'),
      games.length && h('div.tgames', games.map((g) => h('a', { href: `/review/${g.id}` },
        `${g.white_name} – ${g.black_name}`, h('span', g.result)))),
      data.teams?.length > 0 && h('h3', 'Lagställning (klubbar)'),
      data.teams?.length > 0 && h('div.tablewrap', h('table', h('thead', h('tr', ['#', 'Klubb', 'Spelare', 'Poäng'].map((x) => h('th', x)))),
        h('tbody', data.teams.map((c, i) => h('tr', h('td', i + 1), h('td', h('a.user', { href: `/clubs/${c.id}` }, c.name)), h('td', c.players), h('td', h('strong', c.score))))))),
      (chat ??= chatBox(`tournament:${id}`)).el,
    ].filter(Boolean));
  }
  load();
  const off = on((m) => {
    if (m.t === 'tournament' && m.id === id) load();
    if (m.t === 'game' && m.game.over && m.game.tournament === id) setTimeout(load, 300);
    if (m.t === 'conn' && net.connected) ready();
  });
  const timer = setInterval(tick, 1000);
  return { el, destroy() { alive = false; off(); clearInterval(timer); chat?.destroy(); send({ t: 'tleave', id }); } };
}
