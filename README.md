# Sunday Run Club

A tracker for a club's weekly Sunday miles: log your runs, see who's
keeping up with the group, and compare weekly totals at a glance. One
page, three sections:

- **This week** — the week strip (one dot per recent Sunday, filled when
  you ran), the log form, and the board of who has logged this week.
- **Keeping up** — each member's current streak, personal best, last run
  and total miles, best streak on top.
- **Weekly totals** — the group's miles for each of the last eight weeks,
  newest first, broken down by member.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request. Visitors without a Homeroom account can
  look around read-only; every write needs an account.
- **Roster** — the member list comes from the platform (`GET /members`
  with the viewer's token), cached for a minute. When the caller is not
  a member (an admin looking in, the check runner) the boards render
  from the runs alone.
- **Data** — a single `runs` table (one row per member per day; logging
  again for a date replaces that day's miles). Streaks and weekly totals
  are computed in `GET /api/summary`.
- **Weeks** — Monday to Sunday, UTC. The date field defaults to the most
  recent Sunday and never accepts a future date.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme.

## Staging demo

On a staging preview, `/?demo=1` shows the app populated with sample
data (a "Staging demo" note says so at the top): three fake runners plus
a four-week streak of your own to keep. The fake runners are injected in
memory and never stored; runs you log yourself are stored for real. The
plain `/` keeps the honest empty state on a fresh database.

## Developing

```sh
npm ci --include=dev
npm run build   # compiles styles/tailwind-input.css to public/tailwind.css
npm start       # needs DATABASE_URL; see CLAUDE.md for the platform setup
```

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. Start with
`CLAUDE.md` for the app-specific notes and the platform rules.
