# Sunday Run Club — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Sunday Run Club

A weekly miles board for one running club. It opens on the current week
(Sunday to Saturday): how many miles each runner has logged, a dashed line
marking the group average so everyone can see who's keeping up, the week's
run log, the last eight weeks' group totals, and a form for logging a run.
Miles, because the club counts in miles; one shared time zone
(America/New_York) because a week should turn over for everyone at once.

## Design

This app's look. Every later change follows it, and updates it when a
request changes the look on purpose.

- **Palette:** accent: race-bib cobalt blue (`--accent`, cool in the light
  look, a lighter cobalt in the dark one); neutrals: cool asphalt greys
  (`ground`/`raised`/`line`), near-black text. One accent only, for the
  primary action and for lanes at or above the group average.
- **Signature element:** the lane bar — each runner's week drawn as a lane
  in a track, with the group average crossing every lane as a dashed line
  (`.lane-track` with `.lane-fill` / `.lane-fill-below` and a positioned
  `.lane-avg`). Anywhere miles are compared, they are drawn as lanes.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`,
  system sans (`fontFamily.sans` in `tailwind.config.js`), with
  `tabular-nums` wherever miles line up in a column.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`,
`lane-track`, `lane-fill`, `lane-fill-below`, `lane-avg`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- The `runs` table is append-only: no UPDATE or DELETE routes, and no
  editing in the UI. A wrong entry is corrected by logging another run.
- Miles are `numeric(5,1)`, stored per run from 0.1 to 100; the API returns
  them as numbers rounded to 1 decimal.
- Weeks run Sunday to Saturday in America/New_York. Never use `new Date()`,
  SQL `NOW()` or the server's local zone to decide the week: read
  `req.now` / `usernode.now()` and go through `todayInZone` /
  `weekStartOf` in server.js. Dates travel as `YYYY-MM-DD` strings
  (`run_date::text`) and are formatted with `timeZone: 'UTC'` so nothing
  shifts by a day.
- Runs are logged only for today or a day in the last 8 weeks, never a
  future date.
- Staging demo data exists only behind `?demo=1` (gated on `IS_STAGING`),
  merged in-memory in `GET /api/summary`; nothing is ever written to the
  database for it.
- The runner list comes from logged runs (grouped by `user_id`, showing the
  latest username), not from the project's member list.
