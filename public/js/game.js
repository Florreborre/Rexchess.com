// Spelvyer: lobby, onlineparti och parti mot datorn.
import { Chess } from '/vendor/chess.js';
import { h, state, api, fmtClock, REASONS, playSound, moveSound, roman, go } from './util.js';
import { gotwCard, topCard } from './social.js';
import { Board, parseFen } from './board.js';
import { net, send, on } from './net.js';
import { BOTS, botMove } from './engine.js';

const TCS = [['1+0', 'Bullet'], ['3+0', 'Blixt'], ['3+2', 'Blixt'], ['5+0', 'Blixt'], ['10+0', 'Snabb'], ['15+10', 'Snabb']];

function playerBar() {
  const name = h('span.pname'), rating = h('span.prating'), clock = h('span.clock'), title = h('span.title');
  const el = h('div.playerbar', h('div.pinfo', h('span.avatar'), title, name, rating), clock);
  return {
    el, clock,
    set(p) {
      name.textContent = p.name;
      title.textContent = p.title || '';
      title.hidden = !p.title;
      rating.textContent = p.rating ? `(${p.rating})` : '';
      el.querySelector('.avatar').className = 'avatar ' + (p.color === 'w' ? 'white' : 'black');
      clock.hidden = !p.hasClock;
    },
  };
}

