// Träning: schackproblem, träna på egna misstag, analysbräde, öppningsträning och slutspel.
import { Chess } from '/vendor/chess.js';
import { h, state, api, go, playSound, moveSound } from './util.js';
import { Board } from './board.js';
import { getEngine, BOTS } from './engine.js';
import { OPENINGS } from './openings.js';
import { startBotGame } from './game.js';

const colorName = (c) => (c === 'w' ? 'vit' : 'svart');
const uciMove = (chess, u) => chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

// Bräde där man ska hitta rätt drag. `moves` är lösningen: spelarens drag, motståndarens svar, spelarens drag …
function solver({ fen, moves, onWrong, onDone }) {
  const chess = new Chess(fen), me = chess.turn();
  let i = 0, last = null, done = false, clean = true;
  const board = new Board({
    movableColor: () => (!done && chess.turn() === me ? me : null),
    targets: (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to),
    onMove(from, to, promotion) {
      let mv;
      try { mv = chess.move({ from, to, promotion }); } catch { return show(); }
      const isLast = i >= moves.length - 1;
      // Rätt drag, eller på sista draget vilken matt som helst.
      if (from + to + (promotion || '') !== moves[i] && !(isLast && chess.isCheckmate())) {
        chess.undo();
        clean = false;
        onWrong?.(mv.san);
        return show();
      }
      advance(mv);
      if (!done) setTimeout(() => { if (!done) advance(uciMove(chess, moves[i])); }, 450);
    },
  });
  function advance(mv) {
    last = { from: mv.from, to: mv.to };
    playSound(moveSound(mv));
    i++;
    if (i >= moves.length) { done = true; show(); onDone?.(clean); } else show();
  }
  function show(arrows = []) {
    board.set({ fen: chess.fen(), orientation: me, lastMove: last, arrows });
  }
  show();
  return {
    el: board.el, me,
    hint() { // visar varifrån rätt drag går
      if (done) return;
      clean = false;
      show([{ from: moves[i].slice(0, 2), to: moves[i].slice(2, 4), color: '#6aa84f' }]);
    },
    solve() { // spelar upp resten av lösningen
      if (done) return;
      clean = false;
      done = true;
      const step = () => {
        if (i >= moves.length) return show();
        const mv = uciMove(chess, moves[i]);
        last = { from: mv.from, to: mv.to };
        i++;
        show();
        setTimeout(step, 600);
      };
      step();
    },
  };
}

const layout = (boardEl, side) => h('div.game-layout', h('div.board-col.solo', boardEl), side);

// ---------- Schackproblem ----------
export function puzzlesView(ctx, daily) {
  const side = h('div.side.flat');
  const wrap = h('div', h('div.card.narrow', h('p.muted', 'Hämtar ett problem…')));
  let alive = true, lastId = '';

  function load() {
    api(daily ? '/api/puzzles/daily' : `/api/puzzles/next?not=${lastId}`).then(({ puzzle: p, rating }) => {
      if (!alive) return;
      lastId = p.id;
      let reported = false;
      const msg = h('p.verdictline'), ratingEl = h('p.muted', state.user ? `Din problemrating: ${rating}` : 'Logga in för att få en problemrating.');
      const report = (solved) => {
        if (reported || !state.user) return;
        reported = true;
        api(`/api/puzzles/${p.id}/result`, { solved }).then((r) => {
          ratingEl.replaceChildren(`Din problemrating: ${r.rating} `, h('span.' + (r.diff >= 0 ? 'up' : 'down'), `${r.diff >= 0 ? '+' : ''}${r.diff}`), ` · ${r.solved} lösta`);
        }).catch(() => {});
      };
      const s = solver({
        fen: p.fen, moves: p.moves,
        onWrong(san) { msg.className = 'verdictline down'; msg.textContent = `${san} är inte rätt. Försök igen.`; report(false); },
        onDone(clean) {
          msg.className = 'verdictline up';
          msg.textContent = clean ? 'Rätt löst!' : 'Löst – men inte på första försöket.';
          report(clean);
          playSound(clean ? 'victory' : 'draw');
          next.classList.add('primary');
        },
      });
      const next = h('button', { onclick: () => (daily ? go('/puzzles') : load()) }, daily ? 'Fler problem ▶' : 'Nästa problem ▶');
      side.replaceChildren(...[
        h('h2', daily ? 'Dagens problem' : 'Schackproblem'),
        h('p', h('strong', `${p.theme}`), h('span.muted', ` · svårighet ${p.rating}`)),
        h('p', `Du spelar ${colorName(s.me)}. Hitta bästa draget.`),
        msg, ratingEl,
        h('div.btnrow',
          h('button', { onclick: () => { s.hint(); report(false); } }, 'Ledtråd'),
          h('button', { onclick: () => { s.solve(); report(false); msg.className = 'verdictline muted'; msg.textContent = 'Så här går lösningen.'; } }, 'Visa lösningen')),
        next,
        !daily && h('a.btn', { href: '/puzzles/daily' }, 'Dagens problem')].filter(Boolean));
      wrap.replaceChildren(layout(s.el, side));
    }).catch((e) => { if (alive) wrap.replaceChildren(h('div.card.narrow', h('h2', 'Schackproblem'), h('p.error', e.message))); });
  }
  load();
  return { el: wrap, destroy() { alive = false; } };
}

