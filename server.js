// Schack Online – server: konton, sessioner, rating (Elo), onlinepartier via WebSocket.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const { DatabaseSync } = require('node:sqlite');
const { make960, random960Fen } = require('./public/js/chess960.js');
const Chess960 = make960(Chess);

const PORT = Number(process.env.PORT) || 3000;
const START_RATING = 1200;
const TIME_CONTROLS = { '1+0': [60, 0], '2+1': [120, 1], '3+0': [180, 0], '3+2': [180, 2], '5+0': [300, 0], '5+3': [300, 3], '10+0': [600, 0], '10+5': [600, 5], '15+10': [900, 10] };

// ---------- Databas ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'chess.db'));
db.exec('PRAGMA journal_mode = WAL;');
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT ${START_RATING},
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    white_id INTEGER, black_id INTEGER,
    white_name TEXT NOT NULL, black_name TEXT NOT NULL,
    white_rating INTEGER, black_rating INTEGER,
    white_diff INTEGER NOT NULL DEFAULT 0, black_diff INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL, reason TEXT NOT NULL,
    moves TEXT NOT NULL, pgn TEXT NOT NULL,
    tc TEXT, rated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS games_white ON games(white_id, created_at);
  CREATE INDEX IF NOT EXISTS games_black ON games(black_id, created_at);
  CREATE TABLE IF NOT EXISTS friendships (
    user_id INTEGER NOT NULL, friend_id INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, tc TEXT NOT NULL, duration INTEGER NOT NULL,
    creator_id INTEGER NOT NULL, creator_name TEXT NOT NULL, status TEXT NOT NULL,
    starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id TEXT NOT NULL, user_id INTEGER NOT NULL, score REAL NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tournament_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS achievements (user_id INTEGER NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, key));
  CREATE TABLE IF NOT EXISTS seasons (id TEXT PRIMARY KEY, winner_id INTEGER, winner_name TEXT, points INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS clubs (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS club_members (user_id INTEGER PRIMARY KEY, club_id TEXT NOT NULL, joined_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id INTEGER, reporter_name TEXT, target_id INTEGER, target_name TEXT, reason TEXT, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS blocks (user_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, PRIMARY KEY (user_id, blocked_id));
  CREATE TABLE IF NOT EXISTS flags (user_id INTEGER PRIMARY KEY, username TEXT, reason TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, ran_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
  CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_from ON messages(from_id, created_at);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT, text TEXT NOT NULL, link TEXT, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);
  CREATE TABLE IF NOT EXISTS corr_games (
    id TEXT PRIMARY KEY, host_id INTEGER, white_id INTEGER, black_id INTEGER, white_name TEXT, black_name TEXT,
    moves TEXT NOT NULL DEFAULT '', days INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, reason TEXT, draw_offer TEXT,
    last_move_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
`;
const TABLES = ['users', 'sessions', 'games', 'friendships', 'tournaments', 'tournament_players', 'achievements', 'seasons', 'clubs', 'club_members',
  'reports', 'blocks', 'flags', 'corr_games', 'migrations', 'messages', 'notifications'];
const CLASSES = ['bullet', 'blitz', 'rapid'];
const EXTRA_COLUMNS = [['games', 'tournament_id TEXT'], ['games', 'white_acc REAL'], ['games', 'black_acc REAL'], ['games', 'quality REAL'],
  ['users', `peak INTEGER NOT NULL DEFAULT ${START_RATING}`], ['users', 'trophies INTEGER NOT NULL DEFAULT 0'],
  ['users', 'is_admin INTEGER NOT NULL DEFAULT 0'], ['users', 'banned INTEGER NOT NULL DEFAULT 0'],
  ['users', 'puzzle_rating INTEGER NOT NULL DEFAULT 1200'], ['users', 'puzzles_solved INTEGER NOT NULL DEFAULT 0'],
  // Rating och antal partier per betänketidsklass. 0 i rating betyder "inte spelat än" – då används den sammanlagda ratingen.
  ...CLASSES.flatMap((k) => [['users', `r_${k} INTEGER NOT NULL DEFAULT 0`], ['users', `g_${k} INTEGER NOT NULL DEFAULT 0`]]),
  ['users', 'country TEXT'], ['users', 'avatar TEXT'], ['users', 'avatar_v INTEGER NOT NULL DEFAULT 0'],
  ['games', 'variant TEXT'], ['games', 'start_fen TEXT'], ['games', 'acc_phases TEXT'], ['tournaments', 'club_a TEXT'], ['tournaments', 'club_b TEXT'],
  ['users', 'crown_until INTEGER NOT NULL DEFAULT 0'], ['users', 'weekly_wins INTEGER NOT NULL DEFAULT 0'], ['tournaments', 'weekly INTEGER NOT NULL DEFAULT 0'],
  ['tournaments', "format TEXT NOT NULL DEFAULT 'arena'"], ['tournaments', 'rounds INTEGER NOT NULL DEFAULT 0'], ['tournaments', 'round INTEGER NOT NULL DEFAULT 0'],
  ['tournament_players', 'out INTEGER NOT NULL DEFAULT 0']];
db.exec(SCHEMA);
for (const [table, col] of EXTRA_COLUMNS) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* kolumnen finns redan */ }
}
db.exec('UPDATE users SET peak = rating WHERE peak < rating'); // konton från före titlarna: börja från nuvarande rating

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  updateStats: db.prepare('UPDATE users SET rating = ?1, peak = MAX(peak, ?1), games = games + 1, wins = wins + ?2, losses = losses + ?3, draws = draws + ?4 WHERE id = ?5'),
  addTrophy: db.prepare('UPDATE users SET trophies = trophies + 1 WHERE id = ?'),
  tUpdate: db.prepare('UPDATE tournaments SET tc = ?, duration = ?, starts_at = ?, ends_at = ? WHERE id = ?'),
  insertGame: db.prepare(`INSERT INTO games (id, white_id, black_id, white_name, black_name, white_rating, black_rating,
    white_diff, black_diff, result, reason, moves, pgn, tc, rated, created_at, tournament_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  friendRows: db.prepare(`SELECT u.id, u.username, u.rating, u.peak, u.games, f.status, f.user_id AS requester FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.user_id = ?1 THEN f.friend_id ELSE f.user_id END WHERE f.user_id = ?1 OR f.friend_id = ?1`),
  friendship: db.prepare('SELECT * FROM friendships WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)'),
  insertFriend: db.prepare("INSERT INTO friendships (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)"),
  acceptFriend: db.prepare("UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ? AND status = 'pending'"),
  deleteFriend: db.prepare('DELETE FROM friendships WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)'),
  tList: db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS players FROM tournaments t
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, created_at DESC LIMIT 30`),
  tById: db.prepare('SELECT * FROM tournaments WHERE id = ?'),
  tActive: db.prepare("SELECT * FROM tournaments WHERE status IN ('open', 'running')"),
  tInsert: db.prepare("INSERT INTO tournaments (id, name, tc, duration, creator_id, creator_name, status, starts_at, ends_at, created_at) VALUES (?,?,?,?,?,?,'open',?,?,?)"),
  tStatus: db.prepare('UPDATE tournaments SET status = ?, ends_at = ? WHERE id = ?'),
  tPlayers: db.prepare(`SELECT u.id, u.username, u.country, u.crown_until, u.rating, u.peak, u.games AS total_games, u.trophies, p.score, p.games, p.wins, p.draws, p.losses, p.out FROM tournament_players p
    JOIN users u ON u.id = p.user_id WHERE p.tournament_id = ? ORDER BY p.out, p.score DESC, p.wins DESC, u.rating DESC`),
  tPlayer: db.prepare('SELECT * FROM tournament_players WHERE tournament_id = ? AND user_id = ?'),
  tJoin: db.prepare('INSERT OR IGNORE INTO tournament_players (tournament_id, user_id) VALUES (?, ?)'),
  tLeave: db.prepare('DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?'),
  tScore: db.prepare('UPDATE tournament_players SET score = score + ?, games = games + 1, wins = wins + ?, draws = draws + ?, losses = losses + ? WHERE tournament_id = ? AND user_id = ?'),
  tGames: db.prepare('SELECT id, white_name, black_name, result, reason, created_at FROM games WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 30'),
  setQuality: db.prepare('UPDATE games SET white_acc = ?, black_acc = ?, quality = ? WHERE id = ?'),
  weekGames: db.prepare(`SELECT id, white_name, black_name, white_rating, black_rating, result, reason, moves, tc, white_acc, black_acc, quality, created_at
    FROM games WHERE rated = 1 AND quality IS NOT NULL AND created_at > ? ORDER BY quality DESC LIMIT 200`),
  gamesForUser: db.prepare(`SELECT id, white_id, black_id, white_name, black_name, white_rating, black_rating, white_diff, black_diff,
    result, reason, tc, rated, created_at, moves FROM games WHERE white_id = ?1 OR black_id = ?1 ORDER BY created_at DESC LIMIT 100`),
  gameById: db.prepare('SELECT * FROM games WHERE id = ?'),
  profileGames: db.prepare(`SELECT id, white_id, black_id, white_name, black_name, white_rating, black_rating, white_diff, black_diff,
    white_acc, black_acc, acc_phases, result, reason, tc, rated, created_at, moves, variant FROM games WHERE white_id = ?1 OR black_id = ?1 ORDER BY created_at DESC LIMIT 500`),
  leaderboard: db.prepare('SELECT username, country, rating, peak, trophies, crown_until, games, wins, losses, draws FROM users WHERE games >= 5 AND banned = 0 ORDER BY rating DESC, games DESC LIMIT 50'),
};

// ---------- Spegling till Turso ----------
// På ett gratis webbhotell raderas den lokala filen varje gång servern somnar. Om TURSO_DATABASE_URL är satt
// skickas därför varje ändring vidare till en Turso-databas, och vid start hämtas allt tillbaka därifrån.
// Utan variabeln (t.ex. hemma på egen dator) används bara den lokala filen, precis som förut.
const remote = process.env.TURSO_DATABASE_URL
  ? require('@libsql/client').createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : null;
const mirrorQueue = [];
let mirroring = false, mirrorFailures = 0;
function mirror(sql, args) {
  if (!remote) return;
  mirrorQueue.push({ sql, args });
  flushMirror();
}
async function flushMirror() {
  if (mirroring) return;
  mirroring = true;
  while (mirrorQueue.length) {
    const batch = mirrorQueue.slice(0, 50);
    try {
      await remote.batch(batch, 'write');
      mirrorQueue.splice(0, batch.length);
      mirrorFailures = 0;
    } catch (e) {
      console.error('Kunde inte spara till Turso:', e.message);
      if (++mirrorFailures >= 3) {
        // Samma grupp har misslyckats flera gånger: kör satserna en och en och hoppa över den som är trasig.
        for (const stmt of batch) {
          try { await remote.execute(stmt); } catch (e2) { console.error('Hoppar över sats:', stmt.sql, e2.message); }
        }
        mirrorQueue.splice(0, batch.length);
        mirrorFailures = 0;
      } else await new Promise((r) => setTimeout(r, 3000));
    }
  }
  mirroring = false;
}
for (const name of ['insertUser', 'insertSession', 'deleteSession', 'updateStats', 'insertGame', 'insertFriend', 'acceptFriend',
  'deleteFriend', 'tInsert', 'tStatus', 'tJoin', 'tLeave', 'tScore', 'setQuality', 'addTrophy', 'tUpdate']) {
  const stmt = q[name];
  q[name] = {
    run(...args) {
      const info = stmt.run(...args);
      // Nya användare speglas med sitt id, så att numreringen garanterat blir densamma i båda databaserna.
      if (name === 'insertUser') mirror('INSERT INTO users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)', [Number(info.lastInsertRowid), ...args]);
      else mirror(stmt.sourceSQL, args);
      return info;
    },
  };
}
// Skrivande sats som också speglas till Turso. Används för allt som har tillkommit efter grundtabellerna.
const mirrored = (sql) => {
  const stmt = db.prepare(sql);
  return { run(...args) { const info = stmt.run(...args); mirror(sql, args); return info; } };
};
const tFormat = mirrored('UPDATE tournaments SET format = ?, rounds = ? WHERE id = ?');
// Nya spelare väljer själva ungefär hur starka de är och börjar på motsvarande rating. Ratingen visas först efter
// PLACEMENT_GAMES rankade partier; fram till dess syns "?" och spelaren står inte på topplistan.
const START_LEVELS = { new: 600, beginner: 800, intermediate: 1200, advanced: 1600, expert: 2000 };
const PLACEMENT_GAMES = 5;
const setStart = mirrored('UPDATE users SET rating = ?, peak = ?, country = ? WHERE id = ?');
const setAvatar = mirrored('UPDATE users SET avatar = ?, avatar_v = ? WHERE id = ?');
const setVariant = mirrored('UPDATE games SET variant = ?, start_fen = ? WHERE id = ?');
const setPhases = mirrored('UPDATE games SET acc_phases = ? WHERE id = ?');
const avatarUrl = (u) => (u.avatar_v ? `/api/avatar/${encodeURIComponent(u.username)}?v=${u.avatar_v}` : null);
const shownRating = (rating, games) => (games < PLACEMENT_GAMES ? '?' : rating);
const updateClass = Object.fromEntries(CLASSES.map((k) => [k, mirrored(`UPDATE users SET r_${k} = ?1, g_${k} = g_${k} + 1, rating = ?2, peak = MAX(peak, ?1),
  games = games + 1, wins = wins + ?3, losses = losses + ?4, draws = draws + ?5 WHERE id = ?6`)]));
// Körs innan servern börjar ta emot besök: skapar tabellerna i Turso och fyller den lokala filen om den är tom.
async function restoreFromRemote() {
  if (!remote) return;
  await remote.executeMultiple(SCHEMA);
  // Lägg bara till de kolumner som saknas (en fråga per tabell i stället för ett försök per kolumn – snabbare uppstart).
  const have = new Map();
  for (const table of new Set(EXTRA_COLUMNS.map(([t]) => t))) {
    const res = await remote.execute({ sql: 'SELECT name FROM pragma_table_info(?)', args: [table] });
    have.set(table, new Set(res.rows.map((r) => r.name)));
  }
  for (const [table, col] of EXTRA_COLUMNS) {
    if (have.get(table).has(col.split(' ')[0])) continue;
    try { await remote.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* kolumnen finns redan */ }
  }
  await remote.execute('UPDATE users SET peak = rating WHERE peak < rating');
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return; // lokal data finns redan – rör den inte
  let total = 0;
  for (const table of TABLES) {
    for (let last = 0; ;) {
      const res = await remote.execute({ sql: `SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 3000`, args: [last] });
      if (!res.rows.length) break;
      const cols = res.columns.slice(1);
      const insert = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of res.rows) insert.run(...cols.map((c) => row[c]));
      last = Number(res.rows.at(-1)._rid);
      total += res.rows.length;
    }
  }
  console.log(`Hämtade ${total} rader från Turso.`);
}

// ---------- Hjälpfunktioner ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (pw, salt) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, buf) => (e ? rej(e) : res(buf.toString('hex')))));
// Titlar: bygger på spelarens högsta rating någonsin, så en titel man har fått behåller man. Kräver minst 5 rankade partier.
const TITLES = [[2800, 'Supermästare'], [2600, 'Stormästare'], [2400, 'Internationell mästare'], [2200, 'FIDE-mästare'], [2000, 'Kandidatmästare'],
  [1800, 'Elit'], [1600, 'Expert'], [1400, 'Avancerad'], [1200, 'Klubbspelare'], [1000, 'Amatör'], [800, 'Utmanare'], [600, 'Novis'], [400, 'Lärling']];
function titleFor(peak, games) {
  if (games < PLACEMENT_GAMES) return 'Oplacerad';
  return (TITLES.find(([min]) => peak >= min) || [0, 'Nybörjare'])[1];
}
const classRating = (u, k) => u['r_' + k] || u.rating;
const tcClass = (tc) => {
  const min = Number(String(tc).split('+')[0]);
  return min < 3 ? 'bullet' : min < 10 ? 'blitz' : 'rapid';
};
const publicUser = (u) => u && { id: u.id, username: u.username, rating: u.rating, peak: u.peak, title: titleFor(u.peak, u.games), trophies: u.trophies,
  avatar: u.avatar_v ? `/api/avatar/${encodeURIComponent(u.username)}?v=${u.avatar_v}` : null,
  crown: u.crown_until > Date.now(), weeklyWins: u.weekly_wins || 0,
  country: u.country || null, provisional: u.games < PLACEMENT_GAMES, games: u.games, wins: u.wins, losses: u.losses, draws: u.draws, admin: !!u.is_admin, puzzleRating: u.puzzle_rating, puzzlesSolved: u.puzzles_solved,
  ratings: Object.fromEntries(CLASSES.map((k) => [k, { rating: classRating(u, k), games: u['g_' + k] }])) };

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function userFromRequest(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  const u = sid ? q.sessionUser.get(sha256(sid)) : undefined;
  return u && !u.banned ? u : undefined; // avstängda konton räknas som utloggade
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(sha256(token), userId, Date.now());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${req.secure ? '; Secure' : ''}`);
}

// Enkel spärr mot lösenordsgissning: max 20 försök per 10 minuter och IP.
const attempts = new Map();
function rateLimited(req) {
  const ip = req.ip || req.socket.remoteAddress || '?';
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) attempts.set(ip, (a = { count: 0, reset: now + 10 * 60 * 1000 }));
  return ++a.count > 20;
}

function elo(ra, rb, score, gamesPlayed) {
  const k = gamesPlayed < PLACEMENT_GAMES ? 64 : gamesPlayed < 30 ? 40 : 20; // placeringspartierna flyttar ratingen snabbt
  const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
  return Math.round(ra + k * (score - expected));
}

function buildPgn(chess, white, black, result, tc, startFen = null) {
  if (startFen) { // Chess960: dragen skrivs ut direkt, eftersom chess.js inte kan spela upp 960-rockader
    const sans = chess.history();
    const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + s).join(' ');
    return [['Event', 'Schack Online'], ['Variant', 'Chess960'], ['White', white.name], ['Black', black.name], ['Result', result], ['SetUp', '1'], ['FEN', startFen], ['TimeControl', tc]]
      .map(([k, v]) => `[${k} "${v}"]`).join('\n') + `\n\n${body} ${result}`;
  }
  const c = new Chess();
  c.setHeader('Event', 'Schack Online');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  c.setHeader('White', white.name);
  c.setHeader('Black', black.name);
  c.setHeader('Result', result);
  if (white.rating) c.setHeader('WhiteElo', String(white.rating));
  if (black.rating) c.setHeader('BlackElo', String(black.rating));
  if (tc) c.setHeader('TimeControl', tc);
  for (const san of chess.history()) c.move(san);
  let pgn = c.pgn();
  if (!pgn.trim().endsWith(result)) pgn = pgn.trim() + ' ' + result;
  return pgn;
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
if (process.env.PORT) app.set('trust proxy', 1); // bakom webbhotellets proxy: läs besökarens riktiga IP och https-status
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  req.user = userFromRequest(req);
  next();
});

