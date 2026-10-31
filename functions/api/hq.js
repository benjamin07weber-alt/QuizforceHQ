/**
 * QUIZFORCE HQ v5 — private Cloudflare Pages Function.
 * Route: /api/hq. Bind existing D1 database as DB.
 * Set HQ_ADMIN_PASSWORD and HQ_SESSION_SECRET as Cloudflare Pages secrets.
 * Never put either secret in HTML, GitHub, or client JavaScript.
 *
 * This app does not change the original QUIZFORCE public scores table.
 * Admin changes are read by the game via its read-only public sync endpoint.
 * Only this authenticated HQ function may create/edit these changes.
 */
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private, max-age=0',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
const COOKIE = '__Host-qfhq_session';
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_BODY = 4096;
const ID_RE = /^[a-z0-9_-]{8,80}$/i;
const SUBJECTS = new Set(['Mathematics', 'English', 'Afrikaans', 'Natural Sciences', 'Social Sciences']);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const RANKS = [
  ['🚀 Space Cadet', 0], ['🌙 Moon Explorer', 500], ['🪐 Planet Hunter', 1500],
  ['⭐ Star Commander', 3000], ['🌌 Galaxy Master', 6000], ['👑 Galactic Legend', 10000]
];
const reply = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status, headers: { ...JSON_HEADERS, ...extra },
});
const fail = (message, status = 400) => reply({ ok: false, error: message }, status);
const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const decode64 = value => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
};
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const validId = id => typeof id === 'string' && ID_RE.test(id);
const rankOf = xp => RANKS.reduce((rank, entry, i) => xp >= entry[1] ? i : rank, 0);
const formatPlayer = row => {
  const xp = Math.max(0, Number(row.xp) || 0);
  return {
    playerId: row.player_id,
    nickname: row.nickname || `Player ${String(row.player_id).slice(0, 6)}`,
    xp,
    games: Math.max(0, Number(row.games) || 0),
    trackedTests: Math.max(0, Number(row.tracked_tests) || 0),
    legacyTests: Math.max(0, Number(row.legacy_tests) || 0),
    perfectRuns: Math.max(0, Number(row.perfect_runs) || 0),
    rankIndex: rankOf(xp),
    rank: RANKS[rankOf(xp)][0],
    hidden: Boolean(row.hidden),
    overridden: Boolean(row.overridden),
    xpOverridden: row.xp_override !== null && row.xp_override !== undefined,
    nicknameOverridden: row.nickname_override !== null && row.nickname_override !== undefined,
    avatar:row.avatar||null,color:row.color||null,frame:row.frame||null,title:row.title||null,
    updatedAt: row.updated_at || null,
  };
};

