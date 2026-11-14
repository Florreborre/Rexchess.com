// Utbyggnader av servern: admin, konto, rapporter och blockering, fuskflaggor, separata ratingar, säsonger,
// prestationer, schackproblem, chatt, åskådare, returmatch, ångra drag, privata länkar, turneringar i rundor,
// klubbar och korrespondensschack. Laddas av server.js, som skickar in det som behövs i `ctx`.
const fs = require('fs');
const path = require('path');

module.exports = (ctx) => {
  const { app, db, q, mirrored, sockets, activeGame, gamesById, sendTo, broadcastAll, broadcast, gameState, scheduleFlag, createGame, endGame,
    publicUser, titleFor, needUser, parseTc, TIME_CONTROLS, hashPassword, sha256, crypto, Chess, buildPgn, elo } = ctx;
  const DAY = 24 * 3600 * 1000;
  const newId = () => crypto.randomBytes(5).toString('hex');
  const userName = (id) => q.userById.get(id)?.username;
  const busy = (id) => activeGame.has(id);
  const one = (sql) => db.prepare(sql);

  // ---------- Blockering, rapporter, admin ----------
  const w = {
    setAdmin: mirrored('UPDATE users SET is_admin = ? WHERE id = ?'),
    setBanned: mirrored('UPDATE users SET banned = ? WHERE id = ?'),
    dropSessions: mirrored('DELETE FROM sessions WHERE user_id = ?'),
    block: mirrored('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)'),
    unblock: mirrored('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?'),
    report: mirrored('INSERT INTO reports (id, reporter_id, reporter_name, target_id, target_name, reason, created_at) VALUES (?,?,?,?,?,?,?)'),
    resolve: mirrored('UPDATE reports SET resolved = 1 WHERE id = ?'),
    flag: mirrored('INSERT OR IGNORE INTO flags (user_id, username, reason, created_at) VALUES (?,?,?,?)'),
    unflag: mirrored('DELETE FROM flags WHERE user_id = ?'),
    setPassword: mirrored('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?'),
    award: mirrored('INSERT OR IGNORE INTO achievements (user_id, key, created_at) VALUES (?, ?, ?)'),
    puzzle: mirrored('UPDATE users SET puzzle_rating = ?, puzzles_solved = puzzles_solved + ? WHERE id = ?'),
    season: mirrored('INSERT OR IGNORE INTO seasons (id, winner_id, winner_name, points, created_at) VALUES (?,?,?,?,?)'),
    tFormat: mirrored('UPDATE tournaments SET format = ?, rounds = ? WHERE id = ?'),
    tRound: mirrored('UPDATE tournaments SET round = ? WHERE id = ?'),
    tOut: mirrored('UPDATE tournament_players SET out = 1 WHERE tournament_id = ? AND user_id = ?'),
    tBye: mirrored('UPDATE tournament_players SET score = score + 1 WHERE tournament_id = ? AND user_id = ?'),
    clubNew: mirrored('INSERT INTO clubs (id, name, description, owner_id, created_at) VALUES (?,?,?,?,?)'),
    clubJoin: mirrored('INSERT OR REPLACE INTO club_members (user_id, club_id, joined_at) VALUES (?,?,?)'),
    clubLeave: mirrored('DELETE FROM club_members WHERE user_id = ?'),
    clubOwner: mirrored('UPDATE clubs SET owner_id = ? WHERE id = ?'),
    clubDelete: mirrored('DELETE FROM clubs WHERE id = ?'),
    corrNew: mirrored("INSERT INTO corr_games (id, host_id, days, status, moves, created_at, last_move_at) VALUES (?, ?, ?, 'open', '', ?, ?)"),
    corrStart: mirrored("UPDATE corr_games SET white_id = ?, black_id = ?, white_name = ?, black_name = ?, status = 'active', last_move_at = ? WHERE id = ?"),
    corrMove: mirrored('UPDATE corr_games SET moves = ?, last_move_at = ?, draw_offer = NULL WHERE id = ?'),
    corrDraw: mirrored('UPDATE corr_games SET draw_offer = ? WHERE id = ?'),
    corrEnd: mirrored("UPDATE corr_games SET status = 'finished', result = ?, reason = ?, last_move_at = ? WHERE id = ?"),
    corrDelete: mirrored('DELETE FROM corr_games WHERE id = ?'),
    run: (sql, ...args) => mirrored(sql).run(...args),
  };
  const r = {
    blocked: one('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?'),
    blocksOf: one('SELECT u.username FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?'),
    reports: one('SELECT * FROM reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT 100'),
    flags: one('SELECT * FROM flags ORDER BY created_at DESC LIMIT 100'),
    banned: one('SELECT id, username, rating FROM users WHERE banned = 1 ORDER BY username'),
    admins: one('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1'),
    achievements: one('SELECT key, created_at FROM achievements WHERE user_id = ? ORDER BY created_at'),
    lastRated: one('SELECT white_id, black_id, result, white_acc, black_acc, quality, moves FROM games WHERE rated = 1 AND (white_id = ?1 OR black_id = ?1) ORDER BY created_at DESC LIMIT ?2'),
    monthGames: one('SELECT white_id, black_id, white_name, black_name, result FROM games WHERE rated = 1 AND created_at >= ? AND created_at < ?'),
    season: one('SELECT * FROM seasons WHERE id = ?'),
    seasons: one('SELECT * FROM seasons WHERE winner_id IS NOT NULL ORDER BY id DESC LIMIT 24'),
    clubs: one(`SELECT c.id, c.name, c.description, c.owner_id, COUNT(m.user_id) AS members, CAST(ROUND(AVG(u.rating)) AS INTEGER) AS avg
      FROM clubs c LEFT JOIN club_members m ON m.club_id = c.id LEFT JOIN users u ON u.id = m.user_id GROUP BY c.id ORDER BY avg DESC, members DESC LIMIT 100`),
    club: one('SELECT * FROM clubs WHERE id = ?'),
    clubByName: one('SELECT * FROM clubs WHERE name = ?'),
    clubMembers: one('SELECT u.id, u.username, u.rating, u.peak, u.games, m.joined_at FROM club_members m JOIN users u ON u.id = m.user_id WHERE m.club_id = ? ORDER BY u.rating DESC'),
    clubOf: one('SELECT c.id, c.name FROM club_members m JOIN clubs c ON c.id = m.club_id WHERE m.user_id = ?'),
    memberships: one('SELECT m.user_id, c.id, c.name FROM club_members m JOIN clubs c ON c.id = m.club_id'),
    corr: one('SELECT * FROM corr_games WHERE id = ?'),
    corrMine: one("SELECT * FROM corr_games WHERE (white_id = ?1 OR black_id = ?1 OR (status = 'open' AND host_id = ?1)) ORDER BY status = 'finished', last_move_at DESC LIMIT 60"),
    corrOpen: one("SELECT c.*, u.username AS host_name, u.rating AS host_rating FROM corr_games c JOIN users u ON u.id = c.host_id WHERE c.status = 'open' ORDER BY c.created_at DESC LIMIT 40"),
    corrActive: one("SELECT * FROM corr_games WHERE status = 'active'"),
  };
  const isBlocked = (byId, whoId) => !!r.blocked.get(byId, whoId);
  const needAdmin = (req, res) => {
    if (!req.user?.is_admin) res.status(403).json({ error: 'Bara för administratörer.' });
    return !!req.user?.is_admin;
  };
  const target = (req, res) => {
    const u = q.userByName.get(String(req.body?.username || '').trim());
    if (!u) res.status(404).json({ error: 'Det finns ingen spelare med det namnet.' });
    return u;
  };
  function kick(userId) {
    const g = activeGame.get(userId);
    if (g) endGame(g, g.white.id === userId ? '0-1' : '1-0', 'resign');
    for (const ws of sockets.get(userId) || []) ws.close();
  }

  app.post('/api/block/:action', (req, res) => {
    if (!needUser(req, res)) return;
    const u = target(req, res);
    if (!u) return;
    if (u.id === req.user.id) return res.status(400).json({ error: 'Du kan inte blockera dig själv.' });
    if (req.params.action === 'block') {
      w.block.run(req.user.id, u.id);
      q.deleteFriend.run(req.user.id, u.id);
    } else w.unblock.run(req.user.id, u.id);
    res.json({ ok: true });
  });
  app.get('/api/blocks', (req, res) => {
    if (!needUser(req, res)) return;
    res.json({ blocked: r.blocksOf.all(req.user.id).map((x) => x.username) });
  });
  app.post('/api/report', (req, res) => {
    if (!needUser(req, res)) return;
    const u = target(req, res);
    if (!u) return;
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (reason.length < 3) return res.status(400).json({ error: 'Skriv kort vad som har hänt.' });
    w.report.run(newId(), req.user.id, req.user.username, u.id, u.username, reason, Date.now());
    res.json({ ok: true });
  });
  app.get('/api/admin', (req, res) => {
    if (!needAdmin(req, res)) return;
    res.json({ reports: r.reports.all(), flags: r.flags.all(), banned: r.banned.all() });
  });
  app.post('/api/admin/:action', (req, res) => {
    if (!needAdmin(req, res)) return;
    const a = req.params.action;
    if (a === 'resolve') { w.resolve.run(String(req.body?.id || '')); return res.json({ ok: true }); }
    const u = target(req, res);
    if (!u) return;
    if (a === 'ban') {
      if (u.is_admin) return res.status(400).json({ error: 'En administratör kan inte stängas av.' });
      w.setBanned.run(1, u.id);
      w.dropSessions.run(u.id);
      kick(u.id);
    } else if (a === 'unban') w.setBanned.run(0, u.id);
    else if (a === 'unflag') w.unflag.run(u.id);
    else return res.status(404).json({ error: 'Okänd åtgärd.' });
    res.json({ ok: true });
  });

  // ---------- Konto: byta lösenord, ta bort konto ----------
  async function checkPassword(user, password) {
    const hash = await hashPassword(String(password || ''), user.salt);
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.pass_hash));
  }
  app.post('/api/account/password', async (req, res) => {
    if (!needUser(req, res)) return;
    const next = String(req.body?.next || '');
    if (!(await checkPassword(req.user, req.body?.current))) return res.status(401).json({ error: 'Nuvarande lösenord stämmer inte.' });
    if (next.length < 6 || next.length > 200) return res.status(400).json({ error: 'Det nya lösenordet måste vara minst 6 tecken.' });
    const salt = crypto.randomBytes(16).toString('hex');
    w.setPassword.run(await hashPassword(next, salt), salt, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/account/delete', async (req, res) => {
    if (!needUser(req, res)) return;
    const u = req.user;
    if (!(await checkPassword(u, req.body?.password))) return res.status(401).json({ error: 'Lösenordet stämmer inte.' });
    if (u.is_admin) return res.status(400).json({ error: 'Ett administratörskonto kan inte tas bort.' });
    if (busy(u.id)) return res.status(400).json({ error: 'Avsluta ditt pågående parti först.' });
    leaveClub(u.id);
    for (const sql of ['DELETE FROM sessions WHERE user_id = ?', 'DELETE FROM friendships WHERE user_id = ?1 OR friend_id = ?1',
      'DELETE FROM tournament_players WHERE user_id = ?', 'DELETE FROM achievements WHERE user_id = ?', 'DELETE FROM blocks WHERE user_id = ?1 OR blocked_id = ?1',
      'DELETE FROM flags WHERE user_id = ?', "DELETE FROM corr_games WHERE status != 'finished' AND (white_id = ?1 OR black_id = ?1 OR host_id = ?1)",
      'UPDATE games SET white_id = NULL WHERE white_id = ?', 'UPDATE games SET black_id = NULL WHERE black_id = ?', 'DELETE FROM users WHERE id = ?']) w.run(sql, u.id);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
    for (const ws of sockets.get(u.id) || []) ws.close();
  });

  // ---------- Prestationer ----------
  const ACHIEVEMENTS = {
    first_win: ['Första segern', 'Vinn ditt första rankade parti'],
    wins_10: ['Veteran', 'Vinn 10 rankade partier'],
    wins_50: ['Fältherre', 'Vinn 50 rankade partier'],
    wins_100: ['Triumfator', 'Vinn 100 rankade partier'],
    games_100: ['Hundra slag', 'Spela 100 rankade partier'],
    streak_5: ['Fem i rad', 'Vinn fem rankade partier i följd'],
    giant: ['Jättedödare', 'Slå en spelare med minst 200 högre rating'],
    mate_fast: ['Blixtmatt', 'Sätt matt inom 15 drag'],
    tournament_win: ['Turneringssegrare', 'Vinn en turnering'],
    season_champion: ['Säsongsmästare', 'Vinn en månadssäsong'],
    puzzles_10: ['Problemlösare', 'Lös 10 schackproblem'],
    puzzles_100: ['Taktiker', 'Lös 100 schackproblem'],
  };
  function award(userId, key) {
    if (!ACHIEVEMENTS[key] || !userId) return;
    const info = w.award.run(userId, key, Date.now());
    if (info.changes) sendTo(userId, { t: 'achievement', name: ACHIEVEMENTS[key][0], desc: ACHIEVEMENTS[key][1] });
  }
  const achievementsOf = (userId) => r.achievements.all(userId).filter((a) => ACHIEVEMENTS[a.key])
    .map((a) => ({ key: a.key, name: ACHIEVEMENTS[a.key][0], desc: ACHIEVEMENTS[a.key][1], at: a.created_at }));
  app.get('/api/achievements', (req, res) => res.json({ all: Object.entries(ACHIEVEMENTS).map(([key, [name, desc]]) => ({ key, name, desc })) }));

  function gameAchievements(g, info) {
    for (const [side, me, oppRating, myRating] of [['w', info.w, info.rb, info.rw], ['b', info.b, info.rw, info.rb]]) {
      const won = (side === 'w') === (info.sw === 1) && info.sw !== 0.5;
      const fresh = q.userById.get(me.id);
      if (fresh.games >= 100) award(me.id, 'games_100');
      if (!won) continue;
      award(me.id, 'first_win');
      if (fresh.wins >= 10) award(me.id, 'wins_10');
      if (fresh.wins >= 50) award(me.id, 'wins_50');
      if (fresh.wins >= 100) award(me.id, 'wins_100');
      if (oppRating - myRating >= 200) award(me.id, 'giant');
      if (info.reason === 'checkmate' && g.chess.history().length <= 30) award(me.id, 'mate_fast');
      const last = r.lastRated.all(me.id, 5);
      if (last.length === 5 && last.every((x) => (x.result === '1-0' && x.white_id === me.id) || (x.result === '0-1' && x.black_id === me.id))) award(me.id, 'streak_5');
    }
  }

  // ---------- Fuskflagga: orimligt hög träffsäkerhet parti efter parti ----------
  function afterQuality(gameId) {
    const g = q.gameById.get(gameId);
    if (!g) return;
    for (const uid of [g.white_id, g.black_id]) {
      if (!uid) continue;
      const accs = r.lastRated.all(uid, 8).filter((x) => x.quality != null && x.moves.split(' ').length >= 40)
        .map((x) => (x.white_id === uid ? x.white_acc : x.black_acc));
      if (accs.length < 5) continue;
      const avg = accs.reduce((a, b) => a + b, 0) / accs.length;
      if (avg >= 93) w.flag.run(uid, userName(uid), `Snitt-träffsäkerhet ${avg.toFixed(1)} i de ${accs.length} senaste längre partierna`, Date.now());
    }
  }

  // ---------- Topplistor: totalt, per betänketid och säsong ----------
  const CLASSES = ['bullet', 'blitz', 'rapid'];
  const classBoard = Object.fromEntries(CLASSES.map((k) => [k, one(`SELECT username, r_${k} AS rating, peak, trophies, games, g_${k} AS class_games, wins, losses, draws
    FROM users WHERE g_${k} > 0 AND banned = 0 ORDER BY r_${k} DESC LIMIT 50`)]));
  const monthStart = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  function seasonStandings(from, to) {
    const pts = new Map();
    const add = (id, name, p, win) => {
      if (!id) return;
      const e = pts.get(id) || { id, username: name, points: 0, games: 0, wins: 0 };
      e.points += p; e.games++; e.wins += win;
      pts.set(id, e);
    };
    for (const g of r.monthGames.all(from, to)) { // 3 poäng för vinst, 1 för remi
      const sw = g.result === '1-0' ? 3 : g.result === '0-1' ? 0 : 1;
      add(g.white_id, g.white_name, sw, sw === 3 ? 1 : 0);
      add(g.black_id, g.black_name, sw === 3 ? 0 : sw === 0 ? 3 : 1, sw === 0 ? 1 : 0);
    }
    return [...pts.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
  }
  function finalizeSeason() {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const id = monthKey(prev);
    if (r.season.get(id)) return;
    const champ = seasonStandings(monthStart(prev), monthStart(now))[0];
    const info = w.season.run(id, champ?.id ?? null, champ?.username ?? null, champ?.points ?? 0, Date.now());
    if (champ && info.changes && q.userById.get(champ.id)) {
      q.addTrophy.run(champ.id);
      award(champ.id, 'season_champion');
    }
  }
  function leaderboard(req, res) {
    const by = String(req.query.by || '');
    const withTitle = (p) => ({ ...p, title: titleFor(p.peak, p.games) });
    if (CLASSES.includes(by)) return res.json({ players: classBoard[by].all().map(withTitle) });
    res.json({ players: q.leaderboard.all().map(withTitle) });
  }
  app.get('/api/seasons', (req, res) => {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    res.json({ id: monthKey(now), endsAt: next, standings: seasonStandings(monthStart(now), next).slice(0, 50), past: r.seasons.all() });
  });

  // ---------- Schackproblem ----------
  let puzzles = [];
  try { puzzles = JSON.parse(fs.readFileSync(path.join(__dirname, 'puzzles.json'), 'utf8')); } catch { /* inga problem framtagna */ }
  const puzzleById = new Map(puzzles.map((p) => [p.id, p]));
  app.get('/api/puzzles/next', (req, res) => {
    if (!puzzles.length) return res.status(404).json({ error: 'Det finns inga problem ännu.' });
    const rating = req.user?.puzzle_rating ?? 1200;
    let pool = puzzles.filter((p) => Math.abs(p.rating - rating) <= 200 && p.id !== req.query.not);
    if (pool.length < 5) pool = puzzles.filter((p) => p.id !== req.query.not);
    res.json({ puzzle: pool[Math.floor(Math.random() * pool.length)], rating, solved: req.user?.puzzles_solved ?? 0 });
  });
  app.get('/api/puzzles/daily', (req, res) => {
    const pool = puzzles.filter((p) => p.rating >= 1000 && p.rating <= 1800);
    if (!pool.length) return res.status(404).json({ error: 'Det finns inga problem ännu.' });
    const day = Math.floor(Date.now() / DAY);
    res.json({ puzzle: pool[(day * 7919) % pool.length], rating: req.user?.puzzle_rating ?? 1200, daily: true });
  });
  app.post('/api/puzzles/:id/result', (req, res) => {
    if (!needUser(req, res)) return;
    const p = puzzleById.get(String(req.params.id));
    if (!p) return res.status(404).json({ error: 'Problemet finns inte.' });
    const solved = !!req.body?.solved, old = req.user.puzzle_rating;
    const expected = 1 / (1 + 10 ** ((p.rating - old) / 400));
    const rating = Math.max(400, Math.round(old + 24 * ((solved ? 1 : 0) - expected)));
    w.puzzle.run(rating, solved ? 1 : 0, req.user.id);
    const total = req.user.puzzles_solved + (solved ? 1 : 0);
    if (total >= 10) award(req.user.id, 'puzzles_10');
    if (total >= 100) award(req.user.id, 'puzzles_100');
    res.json({ rating, diff: rating - old, solved: total });
  });

  // ---------- Pågående partier, privata länkar ----------
  app.get('/api/live', (req, res) => {
    const games = [...new Set(activeGame.values())].map((g) => ({ id: g.id, white: g.white, black: g.black, tc: g.tc, plies: g.chess.history().length, tournament: g.tournamentId }));
    res.json({ games: games.sort((a, b) => b.white.rating + b.black.rating - a.white.rating - a.black.rating) });
  });
  const invites = new Map(); // id -> { host, tc, at }
  app.post('/api/invites', (req, res) => {
    if (!needUser(req, res)) return;
    const tc = String(req.body?.tc || '');
    if (!TIME_CONTROLS[tc] && !parseTc(tc)) return res.status(400).json({ error: 'Ogiltig betänketid.' });
    for (const [id, inv] of invites) if (inv.host === req.user.id || Date.now() - inv.at > 30 * 60000) invites.delete(id);
    const id = newId();
    invites.set(id, { host: req.user.id, tc, at: Date.now() });
    res.json({ id });
  });
  app.get('/api/invites/:id', (req, res) => {
    const inv = invites.get(String(req.params.id));
    if (!inv || Date.now() - inv.at > 30 * 60000) return res.status(404).json({ error: 'Länken gäller inte längre.' });
    res.json({ tc: inv.tc, host: userName(inv.host), mine: req.user?.id === inv.host });
  });

  // ---------- WebSocket: chatt, åskådare, ångra drag, returmatch, länk ----------
  const rooms = new Map(); // "game:<id>" | "tournament:<id>" | "club:<id>" -> { subs: Set<ws>, log: [] }
  const lastChat = new Map();
  const recent = new Map(); // nyss avslutade partier, för returmatch
  const room = (name) => rooms.get(name) || rooms.set(name, { subs: new Set(), log: [] }).get(name);
  function onWs(m, userId, ws, g, color) {
    switch (m.t) {
      case 'sub': {
        const name = String(m.room || '');
        if (!/^(game|tournament|club):[\w-]{1,40}$/.test(name)) return;
        const rm = room(name);
        rm.subs.add(ws);
        ws.send(JSON.stringify({ t: 'chatlog', room: name, messages: rm.log.filter((x) => !isBlocked(userId, x.uid)).map(({ uid, ...x }) => x) }));
        break;
      }
      case 'unsub':
        rooms.get(String(m.room || ''))?.subs.delete(ws);
        break;
      case 'chat': {
        const name = String(m.room || ''), text = String(m.text || '').trim().slice(0, 200);
        const rm = rooms.get(name);
        if (!rm || !text || Date.now() - (lastChat.get(userId) || 0) < 700) return;
        if (name.startsWith('game:')) { // i ett parti får bara de två spelarna skriva
          const game = gamesById.get(name.slice(5));
          if (!game || (game.white.id !== userId && game.black.id !== userId)) return;
        }
        lastChat.set(userId, Date.now());
        const u = q.userById.get(userId);
        const msg = { uid: userId, user: u.username, title: titleFor(u.peak, u.games), text, at: Date.now() };
        rm.log.push(msg);
        if (rm.log.length > 60) rm.log.shift();
        const { uid, ...pub } = msg;
        const data = JSON.stringify({ t: 'chat', room: name, message: pub });
        for (const s of rm.subs) if (s.readyState === 1 && !isBlocked(s.userId, userId)) s.send(data);
        break;
      }
      case 'watch': {
        const game = gamesById.get(String(m.id || ''));
        ws.watching?.spectators.delete(ws);
        if (!game) return ws.send(JSON.stringify({ t: 'watch', game: null }));
        ws.watching = game;
        game.spectators.add(ws);
        ws.send(JSON.stringify({ t: 'watch', game: { ...gameState(game), you: null } }));
        break;
      }
      case 'unwatch':
        ws.watching?.spectators.delete(ws);
        ws.watching = null;
        break;
      case 'takeback': {
        if (!g) return;
        const undo = (who) => (g.chess.turn() === who ? 2 : 1); // är det frågarens tur ska även motståndarens svar tas bort
        if (g.takebackOffer && g.takebackOffer !== color) {
          const n = undo(g.takebackOffer);
          if (g.chess.history().length < n) return;
          for (let i = 0; i < n; i++) g.chess.undo();
          g.takebackOffer = null;
          g.drawOffer = null;
          g.lastTs = Date.now();
          scheduleFlag(g);
        } else {
          if (g.chess.history().length < undo(color)) return;
          g.takebackOffer = color;
        }
        broadcast(g);
        break;
      }
      case 'rematch': {
        const rec = recent.get(String(m.id || ''));
        if (!rec || (rec.a !== userId && rec.b !== userId)) return;
        const other = rec.a === userId ? rec.b : rec.a;
        if (busy(userId) || busy(other) || !sockets.has(other)) return sendTo(userId, { t: 'notice', text: 'Motståndaren är inte tillgänglig för returmatch.' });
        rec.offers.add(userId);
        if (rec.offers.size === 2) {
          recent.delete(String(m.id));
          createGame(rec.b, rec.a, rec.tc, null, true); // byt färger
        } else {
          sendTo(other, { t: 'rematch', id: m.id, from: userName(userId) });
          sendTo(userId, { t: 'notice', text: 'Returmatch erbjuden.' });
        }
        break;
      }
      case 'join_invite': {
        const inv = invites.get(String(m.id || ''));
        if (!inv || inv.host === userId || busy(userId)) return;
        if (!sockets.has(inv.host) || busy(inv.host)) return sendTo(userId, { t: 'notice', text: 'Den som bjöd in är inte tillgänglig just nu.' });
        invites.delete(String(m.id));
        createGame(inv.host, userId, inv.tc);
        break;
      }
    }
  }
  function onClose(ws) {
    for (const rm of rooms.values()) rm.subs.delete(ws);
    ws.watching?.spectators.delete(ws);
  }

  // ---------- Turneringar i rundor: schweizer och utslagning ----------
  const roundGames = new Map(); // turnerings-id -> Set<parti-id> som pågår i rundan
  const played = new Map(); // turnerings-id -> Set<"a:b"> som redan har mötts
  const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  function startRoundTournament(t) {
    q.tStatus.run('running', Date.now() + DAY, t.id);
    ctx.scheduleTournament(q.tById.get(t.id));
    startRound(t.id);
  }
  function startRound(tid) {
    const t = q.tById.get(tid);
    if (!t || t.status !== 'running') return;
    const alive = q.tPlayers.all(tid).filter((p) => !p.out);
    const done = t.format === 'knockout' ? alive.length <= 1 : t.round >= t.rounds || alive.length < 2;
    if (done) return ctx.finishTournament(tid);
    w.tRound.run(t.round + 1, tid);
    // Schweizer: de med flest poäng möts. Utslagning: efter rating.
    const order = t.format === 'swiss' ? alive : [...alive].sort((a, b) => b.rating - a.rating);
    const met = played.get(tid) || played.set(tid, new Set()).get(tid);
    const games = new Set(), left = order.map((p) => p.id);
    while (left.length >= 2) {
      const a = left.shift();
      let i = left.findIndex((b) => !met.has(pairKey(a, b)));
      if (i < 0) i = 0;
      const [b] = left.splice(i, 1);
      met.add(pairKey(a, b));
      if (busy(a) || busy(b)) { // den som sitter i ett annat parti lämnar walkover
        const [winner, loser] = busy(a) ? [b, a] : [a, b];
        if (!busy(winner)) w.tBye.run(tid, winner);
        if (t.format === 'knockout') w.tOut.run(tid, loser);
        continue;
      }
      const g = createGame(a, b, t.tc, tid);
      g.noAbort = true; // i rundor räknas även partier där någon aldrig drar
      games.add(g.id);
    }
    if (left.length && t.format === 'swiss') w.tBye.run(tid, left[0]); // udda antal: en spelare står över och får en poäng
    roundGames.set(tid, games);
    broadcastAll({ t: 'tournament', id: tid });
    if (!games.size) setTimeout(() => startRound(tid), 1500);
  }
  function roundGameOver(g, sw) {
    const set = roundGames.get(g.tournamentId);
    if (!set?.delete(g.id)) return;
    const t = q.tById.get(g.tournamentId);
    if (t?.format === 'knockout') w.tOut.run(t.id, sw === 1 ? g.black.id : g.white.id); // vid remi går svart vidare
    if (!set.size) setTimeout(() => startRound(g.tournamentId), 5000);
  }
  function resumeRounds(t) { // efter en omstart av servern: rundans partier är borta, gå vidare till nästa runda
    roundGames.set(t.id, new Set());
    setTimeout(() => startRound(t.id), 3000);
  }

  // ---------- Klubbar ----------
  function leaveClub(userId) {
    const c = r.clubOf.get(userId);
    if (!c) return;
    w.clubLeave.run(userId);
    const club = r.club.get(c.id), members = r.clubMembers.all(c.id);
    if (!members.length) w.clubDelete.run(c.id);
    else if (club.owner_id === userId) w.clubOwner.run([...members].sort((a, b) => a.joined_at - b.joined_at)[0].id, c.id);
  }
  app.get('/api/clubs', (req, res) => res.json({ clubs: r.clubs.all(), mine: req.user ? r.clubOf.get(req.user.id) || null : null }));
  app.post('/api/clubs', (req, res) => {
    if (!needUser(req, res)) return;
    const name = String(req.body?.name || '').trim(), description = String(req.body?.description || '').trim().slice(0, 300);
    if (name.length < 3 || name.length > 30) return res.status(400).json({ error: 'Klubbens namn måste vara 3–30 tecken.' });
    if (r.clubOf.get(req.user.id)) return res.status(400).json({ error: 'Du är redan med i en klubb. Lämna den först.' });
    if (r.clubByName.get(name)) return res.status(409).json({ error: 'Det finns redan en klubb med det namnet.' });
    const id = newId();
    w.clubNew.run(id, name, description, req.user.id, Date.now());
    w.clubJoin.run(req.user.id, id, Date.now());
    res.json({ id });
  });
  app.get('/api/clubs/:id', (req, res) => {
    const club = r.club.get(String(req.params.id));
    if (!club) return res.status(404).json({ error: 'Klubben finns inte.' });
    const members = r.clubMembers.all(club.id).map((m) => ({ ...m, title: titleFor(m.peak, m.games), online: sockets.has(m.id) }));
    res.json({ club, members, owner: userName(club.owner_id), member: !!(req.user && members.some((m) => m.id === req.user.id)) });
  });
  app.post('/api/clubs/:id/:action', (req, res) => {
    if (!needUser(req, res)) return;
    const club = r.club.get(String(req.params.id));
    if (!club) return res.status(404).json({ error: 'Klubben finns inte.' });
    if (req.params.action === 'join') {
      if (r.clubOf.get(req.user.id)) return res.status(400).json({ error: 'Du är redan med i en klubb. Lämna den först.' });
      w.clubJoin.run(req.user.id, club.id, Date.now());
    } else if (req.params.action === 'leave') leaveClub(req.user.id);
    else return res.status(404).json({ error: 'Okänd åtgärd.' });
    res.json({ ok: true });
  });
  // Lagställning i en turnering: summan av klubbens fyra bästa spelares poäng.
  function teamStandings(players) {
    const clubs = new Map(r.memberships.all().map((m) => [m.user_id, m]));
    const teams = new Map();
    for (const p of players) {
      const c = clubs.get(p.id);
      if (!c) continue;
      const t = teams.get(c.id) || { id: c.id, name: c.name, scores: [] };
      t.scores.push(p.score);
      teams.set(c.id, t);
    }
    return [...teams.values()].map((t) => ({ id: t.id, name: t.name, players: t.scores.length, score: t.scores.sort((a, b) => b - a).slice(0, 4).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.score - a.score);
  }

  // ---------- Korrespondensschack: ett visst antal dagar per drag ----------
  const corrChess = (row) => {
    const c = new Chess();
    for (const san of row.moves ? row.moves.split(' ') : []) c.move(san);
    return c;
  };
  function corrView(row) {
    const sans = row.moves ? row.moves.split(' ') : [];
    return {
      id: row.id, status: row.status, days: row.days, moves: sans, turn: sans.length % 2 === 0 ? 'w' : 'b',
      white: row.white_id && { id: row.white_id, name: row.white_name }, black: row.black_id && { id: row.black_id, name: row.black_name },
      host: row.host_id, hostName: row.host_name || userName(row.host_id), result: row.result, reason: row.reason, drawOffer: row.draw_offer,
      lastMoveAt: row.last_move_at, deadline: row.status === 'active' ? row.last_move_at + row.days * DAY : null,
    };
  }
  function corrFinish(row, result, reason) {
    w.corrEnd.run(result, reason, Date.now(), row.id);
    const c = corrChess(row);
    if (c.history().length >= 2) { // sparas bland partierna så att det går att analysera
      const [wu, bu] = [q.userById.get(row.white_id), q.userById.get(row.black_id)];
      const white = { name: row.white_name, rating: wu?.rating }, black = { name: row.black_name, rating: bu?.rating };
      q.insertGame.run(row.id, row.white_id, row.black_id, row.white_name, row.black_name, wu?.rating ?? null, bu?.rating ?? null, 0, 0, result, reason,
        c.history().join(' '), buildPgn(c, white, black, result, null), `Korr ${row.days}d`, 0, Date.now(), null);
    }
    for (const id of [row.white_id, row.black_id]) sendTo(id, { t: 'corr', id: row.id, text: 'Ett korrespondensparti är slut.' });
  }
  function corrSweep() { // den som inte dragit inom tiden förlorar
    for (const row of r.corrActive.all()) {
      if (Date.now() - row.last_move_at <= row.days * DAY) continue;
      const turn = (row.moves ? row.moves.split(' ').length : 0) % 2 === 0 ? 'w' : 'b';
      corrFinish(row, turn === 'w' ? '0-1' : '1-0', 'timeout');
    }
  }
  app.get('/api/corr', (req, res) => {
    if (!needUser(req, res)) return;
    corrSweep();
    res.json({ games: r.corrMine.all(req.user.id).map(corrView), open: r.corrOpen.all().filter((c) => c.host_id !== req.user.id && !isBlocked(c.host_id, req.user.id)).map((c) => ({ ...corrView(c), hostRating: c.host_rating })) });
  });
  app.post('/api/corr', (req, res) => {
    if (!needUser(req, res)) return;
    const days = Number(req.body?.days);
    if (![1, 2, 3, 7].includes(days)) return res.status(400).json({ error: 'Välj 1, 2, 3 eller 7 dagar per drag.' });
    if (r.corrMine.all(req.user.id).filter((c) => c.status === 'open').length >= 3) return res.status(400).json({ error: 'Du har redan tre öppna inbjudningar.' });
    const id = newId();
    w.corrNew.run(id, req.user.id, days, Date.now(), Date.now());
    res.json({ id });
  });
  app.get('/api/corr/:id', (req, res) => {
    const row = r.corr.get(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Partiet finns inte.' });
    res.json({ game: corrView(row) });
  });
  app.post('/api/corr/:id/:action', (req, res) => {
    if (!needUser(req, res)) return;
    const row = r.corr.get(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'Partiet finns inte.' });
    const me = req.user.id, a = req.params.action;
    if (a === 'accept') {
      if (row.status !== 'open' || row.host_id === me) return res.status(400).json({ error: 'Inbjudan går inte att anta.' });
      const host = q.userById.get(row.host_id);
      if (!host) { w.corrDelete.run(row.id); return res.status(404).json({ error: 'Inbjudan finns inte längre.' }); }
      const [wu, bu] = Math.random() < 0.5 ? [host, req.user] : [req.user, host];
      w.corrStart.run(wu.id, bu.id, wu.username, bu.username, Date.now(), row.id);
      sendTo(host.id, { t: 'corr', id: row.id, text: `${req.user.username} antog ditt korrespondensparti.` });
      return res.json({ ok: true });
    }
    if (a === 'cancel') {
      if (row.status !== 'open' || row.host_id !== me) return res.status(400).json({ error: 'Går inte att avbryta.' });
      w.corrDelete.run(row.id);
      return res.json({ ok: true });
    }
    const color = row.white_id === me ? 'w' : row.black_id === me ? 'b' : null;
    if (row.status !== 'active' || !color) return res.status(400).json({ error: 'Du spelar inte i det här partiet.' });
    const other = color === 'w' ? row.black_id : row.white_id;
    if (a === 'move') {
      const c = corrChess(row);
      if (c.turn() !== color) return res.status(400).json({ error: 'Det är inte din tur.' });
      try { c.move({ from: String(req.body?.from), to: String(req.body?.to), promotion: req.body?.promotion ? String(req.body.promotion) : undefined }); }
      catch { return res.status(400).json({ error: 'Ogiltigt drag.' }); }
      w.corrMove.run(c.history().join(' '), Date.now(), row.id);
      const fresh = r.corr.get(row.id);
      if (c.isCheckmate()) corrFinish(fresh, color === 'w' ? '1-0' : '0-1', 'checkmate');
      else if (c.isDraw()) corrFinish(fresh, '1/2-1/2', c.isStalemate() ? 'stalemate' : c.isInsufficientMaterial() ? 'insufficient' : c.isThreefoldRepetition() ? 'repetition' : 'fifty');
      else sendTo(other, { t: 'corr', id: row.id, text: `${req.user.username} har dragit i ert korrespondensparti. Din tur.` });
    } else if (a === 'resign') corrFinish(row, color === 'w' ? '0-1' : '1-0', 'resign');
    else if (a === 'draw') {
      if (row.draw_offer && row.draw_offer !== color) corrFinish(row, '1/2-1/2', 'agreement');
      else { w.corrDraw.run(color, row.id); sendTo(other, { t: 'corr', id: row.id, text: `${req.user.username} erbjuder remi i ert korrespondensparti.` }); }
    } else return res.status(404).json({ error: 'Okänd åtgärd.' });
    res.json({ game: corrView(r.corr.get(row.id)) });
  });

  // ---------- Krokar som server.js anropar ----------
  function afterGame(g, info) {
    if (!g.tournamentId) {
      const rec = { a: g.white.id, b: g.black.id, tc: g.tc, offers: new Set() };
      recent.set(g.id, rec);
      setTimeout(() => recent.delete(g.id), 3 * 60000).unref();
    } else roundGameOver(g, info.sw);
    setTimeout(() => { if (gamesById.get(g.id) === g) gamesById.delete(g.id); rooms.delete(`game:${g.id}`); }, 5 * 60000).unref();
    try { gameAchievements(g, info); } catch (e) { console.error('Prestationer:', e.message); }
  }
  function profileExtra(u, viewer) {
    return {
      achievements: achievementsOf(u.id), club: r.clubOf.get(u.id) || null, gameId: activeGame.get(u.id)?.id || null,
      blocked: viewer ? isBlocked(viewer.id, u.id) : false, banned: viewer?.is_admin ? !!u.banned : undefined,
    };
  }
  function boot() {
    // Första administratören: kontot som anges i ADMIN_USER, om ingen administratör finns ännu.
    const name = process.env.ADMIN_USER || 'FlorianLiljeqvist';
    const u = q.userByName.get(name);
    if (u && !u.is_admin && !r.admins.get().c) { w.setAdmin.run(1, u.id); console.log(`${u.username} är nu administratör.`); }
    try { finalizeSeason(); corrSweep(); } catch (e) { console.error('Start:', e.message); }
    setInterval(() => { try { finalizeSeason(); corrSweep(); } catch (e) { console.error(e.message); } }, 3600 * 1000).unref();
  }

  return { onWs, onClose, afterGame, afterQuality, leaderboard, profileExtra, boot, isBlocked, award, startRoundTournament, resumeRounds, teamStandings, puzzleCount: () => puzzles.length };
};