// ---------- Träna på misstagen från en analys ----------
export function mistakesView() {
  const list = state.training;
  if (!list?.length) {
    return { el: h('div.card.narrow', h('h2', 'Träna på misstag'), h('p.muted', 'Analysera ett parti först och välj sedan "Träna på misstagen".'), h('a.btn.primary', { href: '/games' }, 'Mina partier')) };
  }
  const side = h('div.side.flat'), wrap = h('div');
  let n = 0, right = 0;
  function show() {
    if (n >= list.length) {
      return wrap.replaceChildren(h('div.card.narrow', h('h2', 'Klart!'), h('p', `Du hittade det bästa draget i ${right} av ${list.length} ställningar.`),
        h('div.btnrow', h('button.primary', { onclick: () => { n = 0; right = 0; show(); } }, 'En gång till'), h('a.btn', { href: '/games' }, 'Mina partier'))));
    }
    const item = list[n];
    const msg = h('p.verdictline');
    const next = h('button', { onclick: () => { n++; show(); } }, n === list.length - 1 ? 'Visa resultat ▶' : 'Nästa ställning ▶');
    const s = solver({
      fen: item.fen, moves: [item.best],
      onWrong(san) { msg.className = 'verdictline down'; msg.textContent = `${san} är inte det bästa draget. Försök igen.`; },
      onDone(clean) {
        if (clean) right++;
        msg.className = 'verdictline up';
        msg.textContent = clean ? 'Rätt – det var det bästa draget!' : 'Där satt det.';
        next.classList.add('primary');
      },
    });
    side.replaceChildren(h('h2', 'Träna på misstagen'), h('p.muted', `Ställning ${n + 1} av ${list.length}`),
      h('p', `I partiet spelades `, h('strong', item.played), `, som var ${item.label}. Hitta ett bättre drag för ${colorName(s.me)}.`),
      msg, h('div.btnrow', h('button', { onclick: () => s.hint() }, 'Ledtråd'), h('button', { onclick: () => s.solve() }, 'Visa draget')), next);
    wrap.replaceChildren(layout(s.el, side));
  }
  show();
  return { el: wrap };
}

