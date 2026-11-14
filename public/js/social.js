// Vänlista, turneringar, veckans parti och topplistekort.
import { Chess } from '/vendor/chess.js';
import { h, state, api, REASONS, go, titleEl } from './util.js';
import { Board } from './board.js';
import { net, send, on } from './net.js';

const TCS = ['1+0', '3+0', '3+2', '5+0', '10+0', '15+10'];
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
        h('p', h('strong', g.white_name), h('span.prating', ` (${g.white_rating})`), ' mot ', h('strong', g.black_name), h('span.prating', ` (${g.black_rating})`)),
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
      players.length ? h('ol.toplist', players.slice(0, 5).map((p) => h('li', h('strong', p.username), h('span', p.rating))))
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
      titleEl(f.title), h('strong', f.username), h('span.prating', ` (${f.rating})`),
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
  if (t.status === 'open') return `Startar om ${mins(t.starts_at - now)}`;
  if (t.status === 'running') return `Pågår – ${mins(t.ends_at - now)} kvar`;
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
      const err = h('p.error');
      stack.append(h('div.card.wide',
        h('h2', 'Skapa en turnering'),
        h('p.muted', 'Arena: alla anmälda paras ihop om och om igen under turneringstiden. Vinst ger 1 poäng, remi ½. Partierna är rankade.'),
        h('form', {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const { id } = await api('/api/tournaments', { name: name.value, ...fields.values() });
              go(`/tournament/${id}`);
            } catch (ex) { err.textContent = ex.message; }
          },
        },
        name,
        fields.row,
        h('p.muted', 'Du kan ändra tiderna i efterhand på turneringens sida.'),
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
            h('td', h('strong', t.name), h('span.muted', ` av ${t.creator_name}`)), h('td', t.tc), h('td', `${t.duration} min`), h('td', t.players),
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
  let data = null, offset = 0, alive = true, editForm = null;
  const status = h('p.tstatus');

  const tick = () => { if (data) status.textContent = statusText(data.tournament, Date.now() + offset); };
  const ready = () => {
    if (data?.tournament.status === 'running' && data.joined && !(net.game && !net.game.over)) send({ t: 'tready', id });
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
    const playing = net.game && !net.game.over;
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
    else if (t.status === 'open') action = h('div.btnrow', h('span.gold', '✓ Du är anmäld'), h('button', { onclick: () => act('leave') }, 'Lämna'));
    else if (playing) action = h('a.btn.primary', { href: '/game' }, 'Till ditt parti');
    else action = h('div.seeking', h('span.spinner'), 'Väntar på motståndare – du paras ihop automatiskt. Stanna kvar på sidan.');
    tick();
    el.replaceChildren(...[
      h('div.revhead', h('h2', t.name), h('a.btn.small', { href: '/tournaments' }, 'Alla turneringar')),
      h('p.muted', `Arena · ${t.tc} · ${t.duration} min · skapad av ${t.creator_name}`),
      status,
      t.status === 'finished' && players[0]?.games > 0 && h('p.winner', `🏆 Segrare: ${players[0].username} med ${players[0].score} poäng`),
      action,
      canEdit && (editForm || h('button', { onclick: openEdit }, 'Ändra tider')),
      h('h3', `Ställning (${players.length} spelare)`),
      players.length ? h('div.tablewrap', h('table',
        h('thead', h('tr', ['#', 'Spelare', 'Poäng', 'Partier', 'V / R / F'].map((x) => h('th', x)))),
        h('tbody', players.map((p, i) => h('tr' + (p.id === state.user?.id ? '.me' : ''),
          h('td', i + 1), h('td', titleEl(p.title), ' ', h('strong', p.username), h('span.prating', ` (${p.rating})`)), h('td', h('strong', p.score)),
          h('td', p.games), h('td', `${p.wins} / ${p.draws} / ${p.losses}`))))))
        : h('p.muted', 'Inga anmälda ännu.'),
      games.length && h('h3', 'Senaste partierna'),
      games.length && h('div.tgames', games.map((g) => h('a', { href: `/review/${g.id}` },
        `${g.white_name} – ${g.black_name}`, h('span', g.result)))),
    ].filter(Boolean));
  }
  load();
  const off = on((m) => {
    if (m.t === 'tournament' && m.id === id) load();
    if (m.t === 'conn' && net.connected) ready();
  });
  const timer = setInterval(tick, 1000);
  return { el, destroy() { alive = false; off(); clearInterval(timer); send({ t: 'tleave' }); } };
}
