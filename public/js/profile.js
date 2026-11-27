// Profilsida: en spelares statistik, mest spelade öppningar, ratingkurva och partier.
import { h, svg, state, api, titleEl, userLink, flagEl, countryName, avatarImg, crownEl, icon } from './util.js';
import { matchOpening } from './openings.js';

const pct = (n, total) => (total ? Math.round((100 * n) / total) : 0);
const timeClass = (tc) => {
  const min = Number(String(tc).split('+')[0]);
  return min < 3 ? 'Bullet' : min < 10 ? 'Blixt' : 'Snabb';
};

// Räknar fram all statistik ur spelarens partier (nyaste först i `games`).
function compute(user, games) {
  const rated = { n: 0, w: 0, d: 0, l: 0 };
  const color = { w: { n: 0, w: 0 }, b: { n: 0, w: 0 } };
  const classes = {}, openings = { w: new Map(), b: new Map() };
  const history = [], accs = [], byClass = { Bullet: [], Blixt: [], Snabb: [] }, days = new Map(), phase = { sum: [0, 0, 0], n: [0, 0, 0] };
  let best = null, streak = 0, longest = 0, run = 0;
  for (const g of [...games].reverse()) { // äldst först
    const white = g.white_id === user.id, side = white ? 'w' : 'b';
    const day = new Date(g.created_at).toDateString();
    days.set(day, (days.get(day) || 0) + 1);
    const score = g.result === '1/2-1/2' ? 'd' : (g.result === '1-0') === white ? 'w' : 'l';
    const name = matchOpening(g.opening).name || 'Övriga öppningar';
    const o = openings[side].get(name) || { name, n: 0, w: 0, d: 0, l: 0 };
    o.n++; o[score]++;
    openings[side].set(name, o);
    if (!g.rated) continue;
    rated.n++; rated[score]++;
    color[side].n++;
    if (score === 'w') color[side].w++;
    const cls = (classes[timeClass(g.tc)] ??= { n: 0, w: 0, d: 0, l: 0 });
    cls.n++; cls[score]++;
    const [myRating, diff, oppName, oppRating, acc] = white
      ? [g.white_rating, g.white_diff, g.black_name, g.black_rating, g.white_acc]
      : [g.black_rating, g.black_diff, g.white_name, g.white_rating, g.black_acc];
    history.push(myRating + diff);
    byClass[timeClass(g.tc)].push({ r: myRating + diff, at: g.created_at });
    if (g.acc_phases) { // träffsäkerhet i öppning, mittspel och slutspel, viktad med antal drag
      try {
        const p = JSON.parse(g.acc_phases);
        p[side].forEach((v, i) => { if (v != null) { phase.sum[i] += v * p.n[side][i]; phase.n[i] += p.n[side][i]; } });
      } catch { /* äldre parti utan fasdata */ }
    }
    if (acc != null) accs.push(acc);
    if (score === 'w' && (!best || oppRating > best.rating)) best = { name: oppName, rating: oppRating, id: g.id };
    run = score === 'w' ? run + 1 : 0;
    longest = Math.max(longest, run);
    streak = run;
  }
  const top = (m) => [...m.values()].sort((a, b) => b.n - a.n).slice(0, 6);
  return {
    rated, color, classes, history, best, streak, longest, byClass, days,
    phases: phase.sum.map((s, i) => (phase.n[i] ? s / phase.n[i] : null)),
    accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
    openings: { w: top(openings.w), b: top(openings.b) },
  };
}

function ratingGraph(history) {
  const pts = [1200, ...history];
  const min = Math.min(...pts) - 20, max = Math.max(...pts) + 20, W = Math.max(pts.length - 1, 1);
  const y = (r) => 100 - ((r - min) / (max - min)) * 100;
  return h('div.rgraph',
    svg('svg', { viewBox: `0 0 ${W} 100`, preserveAspectRatio: 'none' },
      svg('polyline', { points: pts.map((r, i) => `${i},${y(r).toFixed(1)}`).join(' '), class: 'rline' })),
    h('span.rmax', Math.max(...pts)), h('span.rmin', Math.min(...pts)));
}