// ---------- Analysbräde ----------
export function analysisView() {
  let chess = new Chess(), redo = [], orientation = 'w', token = 0, timer = null, alive = true;
  const fenInput = h('input', { placeholder: 'FEN-sträng' }), err = h('p.error');
  const evalEl = h('strong.bigeval', '…'), lineEl = h('p.line.muted'), movesEl = h('p.pgnline');
  const barFill = h('div.evalfill'), bar = h('div.evalbar', barFill);
  let best = null;
  const board = new Board({
    movableColor: () => chess.turn(),
    targets: (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to),
    onMove(from, to, promotion) {
      try { playSound(moveSound(chess.move({ from, to, promotion }))); redo = []; } catch { /* olagligt */ }
      changed();
    },
  });
  function draw() {
    const hist = chess.history({ verbose: true }), last = hist.at(-1);
    board.set({ fen: chess.fen(), orientation, lastMove: last && { from: last.from, to: last.to },
      arrows: best ? [{ from: best.slice(0, 2), to: best.slice(2, 4), color: '#6aa84f' }] : [] });
    movesEl.textContent = hist.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m.san).join(' ') || 'Flytta pjäserna fritt för båda sidor.';
    fenInput.value = chess.fen();
    bar.classList.toggle('flipped', orientation === 'b');
  }
  function changed() {
    best = null;
    evalEl.textContent = '…';
    lineEl.textContent = '';
    draw();
    clearTimeout(timer);
    const my = ++token;
    if (chess.isGameOver()) {
      evalEl.textContent = chess.isCheckmate() ? (chess.turn() === 'w' ? '0-1 (matt)' : '1-0 (matt)') : 'Remi';
      return;
    }
    timer = setTimeout(async () => { // vänta en kort stund så att motorn inte startas för varje snabbt drag
      const eng = getEngine(), fen = chess.fen(), white = chess.turn() === 'w';
      eng.stop();
      const res = await eng.search(fen, { depth: 16 });
      if (my !== token || !alive || !res.lines[0]) return;
      const l = res.lines[0], sign = white ? 1 : -1;
      evalEl.textContent = l.mate != null ? `${l.mate * sign > 0 ? '+' : '-'}M${Math.abs(l.mate)}` : `${l.cp * sign > 0 ? '+' : ''}${((l.cp * sign) / 100).toFixed(1)}`;
      const wp = l.mate != null ? (l.mate * sign > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * l.cp * sign)) - 1);
      barFill.style.height = `${Math.max(4, Math.min(96, wp))}%`;
      const c = new Chess(fen), sans = [];
      for (const u of l.pv.slice(0, 8)) { try { sans.push(uciMove(c, u).san); } catch { break; } }
      lineEl.textContent = 'Bästa linje: ' + sans.join(' ');
      best = l.pv[0];
      draw();
    }, 250);
  }
  const side = h('div.side.flat',
    h('h2', 'Analysbräde'),
    h('p', 'Bedömning: ', evalEl), lineEl, movesEl,
    h('div.btnrow',
      h('button', { onclick: () => { const m = chess.undo(); if (m) redo.push(m); changed(); } }, '◀ Ångra'),
      h('button', { onclick: () => { const m = redo.pop(); if (m) chess.move(m.san); changed(); } }, 'Gör om ▶'),
      h('button', { onclick: () => { orientation = orientation === 'w' ? 'b' : 'w'; draw(); } }, 'Vänd')),
    h('h3', 'Ställ upp en ställning'),
    fenInput, err,
    h('div.btnrow',
      h('button', { onclick: () => { try { chess = new Chess(fenInput.value.trim()); redo = []; err.textContent = ''; changed(); } catch { err.textContent = 'Ogiltig FEN-sträng.'; } } }, 'Ladda FEN'),
      h('button', { onclick: () => { chess = new Chess(); redo = []; err.textContent = ''; changed(); } }, 'Startställning')));
  barFill.style.height = '50%';
  changed();
  return { el: h('div.game-layout', h('div.board-col.solo', h('div.boardrow', bar, board.el)), side), destroy() { alive = false; token++; clearTimeout(timer); getEngine().stop(); } };
}

