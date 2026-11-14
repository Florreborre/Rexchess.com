// Tar fram schackproblem: Stockfish spelar partier med inlagda misstag, och ställningar där det finns
// en forcerad matt eller en tydlig taktisk vinst sparas som problem i puzzles.json.
// Körs med: node tools/genpuzzles.js [antal minuter]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const OUT = path.join(__dirname, '..', 'puzzles.json');
const MINUTES = Number(process.argv[2]) || 8;
const LIMITS = { m1: 50, m2: 90, m3: 50, tactic: 130 };

const sf = spawn(process.execPath, [require('stockfish').findEngine('lite-single')], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', onLine = null;
sf.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onLine?.(l); }
});
function search(fen, depth, multipv) {
  return new Promise((resolve) => {
    const lines = [];
    onLine = (l) => {
      if (l.startsWith('info') && l.includes(' pv ') && !l.includes('bound')) {
        const m = l.match(/multipv (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)$/);
        if (m) lines[Number(m[1]) - 1] = { cp: m[2] === 'cp' ? Number(m[3]) : null, mate: m[2] === 'mate' ? Number(m[3]) : null, pv: m[4].trim().split(' ') };
      } else if (l.startsWith('bestmove')) { onLine = null; resolve(lines.filter(Boolean)); }
    };
    sf.stdin.write(`setoption name MultiPV value ${multipv}\nposition fen ${fen}\ngo depth ${depth}\n`);
  });
}
const uci = (c, u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
const val = (l) => (l.mate != null ? (l.mate > 0 ? 10000 - l.mate : -10000 - l.mate) : l.cp);

(async () => {
  const puzzles = [], seen = new Set(), count = { m1: 0, m2: 0, m3: 0, tactic: 0 };
  const deadline = Date.now() + MINUTES * 60000;
  const full = () => Object.keys(LIMITS).every((k) => count[k] >= LIMITS[k]);
  let games = 0;
  while (Date.now() < deadline && !full()) {
    const c = new Chess();
    games++;
    let prev = 0; // ställningens värde för sidan vid draget, före motståndarens senaste drag
    for (let ply = 0; ply < 140 && !c.isGameOver(); ply++) {
      const fen = c.fen();
      const lines = await search(fen, 10, 2);
      if (!lines.length) break;
      const [best, second] = lines;
      const key = fen.split(' ').slice(0, 2).join(' ');
      if (ply >= 12 && !seen.has(key)) {
        let puzzle = null;
        if (best.mate >= 1 && best.mate <= 3 && (!second || second.mate == null || second.mate < 0 || second.mate > best.mate)) {
          const kind = 'm' + best.mate;
          if (count[kind] < LIMITS[kind] && best.pv.length >= 2 * best.mate - 1) {
            puzzle = { kind, moves: best.pv.slice(0, 2 * best.mate - 1), rating: { 1: 750, 2: 1200, 3: 1600 }[best.mate] + Math.round(Math.random() * 200 - 100), theme: `Matt i ${best.mate}` };
          }
        } else if (count.tactic < LIMITS.tactic && best.cp != null && best.cp >= 300 && second && val(second) <= best.cp - 250 && prev < 150 && prev > -250) {
          // Bekräfta på större djup att draget verkligen är det enda som vinner.
          const deep = await search(fen, 14, 2);
          if (deep.length === 2 && deep[0].pv[0] === best.pv[0] && deep[0].cp != null && deep[0].cp >= 300 && val(deep[1]) <= deep[0].cp - 250 && deep[0].pv.length >= 3) {
            const gap = deep[0].cp - val(deep[1]);
            puzzle = { kind: 'tactic', moves: deep[0].pv.slice(0, 3), rating: Math.max(900, Math.min(2100, 1900 - Math.round(gap / 2) + Math.round(Math.random() * 200 - 100))), theme: 'Taktik' };
          }
        }
        if (puzzle) {
          // Kontrollera att lösningen är laglig och (för mattproblem) verkligen slutar i matt.
          const t = new Chess(fen);
          let ok = true;
          try { for (const m of puzzle.moves) uci(t, m); } catch { ok = false; }
          if (ok && (puzzle.kind === 'tactic' || t.isCheckmate())) {
            seen.add(key);
            count[puzzle.kind]++;
            puzzles.push({ id: 'p' + (puzzles.length + 1), fen, moves: puzzle.moves, rating: puzzle.rating, theme: puzzle.theme });
          }
        }
      }
      // Välj drag: oftast bäst, ibland näst bäst, ibland slumpat – så att det uppstår misstag att straffa.
      const r = Math.random();
      let move;
      if (r < 0.14) { const legal = c.moves({ verbose: true }); const m = legal[Math.floor(Math.random() * legal.length)]; move = m.from + m.to + (m.promotion || ''); }
      else if (r < 0.32 && second) move = second.pv[0];
      else move = best.pv[0];
      prev = -val(best);
      try { uci(c, move); } catch { break; }
    }
    if (games % 10 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(puzzles));
      console.log(`${games} partier, ${puzzles.length} problem`, JSON.stringify(count));
    }
  }
  puzzles.sort((a, b) => a.rating - b.rating);
  fs.writeFileSync(OUT, JSON.stringify(puzzles));
  console.log(`KLART: ${puzzles.length} problem`, JSON.stringify(count));
  sf.kill();
})();
