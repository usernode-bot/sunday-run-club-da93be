# Sunday Run Club

A weekly miles board for a running club. It opens on the current week
(Sunday to Saturday, America/New_York): each runner's miles as a lane bar
with a dashed line across all lanes marking the group average — anyone at
or above the line is "Keeping up". Below the board: every run logged this
week, a form for logging a run (date, miles, an optional note), and the
group's total miles for each of the last 8 weeks.

Visitors without a Homeroom account can look at the board but not log
runs. People log only their own runs, and a logged run can't be edited or
deleted — the run log is append-only.

## Running it

- `npm ci` then `npm run build` (compiles `styles/tailwind-input.css` to
  `public/tailwind.css`) and `npm start`. Needs `DATABASE_URL`.
- On a staging preview, `?demo=1` shows the board with made-up runners and
  runs (one visible "Staging demo" line) so the populated screen can be
  seen without logging anything; nothing is written to the database.

## API

- `GET /api/summary` — the board: week dates, group total, runner count,
  group average, per-runner miles for this week (with who is keeping up),
  this week's runs newest first, and the last 8 weeks' group totals.
  Guests may read it.
- `POST /api/runs` — `{ runDate, miles, note }`, signed-in users only.
  The date must be today or within the last 8 weeks, miles 0.1 to 100,
  note up to 140 characters.

## Data

One table, append-only:

- `runs` — `id`, `user_id`, `username` (at log time), `run_date` (date in
  the group's zone), `miles numeric(5,1)`, `note`, `created_at`.

The board groups runs by `user_id` and shows the latest username per
person. Weeks and "today" are computed in America/New_York from the
request's time, never the server's local clock or SQL `NOW()`.