async function keyFor(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function tokenFor(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(encoder.encode(JSON.stringify({ iat: now, exp: now + SESSION_SECONDS, n: crypto.randomUUID() })));
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(sig))}`;
}
async function verifyToken(secret, token) {
  try {
    if (!token || token.length > 1000) return false;
    const [payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra || !/^[\w-]+$/.test(payload) || !/^[\w-]+$/.test(sig)) return false;
    const valid = await crypto.subtle.verify('HMAC', await keyFor(secret), decode64(sig), encoder.encode(payload));
    if (!valid) return false;
    const data = JSON.parse(new TextDecoder().decode(decode64(payload)));
    const now = Math.floor(Date.now() / 1000);
    return isInt(data.iat, 1, now + 60) && isInt(data.exp, now + 1, now + SESSION_SECONDS + 60) &&
      data.exp - data.iat === SESSION_SECONDS && typeof data.n === 'string' && data.n.length > 10;
  } catch { return false; }
}
function cookieValue(request) {
  const match = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)__Host-qfhq_session=([^;]+)/);
  return match ? match[1] : null;
}
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
function configured(env) {
  return typeof env?.HQ_ADMIN_PASSWORD === 'string' && env.HQ_ADMIN_PASSWORD.length >= 12 &&
    typeof env?.HQ_SESSION_SECRET === 'string' && env.HQ_SESSION_SECRET.length >= 32;
}
async function constantTimePassword(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
async function hashedIp(secret, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(`hq-login:${ip}`));
  return base64url(new Uint8Array(sig));
}

// These extra tables are created automatically and are separate from the game.
let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_hq_overrides (
    player_id TEXT PRIMARY KEY, nickname_override TEXT, xp_override INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_hq_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_hq_game_revisions (
    player_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_hq_run_corrections (
    run_id TEXT PRIMARY KEY, correct_override INTEGER NOT NULL,
    total_override INTEGER NOT NULL, xp_override INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  // Private messages from QUIZFORCE players. This table is shared with the GAME
  // /api/questions endpoint through the existing D1 DB binding.
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_questions (
    question_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    inbox_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    reply TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    replied_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS qfhq_questions_inbox ON qfhq_questions (player_id,inbox_hash,created_at)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_cosmetic_profiles (
    player_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, key_hash TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '🚀', color TEXT NOT NULL DEFAULT 'cyan',
    frame TEXT NOT NULL DEFAULT 'none', title TEXT NOT NULL DEFAULT 'none',
    favorite_badge TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_awarded_badges (
    player_id TEXT NOT NULL, badge_id TEXT NOT NULL,
    awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id,badge_id)
  )`).run();
  tablesReady = true;
}
async function ensureThrottle(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS qfhq_hq_login_limits (
    ip_hash TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  )`).run();
}
async function login(request, env, body) {
  if (!configured(env)) return fail('HQ is not configured. Set both HQ secrets in Cloudflare.', 503);
  if (!env.DB) return fail('D1 binding DB is missing.', 503);
  const password = body?.password;
  if (typeof password !== 'string' || password.length > 256) return fail('Enter your admin password.', 400);
  await ensureThrottle(env.DB);
  const hash = await hashedIp(env.HQ_SESSION_SECRET, request);
  const now = Math.floor(Date.now() / 1000);
  const record = await env.DB.prepare('SELECT failures, blocked_until, updated_at FROM qfhq_hq_login_limits WHERE ip_hash = ?').bind(hash).first();
  if (record && Number(record.blocked_until) > now) return fail('Too many attempts. Try again in 15 minutes.', 429);
  const match = await constantTimePassword(password, env.HQ_ADMIN_PASSWORD);
  if (!match) {
    const failures = record && now - Number(record.updated_at) < 900 ? Number(record.failures) + 1 : 1;
    const blockedUntil = failures >= 5 ? now + 900 : 0;
    await env.DB.prepare(`INSERT INTO qfhq_hq_login_limits (ip_hash,failures,blocked_until,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(ip_hash) DO UPDATE SET
      failures=excluded.failures, blocked_until=excluded.blocked_until, updated_at=excluded.updated_at`)
      .bind(hash, failures, blockedUntil, now).run();
    return fail(failures >= 5 ? 'Too many attempts. Try again in 15 minutes.' : 'Incorrect password.', failures >= 5 ? 429 : 401);
  }
  await env.DB.prepare('DELETE FROM qfhq_hq_login_limits WHERE ip_hash = ?').bind(hash).run();
  return reply({ ok: true, authenticated: true }, 200, { 'Set-Cookie': cookie(await tokenFor(env.HQ_SESSION_SECRET), SESSION_SECONDS) });
}

// Common player view. Admin corrections are kept separate from original game records.
const PLAYER_CTE = `WITH perfect_deltas AS (
  SELECT r.player_id,
    SUM((CASE WHEN c.correct_override=c.total_override THEN 1 ELSE 0 END)
      - (CASE WHEN r.correct=r.total THEN 1 ELSE 0 END)) AS delta
  FROM qfhq_runs r INNER JOIN qfhq_hq_run_corrections c ON c.run_id=r.run_id
  GROUP BY r.player_id
), players AS (
  SELECT p.player_id,
    COALESCE(o.nickname_override,p.nickname) AS nickname,
    COALESCE(o.xp_override,p.xp) AS xp,
    p.legacy_tests+p.tracked_tests AS games,
    p.legacy_tests, p.tracked_tests,
    MAX(0,p.perfect_runs+COALESCE(d.delta,0)) AS perfect_runs,
    COALESCE(o.hidden,0) AS hidden,
    CASE WHEN o.player_id IS NULL THEN 0 ELSE 1 END AS overridden,
    o.xp_override, o.nickname_override, p.updated_at, c.avatar,c.color,c.frame,c.title
  FROM qfhq_players p
  LEFT JOIN qfhq_hq_overrides o ON o.player_id=p.player_id
  LEFT JOIN qfhq_cosmetic_profiles c ON c.player_id=p.player_id
  LEFT JOIN perfect_deltas d ON d.player_id=p.player_id
) `;
const VISIBLE_RUNS = `FROM qfhq_runs r
  INNER JOIN qfhq_players p ON p.player_id=r.player_id
  LEFT JOIN qfhq_hq_overrides o ON o.player_id=p.player_id
  LEFT JOIN qfhq_hq_run_corrections c ON c.run_id=r.run_id
  WHERE COALESCE(o.hidden,0)=0`;
const RUN_FIELDS = `r.run_id, r.player_id,
  COALESCE(o.nickname_override,p.nickname) AS nickname,
  r.subject, r.difficulty,
  COALESCE(c.correct_override,r.correct) AS correct,
  COALESCE(c.total_override,r.total) AS total,
  COALESCE(c.xp_override,r.earned_xp) AS earned_xp,
  r.speedrun, r.completed_at,
  CASE WHEN c.run_id IS NULL THEN 0 ELSE 1 END AS corrected`;
const list = async (db, sql, args = []) => {
  const stmt = db.prepare(sql);
  return (await (args.length ? stmt.bind(...args) : stmt).all()).results || [];
};
const one = async (db, sql, args = []) => {
  const stmt = db.prepare(sql);
  return (args.length ? stmt.bind(...args) : stmt).first();
};
const num = v => Number(v) || 0;
const runRow = r => ({
  runId: r.run_id, playerId: r.player_id,
  nickname: r.nickname || `Player ${String(r.player_id).slice(0, 6)}`,
  subject: r.subject, difficulty: r.difficulty, correct: num(r.correct),
  total: num(r.total), earnedXp: num(r.earned_xp),
  speedrun: Boolean(r.speedrun), completedAt: r.completed_at,
  corrected: Boolean(r.corrected),
});
async function dashboard(db) {
  const [overview, xp, games, perfect, daily, subjects, activity, featuredSetting] = await Promise.all([
    one(db, PLAYER_CTE + `SELECT COUNT(*) AS players, COALESCE(SUM(games),0) AS games,
      COALESCE(SUM(tracked_tests),0) AS tracked, COALESCE(SUM(perfect_runs),0) AS perfect,
      COALESCE(SUM(xp),0) AS xp FROM players WHERE hidden=0`),
    list(db, PLAYER_CTE + 'SELECT * FROM players WHERE hidden=0 ORDER BY xp DESC, games DESC LIMIT 10'),
    list(db, PLAYER_CTE + 'SELECT * FROM players WHERE hidden=0 ORDER BY games DESC, xp DESC LIMIT 10'),
    list(db, PLAYER_CTE + 'SELECT * FROM players WHERE hidden=0 ORDER BY perfect_runs DESC, xp DESC LIMIT 10'),
    list(db, `SELECT date(r.completed_at) AS day, COUNT(*) AS games ${VISIBLE_RUNS}
      AND date(r.completed_at) >= date('now','-13 days') GROUP BY date(r.completed_at) ORDER BY day`),
    list(db, `SELECT r.subject, COUNT(*) AS games,
      ROUND(AVG(100.0*COALESCE(c.correct_override,r.correct)/COALESCE(c.total_override,r.total)),1) AS accuracy
      ${VISIBLE_RUNS} GROUP BY r.subject ORDER BY games DESC`),
    list(db, `SELECT ${RUN_FIELDS} ${VISIBLE_RUNS} ORDER BY r.completed_at DESC, r.rowid DESC LIMIT 9`),
    one(db, "SELECT value FROM qfhq_hq_settings WHERE key='featured_player'"),
  ]);
  let featured = null;
  if (featuredSetting?.value && validId(featuredSetting.value)) {
    const row = await one(db, PLAYER_CTE + 'SELECT * FROM players WHERE hidden=0 AND player_id=?', [featuredSetting.value]);
    if (row) featured = formatPlayer(row);
  }
  const today = new Date().toISOString().slice(0, 10);
  const last14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (13 - i));
    const day = d.toISOString().slice(0, 10);
    return { day, games: num(daily.find(r => r.day === day)?.games) };
  });
  return {
    overview: { players: num(overview?.players), games: num(overview?.games),
      tracked: num(overview?.tracked), perfect: num(overview?.perfect), xp: num(overview?.xp) },
    leaders: { xp: xp.map(formatPlayer), games: games.map(formatPlayer), perfect: perfect.map(formatPlayer) },
    daily: last14,
    subjects: subjects.map(s => ({ subject: s.subject, games: num(s.games), accuracy: num(s.accuracy) })),
    recent: activity.map(runRow), featured,
    updatedAt: new Date().toISOString(),
  };
}
async function players(db, url) {
  const search = (url.searchParams.get('search') || '').trim().slice(0, 40);
  const sort = url.searchParams.get('sort') || 'xp';
  const columns = { xp: 'xp DESC, games DESC', games: 'games DESC, xp DESC',
    perfect: 'perfect_runs DESC, xp DESC', recent: 'updated_at DESC, xp DESC' };
  const order = columns[sort] || columns.xp;
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
  const offset = Math.min(100000, Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0));
  const includeHidden = url.searchParams.get('includeHidden') === '1';
  const visibility = includeHidden ? '1=1' : 'hidden=0';
  const where = search ? `WHERE ${visibility} AND COALESCE(nickname,'') LIKE ? ESCAPE '\\'` : `WHERE ${visibility}`;
  const args = search ? [`%${search.replace(/[\\%_]/g, '\\$&')}%`] : [];
  const [total, rows] = await Promise.all([
    one(db, PLAYER_CTE + `SELECT COUNT(*) AS count FROM players ${where}`, args),
    list(db, PLAYER_CTE + `SELECT * FROM players ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit, offset]),
  ]);
  return { total: num(total?.count), rows: rows.map(formatPlayer), offset, limit };
}
async function runs(db, url) {
  const subject = url.searchParams.get('subject') || '';
  const difficulty = url.searchParams.get('difficulty') || '';
  const playerId = url.searchParams.get('playerId') || '';
  if (subject && !SUBJECTS.has(subject)) throw new Error('Invalid subject filter');
  if (difficulty && !DIFFICULTIES.has(difficulty)) throw new Error('Invalid difficulty filter');
  if (playerId && !validId(playerId)) throw new Error('Invalid player filter');
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
  const offset = Math.min(100000, Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0));
  const filters = [];
  const args = [];
  if (subject) { filters.push('r.subject=?'); args.push(subject); }
  if (difficulty) { filters.push('r.difficulty=?'); args.push(difficulty); }
  if (playerId) { filters.push('r.player_id=?'); args.push(playerId); }
  const suffix = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const [total, rows] = await Promise.all([
    one(db, `SELECT COUNT(*) AS count ${VISIBLE_RUNS} ${suffix}`, args),
    list(db, `SELECT ${RUN_FIELDS} ${VISIBLE_RUNS} ${suffix}
      ORDER BY r.completed_at DESC, r.rowid DESC LIMIT ? OFFSET ?`, [...args, limit, offset]),
  ]);
  return { total: num(total?.count), rows: rows.map(runRow), offset, limit };
}
async function questions(db, url) {
  const status = url.searchParams.get('status') || 'all';
  if (!['all','open','answered','archived'].includes(status)) throw new Error('Invalid question status');
  const category=url.searchParams.get('category')||'all';
  if(!['all','Idea','Question','Bug report','Other'].includes(category))throw new Error('Invalid category');
  const search = (url.searchParams.get('search') || '').trim().slice(0, 60);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100',10) || 100));
  const offset = Math.min(100000, Math.max(0, parseInt(url.searchParams.get('offset') || '0',10) || 0));
  const conditions = [];
  const args = [];
  if (status !== 'all') { conditions.push('q.status=?'); args.push(status); }
  if(category!=='all'){conditions.push('q.category=?');args.push(category);}
  if (search) {
    conditions.push(`(q.nickname LIKE ? ESCAPE '\\' OR q.message LIKE ? ESCAPE '\\')`);
    const term = `%${search.replace(/[\%_]/g,'\\$&')}%`;
    args.push(term,term);
  }
  const where = conditions.length ? 'WHERE '+conditions.join(' AND ') : '';
  const [total, rows, unread] = await Promise.all([
    one(db, `SELECT COUNT(*) AS count FROM qfhq_questions q ${where}`, args),
    list(db, `SELECT q.question_id,q.player_id,q.nickname,q.category,q.message,q.reply,q.status,
      q.created_at,q.replied_at
      FROM qfhq_questions q ${where}
      ORDER BY q.created_at DESC, q.rowid DESC LIMIT ? OFFSET ?`, [...args,limit,offset]),
    one(db, "SELECT COUNT(*) AS count FROM qfhq_questions WHERE status='open'"),
  ]);
  return {total:num(total?.count),unanswered:num(unread?.count),offset,limit,
    rows:rows.map(r=>({id:r.question_id,playerId:r.player_id,nickname:r.nickname,
      category:r.category,message:r.message,reply:r.reply||null,status:r.status,
      createdAt:r.created_at,repliedAt:r.replied_at}))};
}