app.post('/api/register', async (req, res) => {
  if (rateLimited(req)) return res.status(429).json({ error: 'För många försök. Vänta en stund.' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9_\-åäöÅÄÖ]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Användarnamnet måste vara 3–20 tecken (bokstäver, siffror, _ och -).' });
  if (password.length < 6 || password.length > 200)
    return res.status(400).json({ error: 'Lösenordet måste vara minst 6 tecken.' });
  if (q.userByName.get(username)) return res.status(409).json({ error: 'Användarnamnet är upptaget.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const info = q.insertUser.run(username, await hashPassword(password, salt), salt, Date.now());
  const start = START_LEVELS[req.body?.level] || START_RATING;
  const country = /^[A-Z]{2}$/.test(String(req.body?.country || '')) ? String(req.body.country) : null;
  setStart.run(start, start, country, Number(info.lastInsertRowid));
  startSession(req, res, Number(info.lastInsertRowid));
  res.json({ user: publicUser(q.userById.get(Number(info.lastInsertRowid))) });
});

app.post('/api/login', async (req, res) => {
  if (rateLimited(req)) return res.status(429).json({ error: 'För många försök. Vänta en stund.' });
  const user = q.userByName.get(String(req.body?.username || '').trim());
  const password = String(req.body?.password || '');
  const hash = await hashPassword(password, user ? user.salt : 'x');
  if (!user || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.pass_hash)))
    return res.status(401).json({ error: 'Fel användarnamn eller lösenord.' });
  if (user.banned) return res.status(403).json({ error: 'Kontot är avstängt.' });
  startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) q.deleteSession.run(sha256(sid));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Profilbild: webbläsaren skalar ner bilden till 128×128 innan den skickas, så den ryms i databasen.
app.post('/api/account/avatar', (req, res) => {
  if (!needUser(req, res)) return;
  const data = req.body?.data;
  if (data === null) { setAvatar.run(null, 0, req.user.id); return res.json({ avatar: null }); }
  if (typeof data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 90000)
    return res.status(400).json({ error: 'Bilden är för stor eller i fel format.' });
  const v = Date.now();
  setAvatar.run(data, v, req.user.id);
  res.json({ avatar: avatarUrl({ ...req.user, avatar_v: v }) });
});
app.get('/api/avatar/:username', (req, res) => {
  const u = q.userByName.get(String(req.params.username));
  const m = u?.avatar && /^data:(image\/\w+);base64,(.+)$/.exec(u.avatar);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // adressen ändras när bilden byts
  res.end(Buffer.from(m[2], 'base64'));
});
app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) || null }));
// Offentlig profil: spelarens uppgifter och partier (de 16 första halvdragen räcker för att känna igen öppningen).
app.get('/api/users/:username', (req, res) => {
  const u = q.userByName.get(String(req.params.username));
  if (!u) return res.status(404).json({ error: 'Det finns ingen spelare med det namnet.' });
  const games = q.profileGames.all(u.id).map(({ moves, ...g }) => {
    const sans = moves ? moves.split(' ') : [];
    return { ...g, plies: sans.length, opening: g.variant === '960' ? [] : sans.slice(0, 16) };
  });
  let friend = null;
  if (req.user && req.user.id !== u.id) {
    const f = q.friendship.get(req.user.id, u.id);
    friend = !f ? 'none' : f.status === 'accepted' ? 'accepted' : f.user_id === req.user.id ? 'sent' : 'incoming';
  }
  res.json({ user: { ...publicUser(u), created_at: u.created_at, online: sockets.has(u.id), playing: activeGame.has(u.id), ...features.profileExtra(u, req.user) }, games, friend });
});
app.get('/api/leaderboard', (req, res) => features.leaderboard(req, res));
const countUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE banned = 0');
app.get('/api/stats', (req, res) => res.json({ online: sockets.size, playing: new Set([...activeGame.values()].flatMap((m) => [...m.keys()])).size, players: countUsers.get().c }));

