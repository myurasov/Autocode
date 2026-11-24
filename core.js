/*
 * The demo's core: its clock, the texts' formats (the web UI's own: times,
 * IDs, spend, context), the rules the invented world follows (statuses,
 * settings, wakes) and a small simulation that keeps it moving. Nothing here
 * talks to a server, and nothing is kept after the page closes.
 */
(() => {
  'use strict';

  // The demo's clock: Monday of the current week, 09:12, then real seconds.
  const REAL0 = Date.now();
  const BASE = (() => {
    const d = new Date(REAL0);
    const back = (d.getDay() + 6) % 7;
    return new Date(
      d.getFullYear(), d.getMonth(), d.getDate() - back, 9, 12, 0,
    ).getTime();
  })();
  const now = () => BASE + (Date.now() - REAL0);
  const iso = (ms) => new Date(ms).toISOString();

  const W = window.DEMO_WORLD(BASE);

  // What the page shows and what was typed: kept in memory only.
  const ui = {
    dark: true,
    signedIn: true,
    route: { path: 'agents', query: {}, part: '' },
    notice: {},
    filter: {},
    boxes: { reports: true, costsGone: true },
    folds: new Set(),
    opened: new Set(),
    panels: {},
    forms: { wake: {}, send: {}, job: { delete_session: true } },
    fields: {},
    sort: {},
    more: {},
    editing: null,
    days: null,
    rule: null,
    own: null,
    newOwn: { agent: '', key: 'daily_usd', value: '' },
    resolved: null,
    updatedAt: Date.now(),
    flash: null,
  };

  // ---------------------------------------------------------------- texts

  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  // An ISO time in the viewer's zone, as the web UI writes it:
  // 23-Nov-26 09:12:03 PT.
  function localTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const parts = new Intl.DateTimeFormat('en-US', {
      year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      timeZoneName: 'shortGeneric',
    }).formatToParts(d);
    const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
    return (
      `${part('day')}-${part('month')}-${part('year')} ` +
      `${part('hour')}:${part('minute')}:${part('second')} ` +
      part('timeZoneName')
    );
  }
  // A time as a date, a clock and its zone, each kept whole.
  const timeHtml = (value) => {
    const [date, clock, ...zone] = localTime(value).split(' ');
    return [date, clock, zone.join(' ')]
      .filter(Boolean)
      .map((p) => `<span>${esc(p)}</span>`)
      .join(' ');
  };
  const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  function dayText(day) {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(day);
    return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1].slice(2)}` : day;
  }
  const costText = (usd) => `$${Number(usd).toFixed(2)}`;
  const versionText = (v) => (v ? (/^\d/.test(v) ? `v${v}` : v) : '');
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function tokensShort(n) {
    if (n < 1000) return String(n);
    const k = Math.round(n / 1000);
    if (k < 1000) return `${k}K`;
    if (n <= 1000000) return '1M';
    return `${(n / 1000000).toFixed(1)}M`;
  }
  // How long from now: "in 40s", "in 9m", "in 1h 5m", "in 1d 1h"; "now".
  function leftText(ms) {
    if (ms <= 0) return 'now';
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `in ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
    const d = Math.floor(h / 24);
    return `in ${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
  }
  function waitText(ms) {
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ''}`;
  }
  const FOLD_CHARS = 200;
  const folded = (text) =>
    text.length <= FOLD_CHARS ? text : `${text.slice(0, FOLD_CHARS).trimEnd()}…`;
  const valueText = (v) =>
    v === true ? 'on' : v === false ? 'off' : v == null ? '' : String(v);

  // An ID's parts, each kept whole, with a place to break between them.
  const parts = (list) =>
    list.map((p) => `<span class="id-part">${esc(p)}</span>`).join('<wbr>');
  const idHtml = (id) => parts(id ? String(id).split(/(?<=[:_])/) : []);
  const agentIdHtml = (id) =>
    parts(id ? String(id).split(/(?<=[^\p{L}\p{N}])/u) : []);
  // A folder or a check: it may break after ":", "/" and "_".
  function breaksHtml(text, after = ':/_') {
    const set = after.replace(/[\\\]^-]/g, '\\$&');
    return String(text ?? '')
      .split(new RegExp(`(?<=[${set}])`))
      .map(esc)
      .join('<wbr>');
  }
  const agentLink = (id, plain = false, gone = false) =>
    `<a class="id-link" href="#/agents?agent=${encodeURIComponent(id)}${
      gone ? '&unregistered=1' : ''
    }" title="Show on the Agents page">${
      plain
        ? `<span class="agent-id">${agentIdHtml(id)}</span>`
        : `<code class="agent-id">${agentIdHtml(id)}</code>`
    }</a>`;
  const hostLink = (id) =>
    `<a class="id-link" href="#/hosts?host=${encodeURIComponent(id)}" ` +
    `title="Show on the Hosts page"><code>${idHtml(id)}</code></a>`;
  // owner, autocode and schedule are words; anything else is an agent.
  const who = (id) =>
    ['owner', 'autocode', 'schedule'].includes(id)
      ? `<span class="agent-id">${agentIdHtml(id)}</span>`
      : agentLink(id);
  function modelHtml(model) {
    const at = model.lastIndexOf('/');
    const provider = at < 0 ? '' : model.slice(0, at + 1);
    return (
      `<code><span class="provider muted">${breaksHtml(provider, '/-')}</span>` +
      `<wbr><span class="slug">${breaksHtml(model.slice(at + 1), '-')}</span></code>`
    );
  }

  /*
   * A small markdown: paragraphs with their line breaks, lists, bold and
   * code, which is what the invented messages use.
   */
  function markdown(text) {
    const inline = (s) =>
      esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    const blocks = String(text ?? '').split(/\n{2,}/);
    const html = blocks.map((block) => {
      const lines = block.split('\n');
      const out = [];
      let list = null;
      const flush = () => {
        if (list) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
        list = null;
      };
      let para = [];
      const flushPara = () => {
        if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
        para = [];
      };
      for (const line of lines) {
        const item = /^[-*] (.*)$/.exec(line);
        if (item) {
          flushPara();
          (list ??= []).push(inline(item[1]));
        } else {
          flush();
          para.push(inline(line));
        }
      }
      flush();
      flushPara();
      return out.join('');
    });
    return `<div class="md">${html.join('')}</div>`;
  }

  // -------------------------------------------------------------- the world

  const agentOf = (id) => W.agents.find((a) => a.id === id);
  const hostOf = (id) => W.hosts.find((h) => h.id === id);
  const isAsk = (i) => ['question', 'permission', 'approval'].includes(i.kind);
  const kindOf = (i) => (i.kind === 'message' && i.report ? 'report' : i.kind);
  const openAsks = (id) =>
    W.inbox.filter((i) => isAsk(i) && !i.closed_at && i.agent === id);
  // What waits for the owner: the open items that are not reports.
  const waiting = () =>
    W.inbox.filter((i) => !i.closed_at && kindOf(i) !== 'report').length;

  // A pattern with "*" for anything, as a test of a whole ID.
  const glob = (p) =>
    new RegExp(
      `^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
    );
  // What a filter field holds: a list of parts of IDs; each matches
  // anywhere in an ID unless it starts or ends with "*".
  function matches(pattern, id) {
    const list = String(pattern ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!list.length) return true;
    return list.some((p) =>
      glob(`${p.startsWith('*') ? '' : '*'}${p}${p.endsWith('*') ? '' : '*'}`).test(
        String(id),
      ),
    );
  }
  // A rule's pattern: whole IDs, "*" for anything.
  const ruleMatches = (pattern, id) =>
    String(pattern)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .some((p) => glob(p).test(id));

  // A setting's value for an agent, and where it comes from.
  function resolve(agent, key) {
    const s = W.settings;
    const own = s.agents.find((r) => r.agent === agent && r.key === key);
    if (own) return { value: own.value, from: "the agent's own value" };
    // the first rule that matches counts, whole: a later one adds nothing
    const n = s.rules.findIndex((r) => ruleMatches(r.match, agent));
    if (n >= 0 && key in s.rules[n].values)
      return { value: s.rules[n].values[key], from: `rule ${n + 1} (${s.rules[n].match})` };
    if (key in s.server) return { value: s.server[key], from: 'set server-wide' };
    return { value: s.defs[key].default, from: 'built-in default' };
  }
  // An agent's daily cap in dollars, or null without one.
  function capOf(agent) {
    const v = resolve(agent, 'daily_usd').value;
    const n = Number(String(v).replace(/^\$/, ''));
    return v === 'off' || !Number.isFinite(n) || n <= 0 ? null : n;
  }

  // Whether an agent's turn runs now: a burst started by something, or its
  // own round of work and rest.
  function working(a) {
    if (a.paused || a.error) return false;
    const t = now();
    if (t < a.busy_until) return true;
    if (!a.cycle) return false;
    const [work, rest, phase] = a.cycle;
    return ((t - BASE) / 1000 + phase) % (work + rest) < work;
  }
  function statusOf(a) {
    if (a.registered === false) return 'unregistered';
    if (!hostOf(a.host)?.online) return 'offline';
    if (a.paused) return 'paused';
    if (a.error) return 'error';
    if (openAsks(a.id).length) return 'waiting';
    return working(a) ? 'working' : 'idle';
  }
  const dotClass = (status) =>
    ({ working: 'ok', idle: 'idle', paused: 'warn', offline: 'off', error: 'err' })[status] ?? '';

  let entry = 200000;
  // A line of History.
  function log(kind, agent, data = {}) {
    const a = typeof agent === 'string' ? agentOf(agent) : agent;
    W.history.unshift({
      id: ++entry, at: iso(now()), kind, agent: a ? a.id : null,
      host: a ? a.host : null, session: a ? a.session : null, data,
    });
  }
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  // A message between agents, the owner and Autocode.
  function send(from, to, subject, text, state = 'queued', via = null) {
    const m = {
      id: `m_${hex(20)}`, created_at: iso(now()), from, to, subject, text,
      size: text.length, state, processed_via: via,
      processed_at: via ? iso(now()) : null,
    };
    W.messages.unshift(m);
    if (from !== 'autocode') log('message.sent', agentOf(from), { id: m.id, to, subject });
    return m;
  }
  // Something for the owner's Inbox.
  function inboxOpen(kind, agent, title, body, more = {}) {
    // a message to the owner is on the Messages tab too, under the same ID
    const id =
      kind === 'message' ? send(agent, 'owner', title, body).id : `in_${hex(20)}`;
    const item = { id, kind, agent, created_at: iso(now()), title, body, ...more };
    W.inbox.unshift(item);
    log('inbox.opened', agent, { kind: kindOf(item), title });
    return item;
  }
  // A turn of an agent that lasts so many seconds.
  function burst(a, seconds, why) {
    if (!a || a.paused || a.error) return;
    a.why = why;
    a.busy_until = Math.max(a.busy_until, now() + seconds * 1000);
  }

  // ------------------------------------------------------------- triggers

  const UNIT = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  function duration(text) {
    const m = /^(\d+)\s*([smhd])$/.exec(String(text).trim());
    return m ? Number(m[1]) * UNIT[m[2]] : null;
  }
  function cronField(expr, value, min, max) {
    return expr.split(',').some((part) => {
      const [range, step = '1'] = part.split('/');
      let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
      if (hi === undefined) hi = part.includes('/') ? max : lo;
      if (![lo, hi, Number(step)].every(Number.isFinite)) return false;
      return value >= lo && value <= hi && (value - lo) % Number(step) === 0;
    });
  }
  // The first minute after `from` that a cron expression names (60 days on).
  function cronNext(expr, from) {
    const f = expr.trim().split(/\s+/);
    if (f.length !== 5) return null;
    const d = new Date(from);
    d.setSeconds(0, 0);
    for (let n = 0; n < 60 * 24 * 60; n++) {
      d.setMinutes(d.getMinutes() + 1);
      const dom = cronField(f[2], d.getDate(), 1, 31);
      const dow =
        cronField(f[4], d.getDay(), 0, 7) || (d.getDay() === 0 && cronField(f[4], 7, 0, 7));
      const days = f[2] !== '*' && f[4] !== '*' ? dom || dow : dom && dow;
      if (
        days &&
        cronField(f[0], d.getMinutes(), 0, 59) &&
        cronField(f[1], d.getHours(), 0, 23) &&
        cronField(f[3], d.getMonth() + 1, 1, 12)
      )
        return d.getTime();
    }
    return null;
  }
  const TRIGGER_HINT =
    'every 30m [until 2027-03-01], at 09:00, cron "0 9 * * 1-5", ' +
    'idle 30m, fire-only';
  /*
   * A trigger as its kind and numbers; null when it is none of Autocode's.
   * `set` is when the wake was set: every and in count from then.
   */
  function parseTrigger(trigger, set) {
    let text = String(trigger).trim();
    let until = null;
    const end = / until (\S+(?: \d\d:\d\d)?)$/.exec(text);
    if (end) {
      const day = /^\d{4}-\d\d-\d\d$/.test(end[1]);
      until = Date.parse(day ? `${end[1]}T23:59:59` : end[1].replace(' ', 'T'));
      if (!Number.isFinite(until)) return null;
      text = text.slice(0, end.index);
    }
    let m;
    if (text === 'fire-only' || text === 'fire-only once')
      return until ? null : { kind: 'fire' };
    if ((m = /^every (\S+)$/.exec(text)) && duration(m[1]))
      return { kind: 'every', ms: duration(m[1]), until };
    if ((m = /^idle (\S+)( repeat)?$/.exec(text)) && duration(m[1]))
      return { kind: 'idle', ms: duration(m[1]), repeat: !!m[2], until };
    if ((m = /^cron "([^"]+)"$/.exec(text)) && cronNext(m[1], set))
      return { kind: 'cron', expr: m[1], until };
    if (until) return null;
    if ((m = /^in (\S+)$/.exec(text)) && duration(m[1]))
      return { kind: 'once', at: set + duration(m[1]) };
    if ((m = /^at (\d\d):(\d\d)$/.exec(text))) {
      const d = new Date(set);
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (d.getTime() <= set) d.setDate(d.getDate() + 1);
      return { kind: 'once', at: d.getTime() };
    }
    if ((m = /^at (\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)$/.exec(text))) {
      const t = Date.parse(`${m[1]}T${m[2]}:00`);
      return Number.isFinite(t) && t > set ? { kind: 'once', at: t } : null;
    }
    return null;
  }
  // When a wake falls due next: { next } a time, { due } if its session
  // stays idle, or neither.
  function nextOf(w, t = now()) {
    const set = Date.parse(w.updated_at);
    const p = parseTrigger(w.trigger, set);
    if (!p) return {};
    let next = null;
    if (p.kind === 'every') next = set + (Math.floor((t - set) / p.ms) + 1) * p.ms;
    if (p.kind === 'cron') next = cronNext(p.expr, t);
    if (p.kind === 'once') next = p.at > t ? p.at : null;
    if (p.kind === 'idle') {
      const a = agentOf(w.agent);
      if (!a || statusOf(a) !== 'idle') return {};
      let due = Date.parse(a.last_active) + p.ms;
      if (due <= t) {
        if (!p.repeat) return {};
        due += Math.ceil((t - due) / p.ms + 0.0001) * p.ms;
      }
      return p.until && due > p.until ? {} : { due };
    }
    if (next && p.until && next > p.until) next = null;
    return next ? { next } : {};
  }

  // ------------------------------------------------------------ simulation

  // What an answered ask leads to, by its ID: the invented story goes on.
  const follow = {
    // trailmap:release: v0.19.0 to production
    ask_5f0c1e77a2b94d3180ce(item, answer) {
      const a = agentOf(item.agent);
      if (!a) return;
      if (answer.decision !== 'approve') {
        burst(a, 10, 'the approval was rejected');
        later(10, () => {
          inboxOpen('message', a.id, 'v0.19.0 stays on staging',
            'Understood. v0.19.0 stays on staging and I keep the lock `staging`. I ask again tomorrow at 08:30, with a day more of staging numbers.',
            { report: true });
          setWake(a.id, 'ask-again', 'in 23h', 'Ask the owner again about v0.19.0 in production, with the newest staging numbers.', a.id);
        });
        return;
      }
      if (answer.option === 'tonight') {
        burst(a, 8, 'the approval was answered');
        later(8, () => {
          setWake(a.id, 'deploy-tonight', 'at 22:00', 'Deploy v0.19.0 to production (the owner approved it for tonight), run the smoke tests there, release the lock staging, and report.', a.id);
          inboxOpen('message', a.id, 'v0.19.0 goes to production tonight',
            'Scheduled: my wake `deploy-tonight` deploys v0.19.0 at 22:00. I report when it is live, or at once if a smoke test fails.',
            { report: true });
        });
        return;
      }
      burst(a, 22, 'the approval was answered');
      later(22, () => {
        release('staging', a.id);
        send(a.id, 'trailmap:tests', 'v0.19.0 is in production',
          'The owner approved it. v0.19.0 is live; staging is free again.');
        inboxOpen('message', a.id, 'v0.19.0 is in production',
          'v0.19.0 is live. The rollout went in 3 steps (10%, 50%, 100%); smoke tests on production: 42 of 42.\n\n' +
          '- I released the lock `staging`.\n' +
          '- I watch the error rate for the next hour and tell you only if it rises.',
          { report: true });
      });
    },
    // home:trip: the flights of the winter trip
    ask_a47c0d3e9b1f4862a5d7(item, answer) {
      const a = agentOf(item.agent);
      if (!a) return;
      if (answer.decision !== 'approve') {
        burst(a, 10, 'the approval was rejected');
        later(10, () => {
          release('browser', a.id);
          inboxOpen('message', a.id, 'Winter trip: the fare is let go',
            'Understood: nothing is booked. I let the hold go and released the lock `browser`. My wake `fare-watch` keeps looking; I ask again if the direct fare falls below $1,200.',
            { report: true });
        });
        return;
      }
      const stop = answer.option === 'one stop';
      const usd = stop ? '$1,036' : '$1,284';
      burst(a, 20, 'the approval was answered');
      later(20, () => {
        release('browser', a.id);
        send(a.id, 'home:books', 'Winter trip: flights booked',
          `Booked with the owner's approval: 3 seats, ${stop ? 'one stop' : 'direct'}, ${usd} on the travel card. The receipt is in trips/winter/flights.pdf; it belongs to the trip's budget.`);
        inboxOpen('message', a.id, 'Winter trip: flights booked',
          `Booked 3 seats, ${stop ? 'one stop' : 'direct'}, for ${usd}. The confirmation is in trips/winter/flights.pdf and both days are in the calendar.\n\n` +
          `- The trip's budget: ${usd} of $6,000 spent.\n` +
          '- I released the lock `browser`.\n' +
          '- Next: I hold two places to stay for the first three nights and ask you.',
          { report: true });
      });
    },
    // home:house: the slot for the car service
    ask_91d3e5c80f724ab6b1e2(item, answer) {
      const a = agentOf(item.agent);
      const said = Object.values(answer.answer ?? {}).join('; ');
      burst(a, 18, 'the question was answered');
      later(18, () =>
        send(a.id, 'home:chief', 'Car service',
          `The owner answered: ${said}. I told the garage in its portal; the calendar has it once they confirm.`),
      );
    },
    // home:mail: the answer to the dentist's office
    ask_b2a4097d6e1f4c58a3d0(item, answer) {
      const a = agentOf(item.agent);
      if (answer.decision === 'reject') {
        burst(a, 8, 'the permission was rejected');
        later(8, () =>
          send(a.id, 'home:chief', 'Dentist: nothing sent',
            'The owner rejected the send. Nothing went out; the draft stays in drafts/dentist.md.'),
        );
        return;
      }
      burst(a, 14, 'the permission was allowed');
      later(14, () =>
        send(a.id, 'home:chief', 'Dentist: answer sent',
          'The owner allowed it. The answer accepting Friday 08:10 is sent; I move the calendar entry when the office confirms.'),
      );
    },
  };

  const timers = [];
  // So many seconds from now (of the demo's clock).
  function later(seconds, work) {
    timers.push({ at: now() + seconds * 1000, work });
  }

  function setWake(agent, name, trigger, text, by, check = null, limit = null) {
    const old = W.wakes.findIndex((w) => w.agent === agent && w.name === name);
    const wake = {
      agent, name, trigger, text, check, check_timeout: limit, set_by: by,
      updated_at: iso(now()), last_fired_at: null,
      week: { usd: 0, turns: 0, due: 0, skipped: 0 },
    };
    if (old >= 0) W.wakes[old] = wake;
    else {
      // beside the agent's other wakes
      const at = W.wakes.map((w) => w.agent).lastIndexOf(agent);
      W.wakes.splice(at < 0 ? W.wakes.length : at + 1, 0, wake);
    }
    log('wake.set', agentOf(agent), { wake: name, trigger, by });
    return wake;
  }

  // An agent's hold on a lock, or its place in the queue, ends; the next in
  // the queue gets the place. It says which it was.
  function release(name, agent, by = null) {
    const lock = W.locks.find((l) => l.name === name);
    if (!lock) return null;
    const held = lock.holders.findIndex((h) => h.agent === agent);
    if (held < 0) {
      lock.queue = lock.queue.filter((q) => q.agent !== agent);
      lock.queue.forEach((q, i) => (q.position = i + 1));
      log('lock.left', agentOf(agent), { lock: name, by: by ?? agent });
      if (by)
        send('autocode', agent, `lock "${name}": out of the queue`,
          `The owner took you out of the queue of "${name}".`);
    } else {
      lock.holders.splice(held, 1);
      log('lock.released', agentOf(agent), { lock: name, by: by ?? agent });
      if (by)
        send('autocode', agent, `lock "${name}" released by the owner`,
          `The owner released your hold on "${name}": stop using what it guarded, or acquire it again.`);
      const next = lock.queue.shift();
      if (next) {
        lock.queue.forEach((q, i) => (q.position = i + 1));
        const until = now() + 2 * 3600000;
        lock.holders.push({ agent: next.agent, expires: iso(until) });
        log('lock.acquired', agentOf(next.agent), { lock: name, ttl: '2h' });
        send('autocode', next.agent, `lock "${name}" granted`,
          `You hold "${name}" until ${localTime(iso(until)).split(' ')[1].slice(0, 5)}. Renew it before then, or release it when you are done.`);
      }
    }
    if (!lock.holders.length && !lock.queue.length)
      W.locks.splice(W.locks.indexOf(lock), 1);
    return held < 0 ? 'queued' : 'held';
  }

  // A turn's spend and context grow while it runs; a cap may pause its agent.
  function spend(a, seconds) {
    const big = a.model.includes('opus') ? 3 : a.model.includes('haiku') ? 0.4 : 1;
    const usd = Math.round(seconds * 0.9 * big * (0.6 + Math.random() * 0.8)) / 100;
    a.cost.today_usd = Math.round((a.cost.today_usd + usd) * 100) / 100;
    a.cost.total_usd = Math.round((a.cost.total_usd + usd) * 100) / 100;
    a.week[a.week.length - 1].usd = a.cost.today_usd;
    a.cost.context += Math.round(seconds * (220 + Math.random() * 260));
    a.steps = (a.steps ?? 0) + 1;
    const cap = capOf(a.id);
    if (cap !== null && a.cost.today_usd > cap && !a.paused && !a.cap_override) {
      a.paused = 'cap';
      log('cap.reached', a, { spent: a.cost.today_usd, cap });
      log('agent.paused', a, { by: 'cap' });
      inboxOpen('alert', a.id,
        `${a.id} reached its daily cap (${costText(a.cost.today_usd)} of ${costText(cap)})`,
        "It is paused until tomorrow (the server's zone), or until you raise daily_usd or resume it.");
    }
  }

  // The messages that wait for an agent reach it once it can take them.
  function deliver() {
    const byAgent = new Map();
    for (const m of W.messages)
      if (m.state === 'queued' && m.to !== 'owner')
        byAgent.set(m.to, [...(byAgent.get(m.to) ?? []), m]);
    for (const [id, list] of byAgent) {
      const a = agentOf(id);
      if (!a) {
        for (const m of list) m.state = 'dropped';
        continue;
      }
      const status = statusOf(a);
      if (status !== 'idle' && status !== 'working') continue;
      const via = status === 'working' ? 'steer' : 'prompt';
      for (const m of list) {
        m.state = 'processed';
        m.processed_via = via;
        m.processed_at = iso(now());
      }
      if (via === 'prompt') {
        log('injection.sent', a, { wakes: [], messages: list.length });
        burst(a, 14 + list.length * 4, `${count(list.length, 'message')}`);
      }
    }
  }

  // One second of the world.
  let second = 0;
  function tick() {
    const t = now();
    second += 1;
    for (let i = timers.length - 1; i >= 0; i--)
      if (timers[i].at <= t) timers.splice(i, 1)[0].work();

    for (const a of W.agents) {
      // a failed turn is retried: the third retry goes through
      if (a.error && !a.paused && Date.parse(a.error.next_retry) <= t) {
        a.error.retries += 1;
        log('retry.sent', a, { retry: a.error.retries, error: a.error.type });
        if (a.error.retries >= 3) {
          a.error = null;
          log('agent.recovered', a, { after: '3 retries' });
          burst(a, 26, 'retry 3');
        } else a.error.next_retry = iso(t + 60000);
      }
      // a cap's pause ends with a higher cap
      if (a.paused === 'cap') {
        const cap = capOf(a.id);
        if (cap === null || a.cost.today_usd <= cap) {
          a.paused = null;
          log('cap.lifted', a, { cap: cap ?? 'off' });
          log('agent.resumed', a, { by: 'cap' });
        }
      }
      const status = statusOf(a);
      if (a.seen && a.seen !== status) {
        if (status === 'working')
          log('turn.started', a, { by: a.why ?? (a.cycle ? 'its work goes on' : 'prompt') });
        if (a.seen === 'working') {
          const interrupted = status === 'paused' && a.paused === 'stop-all';
          log('turn.ended', a, {
            outcome: interrupted ? 'interrupted' : 'succeeded', steps: a.steps ?? 1,
          });
          a.steps = 0;
          a.why = null;
          if (interrupted) a.busy_until = 0;
          // a long session is compacted between turns
          if (!interrupted && a.cost.compact_at && a.cost.context > a.cost.compact_at) {
            log('session.compact.noticed', a, { context: a.cost.context, compact_at: a.cost.compact_at });
            const before = a.cost.context;
            a.cost.context = Math.round(a.cost.compact_at * (0.11 + Math.random() * 0.04));
            log('session.compacted', a, { before, after: a.cost.context, compact_at: a.cost.compact_at });
          }
        }
      }
      a.seen = status;
      if (status === 'working') {
        a.last_active = iso(t);
        if (second % 5 === 0) spend(a, 5);
      }
    }
    for (const h of W.hosts) if (h.online) h.last_seen = iso(t);

    // the wakes that fall due while the page is open
    for (const w of [...W.wakes]) {
      if (w.soon === undefined) w.soon = nextOf(w, t).next ?? null;
      if (!w.soon || w.soon > t) continue;
      const a = agentOf(w.agent);
      const status = a ? statusOf(a) : 'offline';
      const once = parseTrigger(w.trigger, Date.parse(w.updated_at))?.kind === 'once';
      w.soon = once ? null : (nextOf(w, t + 1000).next ?? null);
      if (!a || !['idle', 'working'].includes(status)) continue;
      w.week.due += 1;
      // a check passes only where the world says what it prints
      if (w.check && !w.passes) {
        w.week.skipped += 1;
        log('wake.skipped', a, { wake: w.name, check: 'exit 1' });
        continue;
      }
      if (w.check) log('wake.due', a, { wake: w.name, check: 'exit 0', output: w.passes });
      w.last_fired_at = iso(t);
      w.week.turns += 1;
      log('wake.fired', a, { wake: w.name, by: 'schedule' });
      burst(a, 30, `wake ${w.name}`);
      if (once) W.wakes.splice(W.wakes.indexOf(w), 1);
    }
    deliver();
  }

  window.AC = {
    BASE, now, iso, W, ui, tick, later,
    esc, localTime, timeHtml, dayText, costText, versionText, count,
    tokensShort, leftText, waitText, folded, FOLD_CHARS, valueText, idHtml,
    agentIdHtml, breaksHtml, agentLink, hostLink, who, modelHtml, markdown,
    agentOf, hostOf, isAsk, kindOf, openAsks, waiting, matches, ruleMatches,
    resolve,
    capOf, statusOf, dotClass, log, send, inboxOpen, burst, hex,
    parseTrigger, nextOf, TRIGGER_HINT, setWake, release, follow, deliver,
  };
})();