// Ratingkurvor per betänketid i samma diagram.
const CLASS_COLORS = { Bullet: '#c0392b', Blixt: '#b8913a', Snabb: '#3f7d5a' };
function classGraph(byClass) {
  const series = Object.entries(byClass).filter(([, pts]) => pts.length > 0);
  const all = series.flatMap(([, pts]) => pts);
  if (all.length < 2) return null;
  const t0 = Math.min(...all.map((p) => p.at)), t1 = Math.max(...all.map((p) => p.at)) || t0 + 1;
  const lo = Math.min(...all.map((p) => p.r)) - 25, hi = Math.max(...all.map((p) => p.r)) + 25;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * 1000, y = (r) => 100 - ((r - lo) / (hi - lo)) * 100;
  return h('div',
    h('div.rgraph', svg('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none' },
      ...series.map(([k, pts]) => svg('polyline', { points: pts.map((p) => `${x(p.at).toFixed(1)},${y(p.r).toFixed(1)}`).join(' '), class: 'rline', style: `stroke: ${CLASS_COLORS[k]}` }))),
      h('span.rmax', Math.round(hi - 25)), h('span.rmin', Math.round(lo + 25))),
    h('div.legendrow', series.map(([k, pts]) => h('span', h('i', { style: { background: CLASS_COLORS[k] } }), `${k} ${pts.at(-1).r}`))));
}
// Aktivitet: en ruta per dag det senaste året, mörkare ju fler partier.
function calendar(days) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - 364 - ((today.getDay() + 6) % 7));
  const cells = [];
  let total = 0, active = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const n = days.get(d.toDateString()) || 0;
    total += n; if (n) active++;
    const lvl = n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4;
    cells.push(h('i.l' + lvl, { title: `${d.toLocaleDateString('sv-SE')}: ${n} ${n === 1 ? 'parti' : 'partier'}` }));
  }
  return h('div', h('div.heatmap', cells), h('p.muted.small-note', `${total} partier på ${active} dagar det senaste året.`));
}
function phaseBars(phases) {
  const names = ['Öppning', 'Mittspel', 'Slutspel'];
  if (phases.every((p) => p == null)) return h('p.muted', 'Träffsäkerhet per fas räknas ut för rankade partier på minst åtta drag som spelas från och med nu.');
  return h('div.phases', phases.map((p, i) => h('div.phase', h('span', names[i]), h('div.pbar', h('b', { style: { width: `${p ?? 0}%` } })), h('strong', p == null ? '–' : p.toFixed(1)))));
}

function openingList(title, list) {
  const most = list[0]?.n || 1;
  return h('div.openings', h('h3', title),
    list.length ? list.map((o) => h('div.opening',
      h('div.oname', h('strong', o.name), h('span.muted', ` ${o.n} ${o.n === 1 ? 'parti' : 'partier'}`)),
      h('div.obar', h('span', { style: { width: `${(100 * o.n) / most}%` } })),
      h('div.owdl', h('span.up', `${pct(o.w, o.n)} % vinst`), ' · ', h('span.muted', `${pct(o.d, o.n)} % remi`), ' · ', h('span.down', `${pct(o.l, o.n)} % förlust`))))
      : h('p.muted', 'Inga partier ännu.'));
}

