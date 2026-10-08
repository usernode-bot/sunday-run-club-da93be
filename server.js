const express = require('express');
const path = require('path');
const { Pool, types: pgTypes } = require('pg');
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

// Set while the SIGTERM/SIGINT drain at the bottom of this file is running;
// /health flips to 503 so the platform's probe stops routing to us.
let shuttingDown = false;

app.get('/health', (_req, res) =>
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'shutting-down' : 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── The runs table ───────────────────────────────────────────────────────
// One append-only table: every logged run of this group. Its rows are
// usernames and mileages, which every group member already sees on the
// board, so it stays public by the platform's "would a stranger seeing
// every row be a problem" test. No editing, no deleting: no UPDATE or
// DELETE route exists in this version.
pgTypes.setTypeParser(1082, (v) => v); // `date` columns as 'YYYY-MM-DD' strings

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS runs (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    username text NOT NULL,
    run_date date NOT NULL,
    miles numeric(5,2) NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS runs_run_date_idx ON runs (run_date)');
}

// ── The week payload ─────────────────────────────────────────────────────
// Everything the board shows, from one query: the current week window
// (Sunday to Saturday, in UTC calendar days), this week's individual runs,
// per-person totals for it, and the same totals for the current week plus
// the five before it. Built from req.now, never new Date() or NOW(), so a
// staging preview moment shifts the board the same way it shifts the page.
const DAY_MS = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

async function weekPayload(req) {
  const now = req.now;
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = todayStart - now.getUTCDay() * DAY_MS; // 0 for Sunday
  const startISO = isoDay(weekStart);
  const endISO = isoDay(weekStart + 6 * DAY_MS);
  const histStartISO = isoDay(weekStart - 5 * 7 * DAY_MS);

  const { rows } = await pool.query(
    `SELECT username, run_date, miles, note
       FROM runs
      WHERE run_date >= $1 AND run_date <= $2
      ORDER BY run_date DESC, created_at DESC, id DESC`,
    [histStartISO, endISO]
  );

  const num = (v) => round2(parseFloat(v));
  const weekRuns = rows.filter((r) => r.run_date >= startISO && r.run_date <= endISO);
  const runs = weekRuns.map((r) => ({
    username: r.username,
    miles: num(r.miles),
    runDate: r.run_date,
    note: r.note || null,
  }));

  const totalsMap = new Map();
  for (const r of runs) totalsMap.set(r.username, round2((totalsMap.get(r.username) || 0) + r.miles));
  const totals = [...totalsMap.entries()]
    .map(([username, miles]) => ({ username, miles }))
    .sort((a, b) => b.miles - a.miles || a.username.localeCompare(b.username));

  // Six weekly buckets, oldest last. Each run_date maps to the Sunday of
  // its own week first (a date can be 0 to 6 days after that Sunday, so
  // rounding "weeks back from this Sunday" lands late-week runs in the
  // wrong bucket); the difference of the two Sundays is then an exact
  // whole number of weeks.
  const weeks = Array.from({ length: 6 }, (_, i) => ({
    weekStart: isoDay(weekStart - i * 7 * DAY_MS),
    byUser: {},
    group: 0,
  }));
  const windowTotals = new Map();
  for (const r of rows) {
    const runMs = Date.parse(r.run_date + 'T00:00:00Z');
    const runSunday = runMs - new Date(runMs).getUTCDay() * DAY_MS;
    const i = (weekStart - runSunday) / (7 * DAY_MS);
    if (i < 0 || i >= 6) continue;
    const m = num(r.miles);
    weeks[i].byUser[r.username] = round2((weeks[i].byUser[r.username] || 0) + m);
    weeks[i].group = round2(weeks[i].group + m);
    windowTotals.set(r.username, round2((windowTotals.get(r.username) || 0) + m));
  }
  // Columns are the people who ran in the window, most miles first, so the
  // board's order carries through the table.
  const columns = [...windowTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([u]) => u);

  return {
    weekStart: startISO,
    weekEnd: endISO,
    totals,
    runs,
    history: {
      columns,
      weeks: weeks.map((w) => ({
        weekStart: w.weekStart,
        totals: columns.map((c) => (w.byUser[c] ?? null)),
        group: w.group,
      })),
    },
  };
}

app.get('/api/me', (req, res) => {
  res.json(req.user
    ? { signedIn: true, id: req.user.id, username: req.user.username }
    : { signedIn: false });
});

app.get('/api/week', async (req, res, next) => {
  try {
    res.json(await weekPayload(req));
  } catch (err) {
    next(err);
  }
});

app.post('/api/runs', async (req, res, next) => {
  try {
    const body = req.body || {};

    // Miles: a finite number the person typed, more than 0, at most 200,
    // stored to 2 decimals.
    const raw = typeof body.miles === 'number' ? body.miles : parseFloat(String(body.miles ?? '').trim());
    if (!Number.isFinite(raw)) return res.status(400).json({ error: 'Enter how far you ran in miles.' });
    const miles = round2(raw);
    if (miles <= 0) return res.status(400).json({ error: 'Miles must be more than 0.' });
    if (miles > 200) return res.status(400).json({ error: 'Miles must be 200 or less.' });

    // Day: a real date, today or in the past (so a forgotten run can still
    // be added), never in the future. Compared against req.now, not the clock.
    if (typeof body.run_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.run_date) ||
        Number.isNaN(Date.parse(body.run_date + 'T00:00:00Z'))) {
      return res.status(400).json({ error: 'Choose the day you ran.' });
    }
    const now = req.now;
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (Date.parse(body.run_date + 'T00:00:00Z') > todayStart) {
      return res.status(400).json({ error: "A run can't be logged for a future day." });
    }

    // Note: optional, trimmed, at most 200 characters.
    let note = null;
    if (typeof body.note === 'string' && body.note.trim() !== '') {
      note = body.note.trim();
      if (note.length > 200) return res.status(400).json({ error: 'Notes are limited to 200 characters.' });
    }

    await pool.query(
      'INSERT INTO runs (user_id, username, run_date, miles, note) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, req.user.username, body.run_date, miles, note]
    );
    // The refreshed board comes back with the insert, so the page updates
    // in one round trip.
    res.status(201).json(await weekPayload(req));
  } catch (err) {
    next(err);
  }
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

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

// ── Staging seed ─────────────────────────────────────────────────────────
// Demo runners for a fresh staging database, so the board can be seen.
// Idempotent (only fills an empty table), never outside staging, never the
// visitor's own identity. The current week here comes from the boot clock:
// req.now does not exist at boot, and staging demo data needs no more.
async function seedStaging() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM runs');
  if (rows[0].n > 0) return;
  const boot = new Date();
  const sunday = Date.UTC(boot.getUTCFullYear(), boot.getUTCMonth(), boot.getUTCDate()) -
    boot.getUTCDay() * DAY_MS;
  const day = (offset) => isoDay(sunday + offset * DAY_MS);
  const runs = [
    // this week, Sunday-heavy
    ['staging-demo-maya', 0, 6.2, 'bridge loop'],
    ['staging-demo-jun', 0, 6.2, 'canal and back'],
    ['staging-demo-priya', 0, 3.1, ''],
    ['staging-demo-maya', 3, 6.2, 'tempo around the park'],
    // last week
    ['staging-demo-maya', -7, 9.4, 'long run along the river'],
    ['staging-demo-jun', -7, 6.2, ''],
    ['staging-demo-priya', -7, 4.2, 'park with the pram'],
    ['staging-demo-jun', -4, 4.8, ''],
    // two weeks ago
    ['staging-demo-maya', -14, 3.1, 'easy shakeout'],
    ['staging-demo-jun', -14, 6.2, ''],
    ['staging-demo-priya', -14, 6.2, 'evening loop'],
    ['staging-demo-jun', -12, 12.4, 'long one'],
    ['staging-demo-maya', -10, 6.5, ''],
    ['staging-demo-priya', -11, 3.1, ''],
  ];
  for (const [username, offset, miles, note] of runs) {
    await pool.query(
      'INSERT INTO runs (user_id, username, run_date, miles, note) VALUES ($1, $2, $3, $4, $5)',
      [username, username, day(offset), miles, note || null]
    );
  }
  console.log(`Seeded ${runs.length} staging demo runs`);
}

const DRAIN_MS = 3000; // a literal, per the platform's deploy convention

async function start() {
  await migrate();
  if (IS_STAGING) await seedStaging();

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Deploys stop and replace containers, so drain instead of dying mid
  // request: stop taking new connections, let the ones in flight finish
  // (at most DRAIN_MS), then close the pool. Idempotent, on both signals.
  let draining = false;
  const shutdown = async () => {
    if (draining) return;
    draining = true;
    shuttingDown = true;
    console.log('Draining before exit…');
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close();
    await new Promise((r) => setTimeout(r, DRAIN_MS));
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
