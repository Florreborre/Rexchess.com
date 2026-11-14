// Schackbräde: ritar en FEN-ställning och hanterar klick/drag, premoves, egna pilar, markeringar och bedömningsmärken.
import { h, svg, pieceSvg, settings } from './util.js';

const FILES = 'abcdefgh';

export function parseFen(fen) {
  const map = {};
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        map[FILES[f] + (8 - r)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toLowerCase();
        f++;
      }
    }
  });
  return map;
}

// Alla rutor en pjäs skulle kunna gå till på ett tomt bräde – används för premoves, där ställningen hinner ändras.
function premoveTargets(p, sq) {
  const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1, out = [];
  const add = (x, y) => { if (x >= 0 && x < 8 && y >= 0 && y < 8 && (x !== f || y !== r)) out.push(FILES[x] + (y + 1)); };
  const ray = (dx, dy) => { for (let i = 1; i < 8; i++) add(f + dx * i, r + dy * i); };
  const t = p[1], white = p[0] === 'w';
  if (t === 'n') for (const [a, b] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) add(f + a, r + b);
  if (t === 'b' || t === 'q') for (const d of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) ray(...d);
  if (t === 'r' || t === 'q') for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ray(...d);
  if (t === 'k') {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) add(f + dx, r + dy);
    if (f === 4 && r === (white ? 0 : 7)) { add(6, r); add(2, r); }
  }
  if (t === 'p') {
    const d = white ? 1 : -1;
    add(f, r + d);
    if (r === (white ? 1 : 6)) add(f, r + 2 * d);
    add(f - 1, r + d);
    add(f + 1, r + d);
  }
  return out;
}

export class Board {
  // opts: movableColor() -> färg som får dra nu, premoveColor() -> färg som får lägga premove,
  //       targets(sq) -> [sq], onMove(from, to, promotion), onPremove(from, to, promotion), onCancelPremove()
  constructor(opts = {}) {
    this.opts = opts;
    this.orientation = 'w';
    this.pieces = {};
    this.selected = null;
    this.lastMove = null;
    this.check = null;
    this.premove = null;
    this.arrows = [];
    this.userArrows = [];
    this.userMarks = new Set();
    this.badge = null;
    this.el = h('div.board');
    this.grid = h('div.squares');
    this.overlay = svg('svg', { class: 'arrows', viewBox: '0 0 8 8' });
    this.el.append(this.grid, this.overlay);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onDrag(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', () => { this.endDrag(); this.rstart = null; });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  set({ fen, lastMove = null, check = null, orientation, arrows = [], badge = null, premove = null }) {
    if (fen) this.pieces = parseFen(fen);
    if (orientation) this.orientation = orientation;
    Object.assign(this, { lastMove, check, arrows, badge, premove, selected: null });
    this.promo?.remove();
    this.endDrag();
    this.render();
  }
  clearDrawings() {
    this.userArrows = [];
    this.userMarks.clear();
  }

  xy(sq) {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1;
    return this.orientation === 'w' ? [f, 7 - r] : [7 - f, r];
  }
  squareAt(e) {
    const rect = this.el.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.orientation === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
  }
  // Vilket läge brädet är i: vanligt drag, premove eller låst.
  mode() {
    const color = this.opts.movableColor?.();
    if (color) return { color, pre: false };
    const pre = this.opts.premoveColor?.();
    return pre ? { color: pre, pre: true } : null;
  }
  targetsFor(sq, pre) {
    if (pre) return this.pieces[sq] ? premoveTargets(this.pieces[sq], sq) : [];
    return this.opts.targets?.(sq) || [];
  }

  render() {
    const mode = this.mode();
    const hints = this.selected && mode && !mode.pre && settings.hints ? this.targetsFor(this.selected, false) : [];
    const cells = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sq = this.orientation === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
        const dark = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 1;
        const cell = h('div.sq' + (dark ? '.dark' : '.light'));
        if (this.lastMove && (sq === this.lastMove.from || sq === this.lastMove.to)) {
          cell.classList.add('last');
          if (this.lastMove.color) cell.style.setProperty('--hl', this.lastMove.color);
        }
        if (this.premove && (sq === this.premove.from || sq === this.premove.to)) cell.classList.add('pre');
        if (sq === this.selected) cell.classList.add('selected');
        if (sq === this.check) cell.classList.add('check');
        if (this.userMarks.has(sq)) cell.classList.add('marked');
        if (x === 0) cell.append(h('span.coord.rank', sq[1]));
        if (y === 7) cell.append(h('span.coord.file', sq[0]));
        const p = this.pieces[sq];
        if (p) {
          const el = pieceSvg(p);
          if (this.drag?.from === sq && this.drag.moved) el.style.opacity = '0.25';
          cell.append(el);
        }
        if (hints.includes(sq)) cell.append(h('span.hint' + (p ? '.capture' : '')));
        if (this.badge && this.badge.square === sq) {
          cell.append(h('span.badge', { style: { background: this.badge.color }, title: this.badge.title }, this.badge.text));
        }
        cells.push(cell);
      }
    }
    this.grid.replaceChildren(...cells);

