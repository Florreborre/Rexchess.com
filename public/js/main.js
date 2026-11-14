// Startpunkt: router, navigering, inloggning, partihistorik och topplista.
import { Chess } from '/vendor/chess.js';
import { h, state, api, go, titleEl, playSound, userLink } from './util.js';
import { profileView } from './profile.js';
import { net, connect, disconnect, on } from './net.js';
import { lobbyView, onlineGameView, botView } from './game.js';
import { reviewView } from './review.js';
import { friendsView, tournamentsView, tournamentView } from './social.js';
import { send } from './net.js';

const app = document.getElementById('app');
let current = null;

const routes = [
  [/^\/play$/, lobbyView],
  [/^\/game$/, onlineGameView],
  [/^\/bot$/, botView],
  [/^\/review\/([\w-]+)$/, reviewView],
  [/^\/games$/, gamesView],
  [/^\/top$/, leaderboardView],
  [/^\/friends$/, friendsView],
  [/^\/tournaments(\/new)?$/, tournamentsView],
  [/^\/tournament\/([\w-]+)$/, tournamentView],
  [/^\/login$/, loginView],
  [/^\/profile\/([^/]+)$/, profileView],
];

function render() {
  current?.destroy?.();
  current = null;
  const hash = location.pathname;
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      current = view({ refresh: render }, ...m.slice(1));
      app.replaceChildren(current.el);
      renderNav();
      return;
    }
  }
  go('/play');
}

function renderNav() {
  const hash = location.pathname;
  const link = (href, label) => h('a' + (hash.startsWith(href) ? '.active' : ''), { href }, label);
  document.getElementById('nav').replaceChildren(
    link('/play', 'Spela'), link('/bot', 'Mot datorn'), link('/tournament', 'Turneringar'), link('/friends', 'Vänner'),
    link('/games', 'Mina partier'), link('/top', 'Topplista'),
    state.user ? link(`/profile/${encodeURIComponent(state.user.username)}`, 'Min profil') : '',
    net.game && !net.game.over ? h('a.live', { href: '/game' }, '● Pågående parti') : '');
  const box = document.getElementById('userbox');
  if (state.user) {
    box.replaceChildren(h('span.me', titleEl(state.user.title), ' ', userLink(state.user.username), ` ${state.user.rating}`),
      h('button.small', {
        onclick: async () => {
          await api('/api/logout', {});
          state.user = null;
          disconnect();
          go('/play');
          render();
        },
      }, 'Logga ut'));
  } else box.replaceChildren(h('a.btn.small.primary', { href: '/login' }, 'Logga in'));
}

async function refreshMe() {
  const before = state.user?.title;
  state.user = (await api('/api/me')).user;
  if (before && state.user && state.user.title !== before) toast([h('p', 'Ny titel! Du är nu ', titleEl(state.user.title))], 10000);
  renderNav();
}

// ---------- Inloggning / nytt konto ----------
function loginView() {
  let mode = 'login';
  const el = h('div.card.narrow');
  const draw = (error) => {
    const user = h('input', { name: 'username', placeholder: 'Användarnamn', autocomplete: 'username', maxlength: 20, required: true });
    const pass = h('input', { name: 'password', type: 'password', placeholder: 'Lösenord', minlength: 6, required: true,
      autocomplete: mode === 'login' ? 'current-password' : 'new-password' });
    el.replaceChildren(
      h('div.tabs',
        h('button' + (mode === 'login' ? '.active' : ''), { onclick: () => { mode = 'login'; draw(); } }, 'Logga in'),
        h('button' + (mode === 'register' ? '.active' : ''), { onclick: () => { mode = 'register'; draw(); } }, 'Skapa konto')),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            state.user = (await api(mode === 'login' ? '/api/login' : '/api/register', { username: user.value, password: pass.value })).user;
            connect();
            go('/play');
          } catch (err) { draw(err.message); }
        },
      },
      user, pass,
      mode === 'register' && h('p.muted', 'Bara användarnamn och lösenord behövs – ingen e-post. Du börjar på rating 1200.'),
      error && h('p.error', error),
      h('button.primary.big', { type: 'submit' }, mode === 'login' ? 'Logga in' : 'Skapa konto')));
  };
  draw();
  return { el };
}

