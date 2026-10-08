const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── The weekly miles board ─────────────────────────────────────────────────
//
// One table, append-only: a run is logged once and never edited or deleted.
// Weeks run Sunday to Saturday in America/New_York — one shared zone, so the
// whole club sees the week turn over at the same moment. The day is read
// from req.now (see requestNow above), never new Date() or SQL's NOW().

const ZONE = 'America/New_York';

const DAY_MS = 86_400_000;
const utcDay = (d) => Date.parse(d + 'T00:00:00Z');
const fmtDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fmtDay(utcDay(d) + n * DAY_MS);
const r1 = (n) => Math.round(n * 10) / 10;

// Today as YYYY-MM-DD in the group's zone. en-CA formats as ISO, so no
// manual reassembly.
function todayInZone(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// The Sunday on or before `d`.
function weekStartOf(d) {
  const dow = new Date(utcDay(d)).getUTCDay();
  return addDays(d, -dow);
}

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS runs (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    username text NOT NULL,
    run_date date NOT NULL,
    miles numeric(5,1) NOT NULL CHECK (miles > 0 AND miles <= 100),
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS runs_run_date_idx ON runs (run_date);
`;

// Staging demo (?demo=1): in-memory rows merged into the summary, never
// written to the database, no boot-time seed. Generated relative to
// weekStart so they always land in the current and past weeks whenever the
// preview is opened. Negative ids so they never collide with real ones.
const DEMO_PAST = [
  [['mara.demo', 9.2, 'Long run, easy pace'], ['jonas.demo', 6.4, 'River loop'], ['sam.demo', 7.8, 'River loop'], ['priya.demo', 4.2, null]],
  [['mara.demo', 8.0, 'Track repeats'], ['theo.demo', 5.4, null], ['sam.demo', 8.4, 'Long run, easy pace'], ['lena.demo', 3.8, 'Hill repeats'], ['jonas.demo', 6.0, null]],
  [['sam.demo', 7.2, 'River loop'], ['mara.demo', 10.1, 'Long run, easy pace'], ['priya.demo', 5.0, 'Hill repeats'], ['theo.demo', 4.6, null]],
  [['jonas.demo', 7.4, 'River loop'], ['sam.demo', 6.6, null], ['mara.demo', 9.8, 'Track repeats'], ['lena.demo', 5.2, null]],
  [['mara.demo', 11.0, 'Long run, easy pace'], ['theo.demo', 6.2, null], ['sam.demo', 5.9, 'River loop'], ['priya.demo', 4.8, null], ['jonas.demo', 6.8, 'Hill repeats']],
  [['sam.demo', 8.8, 'River loop'], ['mara.demo', 7.6, null], ['theo.demo', 3.4, null]],
  [['mara.demo', 9.4, 'Track repeats'], ['sam.demo', 7.0, 'Long run, easy pace'], ['jonas.demo', 5.6, null], ['priya.demo', 6.2, 'River loop'], ['lena.demo', 4.4, null], ['theo.demo', 4.0, null]],
  [['sam.demo', 6.8, 'River loop'], ['mara.demo', 8.6, 'Long run, easy pace'], ['jonas.demo', 6.1, null]],
];

function demoRuns(req, weekStart) {
  const rows = [];
  let id = 0;
  const add = (userId, username, dayOffset, miles, note) => {
    const runDate = addDays(weekStart, dayOffset);
    rows.push({
      id: --id,
      user_id: userId,
      username,
      run_date: runDate,
      miles,
      note,
      created_at: new Date(utcDay(runDate) + 9 * 3_600_000), // 09:00 UTC that day
    });
  };
  // This week: the Sunday club run plus a few midweek ones (sam.demo only
  // ever appears in past weeks).
  add('demo-mara', 'mara.demo', 0, 10.4, 'Long run, easy pace');
  add('demo-jonas', 'jonas.demo', 0, 7.2, null);
  add('demo-priya', 'priya.demo', 2, 6.5, 'River loop');
  add('demo-theo', 'theo.demo', 3, 5.0, null);
  add('demo-lena', 'lena.demo', 4, 4.5, 'Track repeats');
  add('demo-jonas', 'jonas.demo', 5, 2.6, 'Shakeout jog');
  add('demo-lena', 'lena.demo', 6, 3.0, null);
  // Two runs for the viewer, so their row reads "You" on the demo board.
  if (req.user) {
    add(String(req.user.id), req.user.username || 'you', 0, 8.0, 'River loop');
    add(String(req.user.id), req.user.username || 'you', -7, 6.0, 'Long run, easy pace');
  }
  DEMO_PAST.forEach((week, i) => {
    week.forEach(([name, miles, note], j) => {
      add('demo-' + name.replace('.demo', ''), name, -7 * (i + 1) + [0, 2, 4][j % 3], miles, note);
    });
  });
  return rows;
}

function buildSummary(rows, me, demo, now) {
  const today = todayInZone(now);
  const weekStart = weekStartOf(today);
  const weekEnd = addDays(weekStart, 6);
  const historyStart = addDays(weekStart, -56);

  const weekRuns = [];
  const byUser = new Map();
  const history = Array.from({ length: 8 }, (_, i) => ({
    weekStart: addDays(weekStart, -7 * (i + 1)), miles: 0, runnerIds: new Set(),
  }));
  const historyIndex = new Map(history.map((h, i) => [h.weekStart, i]));

  for (const row of rows) {
    const d = typeof row.run_date === 'string' ? row.run_date.slice(0, 10) : null;
    if (!d || d < historyStart || d > weekEnd) continue;
    const userId = String(row.user_id);
    const miles = r1(Number(row.miles));
    const entry = {
      id: Number(row.id),
      userId,
      username: row.username,
      runDate: d,
      miles,
      note: row.note == null ? null : String(row.note),
      createdAt: row.created_at instanceof Date ? row.created_at.getTime() : 0,
    };
    if (d >= weekStart) {
      weekRuns.push(entry);
      let u = byUser.get(userId);
      if (!u) {
        u = { userId, miles: 0, runs: 0, lastSeen: 0, latestName: row.username };
        byUser.set(userId, u);
      }
      // Rows group by user_id; the display name is the latest one used.
      if (entry.createdAt >= u.lastSeen) { u.lastSeen = entry.createdAt; u.latestName = row.username; }
      u.miles = r1(u.miles + miles);
      u.runs += 1;
    }
    const hi = historyIndex.get(d);
    if (hi !== undefined) {
      history[hi].miles = r1(history[hi].miles + miles);
      history[hi].runnerIds.add(userId);
    }
  }

  // Newest first: date, then when it was logged.
  weekRuns.sort((a, b) =>
    b.runDate.localeCompare(a.runDate) || b.createdAt - a.createdAt || b.id - a.id);

  const totalMiles = r1(weekRuns.reduce((sum, e) => sum + e.miles, 0));
  const runners = Array.from(byUser.values())
    .map(u => ({ userId: u.userId, username: u.latestName, miles: u.miles, runs: u.runs }))
    .sort((a, b) => b.miles - a.miles || a.username.localeCompare(b.username));
  // The average counts only people who ran this week; "keeping up" is at or
  // above it.
  const runnerCount = runners.filter(r => r.miles > 0).length;
  const groupAverage = runnerCount ? r1(totalMiles / runnerCount) : 0;
  for (const r of runners) {
    r.keepingUp = r.miles > 0 && r.miles >= groupAverage;
    r.isMe = !!me && r.userId === me.userId;
  }

  return {
    zone: ZONE,
    today,
    weekStart,
    weekEnd,
    me,
    demo,
    totalMiles,
    runnerCount,
    groupAverage,
    runners,
    runs: weekRuns.map(e => ({
      id: e.id,
      username: e.username,
      runDate: e.runDate,
      miles: e.miles,
      note: e.note,
      isMe: !!me && e.userId === me.userId,
    })),
    history: history.map(h => ({ weekStart: h.weekStart, miles: h.miles, runners: h.runnerIds.size })),
  };
}

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// The board: this week's lanes, this week's runs and the last 8 weeks, in
// one query. Guests may read it, so nothing here assumes req.user.
app.get('/api/summary', async (req, res, next) => {
  try {
    const now = req.now;
    const weekStart = weekStartOf(todayInZone(now));
    const weekEnd = addDays(weekStart, 6);
    const historyStart = addDays(weekStart, -56);
    const { rows } = await pool.query(
      `SELECT id, user_id, username, run_date::text AS run_date, miles, note, created_at
         FROM runs
        WHERE run_date >= $1::date AND run_date <= $2::date`,
      [historyStart, weekEnd]);
    const demo = IS_STAGING && req.query.demo === '1';
    const all = demo ? rows.concat(demoRuns(req, weekStart)) : rows;
    const me = req.user
      ? { userId: String(req.user.id), username: req.user.username }
      : null;
    res.json(buildSummary(all, me, demo, now));
  } catch (err) {
    next(err);
  }
});

// Log a run. Signed-in users only (the middleware answers guests 401
// account_required before this runs).
app.post('/api/runs', async (req, res, next) => {
  try {
    const today = todayInZone(req.now);
    const earliest = addDays(weekStartOf(today), -56);
    const body = req.body || {};

    const runDate = typeof body.runDate === 'string' ? body.runDate : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || fmtDay(utcDay(runDate)) !== runDate) {
      return res.status(400).json({ error: 'Pick a date for the run.' });
    }
    if (runDate > today) {
      return res.status(400).json({ error: "A run can't be logged for a future date." });
    }
    if (runDate < earliest) {
      return res.status(400).json({ error: 'Runs can be logged for the last 8 weeks.' });
    }

    const milesRaw = typeof body.miles === 'number' ? body.miles : Number(String(body.miles ?? '').trim());
    if (!Number.isFinite(milesRaw) || milesRaw <= 0 || milesRaw > 100) {
      return res.status(400).json({ error: 'Enter miles between 0.1 and 100.' });
    }
    const miles = r1(milesRaw);

    let note = null;
    if (typeof body.note === 'string') {
      note = body.note.trim();
      if (note.length > 140) {
        return res.status(400).json({ error: 'Note can be at most 140 characters.' });
      }
      if (note === '') note = null;
    }

    const { rows } = await pool.query(
      `INSERT INTO runs (user_id, username, run_date, miles, note)
       VALUES ($1, $2, $3::date, $4, $5)
       RETURNING id, user_id, username, run_date::text AS run_date, miles, note, created_at`,
      [String(req.user.id), req.user.username || 'runner', runDate, miles, note]);
    const row = rows[0];
    res.status(201).json({
      id: Number(row.id),
      userId: String(row.user_id),
      username: row.username,
      runDate: row.run_date,
      miles: r1(Number(row.miles)),
      note: row.note,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// API errors answer as JSON, not the HTML error page Express defaults to.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/sunday-run-club-da93be/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/sunday-run-club-da93be/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // The runs table exists before the first request can touch it.
  await pool.query(MIGRATION);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Listening on :${port}`);
      resolve(server);
    });
    // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
    server.keepAliveTimeout = 75_000;
  });
}

start().then((server) => {
  let closing = false;
  const exit = () => pool.end().catch(() => {}).finally(() => process.exit(0));
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: closing`);
    server.close(exit);
    setTimeout(exit, 3000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch(err => { console.error(err); process.exit(1); });
