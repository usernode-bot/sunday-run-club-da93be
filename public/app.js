// Sunday Run Club page logic: load the club's summary, render the three
// boards (This week, Keeping up, Weekly totals), and handle the log form.
//
// Every date decision reads the platform's clock: the server computes the
// summary from req.now, and this page sends usernode.now() along as
// x-usernode-now when a staging preview is shown as of a chosen moment,
// so preview and page always agree on what "this week" is.
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var DEMO = params.get('demo') === '1';

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // The starter template's api() helper: forwards the iframe token, and on
  // a preview opened at a moment, that moment as x-usernode-now.
  function api(path, options) {
    options = options || {};
    var url = new URL(path, window.location.origin);
    if (DEMO) url.searchParams.set('demo', '1');
    var headers = {};
    var token = params.get('token');
    if (token) headers['x-usernode-token'] = token;
    if (window.usernode && window.usernode.previewNow) {
      headers['x-usernode-now'] = window.usernode.now().toISOString();
    }
    var init = Object.assign({}, options);
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    init.headers = headers;
    return fetch(url.toString(), init);
  }

  // ── Labels ───────────────────────────────────────────────────────────────
  var F_MONTH_DAY = new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  var F_DAY = new Intl.DateTimeFormat('en', { timeZone: 'UTC', day: 'numeric' });

  function parseDay(iso) {
    return new Date(iso + 'T00:00:00Z');
  }

  // "Oct 5 to 11" when the week sits in one month, "Sep 28 to Oct 4" when
  // it straddles two.
  function weekLabel(weekStart, weekEnd) {
    var s = parseDay(weekStart);
    var e = parseDay(weekEnd);
    if (s.getUTCMonth() === e.getUTCMonth()) {
      return F_MONTH_DAY.format(s).split(' ')[0] + ' ' + s.getUTCDate() + ' to ' + e.getUTCDate();
    }
    return F_MONTH_DAY.format(s) + ' to ' + F_MONTH_DAY.format(e);
  }

  function fmtMiles(n) {
    return Number(n).toFixed(1).replace(/\.0$/, '') + '';
  }

  // The most recent Sunday on or before today (UTC): today if today is
  // Sunday, else the Sunday that started this week's run of days back.
  function mostRecentSunday(todayISO) {
    var t = parseDay(todayISO);
    var day = t.getUTCDay();
    t.setUTCDate(t.getUTCDate() - (day === 0 ? 0 : day));
    return t.toISOString().slice(0, 10);
  }

  // ── State ────────────────────────────────────────────────────────────────
  var state = { data: null, failed: false };

  function skeletonRows(count) {
    var html = '<div class="list" aria-hidden="true">';
    for (var i = 0; i < count; i++) {
      html += '<div class="list-row"><div class="skeleton h-4 w-28"></div>' +
        '<div class="skeleton ml-auto h-4 w-16"></div></div>';
    }
    return html + '</div>';
  }

  function stateError(what) {
    return '<div class="state-error"><p class="text-body font-medium">' + what + ' failed to load.</p>' +
      '<p class="text-small text-muted">Nothing was lost. The rest of the page is fine.</p>' +
      '<button type="button" class="btn-secondary" data-retry>Retry</button></div>';
  }

  function load() {
    state.failed = false;
    el('week-board-body').innerHTML = skeletonRows(3);
    el('keeping-up-body').innerHTML = skeletonRows(2);
    el('totals-body').innerHTML = skeletonRows(3);
    api('/api/summary').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      state.data = data;
      state.failed = false;
      render();
    }).catch(function () {
      state.data = null;
      state.failed = true;
      render();
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function render() {
    if (state.failed) {
      el('week-heading').textContent = 'Could not load the club';
      el('week-strip').innerHTML = '';
      el('log-section').classList.add('hidden');
      el('week-board-body').innerHTML = stateError('The club&rsquo;s runs');
      el('keeping-up-body').innerHTML = '';
      el('totals-body').innerHTML = '';
      return;
    }
    var d = state.data;
    if (!d) return;
    if (DEMO) el('demo-note').hidden = false;

    el('week-heading').textContent = 'This week: ' + weekLabel(d.weekStart, d.weekEnd);
    renderStrip(d);
    renderLogSection(d);
    renderWeekBoard(d);
    renderKeepingUp(d);
    renderTotals(d);
  }

  function renderStrip(d) {
    var strip = el('week-strip');
    strip.innerHTML = '';
    for (var i = 0; i < 8; i++) {
      var w = d.weeks[i];
      var mine = d.me && w.members.some(function (m) { return m.id === d.me.id; });
      var dot = document.createElement('span');
      dot.className = mine ? 'dot on' : 'dot';
      dot.title = weekLabel(w.weekStart, w.weekEnd);
      strip.appendChild(dot);
    }
  }

  function renderLogSection(d) {
    var section = el('log-section');
    if (!d.me) {
      // A guest: read-only boards, and the note where the form was.
      section.innerHTML = '<h2 class="text-heading">Log your run</h2>' +
        '<p class="text-body text-muted">Make an account to log your runs.</p>';
      return;
    }
    var dateInput = el('log-date');
    dateInput.max = d.today;
    if (!dateInput.value) dateInput.value = mostRecentSunday(d.today);
  }

  function milesLabel(n) {
    // "6.2 miles", one decimal, trailing ".0" dropped ("8 miles").
    var v = Number(n);
    return (Math.round(v * 10) / 10).toString() + ' miles';
  }

  function renderWeekBoard(d) {
    var body = el('week-board-body');
    if (!d.people.length) {
      body.innerHTML = '<div class="state-empty"><p class="text-body font-medium">No runs yet.</p>' +
        '<p class="text-small text-muted">Log your first Sunday run.</p></div>';
      return;
    }
    var thisWeek = d.weeks[0];
    var milesBy = {};
    var runIdBy = {};
    thisWeek.members.forEach(function (m) {
      milesBy[m.id] = m.miles;
      runIdBy[m.id] = m.runId;
    });
    var mineId = d.me ? d.me.id : null;
    var entries = d.people.slice().sort(function (a, b) {
      if (mineId !== null) {
        if (a.id === mineId) return -1;
        if (b.id === mineId) return 1;
      }
      var am = milesBy[a.id] != null;
      var bm = milesBy[b.id] != null;
      if (am !== bm) return am ? -1 : 1;
      if (am && bm) return milesBy[b.id] - milesBy[a.id];
      return 0;
    });
    var html = '<ul class="list">';
    entries.forEach(function (p) {
      var miles = milesBy[p.id];
      var name = p.id === mineId ? 'you' : p.username;
      var strong = p.id === mineId;
      var right = miles != null
        ? '<span class="' + (strong ? 'text-body font-semibold' : 'text-body font-semibold') + '">' +
            esc(milesLabel(miles)) + '</span>'
        : '<span class="text-small text-muted">not yet</span>';
      var remove = (p.id === mineId && runIdBy[p.id] != null)
        ? '<button type="button" class="btn-secondary" data-remove="' + Number(runIdBy[p.id]) + '">Remove</button>'
        : '';
      html += '<li class="list-row">' +
        '<span class="grow ' + (strong ? 'text-body font-semibold' : 'text-body') + '">' + esc(name) + '</span>' +
        right + remove + '</li>';
    });
    html += '</ul>';
    var total = d.roster ? d.roster.length : entries.length;
    html += '<p class="text-small text-muted mt-2">' + thisWeek.members.length + ' of ' + total +
      ' logged so far this week</p>';
    body.innerHTML = html;
  }

  function renderKeepingUp(d) {
    var body = el('keeping-up-body');
    if (!d.people.length) {
      body.innerHTML = '<div class="state-empty"><p class="text-body font-medium">No streaks yet.</p>' +
        '<p class="text-small text-muted">A streak is every week in a row you have logged a run.</p></div>';
      return;
    }
    var mine = d.me ? d.people.find(function (p) { return p.id === d.me.id; }) : null;
    var html = '';
    if (mine) {
      var headline;
      var detail;
      if (mine.currentStreak > 0 && mine.ranThisWeek) {
        headline = 'Your streak: ' + mine.currentStreak + (mine.currentStreak === 1 ? ' week' : ' weeks');
        detail = 'Personal best: ' + mine.bestStreak + (mine.bestStreak === 1 ? ' week.' : ' weeks.');
      } else if (mine.currentStreak > 0) {
        headline = 'Your streak: ' + mine.currentStreak + (mine.currentStreak === 1 ? ' week' : ' weeks');
        detail = 'Log this week to keep it. Personal best: ' + mine.bestStreak +
          (mine.bestStreak === 1 ? ' week.' : ' weeks.');
      } else if (mine.bestStreak > 0) {
        headline = 'Your streak: 0';
        detail = 'Your best was ' + mine.bestStreak + (mine.bestStreak === 1 ? ' week.' : ' weeks.') +
          ' Log this week to start again.';
      } else {
        headline = 'Your streak: 0';
        detail = 'Log your first Sunday run to start one.';
      }
      html += '<section class="card flex flex-col gap-1 mb-2">' +
        '<h3 class="text-heading">' + esc(headline) + '</h3>' +
        '<p class="text-small text-muted">' + esc(detail) + '</p></section>';
    }
    html += '<ul class="list">';
    d.people.forEach(function (p) {
      var name = p.id === (d.me && d.me.id) ? 'you' : p.username;
      var strong = p.id === (d.me && d.me.id) || p.currentStreak > 0;
      html += '<li class="list-row">' +
        '<div class="flex-1"><div class="' + (strong ? 'text-body font-semibold' : 'text-body') + '">' +
          esc(name) + '</div>' +
        '<div class="text-small text-muted">' + (p.lastRun ? 'Last run ' + esc(F_MONTH_DAY.format(parseDay(p.lastRun))) : 'No runs yet') + '</div></div>' +
        '<div class="text-right"><div class="' + (p.currentStreak > 0 ? 'text-body font-semibold' : 'text-body text-muted') + '">' +
          p.currentStreak + ' wk</div>' +
        '<div class="text-small text-muted">' + (Math.round(p.totalMiles * 10) / 10) + ' mi total</div></div>' +
        '</li>';
    });
    html += '</ul>';
    body.innerHTML = html;
  }

  function renderTotals(d) {
    var body = el('totals-body');
    var anyRuns = d.people.some(function (p) { return p.totalMiles > 0; });
    if (!anyRuns) {
      body.innerHTML = '<div class="state-empty"><p class="text-body font-medium">No weekly totals yet.</p>' +
        '<p class="text-small text-muted">They appear here once someone logs a run.</p></div>';
      return;
    }
    var mineId = d.me ? d.me.id : null;
    var html = '<ul class="list">';
    d.weeks.slice(0, 8).forEach(function (w) {
      var breakdown = w.members.map(function (m) {
        return esc((m.id === mineId ? 'you' : m.username) + ' ' + fmtMiles(m.miles));
      }).join(' &middot; ');
      html += '<li class="list-row">' +
        '<div class="flex-1"><div class="text-body">' + esc(weekLabel(w.weekStart, w.weekEnd)) + '</div>' +
        '<div class="text-small text-muted">' + (w.members.length ? breakdown : 'no runs') + '</div></div>' +
        (w.members.length
          ? '<div class="text-body font-semibold">' + fmtMiles(w.total) + ' mi</div>'
          : '<div class="text-body text-muted">0 mi</div>') +
        '</li>';
    });
    html += '</ul>';
    body.innerHTML = html;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function showFormError(message) {
    var p = el('form-error');
    p.textContent = message;
    p.hidden = false;
  }

  var formBound = false;

  function bindForm() {
    if (formBound) return;
    formBound = true;
    el('log-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var date = el('log-date').value;
      var miles = Number(el('log-miles').value);
      if (!date) return showFormError('Pick a date for the run.');
      if (!Number.isFinite(miles) || miles <= 0) {
        return showFormError('Enter your miles: more than 0, at most 999.99.');
      }
      var submit = el('log-submit');
      submit.disabled = true;
      api('/api/runs', { method: 'POST', body: { date: date, miles: miles } })
        .then(function (res) {
          if (res.status === 401) {
            showFormError('Make an account to log your runs.');
            return null;
          }
          return res.json().catch(function () { return null; }).then(function (body) {
            if (!res.ok) {
              showFormError((body && body.message) || 'That did not save. Try again.');
              return null;
            }
            el('log-miles').value = '';
            el('form-error').hidden = true;
            return load();
          });
        })
        .catch(function () { showFormError('That did not save. Try again.'); })
        .finally(function () { submit.disabled = false; });
    });
  }

  document.addEventListener('click', function (ev) {
    var retry = ev.target.closest('[data-retry]');
    if (retry) {
      el('log-section').classList.remove('hidden');
      load();
      return;
    }
    var btn = ev.target.closest('[data-remove]');
    if (!btn) return;
    btn.disabled = true;
    api('/api/runs/' + btn.getAttribute('data-remove'), { method: 'DELETE' })
      .then(function (res) {
        if (res.ok || res.status === 404) return load();
        return null;
      })
      .catch(function () { btn.disabled = false; });
  });

  load();
  bindForm();
})();