// ---------- Öppningsträning ----------
export function openingsView() {
  const lines = OPENINGS.filter((o) => o.moves.length >= 6);
  let pick = lines.find((o) => o.name.startsWith('Italienskt')) || lines[0], color = 'w', chess, i, last, done;
  const msg = h('p.verdictline'), progress = h('p.muted'), side = h('div.side.flat');
  const clean = (s) => s.replace(/[+#]/g, '');
  const board = new Board({
    movableColor: () => (!done && chess.turn() === color ? color : null),
    targets: (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to),
    onMove(from, to, promotion) {
      let mv;
      try { mv = chess.move({ from, to, promotion }); } catch { return draw(); }
      if (clean(mv.san) !== clean(pick.moves[i])) {
        chess.undo();
        msg.className = 'verdictline down';
        msg.textContent = `${mv.san} hör inte till den här varianten. Rätt drag är ${pick.moves[i]}.`;
        return draw();
      }
      msg.className = 'verdictline up';
      msg.textContent = 'Rätt!';
      step(mv);
      if (!done) setTimeout(reply, 450);
    },
  });
  function step(mv) {
    last = { from: mv.from, to: mv.to };
    playSound(moveSound(mv));
    i++;
    if (i >= pick.moves.length) { done = true; msg.className = 'verdictline up'; msg.textContent = 'Hela varianten klar!'; playSound('victory'); }
    draw();
  }
  function reply() { if (!done && chess.turn() !== color) step(chess.move(pick.moves[i])); }
  function draw() {
    board.set({ fen: chess.fen(), orientation: color, lastMove: last });
    progress.textContent = `Drag ${Math.min(i, pick.moves.length)} av ${pick.moves.length}: ${pick.moves.slice(0, i).join(' ')}`;
  }
  function restart() {
    chess = new Chess(); i = 0; last = null; done = false;
    msg.textContent = `Spela ${colorName(color)}s drag i varianten.`;
    msg.className = 'verdictline muted';
    draw();
    if (color === 'b') setTimeout(reply, 400);
  }
  const select = h('select', { onchange: (e) => { pick = lines[Number(e.target.value)]; restart(); } },
    lines.map((o, n) => h('option', { value: n, selected: o === pick }, `${o.name} (${o.moves.length} drag)`)));
  side.append(h('h2', 'Öppningsträning'), h('p.muted', 'Välj en öppning och spela dragen ur minnet. Sajten spelar motståndarens drag och rättar dig om du går fel.'),
    select,
    h('div.btnrow', ['w', 'b'].map((c) => h('button', { onclick: (e) => { color = c; e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('active')); e.target.classList.add('active'); restart(); }, class: c === 'w' ? 'active' : '' }, c === 'w' ? 'Som vit' : 'Som svart'))),
    msg, progress,
    h('div.btnrow', h('button', { onclick: () => { if (!done) { msg.className = 'verdictline muted'; msg.textContent = `Nästa drag är ${pick.moves[i]}.`; } } }, 'Visa nästa drag'), h('button', { onclick: restart }, 'Börja om')));
  restart();
  return { el: layout(board.el, side) };
}

// ---------- Slutspel ----------
const ENDGAMES = [
  ['Dam mot ensam kung', 'Det enklaste mattslutspelet. Driv kungen mot kanten.', '8/8/8/4k3/8/8/3QK3/8 w - - 0 1'],
  ['Torn mot ensam kung', 'Stäng in kungen rad för rad med tornet och ta hjälp av din egen kung.', '8/8/8/4k3/8/8/3RK3/8 w - - 0 1'],
  ['Två torn mot ensam kung', 'Trappstegsmatten: tornen turas om att ta rader.', '8/8/8/4k3/8/8/8/R3K2R w - - 0 1'],
  ['Två löpare mot ensam kung', 'Löparna arbetar sida vid sida och tvingar kungen till ett hörn.', '8/8/8/4k3/8/8/2BBK3/8 w - - 0 1'],
  ['Löpare och springare mot ensam kung', 'Det svåraste grundslutspelet. Matt går bara i löparens hörn.', '8/8/8/4k3/8/8/2BNK3/8 w - - 0 1'],
  ['Kung och bonde mot kung', 'Få bonden i dam. Håll kungen framför bonden och ta oppositionen.', '8/8/8/4k3/8/4K3/4P3/8 w - - 0 1'],
  ['Lucenaställningen', 'Tornslutspelens viktigaste vinstställning: bygg en bro med tornet.', '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1'],
];
export function endgamesView() {
  const caesar = { ...BOTS.at(-1), movetime: 400 };
  return {
    el: h('div.card.wide', h('h2', 'Slutspelsträning'),
      h('p.muted', 'Du spelar vit mot Stockfish på full styrka från klassiska ställningar. Lyckas du vinna mot bästa försvar kan du slutspelet.'),
      h('div.endgames', ENDGAMES.map(([name, desc, fen]) => {
        const b = new Board({});
        b.set({ fen });
        return h('div.endgame', h('div.miniboard', b.el), h('div', h('strong', name), h('p.muted', desc),
          h('button.primary.small', { onclick: () => startBotGame({ cfg: caesar, color: 'w', startFen: fen }) }, 'Spela')));
      }))),
  };
}

// ---------- Översikt över all träning ----------
export function trainingView() {
  const card = (title, text, href, label) => h('div.card', h('h2', title), h('p.muted', text), h('a.btn.primary', { href }, label));
  return {
    el: h('div.lobby',
      card('Schackproblem', 'Hitta matten eller den vinnande taktiken. Du får en egen problemrating.', '/puzzles', 'Lös problem'),
      card('Dagens problem', 'Samma problem för alla, ett nytt varje dag.', '/puzzles/daily', 'Dagens problem'),
      card('Analysbräde', 'Ställ upp valfri ställning, flytta fritt och se motorns bedömning.', '/analysis', 'Öppna brädet'),
      card('Öppningsträning', 'Öva in öppningsvarianter. Sajten rättar dig när du går fel.', '/openings', 'Öva öppningar'),
      card('Slutspel', 'Klassiska slutspel mot Stockfish.', '/endgames', 'Välj slutspel'),
      card('Träna på dina misstag', 'Analysera ett parti och få dina misstag som uppgifter.', '/games', 'Mina partier'),
      card('Spela mot datorn', 'Fjorton motståndare från nybörjare till full styrka.', '/bot', 'Välj motståndare')),
  };
}