app.get('/api/games', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Inte inloggad.' });
  const games = q.gamesForUser.all(req.user.id).map((g) => {
    const { moves, ...rest } = g;
    return { ...rest, plies: moves ? moves.split(' ').length : 0 };
  });
  res.json({ games });
});

app.get('/api/games/:id', (req, res) => {
  const g = q.gameById.get(String(req.params.id));
  if (!g) return res.status(404).json({ error: 'Partiet finns inte.' });
  res.json({ game: g });
});

// Spara ett parti mot datorn (orankat). Dragen spelas upp på servern för att kontrollera att de är lagliga.
app.post('/api/games/bot', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Inte inloggad.' });
  const { moves, playerColor, botName, botRating, resigned } = req.body || {};
  if (!Array.isArray(moves) || moves.length < 2 || moves.length > 1000 || !['w', 'b'].includes(playerColor))
    return res.status(400).json({ error: 'Ogiltigt parti.' });
  const chess = new Chess();
  try {
    for (const san of moves) chess.move(String(san));
  } catch {
    return res.status(400).json({ error: 'Ogiltiga drag.' });
  }
  let result, reason;
  if (chess.isCheckmate()) [result, reason] = [chess.turn() === 'w' ? '0-1' : '1-0', 'checkmate'];
  else if (chess.isDraw()) [result, reason] = ['1/2-1/2', drawReason(chess)];
  else if (resigned) [result, reason] = [playerColor === 'w' ? '0-1' : '1-0', 'resign'];
  else return res.status(400).json({ error: 'Partiet är inte slut.' });
  const bot = { name: String(botName || 'Dator').slice(0, 30), rating: Math.max(100, Math.min(3500, Number(botRating) || 0)) };
  const me = { name: req.user.username, rating: req.user.rating };
  const [white, black] = playerColor === 'w' ? [me, bot] : [bot, me];
  const id = crypto.randomBytes(6).toString('hex');
  q.insertGame.run(id, playerColor === 'w' ? req.user.id : null, playerColor === 'b' ? req.user.id : null,
    white.name, black.name, white.rating, black.rating, 0, 0, result, reason,
    chess.history().join(' '), buildPgn(chess, white, black, result, null), null, 0, Date.now(), null);
  res.json({ id });
});

