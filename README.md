# Sunday Run Club

A run tracker for our weekly Sunday run group. Everyone logs the miles they
ran, and the board shows who is keeping up.

## What it does

- **Log a run** — miles, the day it happened (today or any past day) and an
  optional note, logged under your Homeroom username. Runs are recorded once;
  nothing can be edited or deleted.
- **This week** — per-person totals for the current week, most miles first,
  each row carrying a slim bar against the week's leader.
- **This week's runs** — every individual run of the current week, newest
  first, notes included.
- **Recent weeks** — the last six weeks side by side: people as columns,
  weeks as rows, a group total at the end.

Weeks run Sunday to Saturday. Signed-out visitors can read the whole board
but not log; the form's spot carries a note saying a Homeroom account is
needed.

## How it's built

Plain server-rendered single page (`public/index.html`) on an Express app
(`server.js`) with Postgres (`pg`). One `runs` table, created by an
idempotent boot migration; append-only in this version. The API is three
routes behind the platform's JWT auth middleware: `GET /api/me`,
`GET /api/week` and `POST /api/runs` (which returns the refreshed board).

The stylesheet is Tailwind, precompiled from `styles/tailwind-input.css` and
`tailwind.config.js` by `npm run build` on every image build — never edited
in `public/`. The app follows the viewer's Homeroom theme (light and dark)
through the platform bridge.

## Running it

`npm start` (or `node server.js`) — the container image builds the CSS and
runs the same entrypoint. Needs `DATABASE_URL`, `USERNODE_JWT_PUBLIC_KEY`
and `USERNODE_APP_ID`, all injected by the Homeroom platform. Staging
previews seed a handful of obviously fake `staging-demo-*` runners so the
board can be seen; production starts empty.
