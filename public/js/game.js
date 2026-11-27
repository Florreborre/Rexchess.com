// Spelvyer: lobby, onlineparti och parti mot datorn.
import { Chess } from '/vendor/chess.js';
import { h, state, api, fmtClock, REASONS, playSound, moveSound, endSound, roman, go, flagOf, avatarImg, icon, pieceSvg } from './util.js';
import { gotwCard, topCard } from './social.js';
import { chatBox } from './chat.js';
import { Board, parseFen } from './board.js';
import { net, send, on } from './net.js';
import { BOTS, botMove, botFromElo } from './engine.js';
import { make960 } from './chess960.js';
const Chess960 = make960(Chess);

const TCS = [['1+0', 'Bullet'], ['2+1', 'Bullet'], ['3+0', 'Blixt'], ['3+2', 'Blixt'], ['5+0', 'Blixt'], ['5+3', 'Blixt'], ['10+0', 'Snabb'], ['10+5', 'Snabb'], ['15+10', 'Snabb']];

function playerBar() {
  const name = h('span.pname'), rating = h('span.prating'), clock = h('span.clock'), title = h('span.title'), flag = h('span.cc'), crown = h('span.crown', icon('crown', 15));
  const pic = h('span.pfp-slot');
  const el = h('div.playerbar', h('div.pinfo', pic, h('span.avatar'), title, flag, crown, name, rating), clock);
  return {
    el, clock,
    set(p) {
      name.textContent = p.name;
      if (pic.dataset.src !== (p.avatar || '')) { pic.dataset.src = p.avatar || ''; pic.replaceChildren(...(p.avatar ? [avatarImg(p.avatar, 30)] : [])); }
      title.textContent = p.title || '';
      title.hidden = !p.title;
      flag.textContent = /^[A-Z]{2}$/.test(p.country || '') ? p.country : '';
      flag.hidden = !flag.textContent;
      crown.hidden = !p.crown;
      rating.textContent = p.rating ? `(${p.rating})` : '';
      el.querySelector('.avatar').className = 'avatar ' + (p.color === 'w' ? 'white' : 'black');
      clock.hidden = !p.hasClock;
    },
  };
}

// Gemensam skärm för ett pågående parti: bräde, spelare, klockor, draglista.
export class GameScreen {
  constructor({ onMove }) {
    this.startFen = undefined;
    this.moves = [];
    this.chess = new Chess();
    this.fens = [this.chess.fen()];
    this.hist = [];
    this.viewPly = 0;
    this.model = null;
    this.premoves = []; // förberedda drag, spelas i tur och ordning
    this.onMove = onMove;
    this.board = new Board({
      movableColor: () => (this.viewPly === this.moves.length ? this.model?.movable : null),
      premoveColor: () => (this.viewPly === this.moves.length ? this.model?.premovable : null),
      targets: (sq) => this.chess.moves({ square: sq, verbose: true }).map((m) => m.to),
      onMove,
      onPremove: (from, to, promotion) => { if (this.premoves.length < 12) this.premoves.push({ from, to, promotion }); this.render(); },
      onCancelPremove: () => { this.premoves = []; this.render(); },
    });
    this.top = playerBar();
    this.bottom = playerBar();
    this.status = h('div.status');
    this.moveList = h('div.movelist');
    this.panel = h('div.panel');
    const nav = (name, title, fn) => h('button.icon', { title, onclick: () => { fn(); this.render(); } }, icon(name, 18));
    this.el = h('div.game-layout',
      h('div.board-col', this.top.el, this.board.el, this.bottom.el),
      this.side = h('div.side', this.status, this.moveList,
        h('div.navrow',
          nav('first', 'Första', () => (this.viewPly = 0)),
          nav('prev', 'Föregående', () => (this.viewPly = Math.max(0, this.viewPly - 1))),
          nav('next', 'Nästa', () => (this.viewPly = Math.min(this.moves.length, this.viewPly + 1))),
          nav('last', 'Sista', () => (this.viewPly = this.moves.length))),
        this.panel));
    this.onKey = (e) => {
      if (e.target.matches?.('input, textarea')) return;
      if (e.key === 'ArrowLeft') this.viewPly = Math.max(0, this.viewPly - 1);
      else if (e.key === 'ArrowRight') this.viewPly = Math.min(this.moves.length, this.viewPly + 1);
      else return;
      this.render();
    };
    document.addEventListener('keydown', this.onKey);
    this.timer = setInterval(() => this.renderClocks(), 100);
  }
  destroy() {
    document.removeEventListener('keydown', this.onKey);
    clearInterval(this.timer);
  }