export function profileView(ctx, rawName) {
  const name = decodeURIComponent(rawName);
  const el = h('div.stack', h('div.card.wide', h('p.muted', 'Laddar profilen…')));
  let alive = true;

  function load() {
    api(`/api/users/${encodeURIComponent(name)}`).then(({ user, games, friend }) => {
      if (!alive) return;
      const s = compute(user, games);
      const tile = (label, value, sub) => h('div.tile', h('strong', value), h('span', label), sub && h('small', sub));
      const friendAct = (action) => api(`/api/friends/${action}`, { username: user.username }).then(load).catch((e) => alert(e.message));
      const friendBtn = !state.user ? null
        : friend === 'none' ? h('button.primary.small', { onclick: () => friendAct('request') }, 'Lägg till vän')
        : friend === 'sent' ? h('span.muted', 'Vänförfrågan skickad')
        : friend === 'incoming' ? h('button.primary.small', { onclick: () => friendAct('accept') }, 'Acceptera vänförfrågan')
        : friend === 'accepted' ? h('span.gold', icon('check', 16), ' Vän') : null;

      const own = state.user?.id === user.id;
      const extras = h('div.btnrow.left',
        state.user && !(state.user.id === user.id) && h('a.btn.small', { href: `/messages/${encodeURIComponent(user.username)}` }, icon('mail', 15), ' Skicka meddelande'),
        user.club && h('a.btn.small', { href: `/clubs/${user.club.id}` }, `Klubb: ${user.club.name}`),
        user.gameId && h('a.btn.small.primary', { href: `/watch/${user.gameId}` }, 'Titta på partiet'),
        own && h('a.btn.small', { href: '/settings' }, 'Inställningar och konto'),
        state.user && !own && h('button.small', { onclick: () => api(`/api/block/${user.blocked ? 'unblock' : 'block'}`, { username: user.username }).then(load) }, user.blocked ? 'Sluta blockera' : 'Blockera'),
        state.user && !own && h('button.small', {
          onclick: () => {
            const reason = prompt(`Varför rapporterar du ${user.username}?`);
            if (reason) api('/api/report', { username: user.username, reason }).then(() => alert('Tack, rapporten är skickad till administratören.')).catch((e) => alert(e.message));
          },
        }, 'Rapportera'),
        state.user?.admin && !own && h('button.small', { onclick: () => api(`/api/admin/${user.banned ? 'unban' : 'ban'}`, { username: user.username }).then(load).catch((e) => alert(e.message)) }, user.banned ? 'Häv avstängningen' : 'Stäng av kontot'));
      const header = h('div.card.wide.profilehead',
        user.avatar && avatarImg(user.avatar, 84),
        h('div.pmain',
          h('h2', titleEl(user.title), ' ', flagEl(user.country), ' ', crownEl(user.crown), user.username, user.trophies ? h('span.gold.trophies', { title: 'Vunna turneringar' }, ' ', icon('trophy', 20), user.trophies > 1 ? `×${user.trophies}` : '') : null),
          h('p.muted', h('span.presence' + (user.online ? '.online' : '')), user.playing ? ' Spelar just nu' : user.online ? ' Online' : ' Offline',
            ` · Medlem sedan ${new Date(user.created_at).toLocaleDateString('sv-SE')}`, user.country ? ` · ${countryName(user.country)}` : ''),
          friendBtn, extras),
        user.provisional
          ? h('div.prate', h('strong', '?'), h('span', 'Ingen rating än'), h('small', `Placering: ${user.games} av 5 partier`))
          : h('div.prate', h('strong', user.rating), h('span', 'Rating'), h('small', `Högsta: ${user.peak}`)));

      const stats = h('div.card.wide',
        h('h2', 'Statistik'),
        h('div.tiles', [['bullet', 'Bullet'], ['blitz', 'Blixt'], ['rapid', 'Snabb']].map(([k, label]) =>
          tile(label, user.ratings[k].games && !user.provisional ? user.ratings[k].rating : '–', `${user.ratings[k].games} ${user.ratings[k].games === 1 ? 'parti' : 'partier'}`)),
          tile('Problem', user.puzzleRating, `${user.puzzlesSolved} lösta`)),
        h('p.muted', 'Rating per betänketid: bullet (under 3 min), blixt (3–9 min) och snabb (10 min och längre). Siffrorna nedan gäller alla rankade partier.'),
        h('div.tiles',
          tile('Partier', s.rated.n),
          tile('Vinster', `${pct(s.rated.w, s.rated.n)} %`, `${s.rated.w} V · ${s.rated.d} R · ${s.rated.l} F`),
          tile('Som vit', `${pct(s.color.w.w, s.color.w.n)} %`, `${s.color.w.n} ${s.color.w.n === 1 ? "parti" : "partier"}`),
          tile('Som svart', `${pct(s.color.b.w, s.color.b.n)} %`, `${s.color.b.n} ${s.color.b.n === 1 ? "parti" : "partier"}`),
          tile('Träffsäkerhet', s.accuracy != null ? s.accuracy.toFixed(1) : '–', 'snitt i analyserade partier'),
          user.weeklyWins > 0 && tile('Veckosegrar', String(user.weeklyWins), 'vunna veckoturneringar'),
          tile('Vinstsvit', s.streak, `längsta: ${s.longest}`),
          s.best && tile('Bästa vinst', s.best.rating, `mot ${s.best.name}`)),
        s.history.length > 1 && h('h3', 'Ratingutveckling per betänketid'),
        s.history.length > 1 && (classGraph(s.byClass) || ratingGraph(s.history)),
        h('h3', 'Träffsäkerhet per fas'),
        phaseBars(s.phases),
        h('h3', 'Aktivitet'),
        calendar(s.days),
        Object.keys(s.classes).length > 0 && h('h3', 'Per betänketid'),
        Object.keys(s.classes).length > 0 && h('div.tablewrap', h('table',
          h('thead', h('tr', ['Typ', 'Partier', 'V / R / F', 'Vinster'].map((t) => h('th', t)))),
          h('tbody', ['Bullet', 'Blixt', 'Snabb'].filter((k) => s.classes[k]).map((k) => {
            const c = s.classes[k];
            return h('tr', h('td', h('strong', k)), h('td', c.n), h('td', `${c.w} / ${c.d} / ${c.l}`), h('td', `${pct(c.w, c.n)} %`));
          })))));

      const openings = h('div.card.wide',
        h('h2', 'Mest spelade öppningar'),
        h('p.muted', 'Räknat på alla partier, även mot datorn.'),
        h('div.opencols', openingList('Som vit', s.openings.w), openingList('Som svart', s.openings.b)));

      const rows = games.slice(0, 30).map((g) => {
        const white = g.white_id === user.id;
        const score = g.result === '1/2-1/2' ? 'Remi' : (g.result === '1-0') === white ? 'Vinst' : 'Förlust';
        const [oppName, oppId, oppRating] = white ? [g.black_name, g.black_id, g.black_rating] : [g.white_name, g.white_id, g.white_rating];
        const diff = white ? g.white_diff : g.black_diff;
        return h('tr',
          h('td', new Date(g.created_at).toLocaleDateString('sv-SE')),
          h('td', h('span.avatar.' + (white ? 'white' : 'black')), ' ', oppId ? userLink(oppName) : oppName, h('span.prating', ` (${oppRating})`)),
          h('td', h('span.res.' + { Vinst: 'up', Förlust: 'down', Remi: 'draw' }[score], score)),
          h('td', g.rated ? h('span.' + (diff >= 0 ? 'up' : 'down'), `${diff >= 0 ? '+' : ''}${diff}`) : h('span.muted', 'orankat')),
          h('td', g.tc || 'Dator'),
          h('td', matchOpening(g.opening).name || '–'),
          h('td', h('a.btn.small', { href: `/review/${g.id}` }, 'Se partiet')));
      });
      const gameList = h('div.card.wide',
        h('h2', 'Senaste partierna'),
        rows.length ? h('div.tablewrap', h('table',
          h('thead', h('tr', ['Datum', 'Motståndare', 'Resultat', 'Rating', 'Tid', 'Öppning', ''].map((t) => h('th', t)))),
          h('tbody', rows)))
          : h('p.muted', 'Inga partier ännu.'));

      const badges = h('div.card.wide', h('h2', 'Prestationer'),
        user.achievements.length ? h('div.achs', user.achievements.map((a) => h('div.ach', h('strong', icon('medal', 18), ' ', a.name), h('small', a.desc))))
          : h('p.muted', 'Inga prestationer ännu.'));
      el.replaceChildren(header, stats, badges, openings, gameList);
    }).catch((e) => {
      if (alive) el.replaceChildren(h('div.card.narrow', h('h2', 'Profil'), h('p.error', e.message), h('a.btn', { href: '/top' }, 'Till topplistan')));
    });
  }
  load();
  return { el, destroy() { alive = false; } };
}
