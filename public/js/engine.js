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

export const BOTS = [
  { id: 'pelle', name: 'Tiro', rating: 400, desc: 'Har precis lärt sig hur pjäserna går.', random: 0.5, skill: 0, depth: 1 },
  { id: 'maja', name: 'Servius', rating: 800, desc: 'Spelar ibland bra, men sätter ofta bort pjäser.', random: 0.22, skill: 0, depth: 2 },
  { id: 'olle', name: 'Marcus', rating: 1200, desc: 'Klubbspelare som kan grunderna.', random: 0.05, skill: 3, depth: 5 },
  { id: 'saga', name: 'Livia', rating: 1600, desc: 'Stabil och straffar slarv.', elo: 1600, movetime: 300 },
  { id: 'viktor', name: 'Brutus', rating: 2000, desc: 'Stark taktiker.', elo: 2000, movetime: 500 },
  { id: 'freja', name: 'Aurelia', rating: 2400, desc: 'Mästarnivå.', elo: 2400, movetime: 700 },
  { id: 'max', name: 'Caesar', rating: 3200, desc: 'Stockfish på full styrka. Lycka till.', movetime: 1000 },
];

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
