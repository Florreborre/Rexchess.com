// Partianalys: Stockfish går igenom varje ställning, varje drag bedöms och spelarna får en träffsäkerhet.
import { Chess } from '/vendor/chess.js';
import { h, svg, state, api, REASONS, roman, go as navigate } from './util.js';
import { Board } from './board.js';
import { getEngine } from './engine.js';
import { matchOpening } from './openings.js';

export const CLASSES = {
  brilliant: { label: 'Briljant', text: '!!', color: '#17b3a3', phrase: 'ett briljant drag!' },
  great: { label: 'Starkt drag', text: '!', color: '#4a90d9', phrase: 'ett starkt drag – det enda riktigt bra draget' },
  best: { label: 'Bästa', text: '★', color: '#6aa84f', phrase: 'bästa draget' },
  excellent: { label: 'Utmärkt', text: '✓', color: '#6aa84f', phrase: 'ett utmärkt drag' },
  good: { label: 'Bra', text: '✓', color: '#8aa67c', phrase: 'ett bra drag' },
  book: { label: 'Teori', text: 'T', color: '#b08d6a', phrase: 'ett teoridrag' },
  forced: { label: 'Tvingat', text: '→', color: '#8a8f98', phrase: 'det enda lagliga draget' },
  inaccuracy: { label: 'Inexakthet', text: '?!', color: '#e6b422', phrase: 'en inexakthet' },
  mistake: { label: 'Misstag', text: '?', color: '#e8843c', phrase: 'ett misstag' },
  miss: { label: 'Missad chans', text: '✕', color: '#e0607e', phrase: 'en missad chans' },
  blunder: { label: 'Blunder', text: '??', color: '#d9362b', phrase: 'en blunder' },
};
const SUMMARY_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const KEY_CLASSES = ['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

// Vinstchans i procent för sidan vid draget.
const winPct = (s) => (s.mate != null ? (s.mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * s.cp)) - 1));

function isSacrifice(mv, fenAfter) {
  if (mv.piece === 'p' || mv.piece === 'k' || mv.promotion) return false;
  const c = new Chess(fenAfter);
  const opp = mv.color === 'w' ? 'b' : 'w';
  const attackers = c.attackers(mv.to, opp);
  if (!attackers.length) return false;
  const net = VAL[mv.piece] - (mv.captured ? VAL[mv.captured] : 0);
  if (net < 2) return false;
  if (!c.attackers(mv.to, mv.color).length) return true;
  return net - Math.min(...attackers.map((sq) => VAL[c.get(sq).type])) >= 1;
}

export function classify(hist, fens, pos, bookPlies) {
  const out = [];
  for (let k = 0; k < hist.length; k++) {
    const mv = hist[k], before = pos[k], after = pos[k + 1];
    const wpBest = winPct(before.score);
    const wpAfter = 100 - winPct(after.score);
    const isBest = mv.from + mv.to + (mv.promotion || '') === before.best;
    const loss = isBest ? 0 : Math.max(0, wpBest - wpAfter);
    let cls;
    if (k < bookPlies) cls = 'book';
    else if (before.legal === 1) cls = 'forced';
    else if (isBest) {
      const recapture = k > 0 && mv.captured && hist[k - 1].captured && hist[k - 1].to === mv.to;
      if (isSacrifice(mv, fens[k + 1]) && wpAfter >= 45 && (wpBest < 97 || before.score.mate > 0)) cls = 'brilliant';
      else if (before.second && !recapture && wpBest - winPct(before.second) >= 12 && wpBest >= 20 && wpBest < 97) cls = 'great';
      else cls = 'best';
    } else if (loss < 2) cls = 'excellent';
    else if (loss < 5) cls = 'good';
    else if (loss < 10) cls = 'inaccuracy';
    else if (loss < 20) cls = 'mistake';
    else cls = 'blunder';
    if ((cls === 'mistake' || cls === 'blunder') && k > 0 && ['mistake', 'blunder'].includes(out[k - 1].cls) && wpBest >= 65 && wpAfter >= 35) cls = 'miss';
    const acc = cls === 'book' ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
    out.push({ cls, loss, acc, isBest });
  }
  return out;
}

function uciLineToSan(fen, pv, max = 6) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
  }
  return out;
}

function hashStr(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
  return (x >>> 0).toString(36);
}

