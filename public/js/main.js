// Startpunkt: router, navigering, inloggning, partihistorik och topplista.
import { Chess } from '/vendor/chess.js';
import { h, state, api, go, titleEl, playSound, userLink, applySettings, spriteLoaded, saveSettings, settings, isDark, flagEl, countrySelect, LANGUAGES, avatarImg } from './util.js';
import { profileView } from './profile.js';
import { initI18n } from './i18n.js';
import { net, connect, disconnect, on } from './net.js';
import { lobbyView, onlineGameView, botView, watchView, liveGames } from './game.js';
import { puzzlesView, mistakesView, analysisView, openingsView, endgamesView, trainingView } from './train.js';
import { settingsView, clubsView, adminView, liveView, joinView, corrView } from './more.js';
import { reviewView } from './review.js';
import { friendsView, tournamentsView, tournamentView } from './social.js';
import { send } from './net.js';

const app = document.getElementById('app');
let current = null;

const routes = [
  [/^\/play$/, lobbyView],
  [/^\/game(?:\/([\w-]+))?$/, onlineGameView],
  [/^\/bot$/, botView],
  [/^\/review\/([\w-]+)$/, reviewView],
  [/^\/games$/, gamesView],
  [/^\/top$/, leaderboardView],
  [/^\/friends$/, friendsView],
  [/^\/tournaments(\/new)?$/, tournamentsView],
  [/^\/tournament\/([\w-]+)$/, tournamentView],
  [/^\/login$/, loginView],
  [/^\/profile\/([^/]+)$/, profileView],
  [/^\/watch\/([\w-]+)$/, watchView],
  [/^\/live$/, liveView],
  [/^\/join\/([\w-]+)$/, joinView],
  [/^\/training$/, trainingView],
  [/^\/puzzles(\/daily)?$/, puzzlesView],
  [/^\/train$/, mistakesView],
  [/^\/analysis$/, analysisView],
  [/^\/openings$/, openingsView],
  [/^\/endgames$/, endgamesView],
  [/^\/settings$/, settingsView],
  [/^\/clubs(?:\/([\w-]+))?$/, clubsView],
  [/^\/corr(?:\/([\w-]+))?$/, corrView],
  [/^\/admin$/, adminView],
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
    link('/play', 'Spela'), link('/training', 'Träna'), link('/tournament', 'Turneringar'), link('/clubs', 'Klubbar'), link('/friends', 'Vänner'),
    link('/top', 'Topplista'), link('/games', 'Mina partier'),
    state.user ? link(`/profile/${encodeURIComponent(state.user.username)}`, 'Min profil') : '',
    liveGames().length === 1 ? h('a.live', { href: `/game/${liveGames()[0].id}` }, '● Pågående parti')
      : liveGames().length > 1 ? h('a.live', { href: `/game/${liveGames()[0].id}` }, '● ', `${liveGames().length} pågående partier`) : '');
  const box = document.getElementById('userbox');
  // Snabbknappar i sidhuvudet: mörkt/ljust läge och språk.
  const quick = [
    h('button.small', { title: 'Mörkt eller ljust läge', onclick: () => { saveSettings({ theme: isDark() ? 'light' : 'dark' }); renderNav(); } }, isDark() ? '☀' : '☾'),
    h('select.langsel', { title: 'Språk / Language', onchange: (e) => { saveSettings({ lang: e.target.value }); location.reload(); } },
      Object.keys(LANGUAGES).map((k) => h('option', { value: k, selected: k === settings.lang }, k.toUpperCase()))),
  ];
  if (state.user) {
    box.replaceChildren(state.user.avatar ? avatarImg(state.user.avatar, 26) : '', h('span.me', titleEl(state.user.title), ' ', userLink(state.user.username), ` ${state.user.provisional ? '?' : state.user.rating}`),
      state.user.admin ? h('a.btn.small', { href: '/admin' }, 'Admin') : '',
      ...quick, h('a.btn.small', { href: '/settings', title: 'Inställningar' }, '⚙'),
      h('button.small', {
        onclick: async () => {
          await api('/api/logout', {});
          state.user = null;
          disconnect();
          go('/play');
          render();
        },
      }, 'Logga ut'));
  } else box.replaceChildren(...quick, h('a.btn.small', { href: '/settings', title: 'Inställningar' }, '⚙'), h('a.btn.small.primary', { href: '/login' }, 'Logga in'));
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
    const level = h('select', [['new', 'Ny i schack'], ['beginner', 'Nybörjare'], ['intermediate', 'Medel'], ['advanced', 'Avancerad'], ['expert', 'Expert']]
      .map(([v, label]) => h('option', { value: v, selected: v === 'intermediate' }, label)));
    const country = countrySelect('');
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
            state.user = (await api(mode === 'login' ? '/api/login' : '/api/register', { username: user.value, password: pass.value, level: level.value, country: country.value })).user;
            connect();
            go(state.after || '/play'); // tillbaka dit man var på väg, t.ex. en inbjudningslänk
            state.after = null;
          } catch (err) { draw(err.message); }
        },
      },
      user, pass,
      mode === 'register' && h('label.depth', 'Din nivå ', level),
      mode === 'register' && h('label.depth', 'Land (valfritt) ', country),
      mode === 'register' && h('p.muted', 'Bara användarnamn och lösenord behövs – ingen e-post. Välj ungefär hur van du är, så får du lagom motstånd. Din rating visas efter fem rankade partier.'),
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
  let by = '';
  const el = h('div.card.wide', h('h2', 'Topplista'), h('p.muted', 'Laddar…'));
  const tabs = () => h('div.tabs.small', [['', 'Totalt'], ['bullet', 'Bullet'], ['blitz', 'Blixt'], ['rapid', 'Snabb'], ['season', 'Säsong']].map(([k, label]) =>
    h('button' + (by === k ? '.active' : ''), { onclick: () => { by = k; load(); } }, label)));
  const loadSeason = () => api('/api/seasons').then((s) => {
    el.replaceChildren(...[h('h2', 'Topplista'), tabs(),
      h('p.muted', `Säsong ${s.id}. Rankade partier ger 3 poäng för vinst och 1 för remi. Listan nollställs ${new Date(s.endsAt).toLocaleDateString('sv-SE')}, och vinnaren får en pokal.`),
      s.standings.length ? h('div.tablewrap', h('table',
        h('thead', h('tr', ['#', 'Spelare', 'Poäng', 'Partier', 'Vinster'].map((t) => h('th', t)))),
        h('tbody', s.standings.map((p, i) => h('tr' + (p.username === state.user?.username ? '.me' : ''), h('td', i + 1), h('td', userLink(p.username)), h('td', h('strong', p.points)), h('td', p.games), h('td', p.wins))))))
        : h('p.muted', 'Inga rankade partier har spelats den här säsongen ännu.'),
      s.past.length > 0 && h('h3', 'Tidigare säsongsmästare'),
      s.past.map((p) => h('p', h('strong', p.id), ': ', userLink(p.winner_name), ` (${p.points} poäng)`))].flat().filter(Boolean));
  }).catch(() => {});
  const load = () => (by === 'season' ? loadSeason() : api('/api/leaderboard' + (by ? `?by=${by}` : '')).then(({ players }) => {
    el.replaceChildren(h('h2', 'Topplista'), tabs(),
      players.length ? h('div.tablewrap', h('table',
        h('thead', h('tr', ['#', 'Spelare', 'Titel', 'Rating', 'Partier', 'V / R / F'].map((t) => h('th', t)))),
        h('tbody', players.map((p, i) => h('tr' + (p.username === state.user?.username ? '.me' : ''),
          h('td', i + 1), h('td', flagEl(p.country), ' ', userLink(p.username), p.trophies ? h('span.gold', { title: 'Vunna turneringar' }, ` 🏆${p.trophies > 1 ? '×' + p.trophies : ''}`) : null),
          h('td', titleEl(p.title)), h('td', p.rating), h('td', p.class_games ?? p.games), h('td', `${p.wins} / ${p.draws} / ${p.losses}`))))))
        : h('p.muted', by ? 'Ingen har spelat rankade partier med den betänketiden ännu.' : 'Inga spelare ännu. Skapa ett konto och bli först!'),
      h('h3', 'Titlar'),
      h('p.muted', 'Titeln bygger på din högsta rating någonsin, så en titel du har nått behåller du. Spelare syns på topplistan och får rating och titel efter fem rankade partier. 🏆 visar vunna turneringar.'),
      h('div.legend', [['Nybörjare', 'under 1000'], ['Amatör', '1000'], ['Klubbspelare', '1200'], ['Avancerad', '1400'], ['Expert', '1600'], ['Elit', '1800'], ['Kandidatmästare', '2000'], ['Mästare', '2200'], ['Stormästare', '2400']]
        .map(([t, r]) => h('span', titleEl(t), ` ${r}`))));
  }).catch(() => {}));
  load();
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
  if (m.t === 'achievement') {
    playSound('victory');
    toast([h('p', '🏅 Ny prestation: ', h('strong', m.name)), h('p.muted', m.desc)], 10000);
  }
  if (m.t === 'rematch') {
    const el = toast([h('p', h('strong', m.from), ' vill ha returmatch.'),
      h('div.btnrow', h('button.primary.small', { onclick: () => { send({ t: 'rematch', id: m.id }); el.remove(); } }, 'Acceptera'), h('button.small', { onclick: () => el.remove() }, 'Avböj'))], 60000);
  }
  if (m.t === 'corr' && location.pathname !== `/corr/${m.id}`) toast([h('p', m.text), h('a.btn.small.primary', { href: `/corr/${m.id}` }, 'Öppna partiet')], 15000);
  if (m.t === 'game') {
    // Ett nytt parti: gå dit direkt, om man inte redan sitter i ett annat parti – då kommer en avisering i stället.
    const here = location.pathname === `/game/${m.game.id}`, inOther = location.pathname.startsWith('/game/') && !here
      && net.games.get(location.pathname.slice(6)) && !net.games.get(location.pathname.slice(6)).over;
    if (!m.game.over && !here && !m.restored && !m.game.moves.length && !seen.has(m.game.id)) {
      seen.add(m.game.id);
      const opp = m.game.you === 'w' ? m.game.black : m.game.white;
      if (inOther) { playSound('challenge'); toast([h('p', `Nytt parti mot ${opp.name} (${m.game.tc}).`), h('a.btn.small.primary', { href: `/game/${m.game.id}` }, 'Öppna partiet')], 20000); }
      else go(`/game/${m.game.id}`);
    }
    if (m.game.over) refreshMe().catch(() => {});
    renderNav();
  }
});
const seen = new Set(); // partier som redan har öppnats eller aviserats
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
applySettings();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
refreshMe().catch(() => {}).then(() => spriteLoaded).then(() => initI18n()).then(() => {
  connect();
  render();
});