// ---------- Vänner ----------
function needUser(req, res) {
  if (!req.user) res.status(401).json({ error: 'Inte inloggad.' });
  return !!req.user;
}
app.get('/api/friends', (req, res) => {
  if (!needUser(req, res)) return;
  const rows = q.friendRows.all(req.user.id);
  const pub = (r) => ({ username: r.username, rating: shownRating(r.rating, r.games), title: titleFor(r.peak, r.games), online: sockets.has(r.id), playing: activeGame.has(r.id) });
  res.json({
    friends: rows.filter((r) => r.status === 'accepted').map(pub).sort((a, b) => b.online - a.online || a.username.localeCompare(b.username)),
    incoming: rows.filter((r) => r.status === 'pending' && r.requester !== req.user.id).map(pub),
    outgoing: rows.filter((r) => r.status === 'pending' && r.requester === req.user.id).map(pub),
  });
});
app.post('/api/friends/:action', (req, res) => {
  if (!needUser(req, res)) return;
  const me = req.user;
  const other = q.userByName.get(String(req.body?.username || '').trim());
  if (!other) return res.status(404).json({ error: 'Det finns ingen spelare med det namnet.' });
  if (other.id === me.id) return res.status(400).json({ error: 'Du kan inte lägga till dig själv.' });
  const existing = q.friendship.get(me.id, other.id);
  switch (req.params.action) {
    case 'request':
      if (features.isBlocked(other.id, me.id)) return res.status(403).json({ error: 'Den spelaren tar inte emot förfrågningar från dig.' });
      if (existing?.status === 'accepted') return res.status(409).json({ error: 'Ni är redan vänner.' });
      if (existing && existing.user_id === me.id) return res.status(409).json({ error: 'Du har redan skickat en förfrågan.' });
      if (existing) { q.acceptFriend.run(other.id, me.id); features2.notify(other.id, 'friend', `${me.username} och du är nu vänner.`, `/profile/${encodeURIComponent(me.username)}`); } // den andra hade redan frågat
      else { q.insertFriend.run(me.id, other.id, Date.now()); features2.notify(other.id, 'friend', `${me.username} vill bli din vän.`, '/friends'); }
      break;
    case 'accept':
      q.acceptFriend.run(other.id, me.id);
      features2.notify(other.id, 'friend', `${me.username} accepterade din vänförfrågan.`, `/profile/${encodeURIComponent(me.username)}`);
      break;
    case 'remove':
      q.deleteFriend.run(me.id, other.id);
      break;
    default:
      return res.status(404).json({ error: 'Okänd åtgärd.' });
  }
  sendTo(me.id, { t: 'friends' });
  sendTo(other.id, { t: 'friends' });
  features.checkFriends(me.id); features.checkFriends(other.id);
  res.json({ ok: true });
});

