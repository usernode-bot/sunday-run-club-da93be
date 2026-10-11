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

// ── Sunday runs ────────────────────────────────────────────────────────────
// One row per member per day. The UNIQUE index on (user_id, run_date) is
// what makes "log again for the same date" an upsert rather than a
// duplicate; it is also the arbiter the demo seed relies on. The table is
// public by design: it is the group's leaderboard content, it holds
// nothing beyond a public username, and it has no FK to a private table.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id         bigserial    PRIMARY KEY,
      user_id    bigint       NOT NULL,
      username   text         NOT NULL,
      run_date   date         NOT NULL,
      miles      numeric(6,2) NOT NULL CHECK (miles > 0 AND miles <= 999.99),
      created_at timestamptz  NOT NULL DEFAULT now()
    )`);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS runs_user_day_idx ON runs (user_id, run_date)');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS runs_date_idx ON runs (run_date)');
}

// ── Weeks ──────────────────────────────────────────────────────────────────
// The club's weeks run Monday 00:00 to Sunday 24:00, in UTC (the server's
// own zone; a per-club zone is deferred and recorded in CLAUDE.md). Every
// date decision reads req.now — never new Date() or SQL's NOW() — so a
// staging preview opened at a chosen moment shows that moment's week.
function dayISO(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function addDaysISO(iso, n) {
  return dayISO(addDays(new Date(iso + 'T00:00:00Z'), n));
}

// Monday 00:00 UTC of the week containing `now`.
function weekStartUTC(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d;
}

const WEEKS_SHOWN = 10; // weeks the totals board reaches back over

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Consecutive-week counting over a set of week-start ISO dates. The
// current streak counts back from the most recent week with a run — but
// only if that week is this week or last: older than that and the streak
// is gone (0). A member with no run this week keeps their streak through
// last week and the page shows the "log this week to keep it" hint.
function streaksFromWeeks(weekISOs, thisWeekISO) {
  const sorted = [...new Set(weekISOs)].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const w of sorted) {
    run = prev === addDaysISO(w, -7) ? run + 1 : 1;
    if (run > best) best = run;
    prev = w;
  }
  let current = 0;
  const latest = sorted[sorted.length - 1];
  if (latest === thisWeekISO || latest === addDaysISO(thisWeekISO, -7)) {
    let cursor = latest;
    let i = sorted.length - 1;
    while (i >= 0 && sorted[i] === cursor) {
      current++;
      cursor = addDaysISO(cursor, -7);
      i--;
    }
  }
  return { current: current, best: best };
}

// Streaks, weekly totals and the keeping-up order are computed here, in
// one place, so the page stays dumb and the demo injection and the plain
// route share one implementation. `rows` are { user_id, username,
// run_date, miles } with run_date as 'YYYY-MM-DD'. The whole history is
// read (the table is small at club scale) so best streaks reach past the
// ten weeks the totals board shows.
function computeSummary(now, rows, roster, me) {
  const thisWeek = weekStartUTC(now);
  const thisWeekISO = dayISO(thisWeek);
  const weekStarts = [];
  for (let i = 0; i < WEEKS_SHOWN; i++) {
    weekStarts.push(dayISO(addDays(thisWeek, -i * 7)));
  }

  const names = new Map(); // user id -> username; the roster's name wins
  for (const m of roster || []) names.set(String(m.id), m.username);

  // Monday of the week a run date falls in, as ISO.
  const weekOf = (dateISO) =>
    addDaysISO(dateISO, -((new Date(dateISO + 'T00:00:00Z').getUTCDay() + 6) % 7));

  const byWeek = new Map(weekStarts.map(w => [w, new Map()]));
  const perUser = new Map(); // user id -> { weeks, total, last }
  for (const r of rows) {
    const uid = String(r.user_id);
    if (!names.has(uid)) names.set(uid, r.username);
    let u = perUser.get(uid);
    if (!u) {
      u = { weeks: new Set(), total: 0, last: null };
      perUser.set(uid, u);
    }
    const miles = Number(r.miles);
    u.total += miles;
    if (!u.last || r.run_date > u.last) u.last = r.run_date;
    const wISO = weekOf(r.run_date);
    u.weeks.add(wISO);
    const week = byWeek.get(wISO);
    // runId rides along so the page can offer "Remove" on the viewer's own
    // entry; an injected demo row has id null and offers none.
    const cur = week ? week.get(uid) : null;
    if (week) {
      week.set(uid, {
        miles: (cur ? cur.miles : 0) + miles,
        runId: r.id !== undefined && r.id !== null ? r.id : (cur ? cur.runId : null),
      });
    }
  }

  const weeks = weekStarts.map(ws => {
    const members = [...byWeek.get(ws).entries()]
      .map(([uid, entry]) => ({
        id: Number(uid),
        username: names.get(uid),
        miles: round2(entry.miles),
        runId: entry.runId,
      }))
      .sort((a, b) => b.miles - a.miles);
    const total = members.reduce((s, m) => s + m.miles, 0);
    return {
      weekStart: ws,
      weekEnd: addDaysISO(ws, 6),
      total: round2(total),
      runnerCount: members.length,
      members: members,
    };
  });

  const peopleIds = [...perUser.keys()];
  for (const m of roster || []) {
    const uid = String(m.id);
    if (!perUser.has(uid)) peopleIds.push(uid);
  }
  const people = peopleIds.map(uid => {
    const u = perUser.get(uid);
    const s = u ? streaksFromWeeks(u.weeks, thisWeekISO) : { current: 0, best: 0 };
    return {
      id: Number(uid),
      username: names.get(uid),
      currentStreak: s.current,
      bestStreak: s.best,
      totalMiles: round2(u ? u.total : 0),
      lastRun: u ? u.last : null,
      ranThisWeek: u ? u.weeks.has(thisWeekISO) : false,
    };
  }).sort((a, b) =>
    (b.currentStreak - a.currentStreak) ||
    (b.totalMiles - a.totalMiles) ||
    String(a.username).localeCompare(String(b.username)));

  return {
    now: now.toISOString(),
    today: dayISO(now),
    weekStart: thisWeekISO,
    weekEnd: addDaysISO(thisWeekISO, 6),
    me: me ? { id: me.id, username: me.username } : null,
    roster: roster || null,
    weeks: weeks,
    people: people,
  };
}

// ── The club roster ────────────────────────────────────────────────────────
// "Everyone in the group" is the project's member list on the platform
// ("Members" in the conventions): asked for with the viewer's own token,
// never rebuilt from whoever has opened the app and never a fixture. Only
// members get an answer; anyone else (an admin looking in, the check
// runner) gets 403 and the boards render from the runs alone. The budget
// for /members is shared with /users/*, so the answer is cached a minute.
const PLATFORM_API_BASE = (process.env.USERNODE_PLATFORM_API_V1_URL || '')
  .replace(/\/+$/, '');
const ROSTER_TTL_MS = 60_000;
const rosterCache = new Map(); // user id -> { members, at }

function userTokenFrom(req) {
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;
  const header = req.headers['x-usernode-token'];
  return typeof header === 'string' && header ? header : null;
}

async function fetchRoster(req) {
  if (!req.user || !PLATFORM_API_BASE) return null;
  const cached = rosterCache.get(req.user.id);
  if (cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.members;
  try {
    const resp = await fetch(PLATFORM_API_BASE + '/members', {
      headers: { 'x-usernode-user-token': userTokenFrom(req) },
    });
    if (!resp.ok) return null; // 403 not_a_member and friends: no roster
    const body = await resp.json();
    const members = Array.isArray(body && body.members) ? body.members : null;
    if (!members) return null;
    rosterCache.set(req.user.id, { members: members, at: Date.now() });
    return members;
  } catch (err) {
    console.warn('roster fetch failed: ' + err.message);
    return null;
  }
}

// ── Staging demo (first version) ───────────────────────────────────────────
// The first version's populated demo, on `?demo=1` and staging only ("A
// first version's populated demo" in the conventions). The other runners
// are fake identities injected in memory, never stored; the viewer's own
// demo rows are added to the ?demo=1 response rather than written, so the
// plain route keeps its production-shaped answer (the empty state) no
// matter how many previews were opened — the trap the "seeded data must
// not fabricate a signal" rules warn about. What the viewer logs for
// themselves through the form is stored, and stays: that is their real
// data, not a seed.
function demoRequested(req) {
  return IS_STAGING && req.query.demo === '1';
}

// Fake runners, anchored to the week containing `now`. Keys are week
// offsets: 0 is the current week, -1 the one before it. demo-ana keeps a
// six-week streak (this week included); demo-kofi ran five weeks then
// lapsed; demo-mara turns up now and then.
const DEMO_PATTERN = {
  'demo-ana':  { id: 910001, weeks: { '0': 8.0, '-1': 7.5, '-2': 5.5, '-3': 6.0, '-4': 4.5, '-5': 5.0 } },
  'demo-kofi': { id: 910002, weeks: { '-3': 5.0, '-4': 6.5, '-5': 4.0, '-6': 7.0, '-7': 5.5 } },
  'demo-mara': { id: 910003, weeks: { '-2': 6.5, '-5': 5.0 } },
};

// The viewer's demo rows: a four-week streak through last week, nothing
// this week, so the keep-it hint has something to say and the form has
// something to do. Injected per request, skipped on any day the viewer
// already has a run of their own.
function injectDemoRows(now, dbRows, user) {
  const thisWeek = weekStartUTC(now);
  const existing = new Set(dbRows.filter(r => user && String(r.user_id) === String(user.id))
    .map(r => r.run_date));
  const rows = [];
  const viewerWeeks = { '-1': 6.2, '-2': 5.0, '-3': 5.5, '-4': 4.8 };
  if (user) {
    for (const [offset, miles] of Object.entries(viewerWeeks)) {
      const sunday = dayISO(addDays(thisWeek, Number(offset) * 7 + 6));
      if (existing.has(sunday)) continue;
      rows.push({ id: null, user_id: user.id, username: user.username,
        run_date: sunday, miles: miles.toFixed(2) });
    }
  }
  for (const [username, pattern] of Object.entries(DEMO_PATTERN)) {
    for (const [offset, miles] of Object.entries(pattern.weeks)) {
      const sunday = dayISO(addDays(thisWeek, Number(offset) * 7 + 6));
      rows.push({ id: pattern.id, user_id: pattern.id, username: username,
        run_date: sunday, miles: miles.toFixed(2) });
    }
  }
  return rows.filter(r => r.id === null || !demoHiddenRunIds.has(r.id));
}

// A demo row "removed" through the app stays hidden for this process, so
// the control works on injected rows the way it does on stored ones.
const demoHiddenRunIds = new Set();

app.get('/api/summary', async (req, res) => {
  try {
    const demo = demoRequested(req);
    const { rows } = await pool.query(
      'SELECT id, user_id, username, run_date::text AS run_date, miles FROM runs');
    const allRows = demo ? rows.concat(injectDemoRows(req.now, rows, req.user)) : rows;
    const roster = await fetchRoster(req);
    return res.json(computeSummary(req.now, allRows, roster, req.user));
  } catch (err) {
    console.error('summary failed: ' + err.message);
    return res.status(500).json({ error: 'summary_failed' });
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.post('/api/runs', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const body = req.body || {};
  const date = typeof body.date === 'string' ? body.date : '';
  const miles = Number(body.miles);
  if (!DATE_RE.test(date) || Number.isNaN(new Date(date + 'T00:00:00Z').getTime())) {
    return res.status(400).json({ error: 'invalid_date' });
  }
  if (date > dayISO(req.now)) {
    return res.status(400).json({ error: 'future_date', message: 'Pick today or an earlier date.' });
  }
  if (!Number.isFinite(miles) || miles <= 0 || miles > 999.99) {
    return res.status(400).json({ error: 'invalid_miles',
      message: 'Enter your miles: more than 0, at most 999.99.' });
  }
  try {
    // Logging again for a date replaces that day's miles — the unique
    // index on (user_id, run_date) is the arbiter.
    const { rows } = await pool.query(
      `INSERT INTO runs (user_id, username, run_date, miles)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, run_date)
       DO UPDATE SET miles = EXCLUDED.miles, username = EXCLUDED.username
       RETURNING id, run_date::text AS run_date, miles`,
      [req.user.id, req.user.username, date, miles.toFixed(2)]);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('run save failed: ' + err.message);
    return res.status(500).json({ error: 'save_failed' });
  }
});

app.delete('/api/runs/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM runs WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) {
      // A demo-mode Remove on an injected row (never stored) hides it for
      // this process instead, so the control works the way it does on
      // stored rows. In-memory, staging and ?demo=1 only; the plain route
      // keeps its honest 404.
      if (demoRequested(req)) {
        demoHiddenRunIds.add(id);
        return res.status(204).end();
      }
      return res.status(404).json({ error: 'not_found' });
    }
    return res.status(204).end();
  } catch (err) {
    console.error('run delete failed: ' + err.message);
    return res.status(500).json({ error: 'delete_failed' });
  }
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

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
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting connections, drain, close the pool, exit ("Graceful
  // shutdown" in the conventions). The timer is the safety net if a
  // connection will not die on its own.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(signal + ': draining');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Exported for tests; the listening server only starts when run directly.
module.exports = { app, computeSummary, weekStartUTC, streaksFromWeeks, migrate, start };

if (require.main === module) {
  start().catch(err => { console.error(err); process.exit(1); });
}