// Gemensam skärm för ett pågående parti: bräde, spelare, klockor, draglista.
class GameScreen {
  constructor({ onMove }) {
    this.moves = [];
    this.chess = new Chess();
    this.fens = [this.chess.fen()];
    this.hist = [];
    this.viewPly = 0;
    this.model = null;
    this.premove = null;
    this.onMove = onMove;
    this.board = new Board({
      movableColor: () => (this.viewPly === this.moves.length ? this.model?.movable : null),
      premoveColor: () => (this.viewPly === this.moves.length ? this.model?.premovable : null),
      targets: (sq) => this.chess.moves({ square: sq, verbose: true }).map((m) => m.to),
      onMove,
      onPremove: (from, to, promotion) => { this.premove = { from, to, promotion }; this.render(); },
      onCancelPremove: () => { this.premove = null; this.render(); },
    });
    this.top = playerBar();
    this.bottom = playerBar();
    this.status = h('div.status');
    this.moveList = h('div.movelist');
    this.panel = h('div.panel');
    const nav = (label, title, fn) => h('button.icon', { title, onclick: () => { fn(); this.render(); } }, label);
    this.el = h('div.game-layout',
      h('div.board-col', this.top.el, this.board.el, this.bottom.el),
      h('div.side', this.status, this.moveList,
        h('div.navrow',
          nav('⏮', 'Första', () => (this.viewPly = 0)),
          nav('◀', 'Föregående', () => (this.viewPly = Math.max(0, this.viewPly - 1))),
          nav('▶', 'Nästa', () => (this.viewPly = Math.min(this.moves.length, this.viewPly + 1))),
          nav('⏭', 'Sista', () => (this.viewPly = this.moves.length))),
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
    const changed = model.moves.length !== this.moves.length || model.moves.some((m, i) => m !== this.moves[i]);
    if (changed) {
      const grew = model.moves.length > this.moves.length;
      this.moves = [...model.moves];
      this.chess = new Chess();
      this.fens = [this.chess.fen()];
      this.hist = [];
      for (const san of this.moves) {
        this.hist.push(this.chess.move(san));
        this.fens.push(this.chess.fen());
      }
      this.viewPly = this.moves.length;
      if (grew) playSound(moveSound(this.hist.at(-1)));
    }
    if (!model.movable && !model.premovable) this.premove = null;
    // Det har blivit vår tur: spela det förberedda draget om det fortfarande är lagligt.
    if (this.premove && model.movable) {
      const pm = this.premove;
      this.premove = null;
      if (this.chess.moves({ verbose: true }).some((m) => m.from === pm.from && m.to === pm.to)) {
        setTimeout(() => { if (this.model?.movable) this.onMove(pm.from, pm.to, pm.promotion); });
      }
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
    this.board.set({ fen: this.fens[this.viewPly], lastMove: last && { from: last.from, to: last.to }, check, orientation: m.orientation, premove: this.premove });
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
export function lobbyView() {
  const online = h('div.card');
  const draw = () => {
    online.replaceChildren(h('h2', 'Spela online'), h('p.muted', 'Rankade partier mot andra spelare. Välj betänketid.'));
    if (!state.user) {
      online.append(h('p', 'Du behöver ett konto för att spela online.'), h('a.btn.primary', { href: '/login' }, 'Logga in / skapa konto'));
    } else if (net.seeking) {
      online.append(h('div.seeking', h('span.spinner'), `Söker motståndare (${net.seeking})…`),
        h('button', { onclick: () => send({ t: 'cancel' }) }, 'Avbryt'));
    } else {
      online.append(h('div.tcgrid', TCS.map(([tc, label]) =>
        h('button.tc', { onclick: () => send({ t: 'seek', tc }) }, h('strong', tc), h('span', label)))));
      if (!net.connected) online.append(h('p.muted', 'Ansluter till servern…'));
    }
  };
  draw();
  const off = on(draw);
  const el = h('div.lobby', online,
    h('div.card', h('h2', 'Spela mot datorn'), h('p.muted', 'Sju motståndare, från rekryten Tiro till Caesar (full Stockfish). Orankat.'),
      h('a.btn.primary', { href: '/bot' }, 'Välj motståndare')),
    h('div.card', h('h2', 'Turneringar'), h('p.muted', 'Samla spelare i en arena: alla paras ihop om och om igen tills tiden är ute. Flest poäng vinner.'),
      h('div.btnrow', h('a.btn.primary', { href: '/tournaments/new' }, 'Skapa en turnering'), h('a.btn', { href: '/tournaments' }, 'Visa alla'))),
    gotwCard(), topCard(),
    h('div.card', h('h2', 'Vänner'), h('p.muted', 'Lägg till vänner, se vilka som är online och utmana dem på ett parti.'),
      h('a.btn', { href: '/friends' }, 'Vänlista')),
    h('div.card', h('h2', 'Analysera'), h('p.muted', 'Gå igenom dina partier drag för drag med träffsäkerhet, bedömning av varje drag och bästa drag.'),
      h('a.btn', { href: '/games' }, 'Mina partier')));
  return { el, destroy: off };
}

// ---------- Onlineparti ----------
export function onlineGameView() {
  if (!net.game) {
    go('/play');
    return { el: h('div') };
  }
  let endSounded = !!net.game.over;
  if (!net.game.over && !net.game.moves.length) playSound('start');
  const screen = new GameScreen({
    onMove(from, to, promotion) {
      const g = net.game;
      if (!g || g.over) return;
      let mv;
      try { mv = screen.chess.move({ from, to, promotion }); } catch { return; }
      const now = performance.now();
      g.clocks[g.you] -= now - g.at;
      g.at = now;
      g.turn = g.you === 'w' ? 'b' : 'w';
      g.moves.push(mv.san);
      send({ t: 'move', from, to, promotion });
      refresh();
    },
  });

  function refresh() {
    const g = net.game;
    if (!g) return;
    const me = g.you, opp = me === 'w' ? 'b' : 'w';
    const P = { w: { ...g.white, color: 'w' }, b: { ...g.black, color: 'b' } };
    if (g.over?.ratings) for (const c of ['w', 'b']) P[c].rating = g.over.ratings[c][1];
    let panel;
    if (g.over) {
      if (!endSounded) { endSounded = true; playSound('end'); }
      const r = g.over.ratings?.[me];
      const diff = r ? r[1] - r[0] : 0;
      panel = [h('div.result',
        h('h3', resultText(g.over, me)),
        r && h('p.ratingchange', 'Rating: ', h('strong', r[1]), ' ', h('span.' + (diff >= 0 ? 'up' : 'down'), `${diff >= 0 ? '+' : ''}${diff}`)),
        h('div.btnrow',
          g.over.result !== '*' && h('a.btn.primary', { href: `/review/${g.id}` }, 'Analysera partiet'),
          g.tournament
            ? h('a.btn', { href: `/tournament/${g.tournament}`, onclick: () => { net.game = null; } }, 'Till turneringen')
            : h('button', { onclick: () => { net.game = null; send({ t: 'seek', tc: g.tc }); go('/play'); } }, 'Nytt parti')))];
    } else {
      panel = [
        g.drawOffer === opp && h('div.offer', 'Motståndaren erbjuder remi.',
          h('div.btnrow', h('button.primary', { onclick: () => send({ t: 'draw' }) }, 'Acceptera'), h('button', { onclick: () => send({ t: 'decline' }) }, 'Avböj'))),
        h('div.btnrow',
          g.drawOffer !== opp && h('button', { disabled: g.drawOffer === me, onclick: () => send({ t: 'draw' }) }, g.drawOffer === me ? 'Remi erbjuden' : 'Erbjud remi'),
          confirmButton('Ge upp', () => send({ t: 'resign' }))),
      ];
    }
    screen.update({
      moves: g.moves, orientation: me, movable: !g.over && g.turn === me ? me : null,
      premovable: !g.over && g.turn !== me ? me : null,
      top: P[opp], bottom: P[me],
      clocks: { w: g.clocks.w, b: g.clocks.b, running: g.over ? null : g.turn, at: g.at },
      status: g.over ? 'Partiet är slut' : `${g.tc} · ${g.tournament ? 'turnering' : 'rankat'} · ${g.turn === me ? 'din tur' : 'motståndarens tur'}`,
      panel,
    });
  }
  refresh();
  const off = on((m) => { if (m.t === 'game') refresh(); });
  return { el: screen.el, destroy() { off(); screen.destroy(); } };
}

// ---------- Parti mot datorn ----------
let bot = null; // { cfg, color (spelarens färg), moves, over, thinking, savedId, draw }

function chessFrom(moves) {
  const c = new Chess();
  for (const san of moves) c.move(san);
  return c;
}

function botAfterMove(b) {
  const c = chessFrom(b.moves);
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
  const c = chessFrom(b.moves);
  const mv = await botMove(b.cfg, c);
  b.thinking = false;
  if (bot !== b || b.over) return;
  b.moves.push(c.move(mv).san);
  botAfterMove(b);
}
function botFinish(b, resigned = false) {
  playSound('end');
  if (state.user && b.moves.length >= 2) {
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
    const me = { name: meName, rating: state.user?.rating, title: state.user?.title, color: b.color };
    const it = { name: b.cfg.name, rating: b.cfg.rating, color: b.color === 'w' ? 'b' : 'w' };
    return { me, it };
  };
  b.draw = () => {
    const { me, it } = players();
    const turn = b.moves.length % 2 === 0 ? 'w' : 'b';
    let panel;
    if (b.over) {
      panel = [h('div.result', h('h3', resultText(b.over, b.color)),
        h('p.muted', state.user ? 'Partier mot datorn påverkar inte din rating.' : 'Logga in för att spara dina partier.'),
        h('div.btnrow',
          h('button.primary', {
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
      moves: b.moves, orientation: b.color, movable: !b.over && !b.thinking && turn === b.color ? b.color : null,
      premovable: !b.over && (b.thinking || turn !== b.color) ? b.color : null,
      top: it, bottom: me, clocks: null,
      status: b.over ? 'Partiet är slut' : b.thinking ? `${b.cfg.name} tänker…` : 'Din tur',
      panel,
    });
  };
  b.draw();
  if (!b.over && !b.thinking && (b.moves.length % 2 === 0 ? 'w' : 'b') !== b.color) botThink(b);
  return { el: screen.el, destroy() { b.draw = null; screen.destroy(); } };
}

function botSetup(ctx) {
  let chosen = BOTS[2], color = 'w';
  const el = h('div.card.wide');
  const draw = () => {
    el.replaceChildren(
      h('h2', 'Spela mot datorn'),
      h('div.botgrid', BOTS.map((b) =>
        h('button.bot' + (b === chosen ? '.active' : ''), { onclick: () => { chosen = b; draw(); } },
          h('strong', b.name), h('span.prating', b.rating), h('span.muted', b.desc)))),
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
