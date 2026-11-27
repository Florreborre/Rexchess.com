// Chess960 (Fischer Random). Schackbiblioteket (chess.js) kan inte rockera från andra startrutor än de vanliga,
// så den här klassen lägger rockaden ovanpå: vanliga drag sköts av chess.js, rockaden av koden här.
// Samma fil används både i webbläsaren och på servern; därför tar den emot Chess-klassen som argument.

const FILES = 'abcdefgh';

// Slumpar en av de 960 startställningarna. Rockadrätterna skrivs inte i FEN-strängen (de hålls i klassen nedan).
export function random960Fen() {
  const row = Array(8).fill(null);
  const free = () => row.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  row[pick([0, 2, 4, 6])] = 'b'; // löparna på olika färger
  row[pick([1, 3, 5, 7])] = 'b';
  row[pick(free())] = 'q';
  row[pick(free())] = 'n';
  row[pick(free())] = 'n';
  const [a, k, c] = free(); // kungen hamnar alltid mellan tornen
  row[a] = 'r'; row[k] = 'k'; row[c] = 'r';
  const black = row.join('');
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${black.toUpperCase()} w - - 0 1`;
}

export function make960(Chess) {
  const rankOf = (color) => (color === 'w' ? '1' : '8');
  const strip = (fen) => { const f = fen.split(' '); f[2] = '-'; return f.join(' '); };
  const pieceAt = (rows, sq) => rows[8 - Number(sq[1])][FILES.indexOf(sq[0])];

  return class Chess960 {
    constructor(startFen) {
      this.startFen = startFen;
      this.c = new Chess(strip(startFen));
      this.hist = [];
      this.stack = [];
      this.rights = { w: {}, b: {} };
      for (const color of ['w', 'b']) { // tornen på var sida om kungen i startställningen får rockera
        const rank = rankOf(color), row = FILES.split('').map((f) => this.c.get(f + rank));
        const k = row.findIndex((p) => p && p.type === 'k' && p.color === color);
        if (k < 0) continue;
        const left = row.slice(0, k).findIndex((p) => p && p.type === 'r' && p.color === color);
        const right = row.slice(k + 1).findIndex((p) => p && p.type === 'r' && p.color === color);
        if (left >= 0) this.rights[color].q = FILES[left];
        if (right >= 0) this.rights[color].k = FILES[k + 1 + right];
      }
      this.reps = new Map();
      this._count();
    }
    _key() { return this.c.fen().split(' ').slice(0, 4).join(' ') + JSON.stringify(this.rights); }
    _count() { const k = this._key(); this.reps.set(k, (this.reps.get(k) || 0) + 1); }

    fen() { return this.c.fen(); }
    turn() { return this.c.turn(); }
    board() { return this.c.board(); }
    get(sq) { return this.c.get(sq); }
    inCheck() { return this.c.inCheck(); }
    isAttacked(sq, color) { return this.c.isAttacked(sq, color); }
    isCheckmate() { return this.c.isCheckmate(); }
    isStalemate() { return this.c.isStalemate() && !this._castles().length; }
    isInsufficientMaterial() { return this.c.isInsufficientMaterial(); }
    isThreefoldRepetition() { return (this.reps.get(this._key()) || 0) >= 3; }
    isDraw() { return this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition() || Number(this.c.fen().split(' ')[4]) >= 100; }
    isGameOver() { return this.isCheckmate() || this.isDraw(); }
    history(opts) { return opts?.verbose ? [...this.hist] : this.hist.map((m) => m.san); }

    // Möjliga rockader för sidan vid draget: kungen till g- eller c-linjen, tornet till f- eller d-linjen.
    _castles() {
      const color = this.c.turn(), rank = rankOf(color), opp = color === 'w' ? 'b' : 'w';
      if (this.c.inCheck()) return [];
      const kingSq = FILES.split('').map((f) => f + rank).find((sq) => { const p = this.c.get(sq); return p && p.type === 'k' && p.color === color; });
      if (!kingSq) return [];
      const out = [];
      for (const side of ['k', 'q']) {
        const rf = this.rights[color][side];
        if (!rf) continue;
        const rookSq = rf + rank, rook = this.c.get(rookSq);
        if (!rook || rook.type !== 'r' || rook.color !== color) continue;
        const kingTo = (side === 'k' ? 'g' : 'c') + rank, rookTo = (side === 'k' ? 'f' : 'd') + rank;
        const span = (a, b) => { const [x, y] = [FILES.indexOf(a[0]), FILES.indexOf(b[0])].sort((m, n) => m - n); return FILES.slice(x, y + 1).split('').map((f) => f + rank); };
        // Alla rutor som kung och torn passerar eller hamnar på måste vara tomma (förutom de två själva) …
        const needEmpty = new Set([...span(kingSq, kingTo), ...span(rookSq, rookTo)]);
        if ([...needEmpty].some((sq) => sq !== kingSq && sq !== rookSq && this.c.get(sq))) continue;
        // … och kungen får inte gå genom eller hamna på en hotad ruta.
        if (span(kingSq, kingTo).some((sq) => this.c.isAttacked(sq, opp))) continue;
        out.push({ side, kingSq, rookSq, kingTo, rookTo });
      }
      return out;
    }

    moves(opts = {}) {
      const normal = this.c.moves({ square: opts.square, verbose: true });
      const castles = this._castles().filter((c) => !opts.square || opts.square === c.kingSq).flatMap((c) => {
        const san = c.side === 'k' ? 'O-O' : 'O-O-O';
        // Man rockerar genom att flytta kungen till målrutan eller ställa den på det egna tornet.
        const targets = new Set([c.rookSq]);
        if (c.kingTo !== c.kingSq && !normal.some((m) => m.from === c.kingSq && m.to === c.kingTo)) targets.add(c.kingTo);
        return [...targets].map((to) => ({ color: this.c.turn(), from: c.kingSq, to, piece: 'k', san, flags: c.side, castle: c }));
      });
      const all = [...normal, ...castles];
      return opts.verbose ? all : [...new Set(all.map((m) => m.san))];
    }

    move(arg) {
      const castles = this._castles();
      let castle = null;
      if (typeof arg === 'string') {
        const s = arg.replace(/[+#!?]/g, '').replace(/0/g, 'O');
        if (s === 'O-O' || s === 'O-O-O') castle = castles.find((c) => c.side === (s === 'O-O' ? 'k' : 'q'));
      } else {
        castle = castles.find((c) => c.kingSq === arg.from && (arg.to === c.rookSq || (arg.to === c.kingTo && c.kingTo !== c.kingSq)
          && !this.c.moves({ square: arg.from, verbose: true }).some((m) => m.to === arg.to)));
      }
      const snap = { fen: this.c.fen(), rights: JSON.parse(JSON.stringify(this.rights)), reps: new Map(this.reps) };
      let mv;
      if (castle) {
        const color = this.c.turn();
        const rows = this.c.fen().split(' ')[0].split('/').map((r) => r.replace(/\d/g, (d) => '.'.repeat(Number(d))).split(''));
        const set = (sq, v) => { rows[8 - Number(sq[1])][FILES.indexOf(sq[0])] = v; };
        const king = pieceAt(rows, castle.kingSq), rook = pieceAt(rows, castle.rookSq);
        set(castle.kingSq, '.'); set(castle.rookSq, '.');
        set(castle.kingTo, king); set(castle.rookTo, rook);
        const f = this.c.fen().split(' ');
        const placement = rows.map((r) => r.join('').replace(/\.+/g, (m) => String(m.length))).join('/');
        const next = `${placement} ${color === 'w' ? 'b' : 'w'} - - ${Number(f[4]) + 1} ${Number(f[5]) + (color === 'b' ? 1 : 0)}`;
        this.c.load(next);
        this.rights[color] = {};
        const san = (castle.side === 'k' ? 'O-O' : 'O-O-O') + (this.c.isCheckmate() ? '#' : this.c.inCheck() ? '+' : '');
        mv = { color, from: castle.kingSq, to: castle.kingTo, piece: 'k', san, lan: san, flags: castle.side, before: snap.fen, after: this.c.fen() };
      } else {
        mv = this.c.move(arg); // kastar ett fel om draget är olagligt, precis som chess.js
        const color = mv.color, opp = color === 'w' ? 'b' : 'w';
        if (mv.piece === 'k') this.rights[color] = {};
        for (const side of ['k', 'q']) {
          if (mv.piece === 'r' && mv.from === this.rights[color][side] + rankOf(color)) delete this.rights[color][side];
          if (mv.captured === 'r' && mv.to === this.rights[opp][side] + rankOf(opp)) delete this.rights[opp][side];
        }
      }
      this.stack.push(snap);
      this.hist.push(mv);
      this._count();
      return mv;
    }

    undo() {
      const snap = this.stack.pop();
      if (!snap) return null;
      this.c.load(snap.fen);
      this.rights = snap.rights;
      this.reps = snap.reps;
      return this.hist.pop();
    }
  };
}