// ---------- Turneringar (arena: man paras ihop om och om igen tills tiden är ute) ----------
// Betänketid "minuter+sekunder per drag", t.ex. 3+2. Turneringar får välja fritt: 1–60 minuter och 0–30 sekunders tillägg.
function parseTc(tc) {
  const m = /^(\d{1,2})\+(\d{1,2})$/.exec(String(tc));
  if (!m) return null;
  const [min, inc] = [Number(m[1]), Number(m[2])];
  return min >= 1 && min <= 60 && inc <= 30 ? [min * 60, inc] : null;
}
const validDuration = (d) => Number.isInteger(d) && d >= 5 && d <= 240;
const validStartsIn = (s) => Number.isInteger(s) && s >= 0 && s <= 1440;
app.get('/api/tournaments', (req, res) => res.json({ tournaments: q.tList.all(), now: Date.now() }));
app.post('/api/tournaments', (req, res) => {
  if (!needUser(req, res)) return;
  const name = String(req.body?.name || '').trim();
  const { tc, duration, startsIn } = req.body || {};
  if (name.length < 3 || name.length > 40) return res.status(400).json({ error: 'Namnet måste vara 3–40 tecken.' });
  if (!parseTc(tc) || !validDuration(duration) || !validStartsIn(startsIn))
    return res.status(400).json({ error: 'Ogiltiga inställningar.' });
  const id = crypto.randomBytes(5).toString('hex');
  const starts = Date.now() + startsIn * 60000;
  q.tInsert.run(id, name, tc, duration, req.user.id, req.user.username, starts, starts + duration * 60000, Date.now());
  q.tJoin.run(id, req.user.id);
  // Format: arena (löpande parning under en viss tid), schweizer (fast antal rundor) eller utslagning.
  const format = ['swiss', 'knockout'].includes(req.body?.format) ? req.body.format : 'arena';
  if (format !== 'arena') tFormat.run(format, format === 'swiss' ? Math.max(2, Math.min(9, Number(req.body?.rounds) || 5)) : 0, id);
  scheduleTournament(q.tById.get(id));
  broadcastAll({ t: 'tournament', id });
  res.json({ id });
});
app.get('/api/tournaments/:id', (req, res) => {
  const t = q.tById.get(String(req.params.id));
  if (!t) return res.status(404).json({ error: 'Turneringen finns inte.' });
  const tp = q.tPlayers.all(t.id).map(({ crown_until, ...p }) => ({ ...p, crown: crown_until > Date.now(), rating: shownRating(p.rating, p.total_games), title: titleFor(p.peak, p.total_games) }));
  res.json({
    tournament: t, players: tp, teams: features.teamStandings(tp), match: features2.matchScore(t, tp), games: q.tGames.all(t.id), now: Date.now(),
    joined: !!(req.user && q.tPlayer.get(t.id, req.user.id)),
  });
});
app.post('/api/tournaments/:id/:action', (req, res) => {
  if (!needUser(req, res)) return;
  const t = q.tById.get(String(req.params.id));
  if (!t) return res.status(404).json({ error: 'Turneringen finns inte.' });
  if (req.params.action === 'edit') {
    // Bara skaparen får ändra tiderna. Före start: betänketid, längd och starttid. Under spel: betänketid (för nya partier) och längd.
    if (t.creator_id !== req.user.id) return res.status(403).json({ error: 'Bara den som skapade turneringen kan ändra den.' });
    if (t.status === 'finished') return res.status(400).json({ error: 'Turneringen är slut.' });
    if (t.status === 'proposed') return res.status(400).json({ error: 'Lagmatchen måste antas av den andra klubben först.' });
    const { tc, duration, startsIn } = req.body || {};
    if (!parseTc(tc) || !validDuration(duration)) return res.status(400).json({ error: 'Ogiltiga tider.' });
    let starts = t.starts_at;
    if (t.status === 'open') {
      if (!validStartsIn(startsIn)) return res.status(400).json({ error: 'Ogiltig starttid.' });
      starts = Date.now() + startsIn * 60000;
    }
    const begun = t.status === 'open' ? starts : t.ends_at - t.duration * 60000;
    const ends = begun + duration * 60000;
    if (t.status === 'running' && ends <= Date.now()) return res.status(400).json({ error: 'Den längden har redan passerats. Välj en längre tid.' });
    q.tUpdate.run(tc, duration, starts, ends, t.id);
    scheduleTournament(q.tById.get(t.id));
    broadcastAll({ t: 'tournament', id: t.id });
    return res.json({ ok: true });
  }
  if (req.params.action === 'join') {
    if (t.status === 'finished') return res.status(400).json({ error: 'Turneringen är slut.' });
    if (t.format !== 'arena' && t.status !== 'open') return res.status(400).json({ error: 'Turneringen har redan startat. I rundturneringar anmäler man sig före start.' });
    if (!features2.canJoin(t, req.user.id)) return res.status(403).json({ error: 'Bara medlemmar i de två klubbarna kan vara med i lagmatchen.' });
    q.tJoin.run(t.id, req.user.id);
  } else if (req.params.action === 'leave') {
    if (t.status !== 'open') return res.status(400).json({ error: 'Turneringen har redan startat.' });
    q.tLeave.run(t.id, req.user.id);
  } else return res.status(404).json({ error: 'Okänd åtgärd.' });
  broadcastAll({ t: 'tournament', id: t.id });
  res.json({ ok: true });
});

// ---------- Veckans parti: det rankade parti de senaste 7 dagarna som spelades bäst ----------
app.get('/api/gotw', (req, res) => {
  let best = null, bestScore = -1;
  for (const g of q.weekGames.all(Date.now() - 7 * 24 * 3600 * 1000)) {
    const plies = g.moves.split(' ').length;
    // Träffsäkerhet väger tyngst; avgjorda och lagom långa partier får en liten bonus.
    const score = g.quality + (g.result === '1/2-1/2' ? 0 : 2) + Math.min(plies, 60) / 20;
    if (score > bestScore) [best, bestScore] = [g, score];
  }
  res.json({ game: best });
});

const nm = (p) => path.join(__dirname, 'node_modules', p);
app.get('/vendor/chess.js', (req, res) => res.sendFile(nm('chess.js/dist/esm/chess.js')));
app.get('/vendor/pieces.svg', (req, res) => res.sendFile(nm('cm-chessboard/assets/pieces/standard.svg')));
app.get(/^\/vendor\/stockfish\/(stockfish-19-lite-single\.(?:js|wasm))$/, (req, res) => res.sendFile(nm('stockfish/bin/' + req.params[0])));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Alla sidadresser (t.ex. /play, /review/abc) visar samma sida; klienten väljer vy utifrån adressen.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Onlinepartier (WebSocket) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Map(); // userId -> Set<ws>
// En spelare kan ha flera partier igång samtidigt: userId -> Map(parti-id -> parti).
const activeGame = new Map();
const gamesOf = (uid) => activeGame.get(uid) || new Map();
function addActive(uid, g) { if (!activeGame.has(uid)) activeGame.set(uid, new Map()); activeGame.get(uid).set(g.id, g); }
function removeActive(uid, g) { const m = activeGame.get(uid); m?.delete(g.id); if (m && !m.size) activeGame.delete(uid); }
const inTournamentGame = (uid, tid) => [...gamesOf(uid).values()].some((g) => g.tournamentId === tid);
// Vilket parti ett meddelande gäller: det som anges med id, annars det enda pågående.
function pickGame(uid, id) {
  const mine = gamesOf(uid);
  if (id) return mine.get(String(id)) || null;
  return mine.size === 1 ? [...mine.values()][0] : null;
}
const seeks = new Map(); // "tc|variant" -> userId
const challenges = new Map(); // "frånId:tillId" -> { tc, timer }
const gamesById = new Map(); // parti-id -> parti (pågående och nyss avslutade)

server.on('upgrade', onUpgrade);
function onUpgrade(req, socket, head) {
  const user = req.url === '/ws' ? userFromRequest(req) : undefined;
  // Tillåt bara anslutningar från sidan själv (skydd mot att andra webbplatser använder kakan).
  const origin = req.headers.origin;
  const sameOrigin = !origin || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
  if (!user || !sameOrigin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user.id));
}