    this.overlay.replaceChildren();
    [...this.arrows, ...this.userArrows].forEach((a, i) => {
      const [x1, y1] = this.xy(a.from).map((v) => v + 0.5);
      const [x2, y2] = this.xy(a.to).map((v) => v + 0.5);
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const id = `ah${i}`;
      this.overlay.append(
        svg('defs', {}, svg('marker', { id, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 3, markerHeight: 3, orient: 'auto' },
          svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: a.color }))),
        svg('line', { x1: x1 + ux * 0.25, y1: y1 + uy * 0.25, x2: x2 - ux * 0.3, y2: y2 - uy * 0.3,
          stroke: a.color, 'stroke-width': 0.17, 'stroke-linecap': 'round', opacity: 0.85, 'marker-end': `url(#${id})` }),
      );
    });
  }

  onDown(e) {
    if (this.promo?.isConnected) return;
    const sq = this.squareAt(e);
    if (e.button === 2) { // högerklick: rita pil / markera ruta, och avbryt ev. premove
      this.rstart = sq;
      this.selected = null;
      if (this.premove) this.opts.onCancelPremove?.();
      this.el.setPointerCapture(e.pointerId);
      return this.render();
    }
    if (e.button !== 0) return;
    this.clearDrawings();
    const mode = this.mode();
    if (!sq || !mode) return this.render();
    if (this.selected && sq !== this.selected && this.targetsFor(this.selected, mode.pre).includes(sq)) {
      return this.tryMove(this.selected, sq, mode.pre);
    }
    const p = this.pieces[sq];
    if (p && p[0] === mode.color) {
      this.selected = sq;
      this.drag = { from: sq, piece: p, moved: false, x: e.clientX, y: e.clientY, pre: mode.pre };
      this.el.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else {
      this.selected = null;
      if (mode.pre && this.premove) this.opts.onCancelPremove?.();
    }
    this.render();
  }
  onDrag(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    if (!d.moved) {
      d.moved = true;
      const size = this.el.getBoundingClientRect().width / 8;
      d.ghost = h('div.ghost', { style: { width: size + 'px', height: size + 'px' } }, pieceSvg(d.piece));
      document.body.append(d.ghost);
      this.render();
    }
    d.ghost.style.left = e.clientX + 'px';
    d.ghost.style.top = e.clientY + 'px';
  }
  onUp(e) {
    if (e.button === 2 && this.rstart) {
      const from = this.rstart, to = this.squareAt(e);
      this.rstart = null;
      if (to === from) this.userMarks.has(to) ? this.userMarks.delete(to) : this.userMarks.add(to);
      else if (to) {
        const i = this.userArrows.findIndex((a) => a.from === from && a.to === to);
        if (i >= 0) this.userArrows.splice(i, 1);
        else this.userArrows.push({ from, to, color: '#c8922a' });
      }
      return this.render();
    }
    const d = this.drag;
    if (!d) return;
    const moved = d.moved;
    this.endDrag();
    const sq = this.squareAt(e);
    if (moved && sq && sq !== d.from && this.targetsFor(d.from, d.pre).includes(sq)) return this.tryMove(d.from, sq, d.pre);
    this.render();
  }
  endDrag() {
    this.drag?.ghost?.remove();
    this.drag = null;
  }

  tryMove(from, to, pre) {
    const p = this.pieces[from];
    const promotes = p && p[1] === 'p' && (to[1] === '8' || to[1] === '1');
    this.selected = null;
    if (pre) return this.opts.onPremove?.(from, to, promotes ? 'q' : undefined); // premove förvandlar alltid till dam
    if (promotes && settings.autoQueen) return this.opts.onMove(from, to, 'q');
    if (promotes) {
      this.render();
      const [x, y] = this.xy(to);
      const down = y === 0;
      this.promo = h('div.promo', { style: { left: x * 12.5 + '%', [down ? 'top' : 'bottom']: '0' } },
        (down ? ['q', 'n', 'r', 'b'] : ['b', 'r', 'n', 'q']).map((t) =>
          h('button', { onclick: (ev) => { ev.stopPropagation(); this.promo.remove(); this.opts.onMove(from, to, t); } }, pieceSvg(p[0] + t))),
      );
      this.promo.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      const close = () => { this.promo?.remove(); document.removeEventListener('pointerdown', close); };
      setTimeout(() => document.addEventListener('pointerdown', close));
      this.el.append(this.promo);
      return;
    }
    this.opts.onMove(from, to);
  }
}
