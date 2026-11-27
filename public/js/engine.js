// Stockfish (WebAssembly) i en Web Worker. Används både för datormotståndare och partianalys.
let shared = null;
export function getEngine() {
  return (shared ??= new Engine());
}

export class Engine {
  constructor() {
    this.worker = new Worker('/vendor/stockfish/stockfish-19-lite-single.js');
    this.onLine = null;
    this.worker.onmessage = (e) => { if (typeof e.data === 'string') this.onLine?.(e.data); };
    this.chain = new Promise((resolve) => {
      this.onLine = (l) => { if (l.startsWith('uciok')) { this.onLine = null; resolve(); } };
      this.worker.postMessage('uci');
    });
  }

  // Sökningar körs en i taget. Returnerar { best, lines: [{ cp, mate, pv, depth }] } ur dragande sidas perspektiv.
  search(fen, { depth, movetime, multipv = 1, elo = null, skill = 20 } = {}) {
    const run = () => new Promise((resolve) => {
      const lines = [];
      this.onLine = (l) => {
        if (l.startsWith('info') && l.includes(' pv ') && !l.includes('bound')) {
          const m = l.match(/depth (\d+).*?multipv (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)$/);
          if (m) {
            lines[Number(m[2]) - 1] = {
              depth: Number(m[1]), cp: m[3] === 'cp' ? Number(m[4]) : null,
              mate: m[3] === 'mate' ? Number(m[4]) : null, pv: m[5].trim().split(' '),
            };
          }
        } else if (l.startsWith('bestmove')) {
          this.onLine = null;
          const best = l.split(' ')[1];
          resolve({ best: best === '(none)' ? null : best, lines: lines.filter(Boolean) });
        }
      };
      const post = (c) => this.worker.postMessage(c);
      post(`setoption name MultiPV value ${multipv}`);
      post(`setoption name UCI_LimitStrength value ${elo ? 'true' : 'false'}`);
      if (elo) post(`setoption name UCI_Elo value ${elo}`);
      post(`setoption name Skill Level value ${skill}`);
      post(`position fen ${fen}`);
      post(depth ? `go depth ${depth}` : `go movetime ${movetime || 500}`);
    });
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  stop() {
    this.worker.postMessage('stop');
  }
}

// Gör en datormotståndare med ungefär den angivna styrkan. Under 1320 klarar Stockfish inte att ställas in direkt,
// så där blandas svaga motordrag med slumpdrag; från 1320 används motorns egen Elo-inställning.
export function botFromElo(elo, name = `Dator ${elo}`, desc = '') {
  if (elo >= 3200) return { name, rating: 3200, desc, movetime: 1000 };
  if (elo >= 1320) return { name, rating: elo, desc, elo: Math.min(elo, 3190), movetime: 250 + Math.round((elo - 1320) / 4) };
  return { name, rating: elo, desc, random: Math.max(0.03, (1300 - elo) / 1800), skill: elo < 900 ? 0 : 2, depth: elo < 600 ? 1 : elo < 1000 ? 2 : 4 };
}
export const BOTS = [
  ['Elsa', 250, 'Har precis lärt sig hur pjäserna går.'], ['Oskar', 400, 'Har precis lärt sig hur pjäserna går.'],
  ['Maja', 600, 'Spelar ibland bra, men sätter ofta bort pjäser.'], ['Hugo', 800, 'Spelar ibland bra, men sätter ofta bort pjäser.'],
  ['Alice', 1000, 'Klubbspelare som kan grunderna.'], ['Erik', 1200, 'Klubbspelare som kan grunderna.'],
  ['Sara', 1400, 'Stabil och straffar slarv.'], ['Johan', 1600, 'Stabil och straffar slarv.'],
  ['Emma', 1800, 'Stark taktiker.'], ['Viktor', 2000, 'Stark taktiker.'],
  ['Nora', 2200, 'Mästarnivå.'], ['Axel', 2400, 'Mästarnivå.'],
  ['Ingrid', 2800, 'Nästan omöjlig att slå.'], ['Stockfish', 3200, 'Stockfish på full styrka. Lycka till.'],
].map(([name, elo, desc]) => botFromElo(elo, name, desc));

// Väljer datorns drag för ställningen i `chess` (en chess.js-instans). Returnerar { from, to, promotion }.
export async function botMove(bot, chess) {
  const delay = new Promise((r) => setTimeout(r, 350 + Math.random() * 450));
  let move;
  if (bot.random && Math.random() < bot.random) {
    const legal = chess.moves({ verbose: true });
    const m = legal[Math.floor(Math.random() * legal.length)];
    move = { from: m.from, to: m.to, promotion: m.promotion };
  } else {
    const res = await getEngine().search(chess.fen(), { depth: bot.depth, movetime: bot.movetime, elo: bot.elo, skill: bot.skill ?? 20 });
    move = { from: res.best.slice(0, 2), to: res.best.slice(2, 4), promotion: res.best[4] };
  }
  await delay;
  return move;
}