export function reviewView(ctx, id) {
  const root = h('div.review-wrap', h('div.card', 'Laddar partiet…'));
  let destroyed = false, cleanup = () => {};

  (async () => {
    let src;
    if (id === 'local') src = state.review;
    else {
      try {
        const { game: g } = await api(`/api/games/${encodeURIComponent(id)}`);
        src = {
          moves: g.moves.split(' ').filter(Boolean), result: g.result, reason: g.reason,
          white: { name: g.white_name, rating: g.white_rating }, black: { name: g.black_name, rating: g.black_rating },
          flip: state.user && g.black_id === state.user.id,
        };
      } catch { src = null; }
    }
    if (destroyed) return;
    if (!src || !src.moves?.length) {
      root.replaceChildren(h('div.card', h('h2', 'Inget parti att analysera'), h('a.btn', { href: '/games' }, 'Till mina partier')));
      return;
    }
    cleanup = mount(root, src);
  })();

  return { el: root, destroy() { destroyed = true; cleanup(); } };
}

function mount(root, src) {
  const chess = new Chess();
  const fens = [chess.fen()], hist = [];
  for (const san of src.moves) { hist.push(chess.move(san)); fens.push(chess.fen()); }
  const n = hist.length;
  const book = matchOpening(src.moves);
  let ply = 0, pos = null, marks = null, progress = 0, run = 0, depth = 12;
  let orientation = src.flip || (state.user && src.black?.name === state.user.username && src.white?.name !== state.user.username) ? 'b' : 'w';

  const board = new Board({});
  const barFill = h('div.evalfill'), barLabel = h('span.evallabel');
  const evalBar = h('div.evalbar', barFill, barLabel);
  const topBar = h('div.playerbar'), bottomBar = h('div.playerbar');
  const side = h('div.side.review-side');
  root.replaceChildren(h('div.review-layout', h('div.board-col', topBar, h('div.boardrow', evalBar, board.el), bottomBar), side));

  const go = (p) => { ply = Math.max(0, Math.min(n, p)); board.clearDrawings(); render(); };
  const onKey = (e) => {
    if (e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') go(ply - 1);
    else if (e.key === 'ArrowRight') go(ply + 1);
    else if (e.key === 'ArrowUp') go(0);
    else if (e.key === 'ArrowDown') go(n);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  // Vits perspektiv för ställningen efter `p` halvdrag.
  const whiteScore = (p) => {
    const s = pos[p].score, sign = p % 2 === 0 ? 1 : -1;
    if (s.mate != null) return { mate: s.mate * sign, mated: s.mate === 0 ? (sign === 1 ? 'w' : 'b') : null };
    return { cp: s.cp * sign };
  };
  const whiteWin = (p) => (p % 2 === 0 ? winPct(pos[p].score) : 100 - winPct(pos[p].score));
  const evalText = (p) => {
    const s = whiteScore(p);
    if (s.mated) return s.mated === 'w' ? '0-1' : '1-0';
    if (s.mate != null) return `${s.mate > 0 ? '+' : '-'}M${Math.abs(s.mate)}`;
    return `${s.cp > 0 ? '+' : ''}${(s.cp / 100).toFixed(1)}`;
  };

  async function analyse() {
    const my = ++run;
    pos = marks = null;
    progress = 0;
    const key = `rev:${hashStr(src.moves.join(' '))}:${depth}`;
    try {
      const cached = JSON.parse(localStorage.getItem(key));
      if (cached?.length === n + 1) pos = cached;
    } catch { /* ingen cache */ }
    if (!pos) {
      render();
      const eng = getEngine(), out = [];
      for (let i = 0; i <= n; i++) {
        const c = new Chess(fens[i]);
        const legal = c.moves().length;
        if (!legal) out.push({ score: c.inCheck() ? { mate: 0, cp: null } : { cp: 0, mate: null }, best: null, pv: [], second: null, legal });
        else {
          const r = await eng.search(fens[i], { depth, multipv: 2 });
          if (my !== run) return;
          const l = r.lines[0] || { cp: 0, mate: null, pv: [r.best] };
          const sc = (x) => x && { cp: x.cp, mate: x.mate };
          out.push({ score: sc(l), best: l.pv[0], pv: l.pv.slice(0, 8), second: sc(r.lines[1]) || null, legal });
        }
        progress = (i + 1) / (n + 1);
        renderProgress();
      }
      pos = out;
      try { localStorage.setItem(key, JSON.stringify(pos)); } catch { /* fullt lagringsutrymme */ }
    }
    marks = classify(hist, fens, pos, book.plies);
    render();
  }

  let progressEl = null;
  function renderProgress() {
    if (progressEl) {
      progressEl.firstChild.style.width = `${Math.round(progress * 100)}%`;
      progressEl.nextSibling.textContent = `Analyserar drag ${Math.min(n, Math.round(progress * (n + 1)))} av ${n}…`;
    }
  }

  function playerBar(el, color) {
    const p = color === 'w' ? src.white : src.black;
    el.replaceChildren(h('div.pinfo', h('span.avatar.' + (color === 'w' ? 'white' : 'black')), h('span.pname', p?.name || (color === 'w' ? 'Vit' : 'Svart')),
      p?.rating ? h('span.prating', `(${p.rating})`) : null));
  }

  function summary() {
    const stat = (color) => {
      const mine = marks.filter((_, i) => (i % 2 === 0) === (color === 'w'));
      const counts = {};
      for (const m of mine) counts[m.cls] = (counts[m.cls] || 0) + 1;
      const acc = mine.length ? mine.reduce((a, m) => a + m.acc, 0) / mine.length : 0;
      return { counts, acc };
    };
    const w = stat('w'), b = stat('b');
    return h('div.summary',
      h('div.accrow',
        h('div.accbox.white', h('span', src.white?.name || 'Vit'), h('strong', w.acc.toFixed(1)), h('small', 'Träffsäkerhet')),
        h('div.accbox.black', h('span', src.black?.name || 'Svart'), h('strong', b.acc.toFixed(1)), h('small', 'Träffsäkerhet'))),
      h('div.classtable', SUMMARY_ORDER.map((k) => h('div.classrow',
        h('span.count', { style: { color: CLASSES[k].color } }, w.counts[k] || 0),
        h('span.classname', h('span.dot', { style: { background: CLASSES[k].color } }, CLASSES[k].text), CLASSES[k].label),
        h('span.count', { style: { color: CLASSES[k].color } }, b.counts[k] || 0)))));
  }

  function comment() {
    if (ply === 0) {
      return h('div.comment', h('p', h('strong', 'Utgångsställningen. '), 'Stega genom partiet med pilarna eller piltangenterna.'),
        book.name && h('p.muted', `Öppning: ${book.name}`));
    }
    const k = ply - 1, mv = hist[k], mark = marks[k], c = CLASSES[mark.cls];
    const num = `${Math.floor(k / 2) + 1}${k % 2 === 0 ? '.' : '…'}`;
    const kids = [h('p.verdict', h('span.dot.big', { style: { background: c.color } }, c.text),
      h('span', h('strong', `${num} ${mv.san}`), ` är ${c.phrase}`), h('span.evalchip', evalText(ply)))];
    if (!mark.isBest && pos[k].best && mark.cls !== 'book') {
      const line = uciLineToSan(fens[k], pos[k].pv);
      if (line.length) {
        kids.push(h('p', 'Bäst var ', h('strong.bestmove', line[0]), '.'),
          line.length > 1 && h('p.muted.line', 'Bästa linje: ' + line.join(' ')));
      }
    } else if (mark.cls === 'book' && book.name) kids.push(h('p.muted', `Öppning: ${book.name}`));
    if (ply === n && src.result) {
      kids.push(h('p.muted', `Resultat: ${src.result}${src.reason ? ` (${REASONS[src.reason] || src.reason})` : ''}`));
    }
    return h('div.comment', kids);
  }

  function graph() {
    const W = Math.max(n, 1);
    const pts = Array.from({ length: n + 1 }, (_, i) => [i, 100 - whiteWin(i)]);
    const d = `M0,100 L${pts.map(([x, y]) => `${x},${y.toFixed(1)}`).join(' L')} L${W},100 Z`;
    const g = svg('svg', { class: 'graph', viewBox: `0 0 ${W} 100`, preserveAspectRatio: 'none' },
      svg('rect', { x: 0, y: 0, width: W, height: 100, class: 'gbg' }),
      svg('path', { d, class: 'garea' }),
      svg('line', { x1: 0, y1: 50, x2: W, y2: 50, class: 'gmid' }),
      svg('line', { x1: ply, y1: 0, x2: ply, y2: 100, class: 'gcur' }));
    const wrap = h('div.graphwrap', g);
    marks.forEach((m, i) => {
      if (!['brilliant', 'great', 'mistake', 'miss', 'blunder'].includes(m.cls)) return;
      wrap.append(h('span.gdot', { style: { left: `${((i + 1) / W) * 100}%`, top: `${100 - whiteWin(i + 1)}%`, background: CLASSES[m.cls].color } }));
    });
    wrap.addEventListener('click', (e) => {
      const r = wrap.getBoundingClientRect();
      go(Math.round(((e.clientX - r.left) / r.width) * W));
    });
    return wrap;
  }

  function moveList() {
    const rows = [];
    for (let i = 0; i < n; i += 2) {
      const cell = (k) => hist[k] && h('button.mv' + (ply === k + 1 ? '.current' : ''), { onclick: () => go(k + 1) },
        marks && h('span.dot', { style: { background: CLASSES[marks[k].cls].color }, title: CLASSES[marks[k].cls].label }, CLASSES[marks[k].cls].text),
        hist[k].san);
      rows.push(h('div.mvrow', h("span.mvnum", `${roman(i / 2 + 1)}.`), cell(i), cell(i + 1)));
    }
    return h('div.movelist', rows);
  }

  function render() {
    const mv = ply > 0 ? hist[ply - 1] : null;
    const mark = marks && mv ? marks[ply - 1] : null;
    const arrows = [];
    if (mark && !mark.isBest && pos[ply - 1].best && mark.cls !== 'book') {
      const b = pos[ply - 1].best;
      arrows.push({ from: b.slice(0, 2), to: b.slice(2, 4), color: '#6aa84f' });
    }
    board.set({
      fen: fens[ply], orientation, arrows,
      lastMove: mv && { from: mv.from, to: mv.to, color: mark ? CLASSES[mark.cls].color : null },
      badge: mark && { square: mv.to, text: CLASSES[mark.cls].text, color: CLASSES[mark.cls].color, title: CLASSES[mark.cls].label },
    });
    playerBar(topBar, orientation === 'w' ? 'b' : 'w');
    playerBar(bottomBar, orientation);

    evalBar.classList.toggle('flipped', orientation === 'b');
    if (pos) {
      const ww = whiteWin(ply);
      barFill.style.height = `${Math.max(4, Math.min(96, ww))}%`;
      barLabel.textContent = evalText(ply).replace(/^[+-]/, '');
      barLabel.className = 'evallabel ' + (ww >= 50 ? 'forwhite' : 'forblack');
    } else {
      barFill.style.height = '50%';
      barLabel.textContent = '';
    }

    const nextKey = () => {
      for (let i = ply; i < n; i++) if (KEY_CLASSES.includes(marks[i].cls)) return go(i + 1);
      go(n);
    };
    // Spelarens egna misstag som övningsuppgifter (alla misstag om det inte är ens eget parti).
    const mistakes = () => {
      const mine = state.user && src.white?.name === state.user.username ? 'w' : state.user && src.black?.name === state.user.username ? 'b' : null;
      return marks.map((m, k) => ({ m, k })).filter(({ m, k }) => ['mistake', 'miss', 'blunder'].includes(m.cls) && pos[k].best && (!mine || hist[k].color === mine))
        .map(({ m, k }) => ({ fen: fens[k], best: pos[k].best, played: hist[k].san, label: CLASSES[m.cls].phrase }));
    };
    const header = h('div.revhead',
      h('h2', 'Partianalys'),
      h('label.depth', 'Djup ', h('select', { onchange: (e) => { depth = Number(e.target.value); getEngine().stop(); analyse(); } },
        [[10, 'Snabb'], [12, 'Normal'], [15, 'Djup'], [18, 'Mycket djup']].map(([d, l]) => h('option', { value: d, selected: d === depth }, `${l} (${d})`)))));
    const nav = h('div.navrow',
      h('button.icon', { title: 'Första', onclick: () => go(0) }, '⏮'),
      h('button.icon', { title: 'Föregående', onclick: () => go(ply - 1) }, '◀'),
      h('button.icon', { title: 'Nästa', onclick: () => go(ply + 1) }, '▶'),
      h('button.icon', { title: 'Sista', onclick: () => go(n) }, '⏭'),
      h('button.icon', { title: 'Vänd brädet', onclick: () => { orientation = orientation === 'w' ? 'b' : 'w'; render(); } }, '⇅'));

    if (!marks) {
      progressEl = h('div.progress', h('div'));
      side.replaceChildren(header, progressEl, h('p.muted', 'Startar motorn…'), moveList(), nav);
      renderProgress();
    } else {
      progressEl = null;
      side.replaceChildren(...[header, ply === 0 ? summary() : null, comment(), graph(), moveList(), nav,
        h('button.primary', { onclick: nextKey, disabled: ply >= n }, 'Nästa nyckeldrag ▶'),
        mistakes().length > 0 && h('button', { onclick: () => { state.training = mistakes(); navigate('/train'); } }, `Träna på misstagen (${mistakes().length})`)].filter(Boolean));
    }
    side.querySelector('.mv.current')?.scrollIntoView({ block: 'nearest' });
  }

  analyse();
  return () => {
    run++;
    getEngine().stop();
    document.removeEventListener('keydown', onKey);
  };
}