  update(model) {
    this.model = model;
    const changed = model.startFen !== this.startFen || model.moves.length !== this.moves.length || model.moves.some((m, i) => m !== this.moves[i]);
    if (changed) {
      const grew = model.startFen === this.startFen && model.moves.length > this.moves.length;
      this.startFen = model.startFen;
      this.moves = [...model.moves];
      this.chess = model.variant === '960' ? new Chess960(model.startFen) : new Chess(model.startFen);
      this.fens = [this.chess.fen()];
      this.hist = [];
      for (const san of this.moves) {
        this.hist.push(this.chess.move(san));
        this.fens.push(this.chess.fen());
      }
      this.viewPly = this.moves.length;
      if (grew) playSound(moveSound(this.hist.at(-1)));
      this.animateNext = grew;
    }
    if (!model.movable && !model.premovable) this.premoves = [];
    // Det har blivit vår tur: spela nästa förberedda drag om det är lagligt. Är det inte det strycks alla.
    if (this.premoves.length && model.movable) {
      const pm = this.premoves.shift();
      if (this.chess.moves({ verbose: true }).some((m) => m.from === pm.from && m.to === pm.to)) {
        setTimeout(() => { if (this.model?.movable) this.onMove(pm.from, pm.to, pm.promotion); });
      } else this.premoves = [];
    }
    this.render();
  }