function sendTo(userId, msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets.get(userId) || []) if (ws.readyState === 1) ws.send(data);
}
function drawReason(chess) {
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  if (chess.isThreefoldRepetition()) return 'repetition';
  return 'fifty';
}
function gameState(g) {
  const clocks = { ...g.clocks };
  if (!g.over) clocks[g.chess.turn()] = Math.max(0, clocks[g.chess.turn()] - (Date.now() - g.lastTs));
  return { id: g.id, tc: g.tc, white: g.white, black: g.black, moves: g.chess.history(), turn: g.chess.turn(), clocks, drawOffer: g.drawOffer, takebackOffer: g.takebackOffer || null, over: g.over, tournament: g.tournamentId,
    variant: g.variant || null, startFen: g.startFen || null };
}
function broadcast(g) {
  const state = gameState(g);
  sendTo(g.white.id, { t: 'game', game: { ...state, you: 'w' } });
  sendTo(g.black.id, { t: 'game', game: { ...state, you: 'b' } });
  if (g.spectators.size) { // åskådare
    const data = JSON.stringify({ t: 'watch', game: { ...state, you: null } });
    for (const ws of g.spectators) if (ws.readyState === 1) ws.send(data);
  }
}
function scheduleFlag(g) {
  clearTimeout(g.timer);
  if (g.over) return;
  const turn = g.chess.turn();
  g.timer = setTimeout(() => {
    g.clocks[turn] = 0;
    // Tiden är ute: förlust, men remi om motståndaren bara har kungen kvar.
    const opp = turn === 'w' ? 'b' : 'w';
    const oppHasMaterial = g.chess.board().flat().some((p) => p && p.color === opp && p.type !== 'k');
    endGame(g, oppHasMaterial ? (opp === 'w' ? '1-0' : '0-1') : '1/2-1/2', 'timeout');
  }, Math.max(0, g.clocks[turn] - (Date.now() - g.lastTs)) + 30);
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const set of sockets.values()) for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

// --- Turneringslogik ---
const tReady = new Map(); // turnerings-id -> Set<userId> som väntar på parning
const tTimers = new Map();
const tLastOpp = new Map(); // "tid:userId" -> senaste motståndare
function scheduleTournament(t) {
  clearTimeout(tTimers.get(t.id));
  const now = Date.now();
  if (t.status === 'open') tTimers.set(t.id, setTimeout(() => startTournament(t.id), Math.max(0, t.starts_at - now)));
  else if (t.status === 'running') tTimers.set(t.id, setTimeout(() => finishTournament(t.id), Math.max(0, t.ends_at - now)));
}
function startTournament(id) {
  const t = q.tById.get(id);
  if (!t || t.status !== 'open') return;
  if (t.format !== 'arena') return features.startRoundTournament(t);
  q.tStatus.run('running', Date.now() + t.duration * 60000, id);
  features2.tournamentStarted(t);
  tReady.set(id, new Set());
  scheduleTournament(q.tById.get(id));
  broadcastAll({ t: 'tournament', id });
}
function finishTournament(id) {
  const t = q.tById.get(id);
  if (!t || t.status === 'finished') return;
  q.tStatus.run('finished', t.ends_at, id);
  const winner = q.tPlayers.all(id)[0];
  if (winner && winner.games > 0) { q.addTrophy.run(winner.id); features.award(winner.id, 'tournament_win'); if ((q.userById.get(winner.id)?.trophies || 0) >= 3) features.award(winner.id, 'trophies_3'); }
  features.tournamentFinished(t, q.tPlayers.all(id));
  tReady.delete(id);
  broadcastAll({ t: 'tournament', id });
}
function pairTournament(id) {
  const t = q.tById.get(id), set = tReady.get(id);
  if (!t || t.status !== 'running' || !set) return;
  const scores = new Map(q.tPlayers.all(id).map((p) => [p.id, p.score]));
  const okPair = features2.pairOk(t);
  const ready = [...set].filter((u) => sockets.has(u) && !inTournamentGame(u, id) && scores.has(u))
    .sort((a, b) => scores.get(b) - scores.get(a));
  while (ready.length >= 2) {
    const a = ready.shift();
    let i = ready.findIndex((b) => okPair(a, b) && tLastOpp.get(`${id}:${a}`) !== b); // undvik samma motståndare två gånger i rad om det går
    if (i < 0) i = ready.findIndex((b) => okPair(a, b));
    if (i < 0) continue; // i en lagmatch finns ingen ledig motståndare från den andra klubben just nu
    const [b] = ready.splice(i, 1);
    set.delete(a);
    set.delete(b);
    tLastOpp.set(`${id}:${a}`, b);
    tLastOpp.set(`${id}:${b}`, a);
    createGame(a, b, t.tc, id);
  }
}
function leaveTournamentPools(userId) {
  for (const set of tReady.values()) set.delete(userId);
}
function resumeTournaments() {
  for (const t of q.tActive.all()) {
    if (t.status === 'running' && t.format === 'arena') tReady.set(t.id, new Set());
    scheduleTournament(t);
    if (t.status === 'running' && t.format !== 'arena') features.resumeRounds(t);
  }
}