// ---------- Mina partier ----------
function gamesView() {
  const list = h('div.card.wide', h('h2', 'Mina partier'), h('p.muted', state.user ? 'Laddar…' : 'Logga in för att se dina sparade partier.'));
  const statsLink = () => state.user && h('a.btn', { href: `/profile/${encodeURIComponent(state.user.username)}` }, 'Min statistik och mina öppningar');
  const pgn = h('textarea', { rows: 6, placeholder: 'Klistra in ett parti i PGN-format…' });
  const err = h('p.error');
  const importer = h('div.card.wide', h('h2', 'Analysera PGN'), h('p.muted', 'Du kan också analysera vilket parti som helst genom att klistra in det här.'), pgn, err,
    h('button.primary', {
      onclick: () => {
        try {
          const c = new Chess();
          c.loadPgn(pgn.value.trim());
          if (!c.history().length) throw new Error();
          const hd = c.getHeaders();
          state.review = { moves: c.history(), white: { name: hd.White || 'Vit', rating: Number(hd.WhiteElo) || null },
            black: { name: hd.Black || 'Svart', rating: Number(hd.BlackElo) || null }, result: hd.Result && hd.Result !== '*' ? hd.Result : null };
          go('/review/local');
        } catch { err.textContent = 'Kunde inte läsa partiet. Kontrollera att det är giltig PGN.'; }
      },
    }, 'Analysera'));

  if (state.user) {
    api('/api/games').then(({ games }) => {
      const rows = games.map((g) => {
        const white = g.white_id === state.user.id;
        const score = g.result === '1/2-1/2' ? 'Remi' : (g.result === '1-0') === white ? 'Vinst' : 'Förlust';
        const diff = white ? g.white_diff : g.black_diff;
        return h('tr',
          h('td', new Date(g.created_at).toLocaleDateString('sv-SE')),
          h('td', h('span.avatar.' + (white ? 'white' : 'black')), ' ', (white ? g.black_id : g.white_id) ? userLink(white ? g.black_name : g.white_name) : (white ? g.black_name : g.white_name),
            h('span.prating', ` (${white ? g.black_rating : g.white_rating})`)),
          h('td', h('span.res.' + { Vinst: 'up', Förlust: 'down', Remi: 'draw' }[score], score)),
          h('td', g.rated ? h('span.' + (diff >= 0 ? 'up' : 'down'), `${diff >= 0 ? '+' : ''}${diff}`) : h('span.muted', 'orankat')),
          h('td', g.tc || 'Dator'),
          h('td', `${Math.ceil(g.plies / 2)} drag`),
          h('td', h('a.btn.small.primary', { href: `/review/${g.id}` }, 'Analysera')));
      });
      list.replaceChildren(h('div.revhead', h('h2', 'Mina partier'), statsLink()),
        rows.length ? h('div.tablewrap', h('table', h('thead', h('tr', ['Datum', 'Motståndare', 'Resultat', 'Rating', 'Tid', 'Längd', ''].map((t) => h('th', t)))), h('tbody', rows)))
          : h('p.muted', 'Du har inte spelat några partier ännu.'));
    }).catch(() => {});
  }
  return { el: h('div.stack', list, importer) };
}

// ---------- Topplista ----------
function leaderboardView() {
  const el = h('div.card.wide', h('h2', 'Topplista'), h('p.muted', 'Laddar…'));
  api('/api/leaderboard').then(({ players }) => {
    el.replaceChildren(h('h2', 'Topplista'),
      players.length ? h('div.tablewrap', h('table',
        h('thead', h('tr', ['#', 'Spelare', 'Titel', 'Rating', 'Partier', 'V / R / F'].map((t) => h('th', t)))),
        h('tbody', players.map((p, i) => h('tr' + (p.username === state.user?.username ? '.me' : ''),
          h('td', i + 1), h('td', userLink(p.username), p.trophies ? h('span.gold', { title: 'Vunna turneringar' }, ` 🏆${p.trophies > 1 ? '×' + p.trophies : ''}`) : null),
          h('td', titleEl(p.title)), h('td', p.rating), h('td', p.games), h('td', `${p.wins} / ${p.draws} / ${p.losses}`))))))
        : h('p.muted', 'Inga spelare ännu. Skapa ett konto och bli först!'),
      h('h3', 'Titlar'),
      h('p.muted', 'Titeln bygger på din högsta rating någonsin, så en titel du har nått behåller du. Du behöver minst 5 rankade partier; innan dess är du Tiro (rekryt). 🏆 visar vunna turneringar.'),
      h('div.legend', [['Tiro', 'under 1000'], ['Miles', '1000'], ['Decurio', '1200'], ['Centurio', '1400'], ['Tribunus', '1600'], ['Legatus', '1800'], ['Praetor', '2000'], ['Consul', '2200'], ['Imperator', '2400']]
        .map(([t, r]) => h('span', titleEl(t), ` ${r}`))));
  }).catch(() => {});
  return { el };
}

// ---------- Aviseringar (utmaningar från vänner m.m.) ----------
const toasts = h('div.toasts');
document.body.append(toasts);
function toast(content, ms = 6000) {
  const el = h('div.toast', content);
  toasts.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------- Start ----------
on((m) => {
  if (m.t === 'notice') toast(m.text);
  if (m.t === 'challenge') {
    playSound('challenge');
    const el = toast([h('p', h('strong', m.from), ` utmanar dig på ett parti (${m.tc}).`),
      h('div.btnrow',
        h('button.primary.small', { onclick: () => { send({ t: 'accept', from: m.from }); el.remove(); } }, 'Acceptera'),
        h('button.small', { onclick: () => { send({ t: 'reject', from: m.from }); el.remove(); } }, 'Avböj'))], 60000);
  }
  if (m.t === 'game') {
    if (!m.game.over && location.pathname !== '/game') go('/game');
    if (m.game.over) refreshMe().catch(() => {});
    renderNav();
  }
});
window.addEventListener('popstate', render);
// Vanliga länkar inom sidan byter vy utan att ladda om.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="/"]');
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
// Gamla adresser med # (t.ex. /#/play) och startsidan pekas om till de nya.
if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1));
else if (location.pathname === '/') history.replaceState(null, '', '/play');
refreshMe().catch(() => {}).then(() => {
  connect();
  render();
});