// v5 superpowers — all write operations below are authenticated by HQ's
// existing session cookie. The game sees only the public announcement,
// competition standings and awarded cosmetic badges.
const BADGE_AWARDS=new Set(['founder','helper','star','champion']);
const SUBJECT_CHOICES=new Set([...SUBJECTS,'All subjects']);
function parseSetting(row){try{return row?.value?JSON.parse(row.value):null}catch{return null}}
async function competitionBoard(db,competition){
 if(!competition?.title||!competition?.start||!competition?.end)return [];
 const sql=`WITH eligible AS (
  SELECT r.player_id,r.completed_at,
    COALESCE(c.correct_override,r.correct) AS correct,
    COALESCE(c.total_override,r.total) AS total,
    ROW_NUMBER() OVER (PARTITION BY r.player_id ORDER BY r.completed_at ASC,r.rowid ASC) AS attempt
  FROM qfhq_runs r
  LEFT JOIN qfhq_hq_run_corrections c ON c.run_id=r.run_id
  LEFT JOIN qfhq_hq_overrides o ON o.player_id=r.player_id
  WHERE (?='All subjects' OR r.subject=?) AND r.total>=10
    AND datetime(r.completed_at)>=datetime(?) AND datetime(r.completed_at)<datetime(?)
    AND COALESCE(o.hidden,0)=0
 ) SELECT COALESCE(o.nickname_override,p.nickname) AS nickname,e.correct,e.total,e.completed_at
 FROM eligible e JOIN qfhq_players p ON p.player_id=e.player_id
 LEFT JOIN qfhq_hq_overrides o ON o.player_id=e.player_id
 WHERE e.attempt=1 AND e.total>0
 ORDER BY 1.0*e.correct/e.total DESC,e.correct DESC,e.completed_at ASC LIMIT 10`;
 const rows=await list(db,sql,[competition.subject,competition.subject,competition.start,competition.end]);
 return rows.map(r=>({nickname:r.nickname||'Player',correct:num(r.correct),total:num(r.total),completedAt:r.completed_at}));
}
async function superpowers(db){
 const [a,c,awards,activity,bugReports]=await Promise.all([
  one(db,"SELECT value FROM qfhq_hq_settings WHERE key='v5_announcement'"),
  one(db,"SELECT value FROM qfhq_hq_settings WHERE key='v5_competition'"),
  list(db,`SELECT b.player_id,b.badge_id,b.awarded_at,
    COALESCE(o.nickname_override,p.nickname) AS nickname
    FROM qfhq_awarded_badges b LEFT JOIN qfhq_players p ON p.player_id=b.player_id
    LEFT JOIN qfhq_hq_overrides o ON o.player_id=b.player_id
    ORDER BY b.awarded_at DESC LIMIT 25`),
  one(db,`SELECT
    SUM(CASE WHEN date(completed_at)=date('now') THEN 1 ELSE 0 END) AS today,
    SUM(CASE WHEN date(completed_at)>=date('now','-6 days') THEN 1 ELSE 0 END) AS week
    FROM qfhq_runs`),
  one(db,"SELECT COUNT(*) AS count FROM qfhq_questions WHERE category='Bug report' AND status='open'")
 ]);
 const announcement=parseSetting(a),competition=parseSetting(c);
 return {announcement,competition,leaderboard:await competitionBoard(db,competition),
  awards:awards.map(r=>({playerId:r.player_id,nickname:r.nickname||'Player',badgeId:r.badge_id,awardedAt:r.awarded_at})),
  stats:{today:num(activity?.today),week:num(activity?.week),bugs:num(bugReports?.count)}};
}
async function setSetting(db,key,value){
 if(value===null)await db.prepare('DELETE FROM qfhq_hq_settings WHERE key=?').bind(key).run();
 else await db.prepare(`INSERT INTO qfhq_hq_settings(key,value) VALUES (?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`)
  .bind(key,JSON.stringify(value)).run();
}
async function admin(db, body) {
  const operation = body?.operation;
  if(operation==='save_announcement'){
    const message=typeof body.text==='string'?body.text.trim():'';
    if(message.length<1||message.length>240||/https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(message))
      return fail('Announcement must be 1–240 characters, without links or email addresses.');
    const expiry=body.expiresAt;
    if(expiry!==null && (typeof expiry!=='string'||!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now()||Date.parse(expiry)>Date.now()+90*86400000))
      return fail('Choose an expiry in the next 90 days, or leave it blank.');
    await setSetting(db,'v5_announcement',{text:message,expiresAt:expiry||null});
    return reply({ok:true});
  }
  if(operation==='clear_announcement'){
    await setSetting(db,'v5_announcement',null);return reply({ok:true});
  }
  if(operation==='save_competition'){
    const title=typeof body.title==='string'?body.title.trim():'';
    const subject=body.subject;
    const start=body.start,end=body.end;
    if(title.length<3||title.length>60||!SUBJECT_CHOICES.has(subject))return fail('Enter a title (3–60 characters) and subject.');
    if(typeof start!=='string'||typeof end!=='string'||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end)))return fail('Enter valid start and end dates.');
    const startMs=Date.parse(start),endMs=Date.parse(end);
    if(startMs>=endMs||endMs-startMs>30*86400000||endMs<Date.now()-86400000||startMs>Date.now()+60*86400000)
      return fail('Competition must last 1–30 days and be current or upcoming.');
    await setSetting(db,'v5_competition',{title,subject,start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString(),rule:'First eligible 10+ question test counts; IDK gives 0 marks.'});
    return reply({ok:true});
  }
  if(operation==='clear_competition'){
    await setSetting(db,'v5_competition',null);return reply({ok:true});
  }
  if(operation==='award_badge'||operation==='revoke_badge'){
    if(!validId(body.playerId)||!BADGE_AWARDS.has(body.badgeId))return fail('Choose a valid player and special badge.');
    const exists=await one(db,'SELECT player_id FROM qfhq_players WHERE player_id=?',[body.playerId]);
    if(!exists)return fail('Player not found',404);
    if(operation==='award_badge')await db.prepare('INSERT OR IGNORE INTO qfhq_awarded_badges(player_id,badge_id) VALUES (?,?)').bind(body.playerId,body.badgeId).run();
    else await db.prepare('DELETE FROM qfhq_awarded_badges WHERE player_id=? AND badge_id=?').bind(body.playerId,body.badgeId).run();
    return reply({ok:true});
  }
  if (operation === 'feature' || operation === 'clear_feature') {
    if (operation === 'clear_feature') {
      await db.prepare("DELETE FROM qfhq_hq_settings WHERE key='featured_player'").run();
    } else {
      if (!validId(body.playerId)) return fail('Invalid player ID');
      const p = await one(db, PLAYER_CTE + 'SELECT player_id FROM players WHERE player_id=? AND hidden=0', [body.playerId]);
      if (!p) return fail('Player not found');
      await db.prepare(`INSERT INTO qfhq_hq_settings (key,value) VALUES ('featured_player',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(body.playerId).run();
    }
    return reply({ ok: true });
  }
  if (operation === 'reply_question') {
    if (!validId(body.questionId)) return fail('Invalid message ID');
    const answer=typeof body.reply==='string'?body.reply.trim():'';
    if (answer.length<1 || answer.length>800) return fail('Write a reply of 1–800 characters');
    const existing=await one(db,'SELECT question_id FROM qfhq_questions WHERE question_id=?',[body.questionId]);
    if (!existing) return fail('Message not found',404);
    await db.prepare(`UPDATE qfhq_questions SET reply=?,status='answered',
      replied_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE question_id=?`)
      .bind(answer,body.questionId).run();
    return reply({ok:true});
  }
  if (operation === 'archive_question' || operation === 'reopen_question') {
    if (!validId(body.questionId)) return fail('Invalid message ID');
    const existing=await one(db,'SELECT question_id FROM qfhq_questions WHERE question_id=?',[body.questionId]);
    if (!existing) return fail('Message not found',404);
    const sql=operation==='archive_question'
      ? "UPDATE qfhq_questions SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE question_id=?"
      : "UPDATE qfhq_questions SET status=CASE WHEN reply IS NULL THEN 'open' ELSE 'answered' END,updated_at=CURRENT_TIMESTAMP WHERE question_id=?";
    await db.prepare(sql).bind(body.questionId).run();
    return reply({ok:true});
  }
  if (operation === 'save_player') {
    if (!validId(body.playerId)) return fail('Invalid player ID');
    const exists = await one(db, 'SELECT player_id FROM qfhq_players WHERE player_id=?', [body.playerId]);
    if (!exists) return fail('Player not found', 404);
    const nickname = body.nickname === null ? null : typeof body.nickname === 'string' ? body.nickname.trim() : undefined;
    const xp = body.xp === null ? null : body.xp;
    if (nickname === undefined || (nickname !== null && !/^[\p{L}\p{N}_ .-]{2,18}$/u.test(nickname))) return fail('Nickname must be 2–18 characters or left blank');
    if (xp !== null && !isInt(xp, 0, 100000000)) return fail('XP must be a whole number from 0 to 100,000,000');
    if (typeof body.hidden !== 'boolean') return fail('Invalid visibility setting');
    await db.prepare(`INSERT INTO qfhq_hq_overrides (player_id,nickname_override,xp_override,hidden)
      VALUES (?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET
      nickname_override=excluded.nickname_override,xp_override=excluded.xp_override,
      hidden=excluded.hidden,updated_at=CURRENT_TIMESTAMP`)
      .bind(body.playerId, nickname, xp, body.hidden ? 1 : 0).run();
    // Increment revision so the player's game knows there is a new HQ edit.
    await db.prepare(`INSERT INTO qfhq_hq_game_revisions (player_id,revision) VALUES (?,1)
      ON CONFLICT(player_id) DO UPDATE SET revision=revision+1,updated_at=CURRENT_TIMESTAMP`)
      .bind(body.playerId).run();
    return reply({ ok: true });
  }
  if (operation === 'reset_player') {
    if (!validId(body.playerId)) return fail('Invalid player ID');
    await db.prepare('DELETE FROM qfhq_hq_overrides WHERE player_id=?').bind(body.playerId).run();
    await db.prepare(`INSERT INTO qfhq_hq_game_revisions (player_id,revision) VALUES (?,1)
      ON CONFLICT(player_id) DO UPDATE SET revision=revision+1,updated_at=CURRENT_TIMESTAMP`)
      .bind(body.playerId).run();
    return reply({ ok: true });
  }
  if (operation === 'correct_run') {
    if (!validId(body.runId)) return fail('Invalid game ID');
    if (!isInt(body.total, 1, 120) || !isInt(body.correct, 0, body.total) || !isInt(body.earnedXp, 0, 1000)) return fail('Check correct answers, total questions and XP');
    const exists = await one(db, 'SELECT run_id FROM qfhq_runs WHERE run_id=?', [body.runId]);
    if (!exists) return fail('Game not found', 404);
    await db.prepare(`INSERT INTO qfhq_hq_run_corrections (run_id,correct_override,total_override,xp_override)
      VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      correct_override=excluded.correct_override,total_override=excluded.total_override,
      xp_override=excluded.xp_override,updated_at=CURRENT_TIMESTAMP`)
      .bind(body.runId, body.correct, body.total, body.earnedXp).run();
    return reply({ ok: true });
  }
  if (operation === 'reset_run') {
    if (!validId(body.runId)) return fail('Invalid game ID');
    await db.prepare('DELETE FROM qfhq_hq_run_corrections WHERE run_id=?').bind(body.runId).run();
    return reply({ ok: true });
  }
  return fail('Unknown admin action');
}

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST') return fail('Method not allowed', 405);
    if (method === 'POST') {
      const origin = request.headers.get('Origin');
      if (!origin || origin !== url.origin) return fail('Invalid request origin', 403);
      if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return fail('JSON required', 415);
      if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return fail('Request too large', 413);
    }
    if (url.searchParams.get('action') === 'status' && method === 'GET') {
      return reply({ ok: true, configured: configured(env), authenticated: configured(env) &&
        await verifyToken(env.HQ_SESSION_SECRET, cookieValue(request)) });
    }
    if (!configured(env)) return fail('HQ is not configured. Add HQ_ADMIN_PASSWORD and HQ_SESSION_SECRET as Cloudflare secrets.', 503);
    let body = null;
    if (method === 'POST') {
      const raw = await request.text();
      if (encoder.encode(raw).length > MAX_BODY) return fail('Request too large', 413);
      try { body = JSON.parse(raw); } catch { return fail('Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid request');
      if (body.action === 'login') return await login(request, env, body);
    }
    const authorized = await verifyToken(env.HQ_SESSION_SECRET, cookieValue(request));
    if (!authorized) return fail('Please sign in to QUIZFORCE HQ.', 401);
    if (method === 'POST' && body?.action === 'logout') {
      return reply({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    }
    if (!env.DB || typeof env.DB.prepare !== 'function') return fail('D1 database binding DB is missing.', 503);
    await ensureTables(env.DB);
    if (method === 'POST') {
      if (body?.action !== 'admin') return fail('Unknown action');
      return await admin(env.DB, body);
    }
    const action = url.searchParams.get('action') || 'dashboard';
    if (action === 'dashboard') return reply({ ok: true, data: await dashboard(env.DB) });
    if (action === 'players') return reply({ ok: true, data: await players(env.DB, url) });
    if (action === 'runs') return reply({ ok: true, data: await runs(env.DB, url) });
    if (action === 'questions') return reply({ ok: true, data: await questions(env.DB, url) });
    if (action === 'superpowers') return reply({ ok: true, data: await superpowers(env.DB) });
    return fail('Unknown action', 404);
  } catch (error) {
    console.error('QUIZFORCE HQ API error', error);
    return fail('HQ could not load this request. Check the Cloudflare deployment and D1 binding.', 503);
  }
}