// --- Partikvalitet: Stockfish i en egen process räknar ut träffsäkerheten för rankade partier (för Veckans parti) ---
let sf = null, sfBuf = '', sfLine = null;
const analysisQueue = [];
let analysing = false;
function sfEngine() {
  if (sf) return sf;
  sf = spawn(process.execPath, [require('stockfish').findEngine('lite-single')], { stdio: ['pipe', 'pipe', 'ignore'] });
  sf.stdout.on('data', (d) => {
    sfBuf += d;
    let i;
    while ((i = sfBuf.indexOf('\n')) >= 0) {
      const line = sfBuf.slice(0, i).trim();
      sfBuf = sfBuf.slice(i + 1);
      sfLine?.(line);
    }
  });
  sf.on('exit', () => { sf = null; });
  sf.on('error', () => { sf = null; });
  return sf;
}
function evalFen(fen) {
  return new Promise((resolve, reject) => {
    let score = { cp: 0 };
    const timer = setTimeout(() => { sfLine = null; sf?.kill(); reject(new Error('motorn svarar inte')); }, 15000);
    sfLine = (l) => {
      const m = !l.includes('bound') && l.match(/score (cp|mate) (-?\d+)/);
      if (m) score = m[1] === 'cp' ? { cp: Number(m[2]) } : { mate: Number(m[2]) };
      if (l.startsWith('bestmove')) { clearTimeout(timer); sfLine = null; resolve(score); }
    };
    sfEngine().stdin.write(`position fen ${fen}\ngo depth 9\n`);
  });
}
const winPct = (s) => (s.mate != null ? (s.mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * s.cp)) - 1));
async function computeQuality(id, sans, startFen = null) {
  const c = startFen ? new Chess960(startFen) : new Chess(), white = [];
  for (let i = 0; i <= sans.length; i++) {
    const s = c.moves().length ? await evalFen(c.fen()) : c.inCheck() ? { mate: 0 } : { cp: 0 };
    white.push(c.turn() === 'w' ? winPct(s) : 100 - winPct(s));
    if (i < sans.length) c.move(sans[i]);
  }
  const acc = { w: [], b: [] };
  for (let k = 0; k < sans.length; k++) {
    const loss = Math.max(0, k % 2 === 0 ? white[k] - white[k + 1] : white[k + 1] - white[k]);
    acc[k % 2 === 0 ? 'w' : 'b'].push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const [wa, ba] = [mean(acc.w), mean(acc.b)];
  q.setQuality.run(wa, ba, (wa + ba) / 2, id);
  const phases = { w: [[], [], []], b: [[], [], []] };
  acc.w.forEach((a, i) => phases.w[i < 10 ? 0 : i < 30 ? 1 : 2].push(a));
  acc.b.forEach((a, i) => phases.b[i < 10 ? 0 : i < 30 ? 1 : 2].push(a));
  const round = (l) => (l.length ? Math.round(mean(l) * 10) / 10 : null);
  setPhases.run(JSON.stringify({ w: phases.w.map(round), b: phases.b.map(round), n: { w: phases.w.map((l) => l.length), b: phases.b.map((l) => l.length) } }), id);
  features.afterQuality(id);
}
async function runAnalysisQueue() {
  if (analysing) return;
  analysing = true;
  while (analysisQueue.length) {
    const [id, sans, startFen] = analysisQueue.shift();
    try { await computeQuality(id, sans, startFen); } catch (e) { console.error('Kunde inte analysera parti', id, e.message); }
  }
  analysing = false;
}

function createGame(aId, bId, tc, tournamentId = null, fixedColors = false, variant = null) {
  const [wId, bIdd] = fixedColors || Math.random() < 0.5 ? [aId, bId] : [bId, aId];
  const k = tcClass(tc);
  const [w, b] = [q.userById.get(wId), q.userById.get(bIdd)];
  const [base, inc] = TIME_CONTROLS[tc] || parseTc(tc);
  const g = {
    id: crypto.randomBytes(6).toString('hex'), tc, inc: inc * 1000, variant, startFen: variant === '960' ? random960Fen() : null,
    white: { id: w.id, name: w.username, rating: shownRating(classRating(w, k), w.games), country: w.country, avatar: avatarUrl(w), crown: w.crown_until > Date.now(), title: titleFor(w.peak, w.games) },
    black: { id: b.id, name: b.username, rating: shownRating(classRating(b, k), b.games), country: b.country, avatar: avatarUrl(b), crown: b.crown_until > Date.now(), title: titleFor(b.peak, b.games) },
    clocks: { w: base * 1000, b: base * 1000 }, lastTs: Date.now(), drawOffer: null, over: null, timer: null, tournamentId,
    spectators: new Set(), cls: k,
  };
  g.chess = variant === '960' ? new Chess960(g.startFen) : new Chess();
  addActive(w.id, g);
  addActive(b.id, g);
  gamesById.set(g.id, g);
  scheduleFlag(g);
  broadcast(g);
  return g;
}

function endGame(g, result, reason) {
  if (g.over) return;
  clearTimeout(g.timer);
  const turn = g.chess.turn();
  g.clocks[turn] = Math.max(0, g.clocks[turn] - (Date.now() - g.lastTs));
  removeActive(g.white.id, g);
  removeActive(g.black.id, g);
  if (g.chess.history().length < 2 && reason !== 'checkmate' && !g.noAbort) {
    g.over = { result: '*', reason: 'aborted' }; // avbrutet innan båda hunnit dra – räknas inte
    return broadcast(g);
  }
  const [w, b] = [q.userById.get(g.white.id), q.userById.get(g.black.id)];
  const sw = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  if (g.variant === '960') {
    const white = { name: w.username, rating: w.rating }, black = { name: b.username, rating: b.rating };
    q.insertGame.run(g.id, w.id, b.id, w.username, b.username, w.rating, b.rating, 0, 0, result, reason, g.chess.history().join(' '),
      buildPgn(g.chess, white, black, result, g.tc, g.startFen), g.tc, 0, Date.now(), null);
    setVariant.run('960', g.startFen, g.id);
    g.over = { result, reason, ratings: { w: null, b: null } };
    broadcast(g);
    return features.afterGame(g, { w, b, sw, result, reason, rw: w.rating, rb: b.rating, unrated: true });
  }
  // Varje betänketidsklass (bullet, blixt, snabb) har sin egen rating. Den sammanlagda är snittet av de klasser man har spelat.
  const k = g.cls, [rw, rb] = [classRating(w, k), classRating(b, k)];
  const nw = elo(rw, rb, sw, w['g_' + k]);
  const nb = elo(rb, rw, 1 - sw, b['g_' + k]);
  const overall = (u, mine) => {
    const rs = CLASSES.filter((c) => c === k || u['g_' + c] > 0).map((c) => (c === k ? mine : u['r_' + c]));
    return Math.round(rs.reduce((x, y) => x + y, 0) / rs.length);
  };
  updateClass[k].run(nw, overall(w, nw), sw === 1 ? 1 : 0, sw === 0 ? 1 : 0, sw === 0.5 ? 1 : 0, w.id);
  updateClass[k].run(nb, overall(b, nb), sw === 0 ? 1 : 0, sw === 1 ? 1 : 0, sw === 0.5 ? 1 : 0, b.id);
  const white = { name: w.username, rating: rw }, black = { name: b.username, rating: rb };
  q.insertGame.run(g.id, w.id, b.id, w.username, b.username, rw, rb, nw - rw, nb - rb,
    result, reason, g.chess.history().join(' '), buildPgn(g.chess, white, black, result, g.tc), g.tc, 1, Date.now(), g.tournamentId);
  // Under placeringspartierna visas ingen rating, så då skickas ingen ändring heller.
  g.over = { result, reason, ratings: { w: w.games + 1 < PLACEMENT_GAMES ? null : [rw, nw], b: b.games + 1 < PLACEMENT_GAMES ? null : [rb, nb] } };
  broadcast(g);
  if (g.tournamentId) {
    q.tScore.run(sw, sw === 1 ? 1 : 0, sw === 0.5 ? 1 : 0, sw === 0 ? 1 : 0, g.tournamentId, w.id);
    q.tScore.run(1 - sw, sw === 0 ? 1 : 0, sw === 0.5 ? 1 : 0, sw === 1 ? 1 : 0, g.tournamentId, b.id);
    broadcastAll({ t: 'tournament', id: g.tournamentId });
  }
  if (g.chess.history().length >= 16) {
    analysisQueue.push([g.id, g.chess.history(), g.startFen]);
    runAnalysisQueue();
  }
  features.afterGame(g, { w, b, sw, result, reason, rw, rb });
}

function onConnect(ws, userId) {
  ws.userId = userId;
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
  for (const current of gamesOf(userId).values()) ws.send(JSON.stringify({ t: 'game', game: { ...gameState(current), you: current.white.id === userId ? 'w' : 'b' } }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw).slice(0, 500)); } catch { return; }
    const g = pickGame(userId, ['move', 'resign', 'draw', 'decline', 'takeback'].includes(m.t) ? m.id : m.game);
    const color = g && (g.white.id === userId ? 'w' : 'b');
    switch (m.t) {
      case 'seek': { // man får söka nya partier även när man redan spelar
        if (!TIME_CONTROLS[m.tc]) return;
        const variant = m.variant === '960' ? '960' : null, key = `${m.tc}|${variant || ''}`;
        cancelSeek(userId);
        const other = seeks.get(key);
        if (other && other !== userId && sockets.get(other)?.size && !features.isBlocked(other, userId) && !features.isBlocked(userId, other)) {
          seeks.delete(key);
          createGame(other, userId, m.tc, null, false, variant);
          sendTo(userId, { t: 'seeking', tc: null });
        } else {
          seeks.set(key, userId);
          sendTo(userId, { t: 'seeking', tc: m.tc, variant });
        }
        break;
      }
      case 'cancel':
        cancelSeek(userId);
        sendTo(userId, { t: 'seeking', tc: null });
        break;
      case 'move': {
        if (!g || g.chess.turn() !== color) return;
        const now = Date.now();
        const left = g.clocks[color] - (now - g.lastTs);
        if (left <= 0) return; // flaggtimern avgör
        try {
          g.chess.move({ from: String(m.from), to: String(m.to), promotion: m.promotion ? String(m.promotion) : undefined });
        } catch { return broadcast(g); }
        g.clocks[color] = left + g.inc;
        g.lastTs = now;
        g.drawOffer = null;
        g.takebackOffer = null;
        if (g.chess.isCheckmate()) return endGame(g, color === 'w' ? '1-0' : '0-1', 'checkmate');
        if (g.chess.isDraw()) return endGame(g, '1/2-1/2', drawReason(g.chess));
        scheduleFlag(g);
        broadcast(g);
        break;
      }
      case 'resign':
        if (g) endGame(g, color === 'w' ? '0-1' : '1-0', 'resign');
        break;
      case 'draw':
        if (!g) return;
        if (g.drawOffer && g.drawOffer !== color) return endGame(g, '1/2-1/2', 'agreement');
        g.drawOffer = color;
        broadcast(g);
        break;
      case 'decline':
        if (g && ((g.drawOffer && g.drawOffer !== color) || (g.takebackOffer && g.takebackOffer !== color))) { g.drawOffer = null; g.takebackOffer = null; broadcast(g); }
        break;
      case 'tready': { // redo att paras ihop i en turnering
        const t = q.tById.get(String(m.id));
        if (!t || t.status !== 'running' || t.format !== 'arena' || !q.tPlayer.get(t.id, userId) || inTournamentGame(userId, t.id)) return;
        tReady.get(t.id)?.add(userId);
        pairTournament(t.id);
        break;
      }
      case 'tleave':
        if (m.id) tReady.get(String(m.id))?.delete(userId); else leaveTournamentPools(userId);
        break;
      case 'challenge': { // utmana en vän
        const other = q.userByName.get(String(m.to || ''));
        if (!other || !TIME_CONTROLS[m.tc] || q.friendship.get(userId, other.id)?.status !== 'accepted') return;
        if (!sockets.has(other.id)) return sendTo(userId, { t: 'notice', text: `${other.username} är inte tillgänglig just nu.` });
        const key = `${userId}:${other.id}`;
        clearTimeout(challenges.get(key)?.timer);
        challenges.set(key, { tc: m.tc, timer: setTimeout(() => challenges.delete(key), 60000) });
        sendTo(other.id, { t: 'challenge', from: q.userById.get(userId).username, tc: m.tc });
        sendTo(userId, { t: 'notice', text: `Utmaning skickad till ${other.username}.` });
        break;
      }
      case 'accept':
      case 'reject': {
        const other = q.userByName.get(String(m.from || ''));
        const key = other && `${other.id}:${userId}`;
        const ch = key && challenges.get(key);
        if (!ch) return;
        clearTimeout(ch.timer);
        challenges.delete(key);
        if (m.t === 'reject') return sendTo(other.id, { t: 'notice', text: `${q.userById.get(userId).username} tackade nej till utmaningen.` });
        if (!sockets.has(other.id)) return sendTo(userId, { t: 'notice', text: 'Utmaningen gäller inte längre.' });
        createGame(other.id, userId, ch.tc);
        break;
      }
      default:
        features.onWs(m, userId, ws, g, color);
    }
  });

  ws.on('close', () => {
    const set = sockets.get(userId);
    set?.delete(ws);
    features.onClose(ws);
    if (set && !set.size) { sockets.delete(userId); cancelSeek(userId); leaveTournamentPools(userId); }
  });
}
function cancelSeek(userId) {
  for (const [key, id] of seeks) if (id === userId) seeks.delete(key);
}

