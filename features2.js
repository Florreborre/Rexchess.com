// Fler funktioner på servern: aviseringar, privata meddelanden, öppningsutforskaren och lagmatcher mellan klubbar.
// Laddas av server.js efter features.js.
module.exports = (ctx) => {
  const { app, db, q, mirrored, sendTo, needUser, crypto, features, parseTc, scheduleTournament, broadcastAll } = ctx;
  const newId = () => crypto.randomBytes(6).toString('hex');
  const one = (sql) => db.prepare(sql);
  const avatarOf = (u) => (u?.avatar_v ? `/api/avatar/${encodeURIComponent(u.username)}?v=${u.avatar_v}` : null);

  // ---------- Aviseringar (klockan i sidhuvudet) ----------
  const nq = {
    insert: mirrored('INSERT INTO notifications (id, user_id, kind, text, link, created_at, read) VALUES (?, ?, ?, ?, ?, ?, 0)'),
    list: one('SELECT id, kind, text, link, created_at, read FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40'),
    unread: one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0'),
    readAll: mirrored('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'),
    prune: mirrored('DELETE FROM notifications WHERE user_id = ?1 AND id NOT IN (SELECT id FROM notifications WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100)'),
  };
  // Texten sparas på svenska; webbläsaren översätter den till spelarens språk.
  function notify(userId, kind, text, link = null) {
    if (!userId) return;
    nq.insert.run(newId(), userId, kind, String(text).slice(0, 300), link, Date.now());
    if (Math.random() < 0.1) nq.prune.run(userId);
    sendTo(userId, { t: 'notify', kind, text, link, unread: nq.unread.get(userId).c });
  }

  // ---------- Privata meddelanden ----------
  const mq = {
    insert: mirrored('INSERT INTO messages (id, from_id, to_id, text, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)'),
    convs: one(`SELECT CASE WHEN from_id = ?1 THEN to_id ELSE from_id END AS other, MAX(created_at) AS last,
      SUM(CASE WHEN to_id = ?1 AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
      FROM messages WHERE from_id = ?1 OR to_id = ?1 GROUP BY other ORDER BY last DESC LIMIT 50`),
    lastOf: one('SELECT text, from_id FROM messages WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1) ORDER BY created_at DESC LIMIT 1'),
    thread: one('SELECT id, from_id, text, created_at, read_at FROM messages WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1) ORDER BY created_at DESC LIMIT 200'),
    markRead: mirrored('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL'),
    unread: one('SELECT COUNT(*) AS c FROM messages WHERE to_id = ? AND read_at IS NULL'),
    sentSince: one('SELECT COUNT(*) AS c FROM messages WHERE from_id = ? AND created_at > ?'),
  };
  app.get('/api/notifications', (req, res) => {
    if (!needUser(req, res)) return;
    res.json({ items: nq.list.all(req.user.id), unread: nq.unread.get(req.user.id).c, unreadMessages: mq.unread.get(req.user.id).c });
  });
  app.post('/api/notifications/read', (req, res) => {
    if (!needUser(req, res)) return;
    nq.readAll.run(req.user.id);
    res.json({ ok: true });
  });
  app.get('/api/messages', (req, res) => {
    if (!needUser(req, res)) return;
    const convs = mq.convs.all(req.user.id).map((c) => {
      const u = q.userById.get(c.other);
      if (!u) return null;
      const last = mq.lastOf.get(req.user.id, c.other);
      return { username: u.username, avatar: avatarOf(u), last: c.last, unread: c.unread, text: last?.text || '', mine: last?.from_id === req.user.id };
    }).filter(Boolean);
    res.json({ conversations: convs });
  });
  app.get('/api/messages/:username', (req, res) => {
    if (!needUser(req, res)) return;
    const other = q.userByName.get(String(req.params.username));
    if (!other) return res.status(404).json({ error: 'Det finns ingen spelare med det namnet.' });
    const rows = mq.thread.all(req.user.id, other.id).reverse();
    mq.markRead.run(Date.now(), req.user.id, other.id);
    res.json({ with: { username: other.username, avatar: avatarOf(other) }, messages: rows.map((m) => ({ id: m.id, mine: m.from_id === req.user.id, text: m.text, at: m.created_at })) });
  });
  app.post('/api/messages/:username', (req, res) => {
    if (!needUser(req, res)) return;
    const other = q.userByName.get(String(req.params.username));
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!other) return res.status(404).json({ error: 'Det finns ingen spelare med det namnet.' });
    if (other.id === req.user.id) return res.status(400).json({ error: 'Du kan inte skicka meddelanden till dig själv.' });
    if (!text) return res.status(400).json({ error: 'Skriv ett meddelande.' });
    if (features.isBlocked(other.id, req.user.id) || features.isBlocked(req.user.id, other.id)) return res.status(403).json({ error: 'Du kan inte skicka meddelanden till den spelaren.' });
    if (mq.sentSince.get(req.user.id, Date.now() - 60000).c >= 20) return res.status(429).json({ error: 'För många meddelanden. Vänta en stund.' });
    const m = { id: newId(), at: Date.now() };
    mq.insert.run(m.id, req.user.id, other.id, text, m.at);
    sendTo(other.id, { t: 'dm', from: req.user.username, text, unreadMessages: mq.unread.get(other.id).c });
    sendTo(req.user.id, { t: 'dm', to: other.username, text });
    res.json({ message: { ...m, mine: true, text } });
  });

  // ---------- Öppningsutforskaren: vilka drag spelas härnäst, och hur går det? ----------
  let cache = null, cacheAt = 0;
  function gamesCache() {
    if (!cache || Date.now() - cacheAt > 60000) {
      cache = one("SELECT id, moves, result, white_name, black_name, white_rating, black_rating, created_at FROM games WHERE variant IS NULL AND moves != '' ORDER BY created_at DESC LIMIT 30000")
        .all().map((g) => ({ ...g, sans: g.moves.split(' ') }));
      cacheAt = Date.now();
    }
    return cache;
  }
  app.get('/api/explorer', (req, res) => {
    const prefix = String(req.query.moves || '').split(/[ ,]+/).filter(Boolean).slice(0, 80);
    const stats = new Map(), here = { n: 0, w: 0, d: 0, b: 0 }, games = [];
    const add = (s, r) => { s.n++; if (r === '1-0') s.w++; else if (r === '0-1') s.b++; else s.d++; };
    for (const g of gamesCache()) {
      if (g.sans.length < prefix.length) continue;
      let ok = true;
      for (let i = 0; i < prefix.length; i++) if (g.sans[i] !== prefix[i]) { ok = false; break; }
      if (!ok) continue;
      add(here, g.result);
      if (games.length < 8) games.push({ id: g.id, white: g.white_name, black: g.black_name, whiteRating: g.white_rating, blackRating: g.black_rating, result: g.result, at: g.created_at });
      const next = g.sans[prefix.length];
      if (!next) continue;
      const s = stats.get(next) || { san: next, n: 0, w: 0, d: 0, b: 0 };
      add(s, g.result);
      stats.set(next, s);
    }
    res.json({ here, moves: [...stats.values()].sort((a, b) => b.n - a.n).slice(0, 24), games });
  });

  // ---------- Lagmatcher mellan klubbar ----------
  // En klubbledare utmanar en annan klubb. När den andra klubbens ledare antar blir det en arena där
  // spelare bara paras mot den andra klubben, och lagens poäng räknas ihop.
  const cm = {
    create: mirrored("INSERT INTO tournaments (id, name, tc, duration, creator_id, creator_name, status, starts_at, ends_at, created_at, club_a, club_b) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)"),
    accept: mirrored("UPDATE tournaments SET status = 'open', starts_at = ?, ends_at = ? WHERE id = ? AND status = 'proposed'"),
    remove: mirrored("DELETE FROM tournaments WHERE id = ? AND status = 'proposed'"),
    forClub: one('SELECT * FROM tournaments WHERE club_a = ?1 OR club_b = ?1 ORDER BY created_at DESC LIMIT 20'),
    club: one('SELECT * FROM clubs WHERE id = ?'),
    clubOf: one('SELECT club_id FROM club_members WHERE user_id = ?'),
  };
  const clubOf = (uid) => cm.clubOf.get(uid)?.club_id || null;
  app.post('/api/clubs/:id/challenge', (req, res) => {
    if (!needUser(req, res)) return;
    const a = cm.club.get(String(req.params.id)), b = cm.club.get(String(req.body?.opponent || ''));
    if (!a) return res.status(404).json({ error: 'Klubben finns inte.' });
    if (a.owner_id !== req.user.id) return res.status(403).json({ error: 'Bara klubbens ledare kan utmana andra klubbar.' });
    if (!b || b.id === a.id) return res.status(400).json({ error: 'Välj en annan klubb att utmana.' });
    const { tc } = req.body || {}, duration = Number(req.body?.duration), startsIn = Number(req.body?.startsIn);
    if (!parseTc(tc) || !(duration >= 10 && duration <= 120) || !(startsIn >= 0 && startsIn <= 1440)) return res.status(400).json({ error: 'Ogiltiga inställningar.' });
    const id = 'm' + newId(), now = Date.now();
    cm.create.run(id, `${a.name} mot ${b.name}`, tc, duration, req.user.id, req.user.username, now + startsIn * 60000, now + (startsIn + duration) * 60000, now, a.id, b.id);
    notify(b.owner_id, 'club', `Klubben ${a.name} utmanar ${b.name} på en lagmatch.`, `/clubs/${b.id}`);
    broadcastAll({ t: 'tournament', id });
    res.json({ id });
  });
  app.post('/api/matches/:id/:action', (req, res) => {
    if (!needUser(req, res)) return;
    const t = q.tById.get(String(req.params.id));
    if (!t || !t.club_a || t.status !== 'proposed') return res.status(404).json({ error: 'Utmaningen finns inte längre.' });
    const a = cm.club.get(t.club_a), b = cm.club.get(t.club_b);
    const isB = b?.owner_id === req.user.id, isA = a?.owner_id === req.user.id;
    if (req.params.action === 'accept') {
      if (!isB) return res.status(403).json({ error: 'Bara den utmanade klubbens ledare kan anta.' });
      const starts = Date.now() + Math.max(0, t.starts_at - t.created_at);
      cm.accept.run(starts, starts + t.duration * 60000, t.id);
      scheduleTournament(q.tById.get(t.id));
      notify(a.owner_id, 'club', `${b.name} antog lagmatchen.`, `/tournament/${t.id}`);
    } else if (req.params.action === 'decline') {
      if (!isA && !isB) return res.status(403).json({ error: 'Bara klubbarnas ledare kan avböja.' });
      cm.remove.run(t.id);
      notify(isA ? b?.owner_id : a?.owner_id, 'club', `Lagmatchen ${t.name} blev inte av.`, `/clubs/${isA ? b?.id : a?.id}`);
    } else return res.status(404).json({ error: 'Okänd åtgärd.' });
    broadcastAll({ t: 'tournament', id: t.id });
    res.json({ ok: true });
  });
  app.get('/api/clubs/:id/matches', (req, res) => {
    const club = cm.club.get(String(req.params.id));
    if (!club) return res.status(404).json({ error: 'Klubben finns inte.' });
    res.json({ matches: cm.forClub.all(club.id).map((t) => ({ id: t.id, name: t.name, status: t.status, tc: t.tc, duration: t.duration, starts_at: t.starts_at,
      incoming: t.club_b === club.id, opponent: cm.club.get(t.club_a === club.id ? t.club_b : t.club_a)?.name || '?' })) });
  });
  // Krokar som server.js anropar
  const canJoin = (t, uid) => !t.club_a || [t.club_a, t.club_b].includes(clubOf(uid));
  const pairOk = (t) => (t.club_a ? (x, y) => clubOf(x) !== clubOf(y) : () => true);
  function matchScore(t, players) {
    if (!t.club_a) return null;
    const side = (cid) => { const c = cm.club.get(cid); return { id: cid, name: c?.name || '?', score: 0, players: 0 }; };
    const out = { a: side(t.club_a), b: side(t.club_b) };
    for (const p of players) {
      const c = clubOf(p.id), s = c === t.club_a ? out.a : c === t.club_b ? out.b : null;
      if (s) { s.score += p.score; s.players++; }
    }
    return out;
  }
  function tournamentStarted(t) {
    for (const p of q.tPlayers.all(t.id)) notify(p.id, 'tournament', `Turneringen ${t.name} har startat.`, `/tournament/${t.id}`);
  }
  return { notify, canJoin, pairOk, matchScore, tournamentStarted };
};
