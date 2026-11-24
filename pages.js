/*
 * The demo's pages: each tab of the web UI as HTML, in the structure and
 * with the class names of the UI's own templates, so that its stylesheet
 * applies as it is. Buttons carry data-act (an action of main.js), fields
 * data-model (where what is typed is kept).
 */
(() => {
  'use strict';
  const AC = window.AC;
  const {
    W, ui, now, esc, localTime, timeHtml, dayText, costText, versionText,
    tokensShort, leftText, waitText, folded, FOLD_CHARS, valueText, idHtml,
    agentIdHtml, breaksHtml, agentLink, hostLink, who, modelHtml, markdown,
    agentOf, hostOf, isAsk, kindOf, matches, resolve, capOf, statusOf,
    dotClass, nextOf, TRIGGER_HINT,
  } = AC;

  const PAGE_ROWS = 25;
  const dash = '<span class="muted">—</span>';
  const attr = (o) =>
    Object.entries(o)
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
      .join('');

  // ------------------------------------------------------------- sorting

  // Each table's columns: how a row's value is read, and the default one.
  const text = (get, first) => ({ type: 'text', get, first });
  const time = (get, first) => ({ type: 'time', get, first });
  const number = (get) => ({ type: 'number', get });
  const nextTime = (w) => {
    const n = nextOf(w);
    return n.next ?? n.due ?? null;
  };
  const SORT = {
    agents: {
      by: 'active',
      columns: {
        id: text((a) => a.id), desc: text((a) => a.description),
        status: text((a) => statusOf(a)), model: text((a) => a.model),
        effort: text((a) => a.effort), spend: number((a) => a.cost.today_usd),
        context: number((a) => a.cost.context), host: text((a) => a.host),
        folder: text((a) => a.directory), session: text((a) => a.session),
        registered: time((a) => a.registered_at), active: time((a) => a.last_active),
      },
    },
    hosts: {
      by: 'seen',
      columns: {
        id: text((h) => h.id), folder: text((h) => h.directory),
        status: text((h) => (h.online ? 'online' : 'offline')),
        process: text((h) => processText(h)), opencode: text((h) => h.opencode_version),
        plugin: text((h) => h.plugin_version), seen: time((h) => h.last_seen),
      },
    },
    inbox: {
      by: 'time',
      columns: {
        time: time((i) => i.created_at), kind: text((i) => KINDS[kindOf(i)]),
        agent: text((i) => i.agent),
      },
    },
    messages: {
      by: 'time',
      columns: {
        id: text((m) => m.id), time: time((m) => m.created_at),
        from: text((m) => m.from), to: text((m) => m.to),
        subject: text((m) => m.subject), size: number((m) => m.size),
        state: text((m) => stateText(m)),
      },
    },
    locks: {
      by: 'name',
      columns: { name: text((l) => l.name), type: text((l) => capacityText(l.max)) },
    },
    wakes: {
      by: 'set',
      columns: {
        name: text((w) => w.name), trigger: text((w) => w.trigger),
        next: time(nextTime, 'asc'), week: number((w) => w.week.usd),
        by: text((w) => w.set_by), set: time((w) => w.updated_at),
        fired: time((w) => w.last_fired_at),
      },
    },
    jobs: {
      by: 'name',
      columns: {
        name: text((j) => j.name), where: text((j) => `${j.machine} ${j.directory}`),
        model: text((j) => j.model), effort: text((j) => j.variant),
        trigger: text((j) => j.trigger), next: time((j) => jobNext(j), 'asc'),
        to: text((j) => j.to), last: time((j) => lastRun(j)?.started),
        by: text((j) => j.created_by ?? 'owner'),
      },
    },
    runs: {
      by: 'started',
      columns: {
        run: text((r) => r.id), by: text((r) => r.by), state: text((r) => r.state),
        started: time((r) => r.started), ended: time((r) => r.ended),
        cost: number((r) => r.cost),
      },
    },
    costs: {
      by: 'agent',
      columns: {
        agent: text((a) => a.agent), status: text((a) => a.status),
        today: number((a) => a.today_usd),
        cap: number((a) => (a.daily_usd === 'off' ? null : a.daily_usd)),
        total: number((a) => a.total_usd),
      },
    },
    days: {
      by: 'day',
      columns: {
        day: text((d) => d.day, 'desc'), usd: number((d) => d.usd),
        steps: number((d) => d.steps),
      },
    },
    history: {
      by: 'time',
      columns: {
        time: time((e) => e.at), kind: text((e) => e.kind), agent: text((e) => e.agent),
        host: text((e) => e.host), session: text((e) => e.session),
      },
    },
  };
  const natural = (table, key) => {
    const c = SORT[table].columns[key];
    return c.first ?? (c.type === 'text' ? 'asc' : 'desc');
  };
  const sortState = (table) =>
    ui.sort[table] ?? { key: SORT[table].by, dir: natural(table, SORT[table].by) };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  // The rows in the table's order: empty values last either way.
  function sorted(table, rows) {
    const { key, dir } = sortState(table);
    const column = SORT[table].columns[key];
    const sign = dir === 'asc' ? 1 : -1;
    const value = (row) => {
      const v = column.get(row);
      if (v === null || v === undefined || v === '') return null;
      if (column.type === 'time') return typeof v === 'number' ? v : Date.parse(v);
      return column.type === 'number' ? v : String(v);
    };
    return rows
      .map((row) => ({ row, v: value(row) }))
      .sort((a, b) => {
        if (a.v === null || b.v === null) return a.v === b.v ? 0 : a.v === null ? 1 : -1;
        return (
          sign *
          (typeof a.v === 'string' ? collator.compare(a.v, String(b.v)) : a.v - b.v)
        );
      })
      .map((k) => k.row);
  }
  // A heading that sorts its column.
  function th(table, key, label, cls = '') {
    const s = sortState(table);
    const on = s.key === key;
    const plain = label.replace(/&nbsp;/g, ' ');
    return (
      `<th${attr({
        class: `${cls} sortable${on ? ' sorted' : ''}${on && s.dir === 'asc' ? ' asc' : ''}`.trim(),
        'aria-sort': on ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none',
        title: `Sort by ${plain}`, 'data-act': 'sort', 'data-table': table, 'data-key': key,
      })}><button type="button" class="sort" title="Sort by ${esc(plain)}" data-act="sort" ` +
      `data-table="${table}" data-key="${key}">` +
      `${label}<span class="arrow" aria-hidden="true"></span></button></th>`
    );
  }

  // --------------------------------------------------------- shared parts

  // At most 25 rows, then "..."; `keep` rows always show.
  function paged(key, rows, keep) {
    const n = ui.more[key] ?? PAGE_ROWS;
    const extra = keep ? rows.slice(n).filter(keep) : [];
    return {
      rows: [...rows.slice(0, n), ...extra],
      left: Math.max(0, rows.length - n - extra.length),
    };
  }
  const moreRow = (key, columns, left) =>
    left
      ? `<tr class="more-rows" app-more><td colspan="${columns}" role="button" ` +
        `tabindex="0" aria-label="Show more" title="Show more" data-act="more" ` +
        `data-key="${esc(key)}"><span class="dots">...</span></td></tr>`
      : '';
  // A group's heading row: it folds and opens its group.
  function foldRow(key, columns, label, n) {
    const shut = ui.folds.has(key);
    return (
      `<tr app-fold class="group${shut ? ' folded' : ''}"><th class="id-like" ` +
      `scope="rowgroup" role="button" tabindex="0" colspan="${columns}" ` +
      `aria-expanded="${!shut}" data-act="fold" data-key="${esc(key)}">` +
      `<span class="chevron" aria-hidden="true"></span>${label}` +
      `${shut ? ` <span class="fold-count muted">${n}</span>` : ''}</th></tr>`
    );
  }
  const timeCell = (value, cls = 'time') =>
    value
      ? `<td class="${cls}" title="${esc(value)}">${timeHtml(value)}</td>`
      : `<td class="${cls} muted">—</td>`;
  // The result of an action, or why it failed, in a page's toolbar.
  function result(page) {
    const n = ui.notice[page];
    if (!n) return '<span class="result"></span>';
    return (
      `<span class="result"><span class="${n.bad ? 'errmsg' : 'notice'}" ` +
      `role="${n.bad ? 'alert' : 'status'}">${esc(n.text)}</span></span>`
    );
  }
  const footer = () =>
    '<footer class="muted">Updated <span data-updated>0</span>s ago.</footer>';
  const input = (id, model, o = {}) =>
    `<input${attr({
      id, type: o.type ?? 'text', spellcheck: 'false', placeholder: o.placeholder,
      value: valueAt(model), 'data-model': model, 'data-enter': o.enter,
      'aria-label': o.label, class: o.cls, list: o.list, min: o.min, step: o.step,
      title: o.title,
    })}>`;
  const check = (id, model, label) =>
    `<label class="check" for="${id}"><input id="${id}" type="checkbox"` +
    `${attr({ checked: !!valueAt(model), 'data-model': model })}> ${label}</label>`;
  // What a field's model holds: a path into the page's state.
  function valueAt(model) {
    let at = ui;
    for (const part of model.split('.')) at = at?.[part];
    return at ?? '';
  }
  // A long text folded to its first 200 characters, open on a click.
  function longText(key, value, o = {}) {
    const tag = o.code ? 'code' : 'span';
    const show = (s) => (o.code ? breaksHtml(s) : esc(s));
    if (value.length <= FOLD_CHARS)
      return `<${tag} class="whole">${o.md ? markdown(value) : show(value)}</${tag}>`;
    const open = ui.opened.has(key);
    return (
      `<${o.md ? 'div' : tag} class="more${open ? '' : ' folded'}" role="button" ` +
      `tabindex="0" aria-expanded="${open}" data-act="open" data-key="${esc(key)}">` +
      `${open ? (o.md ? markdown(value) : show(value)) : show(folded(value))}` +
      `</${o.md ? 'div' : tag}>`
    );
  }
  const foldable = (key, value) =>
    value && value.length > FOLD_CHARS
      ? ` folds" data-act="open" data-key="${esc(key)}`
      : '';

  // ---------------------------------------------------------------- hosts

  const PROCESS = { service: 'bg service', serve: 'opencode serve' };
  function processText(h) {
    const name = PROCESS[h.process_kind] ?? h.process_kind ?? '';
    return h.process_pid ? `${name} (${h.process_pid})` : name;
  }
  // The rows by machine, machines in alphabetical order.
  function byMachine(rows, machineOf) {
    const groups = new Map();
    for (const row of rows) {
      const m = machineOf(row) || 'unknown machine';
      groups.set(m, [...(groups.get(m) ?? []), row]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }

  function hosts() {
    const target = ui.route.query.host;
    const shown = W.hosts.filter((h) => h.online || ui.boxes.offline || h.id === target);
    const groups = byMachine(sorted('hosts', shown), (h) => h.machine);
    const body = groups
      .map(([machine, list]) => {
        const key = `hosts/${machine}`;
        if (target && list.some((h) => h.id === target)) ui.folds.delete(key);
        const rows = ui.folds.has(key) ? [] : list;
        return (
          `<tbody data-machine="${esc(machine)}">` +
          foldRow(key, 7, `<span>${idHtml(machine)}</span>`, list.length) +
          rows
            .map(
              (h) =>
                `<tr data-host="${esc(h.id)}"${h.id === target ? ' class="highlight" aria-current="true"' : ''}>` +
                `<td class="id id-like"><code>${idHtml(h.id)}</code></td>` +
                `<td class="folder"><code>${breaksHtml(h.directory)}</code></td>` +
                `<td class="status"><span class="dot ${h.online ? 'ok' : 'off'}"></span>${h.online ? 'online' : 'offline'}</td>` +
                `<td class="process">${esc(processText(h))}</td>` +
                `<td class="opencode">${versionText(h.opencode_version)}</td>` +
                `<td class="plugin">${versionText(h.plugin_version)}</td>` +
                timeCell(h.last_seen) +
                '</tr>',
            )
            .join('') +
          '</tbody>'
        );
      })
      .join('');
    return (
      '<div class="toolbar"><span class="muted result">One per OpenCode server ' +
      'folder that the Autocode plugin connects from.</span>' +
      check('show-offline', 'boxes.offline', 'Offline') +
      '</div>' +
      (target && !W.hosts.some((h) => h.id === target)
        ? `<p class="muted missing">No host ${esc(target)} now.</p>`
        : '') +
      '<table class="hosts"><thead><tr>' +
      th('hosts', 'id', 'ID') + th('hosts', 'folder', 'Folder') +
      th('hosts', 'status', 'Status') + th('hosts', 'process', 'Process') +
      th('hosts', 'opencode', 'OpenCode') + th('hosts', 'plugin', 'Plugin') +
      th('hosts', 'seen', 'Last Seen') +
      '</tr></thead>' +
      (body || '<tbody><tr><td class="muted" colspan="7">No hosts yet.</td></tr></tbody>') +
      '</table>' + footer()
    );
  }

  // --------------------------------------------------------------- agents

  const pausedText = (a) =>
    !a.paused
      ? ''
      : a.paused === 'stop-all'
        ? 'Paused by Stop All'
        : a.paused === 'cap'
          ? 'Paused by its daily cost cap'
          : 'Paused by the owner';
  function contextCell(a) {
    const k = a.cost;
    if (k.context === null) return `<td class="context">${dash}</td>`;
    const numbers = [k.context, k.compact_at, k.context_limit]
      .filter((n) => n !== null)
      .map(tokensShort)
      .join('/')
      .split(/(?<=\/)/)
      .map((p) => `<span class="part">${p}</span>`)
      .join('<wbr>');
    const share = k.compact_at ? (k.context / k.compact_at) * 100 : null;
    const bar =
      share === null
        ? ''
        : `<span class="bar${share >= 100 ? ' over' : share >= 75 ? ' near' : ''}">` +
          `<span style="width:${Math.min(100, share).toFixed(1)}%"></span></span>`;
    const title =
      `${k.context.toLocaleString('en-US')} tokens now; compacted past ` +
      `${(k.compact_at ?? 0).toLocaleString('en-US')} (compact_at); the model's window ` +
      `${(k.context_limit ?? 0).toLocaleString('en-US')}`;
    return (
      `<td class="context" title="${esc(title)}"><span class="numbers">` +
      `<a href="#/costs?agent=${encodeURIComponent(a.id)}">${numbers}</a></span>${bar}</td>`
    );
  }
  function agentRow(a, target) {
    const status = statusOf(a);
    const live = a.registered !== false;
    const editing = ui.editing === a.id;
    const e = a.error;
    const wait = e ? Date.parse(e.next_retry) - now() : 0;
    const error = e
      ? `<span class="error-detail muted" title="Failing since ${esc(localTime(e.since))}">` +
        `<code class="error-type">${breaksHtml(e.type, '.')}</code>` +
        `<span class="retry-state">${wait > 0 ? `retry ${e.retries + 1} in ${waitText(wait)}` : `retry ${e.retries + 1} now`}</span></span>`
      : '';
    const desc = editing
      ? '<td class="desc"><div class="inline-edit">' +
        input('agent-desc', 'draft', { label: 'Description', enter: 'save-desc' }) +
        `<button type="button" class="small" data-act="save-desc" data-id="${esc(a.id)}">Save</button>` +
        '<button type="button" class="small" data-act="cancel-desc">Cancel</button></div></td>'
      : live
        ? `<td class="desc editable" tabindex="0" title="Click to edit the description" data-act="edit-desc" data-id="${esc(a.id)}">${esc(a.description)}</td>`
        : `<td class="desc">${esc(a.description)}</td>`;
    const buttons = !live
      ? ''
      : '<div class="row-buttons">' +
        (e ? `<button type="button" data-act="retry" data-id="${esc(a.id)}" title="Retry the agent's failed turn now">Retry</button>` : '') +
        (a.paused
          ? `<button type="button" data-act="resume" data-id="${esc(a.id)}" title="Let wakes and messages reach the agent again">Resume</button>`
          : `<button type="button" data-act="pause" data-id="${esc(a.id)}" title="Type nothing into the agent's session for now">Pause</button>`) +
        `<button type="button" data-act="rotate" data-id="${esc(a.id)}" title="Give the agent a new token">New Token</button>` +
        `<button type="button" data-act="unregister" data-id="${esc(a.id)}">Unregister</button></div>`;
    const cls = [live ? '' : 'gone', a.id === target ? 'highlight' : ''].filter(Boolean).join(' ');
    return (
      `<tr data-agent="${esc(a.id)}"${cls ? ` class="${cls}"` : ''}${a.id === target ? ' aria-current="true"' : ''}>` +
      `<td class="id id-like"><code class="agent-id">${agentIdHtml(a.id)}</code></td>` +
      desc +
      `<td class="status"${attr({ title: pausedText(a) || null })}>` +
      `${live ? `<span class="dot ${dotClass(status)}"></span>` : ''}${status}${error}</td>` +
      `<td class="model" title="${esc(a.model_name)}">${modelHtml(a.model)}</td>` +
      `<td class="effort">${a.effort ? esc(a.effort) : dash}</td>` +
      `<td class="spend"><a href="#/costs?agent=${encodeURIComponent(a.id)}" title="This agent's row on the Costs tab">` +
      `<span class="part">${costText(a.cost.today_usd)} today /</span> <span class="part">${costText(a.cost.total_usd)} total</span></a></td>` +
      contextCell(a) +
      `<td class="host id-like">${a.host ? hostLink(a.host) : dash}</td>` +
      `<td class="folder"><code>${breaksHtml(a.directory)}</code></td>` +
      `<td class="session id-like"><code>${idHtml(a.session)}</code></td>` +
      timeCell(a.registered_at) + timeCell(a.last_active) +
      `<td class="actions">${buttons}</td></tr>`
    );
  }

  function agents() {
    const q = ui.route.query;
    const target = q.agent;
    const pattern = ui.filter.agents ?? '';
    const showGone = ui.boxes.gone || q.unregistered === '1';
    const all = [...W.agents, ...(showGone ? W.gone : [])];
    const shown = all.filter((a) => matches(pattern, a.id) || a.id === target);
    const groups = byMachine(sorted('agents', shown), (a) =>
      a.host ? hostOf(a.host)?.machine : '');
    const body = groups
      .map(([machine, list]) => {
        const key = `agents/${machine}`;
        if (target && list.some((a) => a.id === target)) ui.folds.delete(key);
        const rows = ui.folds.has(key) ? [] : list;
        return (
          `<tbody data-machine="${esc(machine)}">` +
          foldRow(key, 13, `<span>${idHtml(machine)}</span>`, list.length) +
          rows.map((a) => agentRow(a, target)).join('') +
          '</tbody>'
        );
      })
      .join('');
    return (
      '<div class="toolbar">' +
      '<button type="button" data-act="refresh">Refresh</button>' +
      '<button type="button" data-act="stop-all" title="Pause every agent and interrupt every running turn">Stop All</button>' +
      '<button type="button" data-act="resume-all" title="Resume the agents that Stop All paused">Resume All</button>' +
      result('agents') +
      '<label for="match">Filter</label>' +
      input('match', 'filter.agents', { placeholder: 'for example home:* or a:b,c:*' }) +
      check('show-unregistered', 'boxes.gone', 'Unregistered') +
      (pattern ? '<button type="button" data-act="clear-filter" data-key="agents">Show All</button>' : '') +
      '</div>' +
      (target && !all.some((a) => a.id === target)
        ? `<p class="muted missing">No agent ${esc(target)} now.</p>`
        : '') +
      '<table class="agents"><thead><tr>' +
      th('agents', 'id', 'ID') + th('agents', 'desc', 'Description') +
      th('agents', 'status', 'Status') + th('agents', 'model', 'Model') +
      th('agents', 'effort', 'Effort') + th('agents', 'spend', 'Spend') +
      th('agents', 'context', 'Context') + th('agents', 'host', 'Host') +
      th('agents', 'folder', 'Folder') + th('agents', 'session', 'Session') +
      th('agents', 'registered', 'Registered') + th('agents', 'active', 'Last Active') +
      '<th></th></tr></thead>' +
      (body ||
        `<tbody><tr><td class="muted" colspan="13">${pattern ? `No agent matches ${esc(pattern)}.` : 'No agents yet.'}</td></tr></tbody>`) +
      '</table>' + footer()
    );
  }

  // ---------------------------------------------------------------- inbox

  const KINDS = {
    message: 'Message', report: 'Report', alert: 'Alert', question: 'Question',
    permission: 'Permission', approval: 'Approval',
  };
  // What a closed ask was answered with, then who gave the answer.
  function askAnswer(item) {
    const a = item.answer;
    if (!a || item.state === 'gone') return '';
    let what;
    if (item.kind === 'question') {
      what =
        typeof a.cancel === 'string'
          ? `dismissed: ${a.cancel}`
          : Object.values(a.answer ?? {})
              .map((v) => (Array.isArray(v) ? v.join(', ') : v))
              .join('; ');
    } else {
      const head = [a.decision, a.option].filter(Boolean).join(' ');
      what = a.text ? `${head}: ${a.text}` : head;
    }
    if (item.by === 'auto') return `${what} (at once)`;
    if (item.by === 'owner') return `${what} (by the owner)`;
    return item.by ? `${what} (by ${item.by})` : what;
  }
  const field = (item, name) => `fields.${item.id.replace(/\W/g, '_')}_${name}`;

  function inboxItem(item) {
    const closed = !!item.closed_at;
    const title = item.kind === 'approval' && item.agent ? `Approval for ${item.agent}` : item.title;
    let body = `<div class="title">${esc(title)}</div>`;
    for (const note of item.notes ?? [])
      body += `<div class="note"><span class="muted">Note: </span>${esc(note)}</div>`;
    if (item.expires && !closed)
      body += `<div class="expires muted" title="${esc(item.expires)}">expires ${timeHtml(item.expires)} (${leftText(Date.parse(item.expires) - now())})</div>`;
    if (!isAsk(item)) {
      if (item.body) body += `<app-markdown class="body">${markdown(item.body)}</app-markdown>`;
      if (typeof item.answer === 'string')
        body += `<div class="answer"><span class="muted">Answer: </span><app-markdown class="body">${markdown(item.answer)}</app-markdown></div>`;
      else if (!closed && item.kind === 'message')
        body += `<textarea rows="2" aria-label="Answer" placeholder="The answer goes back to the agent as a message" id="draft-${esc(item.id)}" data-model="${field(item, 'draft')}">${esc(valueAt(field(item, 'draft')))}</textarea>`;
    } else if (closed) {
      if (item.kind === 'approval') body += `<div class="ask-text">${esc(item.text)}</div>`;
      if (item.state === 'gone' && item.by)
        body += `<div class="answer"><span class="body">Closed by ${esc(item.by === 'owner' ? 'the owner' : item.by)}${item.answer?.text ? `: ${esc(item.answer.text)}` : ''}</span></div>`;
      else if (askAnswer(item))
        body += `<div class="answer"><span class="muted">Answer: </span><app-markdown class="body">${markdown(askAnswer(item))}</app-markdown></div>`;
    } else if (item.kind === 'question') {
      const one = item.questions.length === 1 && !item.questions[0].multiple && item.questions[0].options.length;
      item.questions.forEach((q, n) => {
        body += `<div class="question"><div class="ask-text">${esc(q.question + (q.multiple ? ' (one or more)' : ''))}</div>`;
        if (one)
          body +=
            '<div class="options">' +
            q.options
              .map((o) => `<button type="button" class="option" data-act="answer-option" data-id="${esc(item.id)}" data-option="${esc(o)}"><span class="data">${esc(o)}</span></button>`)
              .join('') +
            '</div>';
        body +=
          input(`free-${item.id}-${n}`, field(item, `free${n}`), {
            cls: 'free', placeholder: 'or in your own words',
            label: `Answer to question ${n + 1}`, enter: 'answer-question',
          }).replace('<input', `<input data-id="${esc(item.id)}"`) + '</div>';
      });
      const can = item.questions.some((_, n) => String(valueAt(field(item, `free${n}`))).trim());
      body += `<div class="ask-buttons"><button type="button" data-act="answer-question" data-id="${esc(item.id)}"${can ? '' : ' disabled'}>Answer</button></div>`;
    } else if (item.kind === 'permission') {
      body += `<div class="action"><span class="muted">Action: </span>${esc(item.action)}</div>`;
      if (item.resources?.length)
        body += `<div class="resources"><span class="muted">Resources: </span>${item.resources.map((r) => `<code>${esc(r)}</code>`).join('')}</div>`;
      if (item.message) body += `<div class="ask-text">${esc(item.message)}</div>`;
      body +=
        '<div class="ask-buttons">' +
        `<button type="button" data-act="allow" data-how="once" data-id="${esc(item.id)}">Allow Once</button>` +
        `<button type="button" data-act="allow" data-how="always" data-id="${esc(item.id)}" title="OpenCode saves the rule for the project">Allow Always</button>` +
        input(`reason-${item.id}`, field(item, 'reason'), { label: 'Reason to reject', placeholder: 'reason (optional)' }) +
        `<button type="button" data-act="reject-permission" data-id="${esc(item.id)}">Reject</button></div>`;
    } else {
      body += `<div class="ask-text">${esc(item.text)}</div>`;
      if (item.options?.length)
        body +=
          '<div class="choices">' +
          item.options
            .map((o) =>
              `<label class="check"><input type="radio" name="${esc(item.id)}-option"` +
              `${attr({ checked: valueAt(field(item, 'option')) === o, 'data-model': field(item, 'option'), value: o })}> ${esc(o)}</label>`)
            .join('') +
          '</div>';
      body +=
        '<div class="ask-buttons">' +
        input(`note-${item.id}`, field(item, 'note'), { label: 'Note', placeholder: 'note (optional)' }) +
        `<button type="button" data-act="decide" data-how="approve" data-id="${esc(item.id)}">Approve</button>` +
        `<button type="button" data-act="decide" data-how="reject" data-id="${esc(item.id)}">Reject</button></div>`;
    }
    const to = item.routed ?? '';
    const sent = to.startsWith('agent:')
      ? `<td class="sent-to id-like">${agentLink(to.slice(6))}</td>`
      : !isAsk(item) || to === 'owner'
        ? '<td class="sent-to id-like"><span class="agent-id"><span class="id-part">owner</span></span></td>'
        : `<td class="sent-to"><span class="muted">${to === 'auto_answer' || to === 'allow' ? 'answered at once' : esc(to)}</span></td>`;
    const actions = closed
      ? `<span class="muted" title="${esc(localTime(item.closed_at))}">${isAsk(item) ? esc(item.state) : 'closed'}</span>`
      : isAsk(item)
        ? ''
        : '<div class="row-buttons">' +
          (item.kind === 'message'
            ? `<button type="button" data-act="answer" data-id="${esc(item.id)}"${String(valueAt(field(item, 'draft'))).trim() ? '' : ' disabled'}>Answer</button>`
            : '') +
          `<button type="button" data-act="close" data-id="${esc(item.id)}">Close</button></div>`;
    return (
      `<tr data-item="${esc(item.id)}"${closed ? ' class="closed"' : ''}>` +
      timeCell(item.created_at) +
      `<td class="kind kind-${kindOf(item)}">${KINDS[kindOf(item)]}</td>` +
      `<td class="agent id-like">${item.agent ? agentLink(item.agent) : ''}</td>` +
      sent + `<td class="item">${body}</td><td class="actions">${actions}</td></tr>`
    );
  }
  // The items the Inbox shows now, in its order.
  function inboxRows() {
    const pattern = ui.filter.inbox ?? '';
    return sorted(
      'inbox',
      W.inbox.filter(
        (i) =>
          (ui.boxes.closed || !i.closed_at) &&
          (ui.boxes.reports || kindOf(i) !== 'report') &&
          (!pattern || matches(pattern, i.agent ?? '')),
      ),
    );
  }

  function inbox() {
    const pattern = ui.filter.inbox ?? '';
    const page = paged('inbox', inboxRows(), (i) => !i.closed_at);
    const closable = page.rows.filter((i) => !i.closed_at && !isAsk(i));
    const hidden = !ui.boxes.reports && W.inbox.some((i) => !i.closed_at && kindOf(i) === 'report');
    return (
      '<div class="toolbar">' +
      '<button type="button" data-act="refresh">Refresh</button>' +
      result('inbox') +
      '<label for="inbox-match">Agent</label>' +
      input('inbox-match', 'filter.inbox', { placeholder: 'for example home:* or a,b:*' }) +
      `<button type="button" class="close-all" data-act="close-all" title="Close the open messages and alerts shown; asks stay open"${closable.length ? '' : ' disabled'}>Close All</button>` +
      check('show-closed', 'boxes.closed', 'Closed') +
      check('show-reports', 'boxes.reports', 'Reports') +
      '</div>' +
      '<table class="inbox"><thead><tr>' +
      th('inbox', 'time', 'Time') + th('inbox', 'kind', 'Kind') + th('inbox', 'agent', 'Agent') +
      '<th>Sent To</th><th>Item</th><th></th></tr></thead><tbody>' +
      (page.rows.map(inboxItem).join('') ||
        `<tr><td class="muted" colspan="6">${
          hidden
            ? 'Nothing but reports, which are hidden: tick Reports to see them.'
            : pattern
              ? `Nothing in the inbox matches ${esc(pattern)}.`
              : 'Nothing in the inbox.'
        }</td></tr>`) +
      moreRow('inbox', 6, page.left) +
      '</tbody></table>' + footer()
    );
  }

  // ------------------------------------------------------------- messages

  const stateText = (m) =>
    m.state === 'processed' && m.processed_via ? `processed (${m.processed_via})` : m.state;
  const VIA = {
    prompt: 'in a prompt', steer: 'during a turn of its recipient',
    read: "with its recipient's read", wait: "with its recipient's wait",
    inbox: 'in your Inbox',
  };
  function stateTitle(m) {
    if (m.state === 'queued') return 'Waiting for its recipient';
    if (m.state === 'dropped') return 'Dropped: its agent unregistered first';
    const how = m.processed_via ? `, ${VIA[m.processed_via] ?? m.processed_via}` : '';
    return m.processed_at ? `Processed ${localTime(m.processed_at)}${how}` : `Processed${how}`;
  }

  function messages() {
    const f = ui.filter;
    const shown = W.messages.filter(
      (m) =>
        (ui.boxes.processed || m.state !== 'processed') &&
        (!f.from || matches(f.from, m.from)) &&
        (!f.to || matches(f.to, m.to)),
    );
    const page = paged('messages', sorted('messages', shown));
    const send = ui.forms.send;
    const can = String(send.to ?? '').trim() && String(send.text ?? '').trim();
    const n = ui.notice.send;
    return (
      '<div class="toolbar">' +
      '<button type="button" data-act="refresh">Refresh</button><span class="result"></span>' +
      '<label for="message-from">From</label>' +
      input('message-from', 'filter.from', { placeholder: 'for example chief or home:*' }) +
      '<label for="message-to">To</label>' +
      input('message-to', 'filter.to', { placeholder: 'for example owner' }) +
      check('show-processed', 'boxes.processed', 'Processed') +
      '</div>' +
      `<details class="panel" data-panel="send"${ui.panels.send ? ' open' : ''}>` +
      '<summary><span>Send a Message</span></summary><div class="panel-body">' +
      '<div class="add-row"><div><label for="send-to">To</label>' +
      input('send-to', 'forms.send.to', { placeholder: 'an agent ID, a pattern like team:* or a list a:b,c:d' }) +
      '</div><div><label for="send-subject">Subject</label>' +
      input('send-subject', 'forms.send.subject', { placeholder: 'optional' }) +
      '</div></div><label for="send-text">Text</label>' +
      `<textarea id="send-text" rows="3" data-model="forms.send.text">${esc(send.text ?? '')}</textarea>` +
      `<div class="buttons"><button type="button" data-act="send"${can ? '' : ' disabled'}>Send</button>` +
      (n ? `<span class="${n.bad ? 'errmsg' : 'notice'}" role="${n.bad ? 'alert' : 'status'}">${esc(n.text)}</span>` : '') +
      '</div></div></details>' +
      '<table class="messages"><thead><tr>' +
      th('messages', 'id', 'ID') + th('messages', 'time', 'Time') +
      th('messages', 'from', 'From') + th('messages', 'to', 'To') +
      th('messages', 'subject', 'Subject') + '<th>Text</th>' +
      th('messages', 'size', 'Size', 'num') + th('messages', 'state', 'State') +
      '</tr></thead><tbody>' +
      (page.rows
        .map(
          (m) =>
            `<tr data-message="${esc(m.id)}">` +
            `<td class="id id-like"><code>${idHtml(m.id)}</code></td>` +
            timeCell(m.created_at) +
            `<td class="sender id-like">${who(m.from)}</td>` +
            `<td class="recipient id-like">${who(m.to)}</td>` +
            `<td class="subject">${esc(m.subject)}</td>` +
            `<td class="text${foldable(`message/${m.id}`, m.text)}">${
              m.text.length > FOLD_CHARS
                ? longText(`message/${m.id}`, m.text, { md: true })
                : `<app-markdown class="whole">${markdown(m.text)}</app-markdown>`
            }</td>` +
            `<td class="num size">${m.size.toLocaleString('en-US')}</td>` +
            `<td class="state" title="${esc(stateTitle(m))}">${esc(stateText(m))}</td></tr>`,
        )
        .join('') ||
        `<tr><td class="muted" colspan="8">${
          ui.boxes.processed
            ? f.from || f.to
              ? 'No message matches the From and To filters.'
              : 'No messages yet.'
            : (f.from || f.to
                ? 'No message that waits matches the From and To filters '
                : 'No message waits ') + '(the Processed box shows the processed ones).'
        }</td></tr>`) +
      moreRow('messages', 8, page.left) +
      '</tbody></table>' + footer()
    );
  }

  // ---------------------------------------------------------------- locks

  const capacityText = (max) => (max === 1 ? 'Mutex' : `${max} places`);

  function locks() {
    const pattern = ui.filter.locks ?? '';
    const rows = sorted('locks', W.locks.filter((l) => matches(pattern, l.name)));
    return (
      '<div class="toolbar"><button type="button" data-act="refresh">Refresh</button>' +
      result('locks') +
      '<label for="lock-match">Lock</label>' +
      input('lock-match', 'filter.locks', { placeholder: 'for example gpu-* or a,b:*' }) +
      '</div><table class="locks"><thead><tr>' +
      th('locks', 'name', 'Lock') + th('locks', 'type', 'Type') +
      '<th>Holders</th><th>Queue</th></tr></thead><tbody>' +
      (rows
        .map(
          (l) =>
            `<tr data-lock="${esc(l.name)}"><td class="name id-like"><code>${idHtml(l.name)}</code></td>` +
            `<td class="capacity">${capacityText(l.max)}</td><td class="holders">` +
            (l.holders.length
              ? '<div class="grid">' +
                l.holders
                  .map(
                    (h) =>
                      `<div class="holder" data-agent="${esc(h.agent)}">${agentLink(h.agent)}` +
                      `<span class="until" title="${esc(h.expires)}">until <span class="when">${timeHtml(h.expires)}</span> ` +
                      `<span class="left">(${leftText(Date.parse(h.expires) - now())})</span></span>` +
                      `<button type="button" data-act="release" data-lock="${esc(l.name)}" data-id="${esc(h.agent)}" title="The agent is told; the next in the queue gets it">Release</button></div>`,
                  )
                  .join('') +
                '</div>'
              : dash) +
            '</td><td class="queue">' +
            (l.queue.length
              ? '<div class="grid">' +
                l.queue
                  .map(
                    (q) =>
                      `<div class="waiter" data-agent="${esc(q.agent)}"><span class="position">${q.position}. </span>${agentLink(q.agent)}` +
                      `<span class="since" title="${esc(q.since)}"> (since <span class="when">${timeHtml(q.since)}</span>)</span>` +
                      `<button type="button" data-act="unqueue" data-lock="${esc(l.name)}" data-id="${esc(q.agent)}" title="The agent is told; the others move up">Remove</button></div>`,
                  )
                  .join('') +
                '</div>'
              : dash) +
            '</td></tr>',
        )
        .join('') ||
        `<tr><td class="muted" colspan="4">${
          pattern
            ? `No lock matches ${esc(pattern)}.`
            : 'No locks. Agents create one with <code>autocode_lock action=acquire</code>; it is gone when nobody holds it or waits.'
        }</td></tr>`) +
      '</tbody></table>' + footer()
    );
  }

  // ---------------------------------------------------------------- wakes

  // A trigger as the page shows it: a one-time one, and a periodic one's
  // end, in the viewer's zone.
  function triggerText(trigger) {
    const at = /^at (\d{4}-\d\d-\d\dT\S+)$/.exec(trigger);
    if (at) return `at ${localTime(at[1])}`;
    return trigger;
  }

  function wakes() {
    const f = ui.forms.wake;
    const can = ['agent', 'name', 'trigger', 'text'].every((k) => String(f[k] ?? '').trim());
    const groups = new Map();
    for (const w of sorted('wakes', W.wakes))
      groups.set(w.agent, [...(groups.get(w.agent) ?? []), w]);
    const body = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agent, list]) => {
        const key = `wakes/${agent}`;
        const rows = ui.folds.has(key) ? [] : list;
        return (
          `<tbody data-agent="${esc(agent)}">` +
          foldRow(key, 10, agentLink(agent, true), list.length) +
          rows
            .map((w) => {
              const id = `${w.agent}/${w.name}`;
              const n = nextOf(w);
              const next = n.next
                ? timeCell(AC.iso(n.next), 'time next')
                : n.due
                  ? `<td class="time next" title="${esc(AC.iso(n.due))}, if the session stays idle"><span>${timeHtml(AC.iso(n.due))}</span><span class="muted"> if idle</span></td>`
                  : '<td class="time next muted">—</td>';
              const k = w.week;
              const week =
                k.due || k.skipped || k.turns || k.usd
                  ? `<td class="num week" title="Last 7 days: ${k.turns} turn${k.turns === 1 ? '' : 's'}, ${costText(k.usd)}. It fell due ${k.due} time${k.due === 1 ? '' : 's'}; its check skipped ${k.skipped}.">` +
                    `<span class="usd">${costText(k.usd)}</span><span class="turns muted">${k.turns} turn${k.turns === 1 ? '' : 's'}</span></td>`
                  : '<td class="num week muted">—</td>';
              return (
                `<tr data-wake="${esc(w.name)}"><td class="name id-like"><code>${idHtml(w.name)}</code></td>` +
                `<td class="trigger">${esc(triggerText(w.trigger))}</td>${next}` +
                `<td class="text${foldable(`wake/${id}/text`, w.text)}">${longText(`wake/${id}/text`, w.text)}</td>` +
                `<td class="check${foldable(`wake/${id}/check`, w.check)}">${
                  w.check
                    ? longText(`wake/${id}/check`, w.check, { code: true }) +
                      (w.check_timeout ? `<span class="limit muted">up to ${esc(w.check_timeout)}</span>` : '')
                    : dash
                }</td>${week}` +
                `<td class="by id-like">${who(w.set_by)}</td>` +
                timeCell(w.updated_at, 'time set') + timeCell(w.last_fired_at, 'time fired') +
                '<td class="actions"><div class="row-buttons">' +
                `<button type="button" data-act="fire" data-agent="${esc(w.agent)}" data-name="${esc(w.name)}" title="Fire the wake now (its check is skipped)">Fire</button>` +
                `<button type="button" data-act="cancel-wake" data-agent="${esc(w.agent)}" data-name="${esc(w.name)}">Cancel</button></div></td></tr>`
              );
            })
            .join('') +
          '</tbody>'
        );
      })
      .join('');
    const n = ui.notice.setWake;
    return (
      '<div class="toolbar"><button type="button" data-act="refresh">Refresh</button>' +
      result('wakes') + '</div>' +
      `<details class="panel" data-panel="wake"${ui.panels.wake ? ' open' : ''}>` +
      '<summary><span>Set a Wake</span></summary><div class="panel-body"><div class="add-row">' +
      '<div><label for="wake-agent">Agent ID</label>' +
      input('wake-agent', 'forms.wake.agent', { placeholder: 'for example home:chief', list: 'known-agents' }) +
      `<datalist id="known-agents">${W.agents.map((a) => `<option value="${esc(a.id)}"></option>`).join('')}</datalist>` +
      '</div><div><label for="wake-name">Name</label>' +
      input('wake-name', 'forms.wake.name', { placeholder: 'for example standup' }) +
      '</div><div class="wide"><label for="wake-trigger">Trigger</label>' +
      input('wake-trigger', 'forms.wake.trigger', { placeholder: TRIGGER_HINT }) +
      '</div></div><label for="wake-text">Text</label>' +
      `<textarea id="wake-text" rows="2" placeholder="what the agent is told when the wake fires" data-model="forms.wake.text">${esc(f.text ?? '')}</textarea>` +
      '<div class="add-row check-row"><div class="wide"><label for="wake-check">Check</label>' +
      input('wake-check', 'forms.wake.check', { placeholder: 'optional: a command; exit 0 wakes, 1 skips' }) +
      '</div><div><label for="wake-check-timeout">Check Timeout</label>' +
      input('wake-check-timeout', 'forms.wake.limit', { placeholder: 'optional: like 5m' }) +
      '</div></div><div class="buttons">' +
      `<button type="button" data-act="set-wake"${can ? '' : ' disabled'}>Set Wake</button>` +
      '<span class="muted">A wake of the same name is replaced.</span></div>' +
      (n ? `<p class="${n.bad ? 'errmsg' : 'notice'}" role="${n.bad ? 'alert' : 'status'}">${esc(n.text)}</p>` : '') +
      '</div></details>' +
      '<table class="wakes"><thead><tr>' +
      th('wakes', 'name', 'Name') + th('wakes', 'trigger', 'Trigger') +
      th('wakes', 'next', 'Next') + '<th>Text</th><th>Check</th>' +
      th('wakes', 'week', 'Last 7&nbsp;Days', 'num') + th('wakes', 'by', 'Set By') +
      th('wakes', 'set', 'Last Set') + th('wakes', 'fired', 'Last Fired') +
      '<th></th></tr></thead>' +
      (body || '<tbody><tr><td class="muted" colspan="10">No wakes yet.</td></tr></tbody>') +
      '</table>' + footer()
    );
  }

  // ----------------------------------------------------------------- jobs

  const stateWord = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const lastRun = (j) =>
    W.runs.filter((r) => r.job === j.name).sort((a, b) => Date.parse(b.started) - Date.parse(a.started))[0];
  const jobNext = (j) =>
    nextOf({ trigger: j.trigger, updated_at: AC.iso(AC.BASE - 9 * 86400000), agent: '' }).next ?? null;

  function jobs() {
    const q = ui.route.query;
    const f = ui.forms.job;
    const can = ['name', 'host', 'model', 'prompt', 'trigger'].every((k) => String(f[k] ?? '').trim());
    const jobPage = paged('jobs', sorted('jobs', W.jobs), (j) => j.name === q.job);
    const chosen = ui.filter.runs ?? '';
    const runPage = paged(
      'runs',
      sorted('runs', W.runs.filter((r) => !chosen || r.job === chosen)),
      (r) => r.id === q.run,
    );
    const n = ui.notice.setJob;
    const jobRows = jobPage.rows
      .map((j) => {
        const online = hostOf(j.host)?.online;
        const next = jobNext(j);
        const last = lastRun(j);
        const isAgent = !['owner', 'autocode', 'schedule'].includes(j.to) && !/[*,]/.test(j.to);
        return (
          `<tr data-job="${esc(j.name)}"${j.name === q.job ? ' class="highlight" aria-current="true"' : ''}>` +
          `<td class="name id-like"${attr({ title: j.description || null })}><code>${idHtml(j.name)}</code></td>` +
          `<td class="where"><div class="machine">${esc(j.machine)}</div> <code>${breaksHtml(j.directory)}</code>` +
          `${online ? '' : ' <span class="offline"><span class="dot off"></span>offline</span>'}</td>` +
          `<td class="model" title="${esc(j.model_name ?? '')}">${modelHtml(j.model)}${j.agent ? ` <div class="muted">agent ${esc(j.agent)}</div>` : ''}</td>` +
          `<td class="effort">${j.variant ? esc(j.variant) : dash}</td>` +
          `<td class="trigger">${esc(j.trigger)}</td>` +
          (next
            ? `<td class="next" title="${esc(AC.iso(next))}"><span class="when">${timeHtml(AC.iso(next))}</span> (${leftText(next - now())})</td>`
            : '<td class="next muted">—</td>') +
          `<td class="to id-like">${isAgent ? agentLink(j.to) : `<code class="agent-id">${agentIdHtml(j.to)}</code>`}</td>` +
          `<td class="last">${
            last
              ? `<a class="run-link" href="#/jobs?run=${encodeURIComponent(last.id)}">${stateWord(last.state)}</a> <span class="time">${timeHtml(last.started)}</span>`
              : dash
          }</td>` +
          `<td class="by id-like">${who(j.created_by ?? 'owner')}</td>` +
          '<td class="actions"><div class="run-now">' +
          input(`run-text-${j.name}`, `fields.run_${j.name.replace(/\W/g, '_')}`, {
            label: 'Text for the run', placeholder: 'text (optional)', enter: 'run-now',
          }).replace('<input', `<input data-id="${esc(j.name)}"`) +
          `<button type="button" data-act="run-now" data-id="${esc(j.name)}">Run Now</button></div>` +
          '<div class="row-buttons">' +
          `<button type="button" data-act="edit-job" data-id="${esc(j.name)}">Edit</button>` +
          `<button type="button" data-act="delete-job" data-id="${esc(j.name)}">Delete</button></div></td></tr>`
        );
      })
      .join('');
    const runRows = runPage.rows
      .map(
        (r) =>
          `<tr data-run="${esc(r.id)}"${r.id === q.run ? ' class="highlight" aria-current="true"' : ''}>` +
          `<td class="id id-like"${attr({ title: r.text || null })}><code>${idHtml(r.id)}</code></td>` +
          `<td class="by id-like">${who(r.by)}</td>` +
          `<td class="state">${stateWord(r.state)}</td>` +
          timeCell(r.started, 'time started') + timeCell(r.ended, 'time ended') +
          `<td class="num cost">${costText(r.cost)}</td>` +
          `<td class="result${foldable(`run/${r.id}`, r.result)}">${r.result ? longText(`run/${r.id}`, r.result) : dash}</td>` +
          `<td class="reason">${r.reason ? esc(r.reason) : dash}</td>` +
          `<td class="actions">${
            r.session_kept
              ? `<button type="button" data-act="delete-session" data-id="${esc(r.id)}" title="The failed run's session, kept for you to look at">Delete Session</button>`
              : ''
          }</td></tr>`,
      )
      .join('');
    const option = (value, label, on) =>
      `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    return (
      '<div class="toolbar"><button type="button" data-act="refresh">Refresh</button>' +
      result('jobs') + '</div>' +
      `<details class="panel" data-panel="job"${ui.panels.job ? ' open' : ''}>` +
      '<summary><span>Set a Job</span></summary><div class="panel-body">' +
      '<div class="add-row"><div><label for="job-name">Name</label>' +
      input('job-name', 'forms.job.name', { placeholder: 'for example daily-report' }) +
      '</div><div class="wide"><label for="job-description">Description</label>' +
      input('job-description', 'forms.job.description', { placeholder: 'optional: what it does, for agents that look' }) +
      '</div></div><div class="add-row"><div class="wide"><label for="job-host">Host</label>' +
      '<select id="job-host" data-model="forms.job.host">' +
      option('', 'Choose a host', !f.host) +
      W.hosts.map((h) => option(h.id, `${h.machine} ${h.directory}${h.online ? '' : ' (offline)'}`, h.id === f.host)).join('') +
      '</select></div><div><label for="job-model">Model</label>' +
      input('job-model', 'forms.job.model', { placeholder: 'provider/model' }) +
      '</div><div><label for="job-variant">Variant</label>' +
      input('job-variant', 'forms.job.variant', { placeholder: 'optional' }) +
      '</div><div><label for="job-agent">Agent</label>' +
      input('job-agent', 'forms.job.agent', { placeholder: 'optional: an OpenCode agent' }) +
      '</div></div><label for="job-prompt">Prompt</label>' +
      `<textarea id="job-prompt" rows="3" placeholder="what the fresh agent is asked to do" data-model="forms.job.prompt">${esc(f.prompt ?? '')}</textarea>` +
      '<div class="add-row"><div class="wide"><label for="job-trigger">Trigger</label>' +
      input('job-trigger', 'forms.job.trigger', { placeholder: TRIGGER_HINT }) +
      '</div><div><label for="job-to">To</label>' +
      input('job-to', 'forms.job.to', { placeholder: 'owner, an agent or a pattern' }) +
      '</div><div><label for="job-timeout">Time Limit</label>' +
      input('job-timeout', 'forms.job.timeout', { placeholder: 'like 1h' }) +
      '</div><div><label for="job-run-usd">Run Cap</label>' +
      input('job-run-usd', 'forms.job.run_usd', { placeholder: '$ or off' }) +
      '</div></div>' + check('job-delete', 'forms.job.delete_session', 'Delete Session') +
      `<div class="buttons"><button type="button" data-act="set-job"${can ? '' : ' disabled'}>Set Job</button>` +
      (n && !n.bad
        ? `<span class="notice" role="status">${esc(n.text)}</span>`
        : "<span class=\"muted\">A job of the same name is replaced; a run's session is deleted after it succeeds unless you untick Delete Session.</span>") +
      '</div>' + (n && n.bad ? `<p class="errmsg" role="alert">${esc(n.text)}</p>` : '') +
      '</div></details>' +
      '<table class="jobs"><thead><tr>' +
      th('jobs', 'name', 'Name') + th('jobs', 'where', 'Where') + th('jobs', 'model', 'Model') +
      th('jobs', 'effort', 'Effort') + th('jobs', 'trigger', 'Trigger') + th('jobs', 'next', 'Next') +
      th('jobs', 'to', 'To') + th('jobs', 'last', 'Last Run') + th('jobs', 'by', 'Set By') +
      '<th></th></tr></thead><tbody>' +
      (jobRows ||
        '<tr><td class="muted" colspan="9">No jobs yet. Set a Job above, or use <code>autocode job set</code>.</td></tr>') +
      moreRow('jobs', 9, jobPage.left) +
      '</tbody></table><h2>Runs</h2><div class="toolbar"><label for="runs-job">Job</label>' +
      '<select id="runs-job" data-model="filter.runs">' +
      option('', 'All jobs', !chosen) +
      W.jobs.map((j) => option(j.name, j.name, j.name === chosen)).join('') +
      '</select></div><table class="runs"><thead><tr>' +
      th('runs', 'run', 'Run') + th('runs', 'by', 'Started By') + th('runs', 'state', 'State') +
      th('runs', 'started', 'Started') + th('runs', 'ended', 'Ended') +
      th('runs', 'cost', 'Cost', 'num') + '<th>Result</th><th>Reason</th><th></th></tr></thead><tbody>' +
      (runRows || '<tr><td class="muted" colspan="9">No runs yet.</td></tr>') +
      moreRow('runs', 9, runPage.left) +
      '</tbody></table>' + footer()
    );
  }

  // ---------------------------------------------------------------- costs

  // Last 7 Days: a bar per day, each its share of the top day.
  function graph(bars) {
    const top = Math.max(...bars.map((b) => b.usd), 0);
    return (
      '<span class="graph">' +
      bars
        .map(
          (b) =>
            `<span class="col${b.usd === 0 ? ' zero' : ''}" tabindex="0" aria-label="${dayText(b.day)}: ${costText(b.usd)}">` +
            `<span class="fill" style="height:${top ? Math.round((b.usd / top) * 1000) / 10 : 0}%"></span>` +
            `<span class="tip" aria-hidden="true"><span class="usd">${costText(b.usd)}</span> <span class="day">${dayText(b.day)}</span></span></span>`,
        )
        .join('') +
      '</span>'
    );
  }
  // The Costs tab's rows: every agent, the unregistered ones with spend,
  // and one row per job for the runs that no agent started.
  function costRows() {
    const n = Number(ui.filter.days) > 0 ? Math.floor(Number(ui.filter.days)) : 0;
    const period = (week, total) =>
      !n ? total : n >= 7 ? Math.min(total, week.reduce((s, b) => s + b.usd, 0) * (n / 7)) : week.slice(-n).reduce((s, b) => s + b.usd, 0);
    const rows = [...W.agents, ...(ui.boxes.costsGone ? W.gone : [])].map((a) => ({
      agent: a.id, registered: a.registered !== false, job: null,
      status: statusOf(a), today_usd: a.cost.today_usd,
      daily_usd: a.registered === false ? 'off' : (capOf(a.id) ?? 'off'),
      week: a.week, total_usd: period(a.week, a.cost.total_usd),
    }));
    for (const j of W.jobCosts)
      rows.push({
        agent: j.agent, registered: false, job: j.job, status: 'job',
        today_usd: j.today, daily_usd: 'off', week: j.week,
        total_usd: period(j.week, j.total),
      });
    return rows.filter((r) => matches(ui.filter.costs ?? '', r.agent) || r.agent === ui.route.query.agent);
  }

  function costs() {
    const target = ui.route.query.agent;
    const n = Number(ui.filter.days) > 0 ? Math.floor(Number(ui.filter.days)) : 0;
    const title = !n ? 'Total' : n === 1 ? 'Last Day' : `Last ${n} Days`;
    const all = costRows();
    const page = paged('costs', sorted('costs', all), (a) => a.agent === target);
    const rows = page.rows
      .map((a) => {
        const share = a.daily_usd === 'off' ? null : Math.round((a.today_usd / a.daily_usd) * 1000) / 10;
        let row =
          `<tr data-agent="${esc(a.agent)}"${attr({
            class: [!a.registered && !a.job ? 'gone' : '', a.agent === target ? 'highlight' : ''].filter(Boolean).join(' ') || null,
            'aria-current': a.agent === target ? 'true' : null,
          })}>` +
          `<td class="agent id-like">${
            a.job
              ? `<a class="id-link" href="#/jobs?job=${encodeURIComponent(a.job)}" title="Show on the Jobs page"><code class="agent-id">${agentIdHtml(a.agent)}</code></a>`
              : agentLink(a.agent, false, !a.registered)
          }</td>` +
          `<td class="status">${a.registered ? `<span class="dot ${dotClass(a.status)}"></span>` : ''}${a.status}</td>` +
          `<td class="num today">${costText(a.today_usd)}</td><td class="cap">` +
          (a.daily_usd === 'off'
            ? '<span class="muted">off</span>'
            : `<span class="cap-line"><span class="amount">${costText(a.daily_usd)}</span> <span class="share">${share.toFixed(1)}%</span></span>` +
              `<span class="bar${share >= 100 ? ' over' : share >= 75 ? ' near' : ''}"><span style="width:${Math.min(100, share)}%"></span></span>`) +
          `</td><td class="week">${graph(a.week)}</td>` +
          `<td class="num total">${costText(a.total_usd)}</td>` +
          `<td class="actions"><button type="button" class="days small" aria-expanded="${ui.days === a.agent}" data-act="days" data-id="${esc(a.agent)}">Days</button></td></tr>`;
        if (ui.days === a.agent) {
          const days = sorted(
            'days',
            a.week.filter((b) => b.usd > 0).map((b) => ({ day: b.day, usd: b.usd, steps: Math.max(1, Math.round(b.usd * 9.4)) })),
          );
          row +=
            `<tr class="days" data-agent="${esc(a.agent)}"><td colspan="7">` +
            (days.length
              ? '<table class="cost-days"><thead><tr>' +
                th('days', 'day', 'Day') + th('days', 'usd', 'Spend', 'num') + th('days', 'steps', 'Steps', 'num') +
                '</tr></thead><tbody>' +
                days.map((d) => `<tr><td>${dayText(d.day)}</td><td class="num">${costText(d.usd)}</td><td class="num">${d.steps}</td></tr>`).join('') +
                '</tbody></table>'
              : `<span class="muted">No spend kept for ${esc(a.agent)}.</span>`) +
            '</td></tr>';
        }
        return row;
      })
      .join('');
    const sum = (get) => all.reduce((s, a) => s + get(a), 0);
    const days = all[0]?.week.map((b, i) => ({ day: b.day, usd: sum((a) => a.week[i]?.usd ?? 0) })) ?? [];
    return (
      '<div class="toolbar"><button type="button" data-act="refresh">Refresh</button>' +
      `<span class="clock" title="When the data was read (the server's time, ${esc(W.settings.defs.timezone.default)})">${esc(localTime(AC.iso(now())))}</span>` +
      '<span class="result"></span><label for="cost-match">Agent</label>' +
      input('cost-match', 'filter.costs', { placeholder: 'for example home:* or a,b:*' }) +
      '<label for="cost-days">Days</label>' +
      input('cost-days', 'filter.days', { type: 'number', cls: 'days-field', placeholder: 'all', min: 1, step: 1, title: 'Total over the last so many days (empty: all time)' }) +
      check('costs-unregistered', 'boxes.costsGone', 'Unregistered') +
      '</div><table class="costs"><thead><tr>' +
      th('costs', 'agent', 'Agent') + th('costs', 'status', 'Status') +
      th('costs', 'today', 'Today', 'num') + th('costs', 'cap', 'Daily Cap') +
      '<th class="week">Last 7 Days</th>' + th('costs', 'total', title, 'num total') +
      '<th></th></tr></thead><tbody>' +
      (rows ||
        `<tr><td class="muted" colspan="7">${ui.filter.costs ? `No agent matches ${esc(ui.filter.costs)}.` : 'No agent has spent anything or is registered.'}</td></tr>`) +
      moreRow('costs', 7, page.left) + '</tbody>' +
      (all.length
        ? '<tfoot><tr class="totals">' +
          `<td class="agent" colspan="2">Total (${all.length} ${all.length === 1 ? 'agent' : 'agents'}${!n ? '' : n === 1 ? ', last day' : `, last ${n} days`})</td>` +
          `<td class="num today">${costText(sum((a) => a.today_usd))}</td><td></td>` +
          `<td class="week">${graph(days)}</td><td class="num total">${costText(sum((a) => a.total_usd))}</td><td></td></tr></tfoot>`
        : '') +
      '</table>' + footer()
    );
  }

  // -------------------------------------------------------------- history

  const dataSummary = (data) =>
    Object.entries(data)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(', ')
      .replace(/\s+/g, ' ');

  function history() {
    const pattern = ui.filter.history ?? '';
    const kind = ui.filter.kind ?? '';
    const counts = new Map();
    for (const e of W.history) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const kinds = [...counts].sort(([a], [b]) => a.localeCompare(b));
    const groups = [...new Set(kinds.map(([k]) => `${k.split('.')[0]}.*`))];
    const shown = W.history.filter(
      (e) =>
        (!pattern || matches(pattern, e.agent ?? '')) &&
        (!kind || (kind.endsWith('.*') ? e.kind.startsWith(kind.slice(0, -1)) : e.kind === kind)),
    );
    const page = paged('history', sorted('history', shown));
    const option = (value, label) =>
      `<option value="${esc(value)}"${kind === value ? ' selected' : ''}>${esc(label)}</option>`;
    return (
      '<div class="toolbar"><button type="button" data-act="refresh">Refresh</button><span class="result"></span>' +
      '<label for="history-match">Agent</label>' +
      input('history-match', 'filter.history', { placeholder: 'for example home:* or a:b,c:*' }) +
      '<label for="history-kind">Kind</label><select id="history-kind" data-model="filter.kind">' +
      option('', 'All kinds') +
      `<optgroup label="Groups">${groups.map((g) => option(g, g)).join('')}</optgroup>` +
      `<optgroup label="Kinds">${kinds.map(([k, n]) => option(k, `${k} (${n})`)).join('')}</optgroup>` +
      '</select></div><table class="history"><thead><tr>' +
      th('history', 'time', 'Time') + th('history', 'kind', 'Kind') + th('history', 'agent', 'Agent') +
      th('history', 'host', 'Host') + th('history', 'session', 'Session') + '<th>Data</th></tr></thead><tbody>' +
      (page.rows
        .map((e) => {
          const key = `history/${e.id}`;
          const open = ui.opened.has(key);
          const has = Object.keys(e.data ?? {}).length > 0;
          return (
            `<tr data-entry="${e.id}">` + timeCell(e.at) +
            `<td class="kind id-like"><code>${idHtml(e.kind)}</code></td>` +
            `<td class="agent id-like">${e.agent ? agentLink(e.agent, false, !agentOf(e.agent)) : ''}</td>` +
            `<td class="host id-like">${e.host ? hostLink(e.host) : ''}</td>` +
            `<td class="session id-like">${e.session ? `<code>${idHtml(e.session)}</code>` : ''}</td>` +
            (has
              ? `<td class="data folds" data-act="open" data-key="${key}"><span class="more${open ? ' json' : ''}" role="button" tabindex="0" aria-expanded="${open}">${esc(open ? JSON.stringify(e.data, null, 2) : folded(dataSummary(e.data)))}</span></td>`
              : `<td class="data">${dash}</td>`) +
            '</tr>'
          );
        })
        .join('') ||
        `<tr><td class="muted" colspan="6">${pattern || kind ? 'No entries match these filters.' : 'No history yet.'}</td></tr>`) +
      moreRow('history', 6, page.left) +
      '</tbody></table>' + footer()
    );
  }

  // ------------------------------------------------------------- settings

  // A setting's edit control: a list for the ones with fixed values, a
  // field for the rest.
  function valueInput(id, model, def, label) {
    const value = String(valueAt(model));
    if (def.values) {
      const values = def.values.includes(value) || !value ? def.values : [...def.values, value];
      return (
        `<app-value-input><select id="${id}" aria-label="${esc(label)}" data-model="${model}">` +
        values.map((v) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(v)}</option>`).join('') +
        '</select></app-value-input>'
      );
    }
    return `<app-value-input>${input(id, model, { label })}</app-value-input>`;
  }
  const message = (where) => {
    const n = ui.notice[where];
    return n ? `<p class="${n.bad ? 'errmsg' : 'notice'}" role="${n.bad ? 'alert' : 'status'}">${esc(n.text)}</p>` : '';
  };

  function settings() {
    const s = W.settings;
    const keys = Object.keys(s.defs);
    const agentKeys = keys.filter((k) => s.defs[k].scope === 'agent');
    ui.fields.set ??= {};
    for (const k of keys) ui.fields.set[k] ??= valueText(k in s.server ? s.server[k] : s.defs[k].default);
    const server = keys
      .map((k) => {
        const set = k in s.server;
        const current = valueText(set ? s.server[k] : s.defs[k].default);
        return (
          `<tr data-key="${k}"><td class="key id-like"><code>${idHtml(k)}</code></td>` +
          '<td class="value"><div class="inline-edit">' +
          valueInput(`set-${k}`, `fields.set.${k}`, s.defs[k], `Value of ${k}`).replace('<input', `<input data-enter="save-setting" data-id="${k}"`) +
          `<button type="button" class="small" data-act="save-setting" data-id="${k}"${String(ui.fields.set[k]) === current ? ' disabled' : ''}>Save</button>` +
          `<button type="button" class="small" title="Back to the built-in default" data-act="reset-setting" data-id="${k}"${set ? '' : ' disabled'}>Reset</button></div></td>` +
          `<td class="from${set ? ' set' : ''}">${set ? 'set server-wide' : 'built-in default'}</td>` +
          `<td class="scope">${s.defs[k].scope}</td><td class="help">${esc(s.defs[k].help)}</td></tr>`
        );
      })
      .join('');
    const d = ui.rule;
    const rules = s.rules
      .map(
        (r, i) =>
          `<tr data-rule="${i + 1}"><td class="num">${i + 1}</td>` +
          `<td class="match id-like"><code>${idHtml(r.match)}</code></td><td class="pairs">` +
          (Object.entries(r.values)
            .map(([k, v]) => `<span class="pair"><code>${k}</code> = ${esc(valueText(v))}</span>`)
            .join('') || '<span class="muted">no settings</span>') +
          '</td><td class="actions">' +
          `<button type="button" data-act="edit-rule" data-n="${i}"${d ? ' disabled' : ''}>Edit</button>` +
          `<button type="button" title="Move up" aria-label="Move rule ${i + 1} up" data-act="move-rule" data-n="${i}" data-by="-1"${d || i === 0 ? ' disabled' : ''}>&uarr;</button>` +
          `<button type="button" title="Move down" aria-label="Move rule ${i + 1} down" data-act="move-rule" data-n="${i}" data-by="1"${d || i === s.rules.length - 1 ? ' disabled' : ''}>&darr;</button>` +
          `<button type="button" data-act="remove-rule" data-n="${i}"${d ? ' disabled' : ''}>Remove</button></td></tr>`,
      )
      .join('');
    const editor = d
      ? `<div class="editor"><h3>${d.index === null ? 'New Rule' : `Rule ${d.index + 1}`}</h3>` +
        '<label for="rule-match">Match</label>' +
        input('rule-match', 'rule.match', { placeholder: 'for example home:* or a:b,c:*' }) +
        '<label>Settings</label><table class="items"><tbody>' +
        (d.items
          .map(
            (item, n) =>
              `<tr><td><select aria-label="Setting ${n + 1}" id="rule-key-${n}" data-model="rule.items.${n}.key">` +
              agentKeys
                .filter((k) => k === item.key || !d.items.some((x) => x.key === k))
                .map((k) => `<option value="${k}"${k === item.key ? ' selected' : ''}>${k}</option>`)
                .join('') +
              `</select></td><td>${valueInput(`rule-value-${n}`, `rule.items.${n}.value`, s.defs[item.key], `Value ${n + 1}`)}</td>` +
              `<td><button type="button" class="small" data-act="rule-remove-item" data-n="${n}">Remove</button></td></tr>`,
          )
          .join('') || '<tr><td class="muted" colspan="3">No settings yet.</td></tr>') +
        '</tbody></table><div class="buttons">' +
        '<button type="button" class="small" data-act="rule-add-item">Add a Setting</button><span class="spacer"></span>' +
        '<button type="button" data-act="save-rule">Save Rule</button>' +
        '<button type="button" data-act="cancel-rule">Cancel</button></div></div>'
      : '<div class="buttons"><button type="button" data-act="add-rule">Add a Rule</button></div>';
    const own = s.agents
      .map((row, n) => {
        const editing = ui.own && ui.own.n === n;
        return (
          `<tr data-agent="${esc(row.agent)}" data-key="${row.key}"><td class="id id-like">${agentLink(row.agent)}</td>` +
          `<td class="key id-like"><code>${idHtml(row.key)}</code></td><td class="value">` +
          (editing
            ? '<div class="inline-edit">' +
              valueInput('own-value', 'own.value', s.defs[row.key], `New value of ${row.key} for ${row.agent}`).replace('<input', '<input data-enter="save-own"') +
              '<button type="button" class="small" data-act="save-own">Save</button>' +
              '<button type="button" class="small" data-act="cancel-own">Cancel</button></div>'
            : esc(valueText(row.value))) +
          '</td><td class="actions">' +
          `<button type="button" data-act="change-own" data-n="${n}"${editing ? ' disabled' : ''}>Change</button>` +
          `<button type="button" data-act="remove-own" data-n="${n}">Remove</button></td></tr>`
        );
      })
      .join('');
    const r = ui.resolved;
    return (
      '<h2 class="first">Server Settings</h2><p class="muted">Each value applies to the whole server. ' +
      'Settings with scope "agent" can be changed further by the rules and by an agent\'s own values below.</p>' +
      message('server') +
      '<table class="settings"><thead><tr><th>Setting</th><th>Value</th><th>From</th><th>Scope</th><th>Description</th></tr></thead>' +
      `<tbody>${server}</tbody></table>` +
      '<h2>Rules</h2><p class="muted">A rule sets values for the agents whose ID matches its pattern (<code>*</code> ' +
      'matches anything; separate several patterns with commas). The first matching rule counts; an agent\'s own values count more.</p>' +
      message('rules') +
      '<table class="rules"><thead><tr><th>#</th><th>Match</th><th>Settings</th><th></th></tr></thead><tbody>' +
      (rules || '<tr><td class="muted" colspan="4">No rules.</td></tr>') +
      `</tbody></table>${editor}` +
      "<h2>Agents' Own Values</h2><p class=\"muted\">Values set for one agent ID. They count more than the rules and the server-wide values.</p>" +
      message('own') +
      '<table class="agent-values"><thead><tr><th>Agent</th><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>' +
      (own || '<tr><td class="muted" colspan="4">No agent has its own values.</td></tr>') +
      '</tbody></table><div class="add-row"><div><label for="agent-value-id">Agent ID</label>' +
      input('agent-value-id', 'newOwn.agent', { placeholder: 'for example home:chief', list: 'known-agents' }) +
      `<datalist id="known-agents">${W.agents.map((a) => `<option value="${esc(a.id)}"></option>`).join('')}</datalist>` +
      '</div><div><label for="agent-value-key">Setting</label><select id="agent-value-key" data-model="newOwn.key">' +
      agentKeys.map((k) => `<option value="${k}"${k === ui.newOwn.key ? ' selected' : ''}>${k}</option>`).join('') +
      '</select></div><div><label>Value</label>' +
      valueInput('agent-value-value', 'newOwn.value', s.defs[ui.newOwn.key], 'Value').replace('<input', '<input data-enter="add-own"') +
      '</div><div class="go"><button type="button" data-act="add-own">Set</button></div></div>' +
      '<h2>Resolved for an Agent</h2><p class="muted">The values an agent ID gets from all of the above, and where each one comes from.</p>' +
      '<div class="toolbar"><label for="resolve-agent">Agent ID</label>' +
      input('resolve-agent', 'filter.resolve', { placeholder: 'for example home:chief', list: 'known-agents', enter: 'resolve' }) +
      '<button type="button" data-act="resolve">Show</button></div>' +
      (r
        ? `<table class="resolved" data-agent="${esc(r)}"><thead><tr><th>Setting</th><th>Value for ${agentLink(r)}</th><th>From</th></tr></thead><tbody>` +
          agentKeys
            .map((k) => {
              const v = resolve(r, k);
              return `<tr data-key="${k}"><td class="key id-like"><code>${idHtml(k)}</code></td><td class="value">${esc(valueText(v.value))}</td><td class="from">${esc(v.from)}</td></tr>`;
            })
            .join('') +
          '</tbody></table>'
        : '')
    );
  }

  // ----------------------------------------------------------------- help

  function help() {
    const h = window.DEMO_HELP;
    return (
      '<div class="layout"><nav class="toc" aria-label="Contents">' +
      h.sections
        .map((s) => `<a href="#/help/${s.id}"${s.sub ? ' class="sub"' : ''}><span class="n">${s.n}</span> ${esc(s.label)}</a>`)
        .join('') +
      `</nav><article>${h.html}</article></div>`
    );
  }

  AC.pages = { hosts, agents, inbox, messages, locks, wakes, jobs, costs, history, settings, help };
  AC.sort = { SORT, natural, sortState };
  AC.inboxRows = inboxRows;
  AC.field = field;
  AC.valueAt = valueAt;
})();