const ctx = {
  app, db, q, mirrored, sockets, activeGame, gamesOf, gamesById, sendTo, broadcastAll, broadcast, gameState, scheduleFlag, createGame, endGame,
  publicUser, titleFor, shownRating, needUser, parseTc, startTournament, broadcastTournament: (id) => broadcastAll({ t: 'tournament', id }), TIME_CONTROLS, hashPassword, sha256, crypto, Chess, buildPgn, elo, scheduleTournament, finishTournament,
};
const features = require('./features')(ctx);
const features2 = require('./features2')({ ...ctx, features });
ctx.notify = features2.notify; // så att features.js kan skicka aviseringar (prestationer, korrespondens)
// Engångsåtgärder på databasen. Varje åtgärd körs en enda gång; att den har körts sparas i tabellen migrations
// (som också speglas till Turso, så att den inte körs om när webbhotellet startar om med tom lokal databas).
function runMigrations() {
  const done = (id) => !!db.prepare('SELECT 1 AS x FROM migrations WHERE id = ?').get(id);
  const mark = mirrored('INSERT OR IGNORE INTO migrations (id, ran_at) VALUES (?, ?)');
  // 2026-11: nytt ratingsystem med startnivå och fem placeringspartier. Alla som redan har spelat börjar om på 1200.
  // Konton utan partier behåller den nivå de valde. Partihistorik, pokaler, prestationer och problemrating lämnas orörda.
  if (!done('rating-reset-2026-11')) {
    const info = mirrored(`UPDATE users SET rating = 1200, peak = 1200, games = 0, wins = 0, losses = 0, draws = 0,
      r_bullet = 0, g_bullet = 0, r_blitz = 0, g_blitz = 0, r_rapid = 0, g_rapid = 0 WHERE games > 0`).run();
    mark.run('rating-reset-2026-11', Date.now());
    console.log(`Ratingen nollställd för ${info.changes} spelare.`);
  }
}
app.get('/api/ping', (req, res) => res.json({ ok: true, up: Math.round(process.uptime()) }));
// Okända /api-adresser ska ge ett tydligt fel i stället för en tom sida.
app.use('/api', (req, res) => res.status(404).json({ error: 'Finns inte.' }));

restoreFromRemote()
  .catch((e) => console.error('Kunde inte hämta data från Turso:', e.message))
  .then(() => {
    runMigrations();
    features.boot();
    resumeTournaments();
    const bootStart = process.uptime();
    server.listen(PORT, () => console.log(`Schack Online körs på port ${PORT} (uppstart ${bootStart.toFixed(1)} s)${process.env.PORT ? '' : ` – http://schackonline.localhost:${PORT}`}`));
    // Gratisservern hos Render somnar efter 15 minuter utan besök och tar sedan lång tid att vakna.
    // Servern besöker därför sig själv var tionde minut, så att den alltid är vaken.
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (selfUrl) setInterval(() => fetch(`${selfUrl}/api/ping`).catch(() => {}), 10 * 60 * 1000);
  });
// Webbhotellet stänger servern med SIGTERM när den somnar: hinn spara det sista till Turso först.
process.on('SIGTERM', () => {
  const done = () => process.exit(0);
  setTimeout(done, 8000);
  (async () => { while (mirrorQueue.length || mirroring) await new Promise((r) => setTimeout(r, 100)); })().then(done);
});
// Hemma: lyssna även på standardporten 80 om den är ledig, så att adressen blir http://schackonline.localhost utan portnummer.
if (!process.env.PORT) {
  const plain = http.createServer(app);
  plain.on('upgrade', onUpgrade);
  plain.on('error', () => console.log('Port 80 är upptagen – använd adressen med portnummer ovan.'));
  plain.listen(80, () => console.log('…och på http://schackonline.localhost'));
}