  render() {
    const m = this.model;
    if (!m) return;
    const last = this.viewPly > 0 ? this.hist[this.viewPly - 1] : null;
    let check = null;
    if (last && /[+#]/.test(last.san)) {
      const king = (last.color === 'w' ? 'b' : 'w') + 'k';
      check = Object.entries(parseFen(this.fens[this.viewPly])).find(([, p]) => p === king)?.[0];
    }
    this.board.set({ fen: this.fens[this.viewPly], lastMove: last && { from: last.from, to: last.to }, check, orientation: m.orientation, premoves: this.viewPly === this.moves.length ? this.premoves : [],
      animate: this.animateNext && this.viewPly === this.moves.length });
    this.animateNext = false;
    this.top.set({ ...m.top, hasClock: !!m.clocks });
    this.bottom.set({ ...m.bottom, hasClock: !!m.clocks });
    this.status.textContent = m.status || '';

    const rows = [];
    for (let i = 0; i < this.moves.length; i += 2) {
      const cell = (ply) => this.moves[ply] && h('button.mv' + (this.viewPly === ply + 1 ? '.current' : ''),
        { onclick: () => { this.viewPly = ply + 1; this.render(); } }, this.moves[ply]);
      rows.push(h('div.mvrow', h('span.mvnum', `${roman(i / 2 + 1)}.`), cell(i), cell(i + 1)));
    }
    this.moveList.replaceChildren(...(rows.length ? rows : [h('div.muted', 'Inga drag ännu.')]));
    this.moveList.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
    this.panel.replaceChildren(...(m.panel || []).filter(Boolean));
    this.renderClocks();
  }

  renderClocks() {
    const c = this.model?.clocks;
    if (!c) return;
    for (const bar of [this.top, this.bottom]) {
      const color = bar === this.top ? this.model.top.color : this.model.bottom.color;
      let ms = c[color];
      if (c.running === color) ms -= performance.now() - c.at;
      bar.clock.textContent = fmtClock(ms);
      bar.clock.classList.toggle('running', c.running === color);
      bar.clock.classList.toggle('low', ms < 20000);
      // Varningsljud en gång när den egna klockan går under 10 sekunder.
      if (bar === this.bottom && c.running === color && ms < 10000 && ms > 0 && !this.lowWarned) { this.lowWarned = true; playSound('lowtime'); }
    }
  }
}

function resultText(over, myColor) {
  if (over.result === '*') return 'Partiet avbröts';
  if (over.result === '1/2-1/2') return `Remi – ${REASONS[over.reason]}`;
  const won = (over.result === '1-0') === (myColor === 'w');
  return `${won ? 'Du vann' : 'Du förlorade'} – ${REASONS[over.reason]}`;
}

function confirmButton(label, onConfirm, cls = '') {
  let armed = false;
  const btn = h('button' + cls, {
    onclick: () => {
      if (armed) return onConfirm();
      armed = true;
      btn.textContent = 'Säker? Klicka igen';
      setTimeout(() => { armed = false; btn.textContent = label; }, 3000);
    },
  }, label);
  return btn;
}

// ---------- Lobby ----------
let lobbyVariant = null; // null = vanligt schack, '960' = Chess960
export function lobbyView() {
  const online = h('div.card');
  const draw = () => {
    online.replaceChildren(h('h2', 'Spela online'),
      h('div.tabs.small', [[null, 'Standard'], ['960', 'Chess960']].map(([v, label]) => h('button' + (lobbyVariant === v ? '.active' : ''), { onclick: () => { lobbyVariant = v; draw(); } }, label))),
      h('p.muted', lobbyVariant === '960' ? 'Chess960: pjäserna på första raden ställs upp slumpvis (kungen alltid mellan tornen). Orankat.' : 'Rankade partier mot andra spelare. Välj betänketid: minuter + sekunder som läggs till per drag.'));
    if (!state.user) {
      online.append(h('p', 'Du behöver ett konto för att spela online.'), h('a.btn.primary', { href: '/login' }, 'Logga in / skapa konto'));
    } else if (net.seeking) {
      online.append(h('div.seeking', h('span.spinner'), `Söker motståndare (${net.seeking})…`, net.seekingVariant === '960' ? ' · Chess960' : ''),
        h('button', { onclick: () => send({ t: 'cancel' }) }, 'Avbryt'));
    } else {
      online.append(h('div.tcgrid', TCS.map(([tc, label]) =>
        h('button.tc', { onclick: () => send({ t: 'seek', tc, variant: lobbyVariant }) }, h('strong', tc), h('span', label)))));
      const others = liveGames();
      if (others.length) online.append(h('p.muted', 'Du kan spela flera partier samtidigt.'), gameLinks(others));
      if (!net.connected) online.append(h('p.muted', 'Ansluter till servern…'));
    }
  };
  draw();
  const off = on(draw);
  online.id = 'online';
  const top = heroSection(), weekly = weeklyBanner();
  const grid = h('div.lobby', online,
    h('div.card', h('h2', 'Spela mot datorn'), h('p.muted', 'Fjorton motståndare från nybörjare till full Stockfish, eller välj en egen styrka. Orankat.'),
      h('a.btn.primary', { href: '/bot' }, 'Välj motståndare')),
    h('div.card', h('h2', 'Turneringar'), h('p.muted', 'Samla spelare i en arena: alla paras ihop om och om igen tills tiden är ute. Flest poäng vinner.'),
      h('div.btnrow', h('a.btn.primary', { href: '/tournaments/new' }, 'Skapa en turnering'), h('a.btn', { href: '/tournaments' }, 'Visa alla'))),
    h('div.card', h('h2', 'Träna'), h('p.muted', 'Schackproblem, analysbräde, öppningar och slutspel.'),
      h('div.btnrow', h('a.btn.primary', { href: '/puzzles' }, 'Lös problem'), h('a.btn', { href: '/training' }, 'All träning'))),
    liveCard(), inviteCard(),
    gotwCard(), topCard(),
    h('div.card', h('h2', 'Klubbar'), h('p.muted', 'Gå med i en klubb eller starta en egen. Klubbar tävlar som lag i turneringar.'),
      h('a.btn', { href: '/clubs' }, 'Visa klubbar')),
    h('div.card', h('h2', 'Korrespondens'), h('p.muted', 'Partier utan klocka: du har en eller flera dagar på dig per drag.'),
      h('a.btn', { href: '/corr' }, 'Korrespondenspartier')),
    h('div.card', h('h2', 'Vänner'), h('p.muted', 'Lägg till vänner, se vilka som är online och utmana dem på ett parti.'),
      h('a.btn', { href: '/friends' }, 'Vänlista')),
    h('div.card', h('h2', 'Analysera'), h('p.muted', 'Gå igenom dina partier drag för drag med träffsäkerhet, bedömning av varje drag och bästa drag.'),
      h('a.btn', { href: '/games' }, 'Mina partier')));
  // Varje kort får en stor pjäs som bild i hörnet.
  const arts = ['wn', 'bq', 'wk', 'bb', 'wp', 'bn', null, 'wq', 'wr', 'bp', 'wb', 'bk'];
  [...grid.children].forEach((card, i) => { if (arts[i]) { card.classList.add('has-art'); card.append(h('div.card-art', pieceSvg(arts[i]))); } });
  const el = h('div.home', top.el, weekly.el, grid);
  return { el, destroy() { off(); top.destroy(); weekly.destroy(); } };
}

// Stor startsektion överst: rubrik, knappar, levande siffror och ett svävande bräde som spelar upp ett klassiskt parti.
const CLASSICS = [
  { white: 'Paul Morphy', black: 'Hertigen av Braunschweig och greve Isouard', place: 'Paris', year: 1858, label: 'Operapartiet',
    moves: 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#' },
  { white: 'Adolf Anderssen', black: 'Lionel Kieseritzky', place: 'London', year: 1851, label: 'Det odödliga partiet',
    moves: 'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#' },
];
function heroSection() {
  const stat = (label) => { const v = h('strong', '–'); return { v, el: h('div.hstat', v, h('span', label)) }; };
  const online = stat('spelare online'), playing = stat('partier just nu'), players = stat('registrerade spelare');
  const board = new Board({});
  const caption = h('div.hero-caption'), moveLine = h('div.hero-moves');
  let gameIx = 0, ply = 0, plan = null, alive = true, timer = null;
  function prepare() { // räkna fram alla ställningar i partiet en gång
    const g = CLASSICS[gameIx % CLASSICS.length], c = new Chess(), steps = [{ fen: c.fen() }];
    for (const san of g.moves.split(' ')) { const m = c.move(san); steps.push({ fen: c.fen(), from: m.from, to: m.to, san: m.san, check: /[+#]/.test(m.san) && m.color }); }
    plan = { g, steps };
    caption.replaceChildren(h('strong', g.label), h('span', `${g.white} – ${g.black}`), h('span.muted', `${g.place} ${g.year}`));
  }
  function show() {
    const s = plan.steps[ply];
    let check = null;
    if (s.check) check = Object.entries(parseFen(s.fen)).find(([, p]) => p === (s.check === 'w' ? 'bk' : 'wk'))?.[0];
    board.set({ fen: s.fen, lastMove: s.from && { from: s.from, to: s.to }, check, animate: ply > 0 });
    const recent = plan.steps.slice(Math.max(1, ply - 5), ply + 1).map((st, i, arr) => {
      const n = plan.steps.indexOf(st), num = n % 2 === 1 ? `${(n + 1) / 2}. ` : '';
      return h('span' + (i === arr.length - 1 ? '.cur' : ''), num + st.san);
    }).filter((x, i) => ply > 0 || i < 0);
    moveLine.replaceChildren(...(ply === 0 ? [h('span.muted', 'Utgångsställningen')] : recent));
  }
  function step() {
    if (!alive) return;
    if (ply < plan.steps.length - 1) { ply++; show(); timer = setTimeout(step, ply === plan.steps.length - 1 ? 5200 : 1350); }
    else { gameIx++; ply = 0; prepare(); show(); timer = setTimeout(step, 1600); }
  }
  prepare(); show(); timer = setTimeout(step, 1200);
  const load = () => api('/api/stats').then((s) => { online.v.textContent = s.online; playing.v.textContent = s.playing; players.v.textContent = s.players; }).catch(() => {});
  load();
  const statTimer = setInterval(load, 15000);
  const el = h('section.hero',
    h('div.hero-text',
      h('div.kicker', h('span.rule'), 'Schack sedan 1500-talet. Online sedan i dag.'),
      h('h1', 'Spela schack ', h('em', 'online')),
      h('p.lead', 'Rankade partier mot spelare från hela världen, en turnering varje söndag, tusentals problem och analys av varje drag med Stockfish. Helt gratis.'),
      h('div.hero-cta',
        h('a.btn.primary.big-cta', { href: '/play', onclick: (e) => { e.preventDefault(); e.stopPropagation(); document.getElementById('online')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Spela online'),
        h('a.btn.outline', { href: '/bot' }, 'Mot datorn'),
        h('a.btn.outline', { href: '/puzzles/daily' }, 'Dagens problem')),
      h('div.hero-stats', online.el, playing.el, players.el)),
    h('div.hero-art',
      h('div.hero-glow'),
      h('div.hero-stage', h('div.hero-board', board.el)),
      h('div.hero-info', caption, moveLine)));
  return { el, destroy() { alive = false; clearTimeout(timer); clearInterval(statTimer); } };
}

// Guldbanner för veckoturneringen med nedräkning och belöning.
function weeklyBanner() {
  const el = h('section.weekly');
  let data = null, offset = 0, timer = null;
  const clock = h('div.countdown');
  const unit = (n, label) => h('div', h('strong', String(n).padStart(2, '0')), h('span', label));
  function tick() {
    const t = data?.tournament;
    if (!t) return;
    const now = Date.now() + offset;
    if (t.status === 'running') { clock.replaceChildren(h('div.livebadge', h('span.livedot'), 'Pågår nu')); return; }
    const ms = Math.max(0, t.starts_at - now), s = Math.floor(ms / 1000);
    clock.replaceChildren(unit(Math.floor(s / 86400), 'dagar'), unit(Math.floor(s / 3600) % 24, 'tim'), unit(Math.floor(s / 60) % 60, 'min'), unit(s % 60, 'sek'));
  }
  function draw() {
    const t = data?.tournament;
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    const join = () => (state.user ? api(`/api/tournaments/${t.id}/join`, {}).then(() => go(`/tournament/${t.id}`)).catch((e) => alert(e.message)) : go('/login'));
    el.replaceChildren(
      h('div.weekly-crown', icon('crown', 64)),
      h('div.weekly-main',
        h('span.eyebrow', 'Veckoturnering'),
        h('h2', t.name),
        h('p', `Arena ${t.tc} · ${t.duration} min · varje söndag kl. 18 · ${t.players} anmälda`),
        h('ul.rewards', h('li', icon('crown', 14), 'Krona vid namnet i en vecka'), h('li', icon('spark', 14), 'Exklusivt guldbräde'), h('li', icon('trophy', 14), 'Pokal och prestation')),
        data.lastWinner && h('p.muted', 'Förra veckans mästare: ', h('a.user', { href: `/profile/${encodeURIComponent(data.lastWinner.username)}` }, data.lastWinner.username))),
      h('div.weekly-side', clock,
        t.joined ? h('a.btn.primary', { href: `/tournament/${t.id}` }, icon('check', 16), ' Du är anmäld') : h('button.primary', { onclick: join }, 'Anmäl dig'),
        h('a.btn.outline', { href: `/tournament/${t.id}` }, 'Visa turneringen')));
    tick();
  }
  api('/api/weekly').then((d) => { data = d; offset = d.now - Date.now(); draw(); timer = setInterval(tick, 1000); }).catch(() => { el.hidden = true; });
  el.hidden = true;
  return { el, destroy() { clearInterval(timer); } };
}

// Kort på startsidan: partier som spelas just nu.
function liveCard() {
  const el = h('div.card', h('h2', 'Pågående partier'), h('p.muted', 'Laddar…'));
  api('/api/live').then(({ games }) => {
    el.replaceChildren(h('h2', 'Pågående partier'),
      games.length ? h('div.livelist', games.slice(0, 4).map((g) => h('a', { href: `/watch/${g.id}` }, `${g.white.name} – ${g.black.name}`, h('span', g.tc))))
        : h('p.muted', 'Inga partier spelas just nu.'),
      h('a.btn', { href: '/live' }, 'Visa alla'));
  }).catch(() => {});
  return el;
}
// Kort på startsidan: skapa en länk som en kompis kan öppna för att börja ett parti.
function inviteCard() {
  const tc = h('select', TCS.map(([t]) => h('option', { value: t, selected: t === '5+0' }, t)));
  const err = h('p.error');
  return h('div.card', h('h2', 'Utmana via länk'), h('p.muted', 'Skapa en länk och skicka den till en kompis. Partiet börjar när den öppnas.'),
    h('div.btnrow', tc, h('button.primary', {
      onclick: () => (state.user ? api('/api/invites', { tc: tc.value }).then(({ id }) => go(`/join/${id}`)).catch((e) => { err.textContent = e.message; }) : go('/login')),
    }, 'Skapa länk')), err);
}

// ---------- Onlineparti ----------
// Pågående partier för den inloggade spelaren, och länkar till dem.
export const liveGames = (except) => [...net.games.values()].filter((g) => !g.over && g.id !== except);
export function gameLinks(games) {
  return h('div.livelist', games.map((g) => {
    const opp = g.you === 'w' ? g.black : g.white, mine = g.turn === g.you;
    return h('a', { href: `/game/${g.id}` }, `${opp.name} · ${g.tc}${g.variant === '960' ? ' · 960' : ''}`, h('span', mine ? 'Din tur' : 'Motståndarens tur'));
  }));
}

export function onlineGameView(ctx, id) {
  const gameId = id || liveGames()[0]?.id;
  if (!gameId) { go('/play'); return { el: h('div') }; }
  if (!id) { history.replaceState(null, '', `/game/${gameId}`); }
  if (!net.games.has(gameId)) { // sidan laddades om: vänta på att servern skickar partiet
    const off = on((m) => { if (m.t === 'game' && m.game.id === gameId) ctx.refresh(); });
    const t = setTimeout(() => { if (!net.games.has(gameId)) go('/play'); }, 4000);
    return { el: h('div.card.narrow', h('p.muted', 'Hämtar partiet…')), destroy() { off(); clearTimeout(t); } };
  }
  const cur = () => net.games.get(gameId);
  let endSounded = !!cur().over;
  if (!cur().over && !cur().moves.length) playSound('start');
  const others = h('div.others');
  const screen = new GameScreen({
    onMove(from, to, promotion) {
      const g = cur();
      if (!g || g.over) return;
      let mv;
      try { mv = screen.chess.move({ from, to, promotion }); } catch { return; }
      const now = performance.now();
      g.clocks[g.you] -= now - g.at;
      g.at = now;
      g.turn = g.you === 'w' ? 'b' : 'w';
      g.moves.push(mv.san);
      send({ t: 'move', id: gameId, from, to, promotion });
      refresh();
    },
  });

  function refresh() {
    const g = cur();
    if (!g) return;
    const me = g.you, opp = me === 'w' ? 'b' : 'w';
    const P = { w: { ...g.white, color: 'w' }, b: { ...g.black, color: 'b' } };
    if (g.over?.ratings) for (const c of ['w', 'b']) if (g.over.ratings[c]) P[c].rating = g.over.ratings[c][1];
    let panel;
    if (g.over) {
      if (!endSounded) { endSounded = true; playSound(endSound(g.over, me)); }
      const r = g.over.ratings?.[me];
      const diff = r ? r[1] - r[0] : 0;
      panel = [h('div.result',
        h('h3', resultText(g.over, me)),
        !r && g.over.result !== '*' && g.variant !== '960' && h('p.muted', 'Placeringsparti: din rating visas när du har spelat fem rankade partier.'),
        g.variant === '960' && g.over.result !== '*' && h('p.muted', 'Chess960 är orankat.'),
        r && h('p.ratingchange', 'Rating: ', h('strong', r[1]), ' ', h('span.' + (diff >= 0 ? 'up' : 'down'), `${diff >= 0 ? '+' : ''}${diff}`)),
        h('div.btnrow',
          g.over.result !== '*' && h('a.btn.primary', { href: `/review/${g.id}` }, 'Analysera partiet'),
          !g.tournament && g.over.result !== '*' && h('button', { onclick: () => send({ t: 'rematch', id: g.id }) }, 'Returmatch'),
          g.tournament
            ? h('a.btn', { href: `/tournament/${g.tournament}` }, 'Till turneringen')
            : h('button', { onclick: () => { net.games.delete(g.id); send({ t: 'seek', tc: g.tc, variant: g.variant }); go('/play'); } }, 'Nytt parti')))];
    } else {
      panel = [
        g.takebackOffer === opp && h('div.offer', 'Motståndaren vill ta tillbaka sitt senaste drag.',
          h('div.btnrow', h('button.primary', { onclick: () => send({ t: 'takeback', id: gameId }) }, 'Tillåt'), h('button', { onclick: () => send({ t: 'decline', id: gameId }) }, 'Avböj'))),
        g.drawOffer === opp && h('div.offer', 'Motståndaren erbjuder remi.',
          h('div.btnrow', h('button.primary', { onclick: () => send({ t: 'draw', id: gameId }) }, 'Acceptera'), h('button', { onclick: () => send({ t: 'decline', id: gameId }) }, 'Avböj'))),
        h('div.btnrow',
          g.drawOffer !== opp && h('button', { disabled: g.drawOffer === me, onclick: () => send({ t: 'draw', id: gameId }) }, g.drawOffer === me ? 'Remi erbjuden' : 'Erbjud remi'),
          g.takebackOffer !== opp && h('button', { disabled: g.takebackOffer === me || g.moves.length < (g.turn === me ? 2 : 1), onclick: () => send({ t: 'takeback', id: gameId }) }, g.takebackOffer === me ? 'Väntar på svar' : 'Ångra drag'),
          confirmButton('Ge upp', () => send({ t: 'resign', id: gameId }))),
      ];
    }
    screen.update({
      moves: g.moves, startFen: g.startFen || undefined, variant: g.variant, orientation: me, movable: !g.over && g.turn === me ? me : null,
      premovable: !g.over && g.turn !== me ? me : null,
      top: P[opp], bottom: P[me],
      clocks: { w: g.clocks.w, b: g.clocks.b, running: g.over ? null : g.turn, at: g.at },
      status: g.over ? 'Partiet är slut' : `${g.tc} · ${g.variant === '960' ? 'Chess960' : g.tournament ? 'turnering' : 'rankat'} · ${g.turn === me ? 'din tur' : 'motståndarens tur'}`,
      panel,
    });
    const rest = liveGames(gameId);
    others.replaceChildren(...(rest.length ? [h('h3', 'Dina andra partier'), gameLinks(rest)] : []));
  }
  refresh();
  screen.side.append(others);
  const chat = chatBox(`game:${gameId}`);
  screen.side.append(chat.el);
  const off = on((m) => { if (m.t === 'game') refresh(); });
  return { el: screen.el, destroy() { off(); chat.destroy(); screen.destroy(); if (cur()?.over) net.games.delete(gameId); } };
}

// ---------- Åskådare: följ ett pågående parti ----------
export function watchView(ctx, id) {
  const screen = new GameScreen({ onMove() {} });
  const wrap = h('div', h('div.card.narrow', h('p.muted', 'Hämtar partiet…')));
  let shown = false;
  const ask = () => send({ t: 'watch', id });
  const off = on((m) => {
    if (m.t === 'conn' && net.connected) ask();
    if (m.t !== 'watch') return;
    const g = m.game;
    if (!g) return wrap.replaceChildren(h('div.card.narrow', h('h2', 'Partiet pågår inte'), h('p.muted', 'Partiet är slut eller finns inte.'), h('a.btn', { href: '/live' }, 'Pågående partier')));
    if (!shown) { shown = true; wrap.replaceChildren(screen.el); }
    const P = { w: { ...g.white, color: 'w' }, b: { ...g.black, color: 'b' } };
    screen.update({
      moves: g.moves, startFen: g.startFen || undefined, variant: g.variant, orientation: 'w', movable: null, top: P.b, bottom: P.w,
      clocks: { w: g.clocks.w, b: g.clocks.b, running: g.over ? null : g.turn, at: g.at },
      status: g.over ? `Partiet är slut: ${g.over.result} (${REASONS[g.over.reason] || g.over.reason})` : `Du tittar · ${g.tc}`,
      panel: [g.over && g.over.result !== '*' && h('a.btn.primary', { href: `/review/${g.id}` }, 'Analysera partiet')],
    });
  });
  ask();
  const chat = chatBox(`game:${id}`, { readonly: true });
  screen.side.append(chat.el);
  if (!state.user) wrap.replaceChildren(h('div.card.narrow', h('h2', 'Titta på parti'), h('p.muted', 'Du behöver vara inloggad för att följa partier live.'), h('a.btn.primary', { href: '/login' }, 'Logga in')));
  return { el: wrap, destroy() { off(); send({ t: 'unwatch' }); chat.destroy(); screen.destroy(); } };
}

// ---------- Parti mot datorn ----------
let bot = null; // { cfg, color (spelarens färg), moves, over, thinking, savedId, draw }

function chessFrom(moves, fen) {
  const c = new Chess(fen);
  for (const san of moves) c.move(san);
  return c;
}

function botAfterMove(b) {
  const c = chessFrom(b.moves, b.startFen);
  if (c.isCheckmate()) b.over = { result: c.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  else if (c.isDraw()) {
    b.over = { result: '1/2-1/2', reason: c.isStalemate() ? 'stalemate' : c.isInsufficientMaterial() ? 'insufficient' : c.isThreefoldRepetition() ? 'repetition' : 'fifty' };
  }
  if (b.over) botFinish(b);
  else if (c.turn() !== b.color) botThink(b);
  b.draw?.();
}
async function botThink(b) {
  if (b.thinking) return;
  b.thinking = true;
  b.draw?.();
  const c = chessFrom(b.moves, b.startFen);
  const mv = await botMove(b.cfg, c);
  b.thinking = false;
  if (bot !== b || b.over) return;
  b.moves.push(c.move(mv).san);
  botAfterMove(b);
}
function botFinish(b, resigned = false) {
  playSound(endSound(b.over, b.color));
  if (state.user && !b.startFen && b.moves.length >= 2) {
    api('/api/games/bot', { moves: b.moves, playerColor: b.color, botName: b.cfg.name, botRating: b.cfg.rating, resigned })
      .then((r) => { b.savedId = r.id; b.draw?.(); })
      .catch(() => {});
  }
}

export function botView(ctx) {
  if (!bot) return botSetup(ctx);
  const b = bot;
  const meName = state.user?.username || 'Gäst';
  const screen = new GameScreen({
    onMove(from, to, promotion) {
      if (b.over || b.thinking) return;
      let mv;
      try { mv = screen.chess.move({ from, to, promotion }); } catch { return; }
      b.moves.push(mv.san);
      botAfterMove(b);
    },
  });
  const players = () => {
    const me = { name: meName, rating: state.user?.provisional ? null : state.user?.rating, title: state.user?.title, country: state.user?.country, avatar: state.user?.avatar, color: b.color };
    const it = { name: b.cfg.name, rating: b.cfg.rating, color: b.color === 'w' ? 'b' : 'w' };
    return { me, it };
  };
  b.draw = () => {
    const { me, it } = players();
    const turn = chessFrom(b.moves, b.startFen).turn();
    let panel;
    if (b.over) {
      panel = [h('div.result', h('h3', resultText(b.over, b.color)),
        h('p.muted', state.user ? 'Partier mot datorn påverkar inte din rating.' : 'Logga in för att spara dina partier.'),
        h('div.btnrow',
          !b.startFen && h('button.primary', {
            onclick: () => {
              const [white, black] = b.color === 'w' ? [me, it] : [it, me];
              state.review = { moves: [...b.moves], white, black, result: b.over.result, reason: b.over.reason };
              go(b.savedId ? `/review/${b.savedId}` : '/review/local');
            },
          }, 'Analysera partiet'),
          h('button', { onclick: () => { bot = null; ctx.refresh(); } }, 'Nytt parti')))];
    } else {
      panel = [h('div.btnrow',
        h('button', {
          disabled: b.thinking || b.moves.length < (b.color === 'w' ? 2 : 3),
          onclick: () => { b.moves.splice(-2); b.draw(); },
        }, 'Ångra drag'),
        confirmButton('Ge upp', () => {
          b.over = { result: b.color === 'w' ? '0-1' : '1-0', reason: 'resign' };
          botFinish(b, true);
          b.draw();
        }))];
    }
    screen.update({
      moves: b.moves, startFen: b.startFen, orientation: b.color, movable: !b.over && !b.thinking && turn === b.color ? b.color : null,
      premovable: !b.over && (b.thinking || turn !== b.color) ? b.color : null,
      top: it, bottom: me, clocks: null,
      status: b.over ? 'Partiet är slut' : b.thinking ? `${b.cfg.name} tänker…` : 'Din tur',
      panel,
    });
  };
  b.draw();
  if (!b.over && !b.thinking && chessFrom(b.moves, b.startFen).turn() !== b.color) botThink(b);
  return { el: screen.el, destroy() { b.draw = null; screen.destroy(); } };
}

// Startar ett parti mot datorn från en given ställning (används av slutspelsträningen).
export function startBotGame({ cfg, color, startFen }) {
  bot = { cfg, color, startFen, moves: [], over: null, thinking: false, savedId: null, draw: null };
  playSound('start');
  go('/bot');
}

function botSetup(ctx) {
  let chosen = BOTS[5], color = 'w';
  const el = h('div.card.wide');
  const custom = h('input.num', { type: 'number', min: 250, max: 3200, step: 50, value: 1500 });
  const draw = () => {
    el.replaceChildren(
      h('h2', 'Spela mot datorn'),
      h('div.botgrid', BOTS.map((b) =>
        h('button.bot' + (b === chosen ? '.active' : ''), { onclick: () => { chosen = b; draw(); } },
          h('strong', b.name), h('span.prating', b.rating), h('span.muted', b.desc)))),
      h('h3', 'Egen styrka'),
      h('form.inline', { onsubmit: (e) => { e.preventDefault(); chosen = botFromElo(Math.max(250, Math.min(3200, Math.round(Number(custom.value)) || 1200))); draw(); } },
        custom, h('button', { type: 'submit' }, 'Välj den styrkan')),
      h('h3', 'Din färg'),
      h('div.btnrow', [['w', 'Vit'], ['r', 'Slumpa'], ['b', 'Svart']].map(([c, label]) =>
        h('button' + (color === c ? '.active' : ''), { onclick: () => { color = c; draw(); } }, label))),
      h('button.primary.big', {
        onclick: () => {
          const mine = color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
          bot = { cfg: chosen, color: mine, moves: [], over: null, thinking: false, savedId: null, draw: null };
          playSound('start');
          ctx.refresh();
        },
      }, `Spela mot ${chosen.name}`));
  };
  draw();
  return { el };
}
