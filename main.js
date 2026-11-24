/*
 * The demo's shell: the tabs and their addresses (#/agents?agent=...), what
 * each button does to the invented world, and the timer that keeps the page
 * current. Every action changes this page's memory only.
 */
(() => {
  'use strict';
  const AC = window.AC;
  const {
    W, ui, now, iso, esc, count, costText, valueText, agentOf, hostOf, isAsk,
    kindOf, statusOf, log, send, burst, parseTrigger, TRIGGER_HINT,
  } = AC;
  const { natural, sortState } = AC.sort;

  const TABS = [
    'hosts', 'agents', 'inbox', 'messages', 'locks', 'wakes', 'jobs', 'costs',
    'history', 'settings', 'help',
  ];
  const TITLE = (t) => t[0].toUpperCase() + t.slice(1);
  const $ = (id) => document.getElementById(id);

  // A result (or a failure) beside a page's buttons.
  const note = (where, text, bad = false) => {
    ui.notice[where] = { text, bad };
  };
  // A value kept under a path of the page's state ("forms.wake.name").
  function setAt(model, value) {
    const path = model.split('.');
    let at = ui;
    for (const part of path.slice(0, -1)) at = at[part] ??= {};
    at[path.at(-1)] = value;
  }
  // What was typed for a setting, as its kind of value.
  function coerce(def, typed) {
    const s = String(typed).trim();
    if (def.kind === 'int' && /^\d+$/.test(s)) return Number(s);
    if (def.kind === 'usd') {
      const n = Number(s.replace(/^\$/, ''));
      return s !== '' && Number.isFinite(n) && n > 0 ? n : 'off';
    }
    return s;
  }
  const item = (id) => W.inbox.find((i) => i.id === id);
  const typed = (i, name) => String(AC.valueAt(AC.field(i, name)) ?? '').trim();
  // The message a closed Inbox item came as counts as read there.
  function readInInbox(id) {
    const m = W.messages.find((x) => x.id === id);
    if (m && m.state === 'queued') {
      m.state = 'processed';
      m.processed_via = 'inbox';
      m.processed_at = iso(now());
    }
  }
  // An ask gets its answer; its agent goes on.
  function settle(i, answer) {
    i.closed_at = iso(now());
    i.state = 'answered';
    i.by = 'owner';
    i.answer = answer;
    log('ask.answered', i.agent, { kind: i.kind, id: i.id, by: 'owner' });
    note('inbox', `Answered ${i.kind} from ${i.agent}.`);
    if (AC.follow[i.id]) AC.follow[i.id](i, answer);
    else burst(agentOf(i.agent), 16, `the ${i.kind} was answered`);
  }
  function closeItem(i) {
    i.closed_at = iso(now());
    i.state = 'closed';
    log('inbox.closed', i.agent, { id: i.id });
    readInInbox(i.id);
  }
  const itemText = (i) =>
    !i.agent
      ? `the ${kindOf(i)}`
      : `the ${kindOf(i)} ${i.kind === 'message' ? 'from' : 'about'} ${i.agent}`;
  const RESULTS = {
    'backup-check': 'All 3 backups verify. Nothing changed since the run at 04:00.',
    'nightly-audit': 'Nothing blocking in the commits since the last run. No secrets, no new licences.',
    'statement-check': '2 charges match nothing in the ledger: a $4.99 app purchase on the 12th, and $61.20 at a hardware store on the 19th. Everything else has a bill, a subscription or a receipt.',
    'weekly-costs': 'So far this week: every agent is under its cap but home:photos, which reached it this morning.',
    'notes-digest': 'No new notes since the last digest.',
  };

  const act = {
    refresh() {
      ui.updatedAt = Date.now();
    },
    sort({ table, key }) {
      const s = sortState(table);
      ui.sort[table] =
        s.key === key
          ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: natural(table, key) };
    },
    more({ key }) {
      ui.more[key] = (ui.more[key] ?? 25) + 25;
    },
    fold({ key }) {
      if (!ui.folds.delete(key)) ui.folds.add(key);
    },
    open({ key }) {
      if (!ui.opened.delete(key)) ui.opened.add(key);
    },
    theme() {
      ui.dark = !ui.dark;
    },
    'sign-out'() {
      ui.signedIn = false;
    },
    'sign-in'() {
      ui.signedIn = true;
    },
    'demo-hide'() {
      document.body.classList.add('bare');
    },
    'clear-filter'({ key }) {
      ui.filter[key] = '';
    },

    // ----- agents
    'stop-all'() {
      const ok = confirm(
        'Stop all agents?\n\nEvery agent is paused (nothing is typed into its ' +
          'session) and every running turn is interrupted. Resume All resumes them.',
      );
      if (!ok) return;
      let paused = 0;
      let interrupted = 0;
      for (const a of W.agents) {
        if (statusOf(a) === 'working') interrupted += 1;
        if (a.paused) continue;
        a.paused = 'stop-all';
        paused += 1;
        log('agent.paused', a, { by: 'stop-all' });
      }
      note('agents', `Stop All paused ${count(paused, 'agent')} and interrupted ${count(interrupted, 'session')}.`);
    },
    'resume-all'() {
      let resumed = 0;
      for (const a of W.agents)
        if (a.paused === 'stop-all') {
          a.paused = null;
          resumed += 1;
          log('agent.resumed', a, { by: 'resume-all' });
        }
      note('agents', resumed ? `Resumed ${count(resumed, 'agent')}.` : 'No agent was paused by Stop All.');
    },
    pause({ id }) {
      const a = agentOf(id);
      a.paused = 'owner';
      log('agent.paused', a, { by: 'owner' });
      note('agents', `Paused ${id}.`);
    },
    resume({ id }) {
      const a = agentOf(id);
      if (a.paused === 'cap') a.cap_override = true;
      a.paused = null;
      log('agent.resumed', a, { by: 'owner' });
      note('agents', `Resumed ${id}.`);
    },
    retry({ id }) {
      const a = agentOf(id);
      log('retry.requested', a, { by: 'owner', error: a.error?.type });
      a.error = null;
      log('agent.recovered', a, { after: 'a retry of the owner' });
      burst(a, 26, 'retry');
      note('agents', `Retrying ${id}.`);
    },
    rotate({ id }) {
      const ok = confirm(
        `Give ${id} a new token?\n\nThe plugin hands the new token to the ` +
          "agent's session; the old token stops working at once.",
      );
      if (!ok) return;
      log('token.rotated', agentOf(id), { by: 'owner' });
      note('agents', `${id} has a new token.`);
    },
    unregister({ id }) {
      if (!confirm(`Unregister ${id}?\n\nIts session keeps running, without the agent ID.`))
        return;
      const a = agentOf(id);
      log('agent.unregistered', a, { by: 'owner' });
      W.agents.splice(W.agents.indexOf(a), 1);
      W.gone.push({ ...a, registered: false, paused: null, error: null, cycle: null, busy_until: 0 });
      W.wakes = W.wakes.filter((w) => w.agent !== id);
      for (const l of [...W.locks])
        if (l.holders.some((h) => h.agent === id) || l.queue.some((q) => q.agent === id))
          AC.release(l.name, id);
      for (const i of W.inbox)
        if (i.agent === id && isAsk(i) && !i.closed_at) {
          i.closed_at = iso(now());
          i.state = 'gone';
          i.by = 'autocode';
          i.answer = { text: 'its agent unregistered' };
        }
      if (ui.editing === id) ui.editing = null;
      note('agents', `Unregistered ${id}.`);
    },
    'edit-desc'({ id }) {
      ui.editing = id;
      ui.draft = agentOf(id).description;
      ui.focus = 'agent-desc';
    },
    'save-desc'() {
      const a = agentOf(ui.editing);
      if (!a) return;
      a.description = String(ui.draft ?? '').trim();
      ui.editing = null;
      note('agents', `Saved the description of ${a.id}.`);
    },
    'cancel-desc'() {
      ui.editing = null;
    },

    // ----- inbox
    'answer-option'({ id, option }) {
      settle(item(id), { answer: { 0: option } });
    },
    'answer-question'({ id }) {
      const i = item(id);
      const answer = {};
      i.questions.forEach((_, n) => {
        if (typed(i, `free${n}`)) answer[n] = typed(i, `free${n}`);
      });
      if (Object.keys(answer).length) settle(i, { answer });
    },
    allow({ id, how }) {
      settle(item(id), { decision: how });
    },
    'reject-permission'({ id }) {
      const i = item(id);
      settle(i, { decision: 'reject', ...(typed(i, 'reason') ? { text: typed(i, 'reason') } : {}) });
    },
    decide({ id, how }) {
      const i = item(id);
      const answer = { decision: how };
      if (how === 'approve' && typed(i, 'option')) answer.option = typed(i, 'option');
      if (typed(i, 'note')) answer.text = typed(i, 'note');
      settle(i, answer);
    },
    answer({ id }) {
      const i = item(id);
      const text = typed(i, 'draft');
      if (!text) return;
      i.answer = text;
      i.closed_at = iso(now());
      i.state = 'closed';
      log('inbox.answered', i.agent, { id: i.id });
      readInInbox(i.id);
      send('owner', i.agent, `Re: ${i.title}`, text);
      note('inbox', `Sent the answer to ${i.agent}.`);
    },
    close({ id }) {
      const i = item(id);
      closeItem(i);
      note('inbox', `Closed ${itemText(i)}.`);
    },
    'close-all'() {
      const items = AC.inboxRows().filter((i) => !i.closed_at && !isAsk(i));
      if (!items.length) return;
      const n = (kind) => items.filter((i) => kindOf(i) === kind).length;
      const parts = [
        n('message') && count(n('message'), 'message'),
        n('report') && count(n('report'), 'report'),
        n('alert') && count(n('alert'), 'alert'),
      ].filter(Boolean);
      const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
      const of = ui.filter.inbox ? ` of ${ui.filter.inbox}` : '';
      if (!confirm(`Close ${what}${of}?\n\nQuestions, permissions and approvals stay open.`))
        return;
      items.forEach(closeItem);
      note('inbox', `Closed ${items.length} item${items.length === 1 ? '' : 's'}.`);
    },

    // ----- messages
    send() {
      const f = ui.forms.send;
      const to = String(f.to ?? '').trim();
      const text = String(f.text ?? '');
      if (!to || !text.trim()) return;
      const ids = W.agents.map((a) => a.id).filter((id) => AC.ruleMatches(to, id));
      if (!ids.length) {
        note('send', /[*,]/.test(to) ? `No agent matches ${to}.` : `There is no agent ${to}.`, true);
        return;
      }
      for (const id of ids) send('owner', id, String(f.subject ?? '').trim(), text);
      note('send', `Sent to ${ids.join(', ')}.`);
      f.subject = '';
      f.text = '';
    },

    // ----- locks
    release({ lock, id }) {
      const ok = confirm(
        `Release ${id}'s hold on ${lock}?\n\nThe agent is told and the next in the queue gets it.`,
      );
      if (!ok) return;
      AC.release(lock, id, 'owner');
      note('locks', `Released ${id}'s hold on ${lock}.`);
    },
    unqueue({ lock, id }) {
      const ok = confirm(
        `Take ${id} out of the queue of ${lock}?\n\nThe agent is told; the others move up.`,
      );
      if (!ok) return;
      AC.release(lock, id, 'owner');
      note('locks', `Took ${id} out of the queue of ${lock}.`);
    },

    // ----- wakes
    fire({ agent, name }) {
      const w = W.wakes.find((x) => x.agent === agent && x.name === name);
      const a = agentOf(agent);
      w.last_fired_at = iso(now());
      w.week.turns += 1;
      log('wake.fired', a, { wake: name, by: 'owner' });
      if (a && statusOf(a) === 'idle') burst(a, 18, `wake ${name}`);
      if (w.trigger === 'fire-only once') W.wakes.splice(W.wakes.indexOf(w), 1);
      note('wakes', `Fired ${agent}'s wake ${name}.`);
    },
    'cancel-wake'({ agent, name }) {
      if (!confirm(`Cancel ${agent}'s wake ${name}?\n\nIt is deleted and does not fire again.`))
        return;
      W.wakes = W.wakes.filter((w) => !(w.agent === agent && w.name === name));
      log('wake.cancelled', agentOf(agent), { wake: name, by: 'owner' });
      note('wakes', `Cancelled ${agent}'s wake ${name}.`);
    },
    'set-wake'() {
      const f = ui.forms.wake;
      const v = (k) => String(f[k] ?? '').trim();
      if (!['agent', 'name', 'trigger', 'text'].every(v)) return;
      if (!agentOf(v('agent'))) return note('setWake', `There is no agent ${v('agent')}.`, true);
      if (!/^[A-Za-z0-9._:-]+$/.test(v('name')))
        return note('setWake', 'A name is letters, digits, -, _, . and :.', true);
      if (!parseTrigger(v('trigger'), now()))
        return note('setWake', `Not a trigger: ${v('trigger')}. A trigger looks like: ${TRIGGER_HINT}.`, true);
      AC.setWake(v('agent'), v('name'), v('trigger'), String(f.text), 'owner', v('check') || null, v('limit') || null);
      note('setWake', `Set ${v('agent')}'s wake ${v('name')}.`);
      for (const k of ['name', 'trigger', 'text', 'check', 'limit']) f[k] = '';
    },

    // ----- jobs
    'run-now'({ id }) {
      const job = W.jobs.find((j) => j.name === id);
      if (!hostOf(job.host)?.online)
        return note('jobs', `The host of ${id} is offline: its run would wait.`, true);
      const text = String(AC.valueAt(`fields.run_${id.replace(/\W/g, '_')}`) ?? '').trim();
      const run = {
        id: `${id}:${iso(now()).slice(0, 16)}`, job: id, by: 'owner', state: 'running',
        started: iso(now()), ended: null, cost: 0, result: null, reason: null,
        session_kept: false, text: text || null,
      };
      if (W.runs.some((r) => r.job === id && r.state === 'running'))
        return note('jobs', `${id} runs already.`, true);
      W.runs = W.runs.filter((r) => r.id !== run.id);
      W.runs.unshift(run);
      log('run.started', null, { job: id, by: 'owner', ...(text ? { text } : {}) });
      note('jobs', `Started run ${run.id}.`);
      setAt(`fields.run_${id.replace(/\W/g, '_')}`, '');
      AC.later(9, () => {
        run.state = 'succeeded';
        run.ended = iso(now());
        run.cost = Math.round((0.3 + Math.random() * 0.7) * 100) / 100;
        run.result =
          RESULTS[id] ??
          (id.endsWith('pr-review')
            ? `Approve. ${text || 'The pull request'}: no correctness problems; the tests cover the change. Two naming nits are in the review notes.`
            : 'Done.');
        log('run.finished', null, { run: run.id, state: 'succeeded', usd: run.cost });
        if (agentOf(job.to)) send('autocode', job.to, `result of run ${run.id}`, run.result);
      });
    },
    'edit-job'({ id }) {
      const j = W.jobs.find((x) => x.name === id);
      ui.forms.job = {
        name: j.name, description: j.description ?? '', host: j.host, model: j.model,
        variant: j.variant ?? '', agent: j.agent ?? '', prompt: j.prompt,
        trigger: j.trigger, to: j.to, timeout: j.timeout,
        run_usd: j.run_usd === 'off' ? 'off' : String(j.run_usd),
        delete_session: j.delete_session,
      };
      ui.panels.job = true;
      delete ui.notice.setJob;
      ui.focus = 'job-name';
    },
    'delete-job'({ id }) {
      if (!confirm(`Delete job ${id}?\n\nIts runs' history stays.`)) return;
      W.jobs = W.jobs.filter((j) => j.name !== id);
      log('job.deleted', null, { job: id, by: 'owner' });
      note('jobs', `Deleted job ${id}.`);
    },
    'set-job'() {
      const f = ui.forms.job;
      const v = (k) => String(f[k] ?? '').trim();
      if (!['name', 'host', 'model', 'prompt', 'trigger'].every(v)) return;
      if (!parseTrigger(v('trigger'), now()))
        return note('setJob', `Not a trigger: ${v('trigger')}. A trigger looks like: ${TRIGGER_HINT}.`, true);
      const cap = v('run_usd').replace(/^\$/, '');
      const usd = !cap || cap.toLowerCase() === 'off' ? 'off' : Number(cap);
      if (usd !== 'off' && !(usd > 0))
        return note('setJob', 'run_usd is dollars above 0, or off', true);
      const h = hostOf(v('host'));
      const job = {
        name: v('name'), description: v('description'), host: h.id, machine: h.machine,
        directory: h.directory, model: v('model'), model_name: null,
        variant: v('variant') || null, agent: v('agent') || null, prompt: String(f.prompt),
        trigger: v('trigger'), to: v('to') || 'owner', timeout: v('timeout') || '1h',
        run_usd: usd, created_by: null, delete_session: !!f.delete_session,
      };
      const old = W.jobs.findIndex((j) => j.name === job.name);
      if (old >= 0) W.jobs[old] = { ...W.jobs[old], ...job, created_by: W.jobs[old].created_by };
      else W.jobs.push(job);
      log('job.set', null, { job: job.name, trigger: job.trigger, by: 'owner' });
      note('setJob', `Set job ${job.name}.`);
      ui.forms.job = { delete_session: true };
    },
    'delete-session'({ id }) {
      if (!confirm(`Delete the session of run ${id}?`)) return;
      W.runs.find((r) => r.id === id).session_kept = false;
      log('run.session_deleted', null, { run: id, by: 'owner' });
      note('jobs', `Deleted the session of run ${id}.`);
    },

    // ----- costs
    days({ id }) {
      ui.days = ui.days === id ? null : id;
    },

    // ----- settings
    'save-setting'({ id }) {
      const def = W.settings.defs[id];
      const value = coerce(def, ui.fields.set[id]);
      W.settings.server[id] = value;
      ui.fields.set[id] = valueText(value);
      log('settings.changed', null, { key: id, value, scope: 'server' });
      note('server', `Saved ${id}.`);
    },
    'reset-setting'({ id }) {
      delete W.settings.server[id];
      ui.fields.set[id] = valueText(W.settings.defs[id].default);
      log('settings.changed', null, { key: id, value: 'default', scope: 'server' });
      note('server', `${id} is back to its built-in default.`);
    },
    'add-rule'() {
      ui.rule = { index: null, match: '', items: [] };
      ui.focus = 'rule-match';
    },
    'edit-rule'({ n }) {
      const r = W.settings.rules[Number(n)];
      ui.rule = {
        index: Number(n), match: r.match,
        items: Object.entries(r.values).map(([key, value]) => ({ key, value: valueText(value) })),
      };
    },
    'rule-add-item'() {
      const defs = W.settings.defs;
      const key = Object.keys(defs).find(
        (k) => defs[k].scope === 'agent' && !ui.rule.items.some((x) => x.key === k),
      );
      if (key) ui.rule.items.push({ key, value: valueText(defs[key].default) });
    },
    'rule-remove-item'({ n }) {
      ui.rule.items.splice(Number(n), 1);
    },
    'save-rule'() {
      const d = ui.rule;
      const match = String(d.match ?? '').trim();
      if (!match) return note('rules', 'A rule needs a pattern to match.', true);
      const values = Object.fromEntries(
        d.items.map((x) => [x.key, coerce(W.settings.defs[x.key], x.value)]),
      );
      if (d.index === null) W.settings.rules.push({ match, values });
      else W.settings.rules[d.index] = { match, values };
      log('settings.changed', null, { rule: match, values });
      note('rules', d.index === null ? `Added rule ${W.settings.rules.length}.` : `Saved rule ${d.index + 1}.`);
      ui.rule = null;
    },
    'cancel-rule'() {
      ui.rule = null;
    },
    'move-rule'({ n, by }) {
      const rules = W.settings.rules;
      const from = Number(n);
      const to = from + Number(by);
      if (to < 0 || to >= rules.length) return;
      [rules[from], rules[to]] = [rules[to], rules[from]];
      note('rules', `Moved rule ${from + 1} ${Number(by) < 0 ? 'up' : 'down'}.`);
    },
    'remove-rule'({ n }) {
      const rule = W.settings.rules[Number(n)];
      if (!rule || !confirm(`Remove rule ${Number(n) + 1} (${rule.match})?`)) return;
      W.settings.rules.splice(Number(n), 1);
      note('rules', `Removed rule ${Number(n) + 1}.`);
    },
    'change-own'({ n }) {
      ui.own = { n: Number(n), value: valueText(W.settings.agents[Number(n)].value) };
      ui.focus = 'own-value';
    },
    'save-own'() {
      const row = W.settings.agents[ui.own.n];
      row.value = coerce(W.settings.defs[row.key], ui.own.value);
      log('settings.changed', row.agent, { key: row.key, value: row.value, scope: 'agent' });
      note('own', `Set ${row.key} for ${row.agent}.`);
      ui.own = null;
    },
    'cancel-own'() {
      ui.own = null;
    },
    'remove-own'({ n }) {
      const [row] = W.settings.agents.splice(Number(n), 1);
      ui.own = null;
      note('own', `Removed ${row.key} from ${row.agent}.`);
    },
    'add-own'() {
      const o = ui.newOwn;
      const agent = String(o.agent ?? '').trim();
      const def = W.settings.defs[o.key];
      const typedValue = String(o.value ?? '').trim() || valueText(def.default);
      if (!agent) return note('own', 'Type an agent ID and pick a setting.', true);
      const value = coerce(def, typedValue);
      const old = W.settings.agents.find((r) => r.agent === agent && r.key === o.key);
      if (old) old.value = value;
      else W.settings.agents.push({ agent, key: o.key, value });
      log('settings.changed', agentOf(agent), { key: o.key, value, scope: 'agent' });
      note('own', `Set ${o.key} for ${agent}.`);
      ui.newOwn = { agent: '', key: o.key, value: '' };
    },
    resolve() {
      ui.resolved = String(ui.filter.resolve ?? '').trim() || null;
    },
  };

  // ---------------------------------------------------------- the shell

  function route() {
    const [where, search = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [path, part = ''] = where.split('/');
    return {
      path: TABS.includes(path) ? path : 'agents',
      part,
      query: Object.fromEntries(new URLSearchParams(search)),
    };
  }

  let shown = null;
  // The page, from the state: again after every action and every 5 s.
  function render(why) {
    document.documentElement.classList.toggle('dark', ui.dark);
    const root = $('demo-app');
    $('demo-who').hidden = !ui.signedIn;
    if (!ui.signedIn) {
      shown = null;
      root.innerHTML =
        '<app-sign-in><section id="frame" class="sign-in"><h2>Sign In</h2>' +
        '<form data-form="sign-in"><div class="row">' +
        '<input id="token" aria-label="Token" type="password" autocomplete="off" spellcheck="false" placeholder="admin token">' +
        '<button type="submit">Sign In</button></div>' +
        '<label class="check"><input type="checkbox" checked> Stay signed in</label></form>' +
        '<p class="muted">In this demo, any token signs in.</p></section></app-sign-in>';
      return;
    }
    const page = ui.route.path;
    const open = AC.waiting();
    const tabs = TABS.map((t) => {
      const cls = [t === page ? 'on' : '', t === 'inbox' && open > 0 ? 'has-items' : '']
        .filter(Boolean)
        .join(' ');
      const title =
        t === 'inbox' && open > 0
          ? ` title="${open === 1 ? '1 item waits for you' : `${open} items wait for you`}"`
          : '';
      return `<a href="#/${t}"${cls ? ` class="${cls}"` : ''}${title}>${TITLE(t)}</a>`;
    }).join('');
    // Help's text does not change: it is drawn once, so that its place and
    // a selection in it stay.
    if (page === 'help' && shown === 'help' && why === 'tick') {
      $('demo-nav').innerHTML = tabs;
      return;
    }
    const active = document.activeElement;
    const focus =
      ui.focus ??
      (active && active.id && root.contains(active) ? active.id : null);
    let caret = null;
    try {
      if (!ui.focus && focus) caret = [active.selectionStart, active.selectionEnd];
    } catch {
      // a field without a caret (a number)
    }
    ui.focus = null;
    if (!$('frame') || shown === null)
      root.innerHTML = '<nav id="demo-nav"></nav><main id="frame"></main>';
    $('demo-nav').innerHTML = tabs;
    $('frame').innerHTML =
      `<router-outlet></router-outlet><app-${page}-page>${AC.pages[page]()}</app-${page}-page>`;
    shown = page;
    if (focus) {
      const el = $(focus);
      // a list is left as it is: one that keeps the focus looks open
      if (el && el.tagName !== 'SELECT') {
        el.focus({ preventScroll: true });
        try {
          if (caret && caret[0] !== null) el.setSelectionRange(caret[0], caret[1]);
          else if (!caret && el.select) el.select();
        } catch {
          // no caret to put back
        }
      }
    }
    updated();
    if (ui.scroll) {
      const target =
        page === 'help' && ui.route.part
          ? $(ui.route.part)
          : document.querySelector('#frame tr.highlight');
      if (target) target.scrollIntoView({ block: page === 'help' ? 'start' : 'center' });
      else if (ui.scroll === 'top') window.scrollTo(0, 0);
      ui.scroll = null;
    }
  }
  // "Updated Ns ago.", counting up between loads.
  function updated() {
    const s = Math.max(0, Math.floor((Date.now() - ui.updatedAt) / 1000));
    for (const el of document.querySelectorAll('[data-updated]')) el.textContent = s;
  }
  function run(name, data, el) {
    if (!act[name]) return;
    act[name](data ?? {}, el);
    render('action');
  }

  // ---------------------------------------------------------------- events

  let pressed = false;
  document.addEventListener('pointerdown', () => (pressed = true), true);
  document.addEventListener('pointerup', () => (pressed = false), true);
  document.addEventListener('pointercancel', () => (pressed = false), true);
  // a button let go outside the window
  document.addEventListener('pointermove', (e) => e.buttons === 0 && (pressed = false), true);
  window.addEventListener('blur', () => (pressed = false));

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('a')) return;
    const el = target.closest('[data-act]');
    if (!el) return;
    // a field inside a clickable cell is typed into, not clicked
    if (el.tagName !== 'BUTTON' && target.closest('input, textarea, select, button, label'))
      return;
    if (el.dataset.act === 'open' && String(window.getSelection())) return;
    run(el.dataset.act, el.dataset, el);
  });
  document.addEventListener('keydown', (event) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    if (event.key === 'Enter' && el.dataset.enter) {
      event.preventDefault();
      run(el.dataset.enter, el.dataset, el);
    } else if (event.key === 'Escape' && el.id === 'agent-desc') run('cancel-desc');
    else if (
      (event.key === 'Enter' || event.key === ' ') &&
      el.getAttribute('role') === 'button' &&
      el.dataset.act
    ) {
      event.preventDefault();
      run(el.dataset.act, el.dataset, el);
    } else if (
      (event.key === 'Enter' || event.key === ' ') &&
      el.getAttribute('role') === 'button' &&
      el.parentElement?.dataset.act
    ) {
      event.preventDefault();
      run(el.parentElement.dataset.act, el.parentElement.dataset, el.parentElement);
    } else if (event.key === 'Enter' && el.matches('td.desc.editable')) run('edit-desc', el.dataset);
  });
  // What is typed is kept in the page's state, so the page can be drawn
  // again at any time without losing it.
  document.addEventListener('input', (event) => {
    const el = event.target;
    const model = el.dataset?.model;
    if (!model || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio')
      return;
    setAt(model, el.value);
    render('input');
  });
  document.addEventListener('change', (event) => {
    const el = event.target;
    const model = el.dataset?.model;
    if (!model) return;
    if (el.type === 'checkbox') setAt(model, el.checked);
    else if (el.type === 'radio' || el.tagName === 'SELECT') setAt(model, el.value);
    else return;
    // another setting: its own default as the value to start from
    const ruleKey = /^rule\.items\.(\d+)\.key$/.exec(model);
    if (ruleKey)
      ui.rule.items[Number(ruleKey[1])].value = valueText(W.settings.defs[el.value].default);
    if (model === 'newOwn.key') ui.newOwn.value = '';
    render('input');
  });
  // A form's panel stays open or folded as the owner left it.
  document.addEventListener(
    'toggle',
    (event) => {
      const el = event.target;
      if (el.dataset?.panel) ui.panels[el.dataset.panel] = el.open;
    },
    true,
  );
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.dataset.form === 'sign-in') run('sign-in');
  });
  window.addEventListener('hashchange', () => {
    const before = ui.route.path;
    ui.route = route();
    ui.scroll = ui.route.path !== before ? 'top' : 'same';
    ui.updatedAt = Date.now();
    render('route');
  });

  // ----------------------------------------------------------------- start

  if (/[?&#]bare\b/.test(location.search + location.hash)) document.body.classList.add('bare');
  if (/[?&]theme=light\b/.test(location.search)) ui.dark = false;
  $('demo-version').textContent = AC.versionText(W.server.version);
  ui.route = route();
  ui.scroll = 'same';
  render('route');

  let seconds = 0;
  let due = false;
  setInterval(() => {
    AC.tick();
    seconds += 1;
    if (seconds % 5 === 0) due = true;
    // not under a pressed button, an open list or a selection: a page drawn
    // again there would lose the click
    const busy =
      pressed ||
      document.activeElement?.tagName === 'SELECT' ||
      (String(window.getSelection()) && $('frame')?.contains(window.getSelection().anchorNode));
    if (due && !busy && ui.signedIn) {
      due = false;
      ui.updatedAt = Date.now();
      render('tick');
    }
    updated();
  }, 1000);

  AC.render = render;
  AC.run = run;
})();
