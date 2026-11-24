/*
 * The demo's invented world: one person's home life and their engineering
 * project, run by 12 agents on 3 machines. The home team (home:*) is a chief
 * of staff with a fetcher, a bookkeeper, a mail drafter, and agents for the
 * house, a trip and the photos; the project team (trailmap:*) builds a route
 * planner. Every name, number and text here is made up.
 *
 * The story is one Monday morning, 09:12: the agents worked through the
 * night and the weekend, and a few decisions wait for the owner. Every time
 * below is a clock time of that Monday (or so many days before it), so the
 * tabs agree with each other: a wake's cron, when it last fired, the report
 * it led to. The page sets the clock to the Monday of the current week.
 */
window.DEMO_WORLD = function buildWorld(base) {
  'use strict';
  const MIN = 60000;
  const iso = (ms) => new Date(ms).toISOString();
  const day0 = new Date(base);
  // A clock time ("07:04", "09:08:50") of the demo's Monday, or of the day
  // so many days before it, in milliseconds.
  const ms = (clock, back = 0) => {
    const [h, m, s = 0] = clock.split(':').map(Number);
    return new Date(
      day0.getFullYear(), day0.getMonth(), day0.getDate() - back, h, m, s,
    ).getTime();
  };
  const at = (clock, back = 0) => iso(ms(clock, back));
  // The day (YYYY-MM-DD) so many days before the demo's Monday.
  const day = (back) => {
    const d = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() - back);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  };
  // The six days before today, oldest first, then today.
  const week = (...usd) => usd.map((v, i) => ({ day: day(6 - i), usd: v }));
  // A day so many days after the demo's Monday, as people write it:
  // "Sat 16 Jan".
  const dateIn = (days) =>
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      .format(new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + days))
      .replace(',', '');
  // The winter trip: out on a Saturday about 8 weeks away, back 2 weeks later.
  const OUT = dateIn(54);
  const BACK = dateIn(68);
  // The latest first day of a month at 09:00, as a monthly wake last fired.
  const FIRST = (() => {
    const first = (back) => new Date(day0.getFullYear(), day0.getMonth() - back, 1, 9, 0).getTime();
    return first(0) <= base ? first(0) : first(1);
  })();
  // The ID of a job's run that started at a clock time.
  const RUN = (job, clock, back = 0) => `${job}:${at(clock, back).slice(0, 16)}`;

  const SONNET = ['anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5'];
  const OPUS = ['anthropic/claude-opus-5-5', 'Claude Opus 5.5'];
  const HAIKU = ['anthropic/claude-haiku-5-5', 'Claude Haiku 5.5'];

  const HOME = 'home-server:household:3fa9c1d2';
  const CODE = 'workstation:trailmap:a07be9c4';
  const ML = 'workstation:trailmap-ml:71c2d0f4';
  const PHOTOS = 'workstation:photos:5e8813bd';
  const LAPTOP = 'laptop:notes:c41f77e0';

  const hosts = [
    [HOME, 'home-server', '/home/dev/household', 'service', 2164, null],
    [CODE, 'workstation', '/home/dev/trailmap', 'service', 41872, null],
    [ML, 'workstation', '/home/dev/trailmap-ml', 'service', 41872, null],
    [PHOTOS, 'workstation', '/home/dev/photos', 'service', 41872, null],
    [LAPTOP, 'laptop', '/Users/dev/notes', 'serve', 88410, at('18:04', 3)],
  ].map(([id, machine, directory, kind, pid, seen]) => ({
    id,
    machine,
    directory,
    online: seen === null,
    process_kind: kind,
    process_pid: pid,
    shell_values: true,
    opencode_version: '2.3.0',
    plugin_version: '1.1.0-rc6-build1',
    last_seen: seen ?? iso(base),
  }));

  /*
   * An agent: who it is, where it runs, what it spent. `cycle` makes an agent
   * work in bursts (seconds of work, of rest, and where in the round it is
   * when the page opens); the page derives its status from all of it.
   */
  const agent = (id, description, model, effort, host, o) => ({
    id,
    description,
    model: model[0],
    model_name: model[1],
    effort,
    host,
    directory: hosts.find((h) => h.id === host).directory,
    session: o.session,
    registered: true,
    registered_at: at(o.registered[1], o.registered[0]),
    last_active: o.active ?? iso(base),
    paused: o.paused ?? null,
    error: o.error ?? null,
    cycle: o.cycle ?? null,
    busy_until: 0,
    cost: {
      today_usd: o.today,
      total_usd: o.total,
      context: o.context,
      compact_at: o.compact,
      context_limit: o.limit,
    },
    week: week(...o.week, o.today),
  });

  const agents = [
    agent(
      'home:chief',
      'Chief of staff at home: the morning briefing, what is due and what slips; decides what the others cannot.',
      OPUS, 'high', HOME,
      { session: 'ses_7c2f4a91d0be', registered: [16, '08:02'], today: 2.84,
        total: 58.3, context: 164200, compact: 500000, limit: 1000000,
        week: [3.9, 4.4, 3.6, 4.8, 2.2, 2.6], cycle: [38, 52, 9] },
    ),
    agent(
      'home:watch',
      'Fetches what moved: the bank feed, the mail, portals and watched pages. Files it and tells who cares. Never asks, never sends.',
      HAIKU, 'medium', HOME,
      { session: 'ses_a3170cd45e68', registered: [16, '08:04'], active: at('09:08:50'),
        today: 0.84, total: 22.1, context: 61300, compact: 100000,
        limit: 200000, week: [1.6, 1.9, 1.4, 2.1, 1.1, 1.2],
        error: { type: 'provider.overloaded', retries: 2, since: at('09:08:50'), next_retry: iso(base + 38000) } },
    ),
    agent(
      'home:books',
      'Bills, subscriptions and spending against the usual. Never pays and never cancels on its own.',
      SONNET, 'medium', HOME,
      { session: 'ses_2e70a1c9d384', registered: [16, '08:06'], active: at('09:06'),
        today: 0.74, total: 17.9, context: 72500, compact: 500000,
        limit: 1000000, week: [0.6, 0.3, 0.9, 0.4, 0, 0] },
    ),
    agent(
      'home:mail',
      "Summarizes threads and drafts answers. Sends nothing in the owner's name without a yes.",
      SONNET, 'medium', HOME,
      { session: 'ses_c05d21fe8843', registered: [16, '08:07'], active: at('08:47'),
        today: 0.42, total: 11.6, context: 58200, compact: 500000,
        limit: 1000000, week: [0.9, 1.2, 0.8, 1.3, 0.3, 0.4] },
    ),
    agent(
      'home:house',
      'The house and the car: maintenance windows, quotes, warranties, the home automation.',
      HAIKU, 'low', HOME,
      { session: 'ses_f61c93b82d07', registered: [16, '08:09'], active: at('08:20'),
        today: 0.31, total: 4.35, context: 21200, compact: 100000,
        limit: 200000, week: [0.2, 0.1, 0.3, 0.2, 0.4, 0.1] },
    ),
    agent(
      'home:trip',
      'Project: the winter trip. Budget $6,000. Watches fares and holds options; books only what was approved.',
      SONNET, 'medium', HOME,
      { session: 'ses_4b6d0e9f17c2', registered: [5, '13:02'], active: at('09:03'),
        today: 1.37, total: 9.84, context: 96400, compact: 500000,
        limit: 1000000, week: [0, 0.2, 1.9, 0.3, 0.6, 0.4] },
    ),
    agent(
      'home:photos',
      'Sorts the photo library each night: duplicates, faces, albums. Waits its turn for gpu:0.',
      SONNET, 'medium', PHOTOS,
      { session: 'ses_9d42c7b0e1f5', registered: [12, '11:34'], active: at('07:36'),
        today: 8.02, total: 61.4, context: 265900, compact: 500000,
        limit: 1000000, week: [5.2, 6.1, 4.8, 6.6, 7.4, 7.9], paused: 'cap' },
    ),
    agent(
      'home:notes',
      'Files notes from calls and appointments and follows up on what was promised.',
      SONNET, 'low', LAPTOP,
      { session: 'ses_08b5e3a6c9d1', registered: [12, '13:20'], active: at('18:04', 3),
        today: 0, total: 3.37, context: 42700, compact: 500000,
        limit: 1000000, week: [0.3, 0, 0.4, 0.5, 0, 0] },
    ),
    agent(
      'trailmap:api',
      'Routing API. Now: moving the tile cache from Redis to SQLite (issue 412).',
      SONNET, 'high', CODE,
      { session: 'ses_19e0b77c35aa', registered: [9, '10:05'], today: 7.91,
        total: 104.3, context: 187400, compact: 500000, limit: 1000000,
        week: [11.2, 14.6, 9.8, 16.1, 4.4, 12.9], cycle: [52, 40, 61] },
    ),
    agent(
      'trailmap:tests',
      'Keeps CI green: reruns flaky tests, bisects failures, tells whoever broke it.',
      HAIKU, 'medium', CODE,
      { session: 'ses_e8a94c02b716', registered: [9, '10:08'], today: 2.36,
        total: 39.4, context: 81700, compact: 100000, limit: 200000,
        week: [5.3, 4.9, 6.6, 5.8, 2.2, 4.1], cycle: [44, 31, 30] },
    ),
    agent(
      'trailmap:release',
      "Weekly release: changelog, tag, staging. Production only with the owner's approval.",
      SONNET, 'medium', CODE,
      { session: 'ses_d1c8a5f02e94', registered: [9, '10:11'], active: at('08:38'),
        today: 1.18, total: 12.66, context: 54100, compact: 500000,
        limit: 1000000, week: [0, 0.4, 0, 0.2, 0, 0.3] },
    ),
    agent(
      'trailmap:elevation',
      'Trains the elevation model, one experiment at a time on gpu:0.',
      OPUS, 'high', ML,
      { session: 'ses_51fb8e26a09d', registered: [9, '11:30'], active: at('03:56'),
        today: 5.2, total: 143.75, context: 402600, compact: 500000,
        limit: 1000000, week: [19.4, 22.8, 17.1, 25.3, 20.6, 18.9] },
    ),
  ];

  // An agent that unregistered: its spend is kept.
  const gone = [
    {
      id: 'trailmap:spike',
      description: 'One-week spike: vector tiles on the client.',
      model: SONNET[0], model_name: SONNET[1], effort: 'high',
      host: null, directory: '/home/dev/trailmap', session: 'ses_d7e21a40f93b',
      registered: false, registered_at: null, last_active: at('16:42', 4),
      paused: null, error: null, cycle: null, busy_until: 0,
      cost: { today_usd: 0, total_usd: 6.48, context: null, compact_at: null, context_limit: null },
      week: week(0, 0, 3.1, 0, 0, 0, 0),
    },
  ];

  const BRIEF =
    '**Today**\n' +
    '- 10:00 design review.\n' +
    '- 12:30 lunch with the accountant; her 3 open questions are in notes/accountant.md.\n' +
    '- The electricity bill ($198.30) leaves the account on autopay.\n\n' +
    '**Tomorrow**\n' +
    '- The school form for the museum visit is due. It is filled in and needs your signature: forms/museum-visit.pdf.\n\n' +
    '**Slipping**\n' +
    '- The car is 400 km past its service; the garage has not answered since Thursday.\n' +
    '- One passport expires 7 months from now. The winter trip needs 6 months left on the day you fly back: enough, by 3 weeks.\n\n' +
    '**Since Friday**\n' +
    '- 61 new mails: 48 filed, 9 need no answer, 4 drafts wait in drafts/.\n' +
    '- 2,318 photos from the weekend are sorted into 3 albums.\n' +
    '- The fare for the winter trip fell 4%; home:trip holds one if it falls below $1,300.';
  const BILLS =
    '3 bills this week, $612.40 in total.\n\n' +
    '- Electricity, $198.30, today: on autopay.\n' +
    '- Internet, $74.00, Thursday: on autopay.\n' +
    '- Water, $340.10, Friday: not on autopay, and twice the usual ($168 on average). home:house looks for the cause before I ask you to pay it.\n\n' +
    '**Subscriptions**\n' +
    '- The video editor\'s trial converts on Thursday at $23.99 a month. Nobody has opened it for 3 weeks: I ask you on Wednesday whether to cancel it.\n' +
    '- The photo storage plan renews next month at $9.99, as before.';
  const FLAKY =
    '`route_merge_test` failed 3 of the last 40 runs on main, each time in ' +
    '`TestMergeAtSwitchback`. I ran it 200 times here: 7 failures, all when ' +
    'two segments share an endpoint within 1 m.\n\n' +
    '- Quarantine it: CI stays green, issue 431 tracks it.\n' +
    '- Leave it red until trailmap:api fixes the merge.\n\n' +
    'I quarantine it at 13:00 unless you say otherwise.';
  const EXP =
    'exp-26: validation error 3.82 m (baseline 3.98 m), so the wider ' +
    'receptive field helps. I started exp-27 with it and a longer ' +
    'schedule; it needs gpu:0 for about 7 hours. I am woken when it ends.';
  const BACKUP =
    "All 3 of last night's backups verify: documents (2.1 GB), photos " +
    '(412 GB, 2,318 new files), code (18.4 GB). A test restore of the ' +
    'documents took 41 s.';
  const REVIEW =
    'Approve with two changes. (1) cache/open.go:88 opens the store before the schema check, so a cold start can hand out a nil store. (2) cache_warm_test never runs with the flag off. Naming and structure are fine.';
  const AUDIT =
    'Nothing blocking. One note: web/package.json adds maplibre-gl@5 (BSD-3-Clause), compatible with our licence. No secrets in the 14 commits read.';
  const COSTS =
    'Last week: $304.70 across 12 agents. trailmap:elevation spent the most ($124.10, 6 experiments); at home, home:photos ($38.00). The wake sources of home:watch fell due 336 times and its check skipped 301. Suggestion: give nightly-sort a check that skips nights without new photos.';

  const inbox = [
    {
      id: 'ask_5f0c1e77a2b94d3180ce', kind: 'approval', agent: 'trailmap:release',
      routed: 'owner', created_at: at('08:38'), expires: at('12:38'),
      title: 'Approval for trailmap:release',
      text:
        'Deploy v0.19.0 to production?\n\n' +
        'Staging has run it for 7 hours: smoke tests 42 of 42, error rate 0.02% ' +
        '(last week 0.03%), p95 route time 184 ms (was 231 ms).\n' +
        'Changelog: docs/changelog/0.19.0.md. Rollback: one command, tried on staging.\n\n' +
        'If you reject, v0.19.0 stays on staging and I ask again tomorrow.',
      options: ['now', 'tonight'],
    },
    {
      id: 'ask_b2a4097d6e1f4c58a3d0', kind: 'permission', agent: 'home:mail',
      routed: 'agent:home:chief', created_at: at('08:47'),
      title: 'Permission for home:mail: mail_send to: office@harbor-dental.example, subject: Re: Thursday 16:30',
      action: 'mail_send',
      resources: ['to: office@harbor-dental.example', 'subject: Re: Thursday 16:30'],
      message: null,
      notes: ["home:chief: mail in the owner's name is not mine to allow. The draft accepts Friday 08:10, which is free in the calendar; it is in drafts/dentist.md."],
    },
    {
      id: 'ask_91d3e5c80f724ab6b1e2', kind: 'question', agent: 'home:house',
      routed: 'owner', created_at: at('08:20'),
      title: 'Question from home:house: Car service',
      questions: [
        {
          header: 'Car service',
          question:
            'The car is 400 km past its service. The garage offers two slots ' +
            'this week; each takes about 2 hours and comes with a loan car. ' +
            'Which one do I book?',
          options: ['Wednesday 08:00', 'Saturday 10:30', 'Neither: ask for next week'],
          multiple: false,
        },
      ],
    },
    {
      id: 'ask_a47c0d3e9b1f4862a5d7', kind: 'approval', agent: 'home:trip',
      routed: 'owner', created_at: at('09:03'), expires: at('12:00'),
      title: 'Approval for home:trip',
      text:
        `Book 3 seats for the winter trip? Out ${OUT}, back ${BACK}.\n\n` +
        'direct: $1,284 in total, 11% below last week. I hold it until 12:00.\n' +
        'one stop: $1,036 in total, 5 hours longer each way. Not held.\n\n' +
        "The trip's budget has $1,500 for flights. If you reject, I let the hold go and keep watching.",
      options: ['direct', 'one stop'],
    },
    {
      id: 'm_3c9a1d04e7b2f6851a0d', kind: 'message', agent: 'trailmap:tests',
      created_at: at('07:50'), title: 'Flaky test: quarantine or leave red?',
      body: FLAKY,
    },
    {
      id: 'in_7e12b0c4d95a3f6e8102', kind: 'alert', agent: 'home:photos',
      created_at: at('07:36'),
      title: 'home:photos reached its daily cap ($8.02 of $8.00)',
      body:
        "It is paused until tomorrow (the server's zone), or until you " +
        'raise daily_usd or resume it.',
    },
    {
      id: 'm_60d2c8f1a3e94b7705bc', kind: 'message', report: true,
      agent: 'home:books', created_at: at('08:06'), title: 'Bills this week',
      body: BILLS,
    },
    {
      id: 'm_a81f5e2c907d4b3610fe', kind: 'message', report: true,
      agent: 'home:chief', created_at: at('06:34'), title: 'Morning briefing',
      body: BRIEF,
    },
    {
      id: 'm_f4b7093e1d2c5a68e970', kind: 'message', report: true,
      agent: 'trailmap:elevation', created_at: at('03:55'),
      title: 'exp-26 finished, exp-27 started', body: EXP,
    },
    // closed ones: shown with the Closed box
    {
      id: 'ask_c7a02f5e8d1b4963a0e4', kind: 'question', agent: 'trailmap:elevation',
      routed: 'auto_answer', created_at: at('03:50'), closed_at: at('03:50'),
      state: 'answered', by: 'auto',
      title: 'Question from trailmap:elevation: exp-27',
      questions: [{ header: 'exp-27', question: 'exp-26 beat the baseline. Which change does exp-27 try first?', options: ['a longer schedule', 'a deeper encoder', 'both'], multiple: false }],
      answer: { answer: { 0: 'Act according to your best judgement and safe practices to achieve my goals.' } },
    },
    {
      id: 'ask_0e6b4d91c2a75f38d1b7', kind: 'permission', agent: 'home:photos',
      routed: 'agent:home:chief', created_at: at('02:40'), closed_at: at('02:41'),
      state: 'answered', by: 'home:chief',
      title: 'Permission for home:photos: shell exiftool -overwrite_original -r inbox/weekend',
      action: 'shell', resources: ['exiftool -overwrite_original -r inbox/weekend'], message: null,
      answer: { decision: 'once' },
    },
    {
      id: 'in_29c6e0b8f4d17a53c6e1', kind: 'alert', agent: null,
      created_at: at('03:30', 1), closed_at: at('10:14', 1), state: 'closed',
      title: `Run ${RUN('nightly-audit', '03:00', 1)} failed: time limit (30m)`,
      body: 'Its session ses_6a0d93f1c2e7 is kept for you to look at; delete it on the Jobs page or with autocode job delete-session.',
    },
    {
      id: 'ask_38f1d7a6b0c24e59927a', kind: 'approval', agent: 'home:books',
      routed: 'owner', created_at: at('15:02', 3), closed_at: at('15:50', 3),
      state: 'answered', by: 'owner',
      title: 'Approval for home:books',
      text:
        'Renew the car insurance at $1,148 for the year (last year $1,096)? ' +
        'I compared 3 other insurers: the cheapest with the same cover is ' +
        '$1,121, with a $500 higher deductible.',
      answer: { decision: 'approve', text: 'same cover, renew' },
    },
    {
      id: 'm_1b9e6f30d4a7c2581e63', kind: 'message', agent: 'trailmap:api',
      created_at: at('11:20', 3), closed_at: at('11:41', 3), state: 'closed',
      title: 'Redis: keep it as a fallback?',
      body: 'After the move to SQLite, do we keep Redis as a fallback for one release, or remove it now?',
      answer: 'Keep it for one release, behind the flag.',
    },
  ];

  // [id, when, from, to, subject, text, state, via]
  const messages = [
    ['m_e94b2f6a1c05d7830f2b', at('09:10'), 'home:chief', 'home:notes', 'Open follow-ups',
      "Two things promised in Thursday's call with the school are still open: the signed form, and an answer about the bus. Which of them is done?", 'queued'],
    ['m_4d81b6e2a09c7f35d2a6', at('09:09'), 'home:chief', 'home:watch', 'This week',
      "This week: add the school's calendar page to what you watch. The garage's portal can go once the service is booked.", 'queued'],
    ['m_c2f09a7d5e1b4836f0c4', at('09:08'), 'home:chief', 'home:trip', 'This week',
      'This week: the flights, once the owner decides. Then hold two places to stay for the first three nights and ask.', 'queued'],
    ['m_97a3e0c1b6d8f254a7e9', at('09:07'), 'home:chief', 'home:house', 'This week',
      'This week: the car service once the owner picks a slot; then two quotes for cleaning the gutters before the rain on Saturday.', 'queued'],
    ['m_1e6d8b4f0a2c9573e8b1', at('09:06'), 'home:chief', 'home:photos', 'This week',
      "This week: the nightly sorting as usual. Last winter's album wants its faces grouped again once gpu:0 is free.", 'queued'],
    ['m_b5c7e20d9f1a6438c3d7', at('09:05'), 'home:chief', 'home:mail', 'This week',
      "This week: the accountant's 3 questions come first. Nothing goes out in the owner's name without a yes.", 'queued'],
    ['m_6f2a4c8e1d7b0953b4e2', at('09:05'), 'home:chief', 'home:books', 'This week',
      "This week: the water bill is right, so ask the owner about it on Wednesday. Then last month's receipts into the ledger for the accountant.", 'processed', 'prompt'],
    ['m_d2e7a90c4f1b3658b7a1', at('09:04'), 'trailmap:tests', 'trailmap:api', 'main is red',
      'Your merge of PR 418 broke `cache_warm_test`: a nil store on a cold start. I bisected it to 3 commits; the fix is likely in `cache/open.go`. I do not touch it unless you ask.', 'queued'],
    ['m_b08d5c2e7a914f63d5a0', at('09:01'), 'autocode', 'trailmap:tests', 'lock "ci-runners" granted',
      'You hold "ci-runners" (1 of 3 places) until 10:01. Renew it before then, or release it when you are done.', 'processed', 'steer'],
    ['m_3c9a1d04e7b2f6851a0d', at('07:50'), 'trailmap:tests', 'owner', 'Flaky test: quarantine or leave red?', FLAKY, 'queued'],
    ['m_77c0e1b5a8d34f92e61c', at('08:50'), 'home:chief', 'home:mail', 'Re: answer to the dentist',
      'I passed your send on to the owner: mail in their name is not mine to allow. Keep the draft as it is.', 'queued'],
    ['m_2b7e91c4a0d35f68e1c3', at('08:19'), 'home:house', 'home:books', 'Re: Water bill twice the usual',
      'No leak: the meter stands still at night. The irrigation ran 14 times last month instead of 6: its controller lost the schedule in a power cut and fell back to daily. I set the schedule again. The bill is right, only high.', 'processed', 'prompt'],
    ['m_8c05d3f7b1e94a62d7f0', at('08:40'), 'home:watch', 'home:mail', 'Dentist: Thursday moved',
      "The dentist's office wrote at 08:21: Thursday 16:30 no longer works for them. They offer Friday 08:10, or the same time a week later.", 'processed', 'prompt'],
    ['m_f1a6c8e03b7d4925a8b4', at('08:10'), 'home:watch', 'home:house', 'The garage answered',
      'The garage answered in its portal: Wednesday 08:00 or Saturday 10:30 for the service, about 2 hours, with a loan car.', 'processed', 'prompt'],
    ['m_5d9b2e7a4c1f0836b9e5', at('08:07'), 'home:books', 'home:house', 'Water bill twice the usual',
      'The water bill is $340.10 against $168 on average. Before I ask the owner to pay it: is anything leaking, or did the irrigation run more than it should?', 'processed', 'prompt'],
    ['m_60d2c8f1a3e94b7705bc', at('08:06'), 'home:books', 'owner', 'Bills this week', BILLS, 'queued'],
    ['m_c94e1a7f3b0d5268e4a1', at('08:02'), 'autocode', 'home:chief', `result of run ${RUN('weekly-costs', '08:00')}`, COSTS, 'processed', 'prompt'],
    ['m_a3e7c05b9d2f4186c0a7', at('07:40'), 'home:watch', 'home:books', 'Bank feed and bills',
      "Since yesterday: 3 new transactions, all known. The water utility's bill is in the mail archive: $340.10, due Friday.", 'processed', 'prompt'],
    ['m_41f6a9d0c3e85b27a94d', at('07:28'), 'autocode', 'home:photos', 'cost warning',
      'You have spent $7.24 of your daily cap of $8.00. Past the cap you are paused after the turn that passed it. Finish what matters first.', 'processed', 'steer'],
    ['m_e03b7d5a9c1f2648a5c0', at('08:57'), 'home:chief', 'home:trip', 'Re: Winter trip: a fare to hold',
      'Both Saturdays are free. School ends the day before you leave and starts two days after you are back.', 'processed', 'steer'],
    ['m_2f51b9c7d0e64a83f17e', at('08:53'), 'home:trip', 'home:chief', 'Winter trip: a fare to hold',
      `The direct fare fell to $1,284 for 3 seats, and I can hold it until 12:00. Are ${OUT} and ${BACK} still free?`, 'processed', 'prompt'],
    ['m_c6a8f24e0b7d1935e82f', at('06:40'), 'trailmap:api', 'trailmap:tests', 'PR 418 merged',
      'The SQLite schema is on main behind `TILE_CACHE=sqlite`. Please run the cache suites with the flag on and off.', 'processed', 'prompt'],
    ['m_a81f5e2c907d4b3610fe', at('06:34'), 'home:chief', 'owner', 'Morning briefing', BRIEF, 'queued'],
    ['m_7a2c4e6b8d0f1357a9c2', at('06:26'), 'autocode', 'trailmap:api', `result of run ${RUN('trailmap:api:pr-review', '06:20')}`, REVIEW, 'processed', 'prompt'],
    ['m_0d4f6a8c2e1b3957c4d6', at('04:04'), 'autocode', 'home:chief', `result of run ${RUN('backup-check', '04:00')}`, BACKUP, 'processed', 'prompt'],
    ['m_f4b7093e1d2c5a68e970', at('03:55'), 'trailmap:elevation', 'owner', 'exp-26 finished, exp-27 started', EXP, 'queued'],
    ['m_0b6c3e9a7f2d4518c7e0', at('03:53'), 'autocode', 'trailmap:elevation', 'lock "gpu:0" granted',
      'You hold "gpu:0" until 12:53. Renew it before then, or release it when you are done.', 'processed', 'steer'],
    ['m_5e2a8d1c9b0f7346a2d8', at('03:52'), 'home:photos', 'trailmap:elevation', 'gpu:0 is yours',
      "The night's sorting is done: 2,318 photos, 41 minutes. I released gpu:0.", 'processed', 'steer'],
    ['m_b61d0f9e3a7c4825d3f8', at('03:09'), 'autocode', 'trailmap:tests', `result of run ${RUN('nightly-audit', '03:00')}`, AUDIT, 'processed', 'prompt'],
    ['m_9e3d70b1f5a2c468d0b3', at('01:27'), 'trailmap:release', 'trailmap:tests', 'v0.19.0 on staging',
      'v0.19.0 is tagged and on staging; I hold the lock `staging` until production is decided. Smoke tests: 42 of 42.', 'processed', 'prompt'],
    ['m_8d07e4a2c6f19b35a4c9', at('17:48', 3), 'owner', 'home:chief', 'Next week',
      'Next week: the winter trip first, then the papers for the accountant. And get the car serviced.', 'processed', 'prompt'],
  ].map(([id, when, from, to, subject, text, state, via]) => ({
    id, created_at: when, from, to, subject, text, size: text.length, state,
    processed_via: via ?? null,
    processed_at: via ? iso(Date.parse(when) + 20000) : null,
  }));

  const locks = [
    {
      name: 'gpu:0', max: 1,
      holders: [{ agent: 'trailmap:elevation', expires: at('12:53') }],
      queue: [{ position: 1, agent: 'home:photos', since: at('07:35') }],
    },
    {
      name: 'ci-runners', max: 3,
      holders: [
        { agent: 'trailmap:tests', expires: at('10:01') },
        { agent: 'trailmap:api', expires: at('09:50') },
      ],
      queue: [],
    },
    {
      name: 'staging', max: 1,
      holders: [{ agent: 'trailmap:release', expires: at('13:24') }],
      queue: [],
    },
    // the one browser profile that is signed in to the airline and the portals
    {
      name: 'browser', max: 1,
      holders: [{ agent: 'home:trip', expires: at('12:54') }],
      queue: [],
    },
  ];

  /*
   * [agent, name, trigger, text, check, check timeout, set by, last set,
   * last fired (or null), last 7 days: usd, turns, due, skipped, and what the
   * check prints when it passes while the page is open (else it skips)]
   */
  const monthly = base - FIRST < 7 * 24 * 60 * MIN;
  const wakes = [
    ['home:chief', 'morning-briefing', 'cron "30 6 * * *"',
      'Fetch nothing. Read the stores and brief the owner: what is due today, what is due tomorrow, what is slipping, and what happened since the last briefing.',
      null, null, 'owner', at('08:10', 16), at('06:30'), 9.8, 7, 7, 0],
    ['home:chief', 'week-plan', 'cron "0 9 * * 1"',
      "Plan the week from the calendar, the open tasks and the owner's last note; send each agent its part.",
      null, null, 'owner', at('08:12', 16), at('09:00'), 3.1, 2, 2, 0],
    ['home:chief', 'weekly-review', 'cron "0 18 * * 0"',
      'The week in review: what was spent, what got done, what slipped. One report to the owner.',
      null, null, 'home:chief', at('08:15', 16), at('18:00', 1), 2.9, 1, 1, 0],
    ['home:watch', 'sources', 'every 30m',
      'Something moved in a watched source: the bank feed, a mail query, a page or a portal. Fetch what is new, file it, and tell each agent what moved for it. Ask nobody; send nothing.',
      'scripts/moved.sh', '2m', 'owner', at('10:08', 16), at('09:08'), 8.6, 35, 336, 301],
    ['home:books', 'bills', 'cron "0 8 * * 1"',
      "Go through the bills due in the next 7 days: each amount against the usual, autopay or not, what needs the owner's yes. Report to the owner.",
      null, null, 'owner', at('08:20', 16), at('08:00'), 1.05, 2, 2, 0],
    ['home:books', 'renewals', 'cron "0 9 1 * *"',
      'Audit the recurring charges: what rose, which trials convert this month, what nobody used. Propose what to cancel; cancel nothing.',
      null, null, 'owner', at('08:22', 16), iso(FIRST), monthly ? 0.38 : 0, monthly ? 1 : 0, monthly ? 1 : 0, 0],
    ['home:house', 'upkeep', 'cron "0 9 * * 6"',
      "This week's maintenance windows for the house and the car: what is due, what needs a quote, what the weather allows.",
      null, null, 'home:house', at('08:31', 16), at('09:00', 2), 0.34, 1, 1, 0],
    ['home:trip', 'fare-watch', 'every 6h',
      'A watched fare for the winter trip moved by more than 5%. Compare it with the budget, hold it if it is under $1,300, and ask the owner before booking.',
      'scripts/fare-moved.sh', null, 'home:trip', at('14:50', 5), at('08:50'), 2.9, 4, 20, 16],
    ['home:photos', 'nightly-sort', 'cron "30 2 * * *"',
      "Sort the day's new photos: wait for gpu:0, find duplicates, group faces, propose albums, release the lock, and report the count.",
      null, null, 'home:photos', at('11:40', 12), at('02:30'), 36.2, 7, 7, 0],
    ['home:notes', 'follow-up', 'cron "0 16 * * 1-5"',
      'Go through what was promised in calls and appointments (notes/promised.md) and ask who has each open item.',
      'test -s notes/promised.md', null, 'home:notes', at('13:31', 12), at('16:00', 3), 0.52, 4, 5, 1],
    ['trailmap:api', 'keep-going', 'idle 10m repeat',
      'Open items remain in notes/todo.md: go on with the next one.',
      "grep -q '^- \\[ \\]' notes/todo.md", null, 'trailmap:api', at('16:12', 3), at('08:09'), 9.32, 14, 97, 83],
    ['trailmap:tests', 'ci-watch', 'every 15m',
      'CI is red on main: find the failing job, rerun it once, bisect if it fails again, and tell whoever broke it.',
      'scripts/ci-red.sh', '2m', 'trailmap:tests', at('10:30', 9), at('09:00'), 6.12, 31, 672, 641,
      'main: job test-go failed (run 5131)'],
    ['trailmap:release', 'weekly-release', 'cron "0 1 * * 1"',
      'Cut the weekly release: changelog from merged PRs, tag, deploy to staging, run the smoke tests. Ask the owner before production.',
      null, null, 'owner', at('10:31', 9), at('01:00'), 1.12, 1, 1, 0],
    ['trailmap:elevation', 'train-done', 'fire-only once',
      'Training run exp-27 ended. Read runs/exp-27/metrics.json, compare with exp-26, write the result to notes/experiments.md, release gpu:0, and decide the next experiment.',
      null, null, 'trailmap:elevation', at('03:54'), null, 0, 0, 0, 0],
    ['trailmap:elevation', 'stall-watch', 'every 30m',
      'The loss of the running experiment has not moved for 30 minutes: look at the log, and stop the run if it diverged.',
      'scripts/loss-stalled.sh', null, 'trailmap:elevation', at('12:01', 7), at('21:31', 2), 0.74, 1, 336, 335],
  ].map(([agent, name, trigger, text, check, limit, by, set, fired, usd, turns, due, skipped, passes]) => ({
    agent, name, trigger, text, check, check_timeout: limit, set_by: by,
    updated_at: set, last_fired_at: fired, week: { usd, turns, due, skipped },
    passes: passes ?? null,
  }));

  const job = (name, description, host, model, variant, prompt, trigger, to, timeout, usd, by = null) => {
    const h = hosts.find((x) => x.id === host);
    return {
      name, description, host, machine: h.machine, directory: h.directory,
      model: model[0], model_name: model[1], variant, agent: null, prompt,
      trigger, to, timeout, run_usd: usd, created_by: by, delete_session: true,
    };
  };
  const jobs = [
    job('backup-check', "Checks last night's backups: documents, photos, code",
      HOME, HAIKU, null,
      "Verify last night's backups of the documents, the photo library and the code: checksums, then a test restore of the smallest. Report sizes, what is new, and anything that failed.",
      'cron "0 4 * * *"', 'home:chief', '10m', 0.5),
    job('nightly-audit', "Reads the day's merged changes for security and licence problems",
      CODE, SONNET, 'high',
      "Read today's merged changes (git log --since=yesterday). Look for security and licence problems. Report what you find, with file and line.",
      'cron "0 3 * * *"', 'trailmap:tests', '30m', 2),
    job('statement-check', "Reads the month's card statements for charges nobody recognizes",
      HOME, SONNET, 'medium',
      "Read last month's card statements against the ledger. List every charge that matches no bill, subscription or receipt, with the date and the merchant as printed. Change nothing.",
      'cron "0 9 2 * *"', 'home:books', '15m', 1),
    job('trailmap:api:pr-review', 'Reviews one pull request with fresh eyes',
      CODE, OPUS, 'high',
      'Review the pull request named in the text below as a careful stranger would: correctness first, then tests, then naming. One verdict line, then findings with file and line.',
      'fire-only', 'trailmap:api', '20m', 3, 'trailmap:api'),
    job('weekly-costs', 'What each agent spent last week, and on what',
      HOME, HAIKU, null,
      'Run `autocode costs --days 7`. Write a short summary: who spent what, which wakes cost the most, and one suggestion to spend less.',
      'cron "0 8 * * 1"', 'home:chief', '10m', 0.5),
    job('notes-digest', "The week's notes in one page",
      LAPTOP, SONNET, 'low',
      "Summarize this week's notes from calls and appointments in one page: what was decided, what was promised and by whom, what is still open.",
      'cron "0 18 * * 5"', 'home:notes', '15m', 1),
  ];

  // [job, started, minutes it took, by, state, cost, result, reason,
  // session kept, the run's text]
  const runs = [
    ['weekly-costs', ms('08:00'), 2, 'schedule', 'succeeded', 0.11, COSTS, null, false, null],
    ['trailmap:api:pr-review', ms('06:20'), 6, 'trailmap:api', 'succeeded', 1.12, REVIEW, null, false, 'PR 418'],
    ['backup-check', ms('04:00'), 4, 'schedule', 'succeeded', 0.06, BACKUP, null, false, null],
    ['nightly-audit', ms('03:00'), 9, 'schedule', 'succeeded', 0.87, AUDIT, null, false, null],
    ['backup-check', ms('04:00', 1), 3, 'schedule', 'succeeded', 0.05,
      "All 3 of last night's backups verify. Nothing new in the code; 1,204 new photos.", null, false, null],
    ['nightly-audit', ms('03:00', 1), 30, 'schedule', 'failed', 1.64, null, 'time limit (30m)', true, null],
    ['nightly-audit', ms('03:00', 2), 8, 'schedule', 'succeeded', 0.79,
      'Nothing to report in 9 commits.', null, false, null],
    ['notes-digest', ms('18:00', 3), 3, 'schedule', 'succeeded', 0.38,
      '4 notes this week. Decided: the museum visit goes ahead; the accountant gets the papers by the 20th. Promised: the signed form to the school, an answer about the bus. Open: nobody has called the insurer about the windscreen.', null, false, null],
    ['trailmap:api:pr-review', ms('15:10', 3), 5, 'trailmap:api', 'succeeded', 0.94,
      'Approve. The reroute gesture is covered by tests on touch and mouse; one nit on editor/drag.ts:41 (a listener is added twice on hot reload).', null, false, 'PR 415'],
    ['trailmap:api:pr-review', ms('11:02', 4), 7, 'owner', 'succeeded', 1.31,
      'Request changes. The migration 0031_tiles.sql drops an index that routes/nearby.go relies on; with 2M rows the query went from 12 ms to 1.9 s here.', null, false, 'PR 409'],
  ].map(([name, started, took, by, state, cost, result, reason, kept, text]) => ({
    id: `${name}:${iso(started).slice(0, 16)}`, job: name, by, state,
    started: iso(started), ended: iso(started + took * MIN),
    cost, result, reason, session_kept: kept, text,
  }));

  // The runs that no agent started: one row per job on the Costs tab.
  const jobCosts = [
    { agent: 'job:backup-check', job: 'backup-check', today: 0.06, total: 0.83, week: week(0.05, 0.06, 0.05, 0.05, 0.06, 0.05, 0.06) },
    { agent: 'job:nightly-audit', job: 'nightly-audit', today: 0.87, total: 19.44, week: week(0.8, 0.9, 0.8, 0.8, 0.79, 1.64, 0.87) },
    { agent: 'job:notes-digest', job: 'notes-digest', today: 0, total: 1.52, week: week(0, 0, 0, 0.38, 0, 0, 0) },
    { agent: 'job:weekly-costs', job: 'weekly-costs', today: 0.11, total: 0.43, week: week(0, 0, 0, 0, 0, 0, 0.11) },
  ];

  /*
   * History, newest first: [when, kind, agent, data]. The page adds each
   * entry's host and session from its agent.
   */
  const history = [
    [at('09:10:50'), 'retry.sent', 'home:watch', { retry: 2, error: 'provider.overloaded' }],
    [at('09:10'), 'message.sent', 'home:chief', { id: 'm_e94b2f6a1c05d7830f2b', to: 'home:notes', subject: 'Open follow-ups' }],
    [at('09:09:50'), 'retry.sent', 'home:watch', { retry: 1, error: 'provider.overloaded' }],
    [at('09:09'), 'message.sent', 'home:chief', { id: 'm_4d81b6e2a09c7f35d2a6', to: 'home:watch', subject: 'This week' }],
    [at('09:08:50'), 'agent.error', 'home:watch', { type: 'provider.overloaded', message: 'the provider is overloaded; try again later' }],
    [at('09:08:50'), 'turn.ended', 'home:watch', { outcome: 'failed', steps: 3 }],
    [at('09:08:02'), 'turn.started', 'home:watch', { by: 'wake sources' }],
    [at('09:08:01'), 'injection.sent', 'home:watch', { wakes: ['sources'], messages: 0 }],
    [at('09:08'), 'wake.due', 'home:watch', { wake: 'sources', check: 'exit 0', output: 'mail: 2 new; bank feed: 1 new' }],
    [at('09:08'), 'message.sent', 'home:chief', { id: 'm_c2f09a7d5e1b4836f0c4', to: 'home:trip', subject: 'This week' }],
    [at('09:07'), 'message.sent', 'home:chief', { id: 'm_97a3e0c1b6d8f254a7e9', to: 'home:house', subject: 'This week' }],
    [at('09:06'), 'message.sent', 'home:chief', { id: 'm_1e6d8b4f0a2c9573e8b1', to: 'home:photos', subject: 'This week' }],
    [at('09:05'), 'message.sent', 'home:chief', { id: 'm_b5c7e20d9f1a6438c3d7', to: 'home:mail', subject: 'This week' }],
    [at('09:05'), 'message.sent', 'home:chief', { id: 'm_6f2a4c8e1d7b0953b4e2', to: 'home:books', subject: 'This week' }],
    [at('09:04'), 'message.sent', 'trailmap:tests', { id: 'm_d2e7a90c4f1b3658b7a1', to: 'trailmap:api', subject: 'main is red' }],
    [at('09:03'), 'ask.opened', 'home:trip', { kind: 'approval', id: 'ask_a47c0d3e9b1f4862a5d7', routed: 'owner', expires: '2h 57m' }],
    [at('09:01'), 'wake.skipped', 'trailmap:elevation', { wake: 'stall-watch', check: 'exit 1' }],
    [at('09:01'), 'lock.acquired', 'trailmap:tests', { lock: 'ci-runners', ttl: '1h', places: '2 of 3' }],
    [at('09:00:03'), 'turn.started', 'home:chief', { by: 'wake week-plan' }],
    [at('09:00:02'), 'turn.started', 'trailmap:tests', { by: 'wake ci-watch' }],
    [at('09:00:01'), 'wake.fired', 'home:chief', { wake: 'week-plan', by: 'schedule' }],
    [at('09:00'), 'wake.due', 'trailmap:tests', { wake: 'ci-watch', check: 'exit 0', output: 'main: job test-go failed (run 5131)' }],
    [at('08:57'), 'message.sent', 'home:chief', { id: 'm_e03b7d5a9c1f2648a5c0', to: 'home:trip', subject: 'Re: Winter trip: a fare to hold' }],
    [at('08:54'), 'lock.acquired', 'home:trip', { lock: 'browser', ttl: '4h' }],
    [at('08:53'), 'message.sent', 'home:trip', { id: 'm_2f51b9c7d0e64a83f17e', to: 'home:chief', subject: 'Winter trip: a fare to hold' }],
    [at('08:50'), 'wake.due', 'home:trip', { wake: 'fare-watch', check: 'exit 0', output: 'direct fare: $1,284 for 3 (down 11%)' }],
    [at('08:50'), 'message.sent', 'home:chief', { id: 'm_77c0e1b5a8d34f92e61c', to: 'home:mail', subject: 'Re: answer to the dentist' }],
    [at('08:49'), 'ask.escalated', 'home:mail', { id: 'ask_b2a4097d6e1f4c58a3d0', by: 'home:chief', text: "mail in the owner's name is not mine to allow" }],
    [at('08:47'), 'ask.opened', 'home:mail', { kind: 'permission', id: 'ask_b2a4097d6e1f4c58a3d0', routed: 'agent:home:chief', action: 'mail_send' }],
    [at('08:45'), 'wake.skipped', 'trailmap:tests', { wake: 'ci-watch', check: 'exit 1' }],
    [at('08:40'), 'message.sent', 'home:watch', { id: 'm_8c05d3f7b1e94a62d7f0', to: 'home:mail', subject: 'Dentist: Thursday moved' }],
    [at('08:38'), 'wake.due', 'home:watch', { wake: 'sources', check: 'exit 0', output: 'mail: 2 new' }],
    [at('08:38'), 'ask.opened', 'trailmap:release', { kind: 'approval', id: 'ask_5f0c1e77a2b94d3180ce', routed: 'owner', expires: '4h' }],
    [at('08:31'), 'wake.skipped', 'trailmap:elevation', { wake: 'stall-watch', check: 'exit 1' }],
    [at('08:30'), 'wake.skipped', 'trailmap:tests', { wake: 'ci-watch', check: 'exit 1' }],
    [at('08:20'), 'ask.opened', 'home:house', { kind: 'question', id: 'ask_91d3e5c80f724ab6b1e2', routed: 'owner' }],
    [at('08:20'), 'lock.acquired', 'trailmap:api', { lock: 'ci-runners', ttl: '1h 30m', places: '1 of 3' }],
    [at('08:19'), 'message.sent', 'home:house', { id: 'm_2b7e91c4a0d35f68e1c3', to: 'home:books', subject: 'Re: Water bill twice the usual' }],
    [at('08:15'), 'wake.skipped', 'trailmap:tests', { wake: 'ci-watch', check: 'exit 1' }],
    [at('08:10'), 'message.sent', 'home:watch', { id: 'm_f1a6c8e03b7d4925a8b4', to: 'home:house', subject: 'The garage answered' }],
    [at('08:09'), 'wake.fired', 'trailmap:api', { wake: 'keep-going', by: 'schedule' }],
    [at('08:08'), 'wake.due', 'home:watch', { wake: 'sources', check: 'exit 0', output: 'portals: 1 changed; mail: 1 new' }],
    [at('08:07'), 'message.sent', 'home:books', { id: 'm_5d9b2e7a4c1f0836b9e5', to: 'home:house', subject: 'Water bill twice the usual' }],
    [at('08:06'), 'inbox.opened', 'home:books', { kind: 'report', title: 'Bills this week' }],
    [at('08:02'), 'run.finished', null, { run: RUN('weekly-costs', '08:00'), state: 'succeeded', usd: 0.11 }],
    [at('08:00:01'), 'wake.fired', 'home:books', { wake: 'bills', by: 'schedule' }],
    [at('08:00'), 'run.started', null, { job: 'weekly-costs', by: 'schedule' }],
    [at('07:50'), 'inbox.opened', 'trailmap:tests', { kind: 'message', title: 'Flaky test: quarantine or leave red?' }],
    [at('07:40'), 'message.sent', 'home:watch', { id: 'm_a3e7c05b9d2f4186c0a7', to: 'home:books', subject: 'Bank feed and bills' }],
    [at('07:38'), 'wake.due', 'home:watch', { wake: 'sources', check: 'exit 0', output: 'bank feed: 3 new; mail: 1 new' }],
    [at('07:36'), 'agent.paused', 'home:photos', { by: 'cap' }],
    [at('07:36'), 'cap.reached', 'home:photos', { spent: 8.02, cap: 8 }],
    [at('07:35'), 'lock.queued', 'home:photos', { lock: 'gpu:0', position: 1 }],
    [at('07:28'), 'cap.warned', 'home:photos', { spent: 7.24, cap: 8, share: '90%' }],
    [at('07:08'), 'wake.skipped', 'home:watch', { wake: 'sources', check: 'exit 1' }],
    [at('06:34'), 'inbox.opened', 'home:chief', { kind: 'report', title: 'Morning briefing' }],
    [at('06:30'), 'wake.fired', 'home:chief', { wake: 'morning-briefing', by: 'schedule' }],
    [at('06:26'), 'run.finished', 'trailmap:api', { run: RUN('trailmap:api:pr-review', '06:20'), state: 'succeeded', usd: 1.12 }],
    [at('06:20'), 'run.started', 'trailmap:api', { job: 'trailmap:api:pr-review', text: 'PR 418' }],
    [at('05:37'), 'session.compacted', 'trailmap:api', { before: 512800, after: 58300, compact_at: 500000 }],
    [at('05:36'), 'session.compact.noticed', 'trailmap:api', { context: 512800, compact_at: 500000 }],
    [at('04:04'), 'run.finished', null, { run: RUN('backup-check', '04:00'), state: 'succeeded', usd: 0.06 }],
    [at('04:00'), 'run.started', null, { job: 'backup-check', by: 'schedule' }],
    [at('03:56'), 'turn.ended', 'trailmap:elevation', { outcome: 'succeeded', steps: 41, usd: 2.18 }],
    [at('03:54'), 'wake.set', 'trailmap:elevation', { wake: 'train-done', trigger: 'fire-only once' }],
    [at('03:53'), 'lock.acquired', 'trailmap:elevation', { lock: 'gpu:0', ttl: '9h' }],
    [at('03:52'), 'lock.released', 'home:photos', { lock: 'gpu:0' }],
    [at('03:50'), 'ask.answered', 'trailmap:elevation', { kind: 'question', id: 'ask_c7a02f5e8d1b4963a0e4', by: 'auto', routed: 'auto_answer' }],
    [at('03:11'), 'lock.acquired', 'home:photos', { lock: 'gpu:0', ttl: '2h', waited: '40m' }],
    [at('03:11'), 'lock.released', 'trailmap:elevation', { lock: 'gpu:0' }],
    [at('03:09'), 'run.finished', null, { run: RUN('nightly-audit', '03:00'), state: 'succeeded', usd: 0.87 }],
    [at('03:05'), 'wake.fired', 'trailmap:elevation', { wake: 'train-done', by: 'trailmap:elevation', text: 'exit 0' }],
    [at('03:00'), 'run.started', null, { job: 'nightly-audit', by: 'schedule' }],
    [at('02:41'), 'ask.answered', 'home:photos', { kind: 'permission', id: 'ask_0e6b4d91c2a75f38d1b7', by: 'home:chief', answer: 'once' }],
    [at('02:40'), 'ask.opened', 'home:photos', { kind: 'permission', id: 'ask_0e6b4d91c2a75f38d1b7', routed: 'agent:home:chief', action: 'shell' }],
    [at('02:31'), 'lock.queued', 'home:photos', { lock: 'gpu:0', position: 1 }],
    [at('02:30'), 'wake.fired', 'home:photos', { wake: 'nightly-sort', by: 'schedule' }],
    [at('01:24'), 'lock.acquired', 'trailmap:release', { lock: 'staging', ttl: '12h' }],
    [at('01:00'), 'wake.fired', 'trailmap:release', { wake: 'weekly-release', by: 'schedule' }],
    [at('23:41', 1), 'turn.resumed', 'trailmap:api', { cut_by: 'opencode restarted' }],
    [at('23:40', 1), 'opencode.restarted', null, { machine: 'workstation', sessions: 5 }],
    [at('18:00', 1), 'wake.fired', 'home:chief', { wake: 'weekly-review', by: 'schedule' }],
    [at('09:00', 2), 'wake.fired', 'home:house', { wake: 'upkeep', by: 'schedule' }],
    [at('18:04', 3), 'host.offline', 'home:notes', { machine: 'laptop' }],
  ].map(([when, kind, id, data], n) => {
    const a = agents.find((x) => x.id === id);
    return {
      id: 100000 - n, at: when, kind, agent: id,
      host: a ? a.host : null, session: a ? a.session : null, data,
    };
  });

  /*
   * Settings: what the owner set server-wide, the rules, and the agents' own
   * values. The built-in defaults are the product's own.
   */
  const defs = {
    min_interval: ['duration', 'agent', '1m', 'at most one injection per session this often'],
    question_mode: ['mode', 'agent', 'ask', 'questions go to the owner (ask), are answered at once (auto_answer), or go to agent:<id> or job:<name>', ['ask', 'auto_answer']],
    auto_answer_text: ['text', 'agent', 'Act according to your best judgement and safe practices to achieve my goals.', 'the answer given under question_mode auto_answer'],
    permission_mode: ['mode', 'agent', 'ask', 'permission prompts go to the owner (ask), are allowed once (allow), or go to agent:<id> or job:<name>', ['ask', 'allow']],
    approval_mode: ['mode', 'agent', 'ask', 'approvals go to the owner (ask), are approved at once (allow), or go to agent:<id> or job:<name>', ['ask', 'allow']],
    filter_recovery: ['enum', 'agent', 'retry compact', "a reply the provider's content filter blocked: a retry, then a compaction and a retry (retry compact), one retry (retry), or none (off)", ['retry compact', 'retry', 'off']],
    job_mode: ['enum', 'agent', 'ask', 'jobs an agent sets: an approval of the owner first (ask), set at once (allow), or refused (deny)', ['ask', 'allow', 'deny']],
    wake_mode: ['enum', 'agent', 'allow', 'periodic wakes an agent sets (every, cron, idle): set at once, with nobody asked (allow), an approval of the owner first (ask), or refused (deny)', ['ask', 'allow', 'deny']],
    compact_at: ['compact', 'agent', '50% max 500000', 'compact between turns past this context size: tokens, a percentage of the window (with max N, at most N tokens), or off'],
    check_timeout: ['duration', 'agent', '60s', "a wake's check is stopped after this long"],
    check_timeout_max: ['duration', 'agent', '10m', 'the longest time a wake may ask for its own check'],
    check_output: ['int', 'agent', 2000, "characters of a check's output put into the prompt"],
    max_tool_wait: ['duration', 'agent', '5m', 'the longest a tool waits inside a turn'],
    daily_usd: ['usd', 'agent', 'off', "the agent's cap per day, in dollars, or off"],
    cap_warn: ['percent', 'agent', '90%', 'warn the agent at this share of a cap'],
    retry_interval: ['duration', 'agent', '1m', 'wait this long after a failed turn before a retry prompt'],
    retry_attempts: ['int', 'agent', 0, 'the most retries of failed turns in a row (0: no limit)'],
    expire_after: ['duration', 'agent', '14d', "unregister an agent this long after its session's last turn (0: never)"],
    host_expire_after: ['duration', 'server', '1d', 'forget a host this long after it went offline (0: never)'],
    report_close_after: ['duration', 'server', '7d', 'close a report in the Inbox this long after it came (0: never)'],
    history_days: ['int', 'server', 30, 'days of history kept'],
    timezone: ['timezone', 'server', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', "the server's time zone (days for caps, the default for cron)"],
    listen: ['listen', 'server', 'localhost,tailscale:4848', 'addresses and port to listen on (used at start)'],
  };
  const settings = {
    defs: Object.fromEntries(
      Object.entries(defs).map(([key, [kind, scope, def, help, values]]) => [
        key, { kind, scope, default: def, help, values: values ?? null },
      ]),
    ),
    server: { daily_usd: 10, expire_after: '30d', host_expire_after: '7d' },
    // the first rule that matches an agent counts, whole
    rules: [
      { match: 'home:chief,home:books,home:trip', values: { permission_mode: 'ask', daily_usd: 6 } },
      { match: 'home:*', values: { permission_mode: 'agent:home:chief', daily_usd: 6 } },
      { match: 'trailmap:*', values: { daily_usd: 20, question_mode: 'auto_answer' } },
    ],
    agents: [
      { agent: 'home:chief', key: 'daily_usd', value: 12 },
      { agent: 'home:photos', key: 'daily_usd', value: 8 },
      { agent: 'trailmap:elevation', key: 'daily_usd', value: 40 },
      { agent: 'trailmap:api', key: 'job_mode', value: 'allow' },
    ],
  };

  return {
    server: { id: 'home', version: '1.1.0-rc6-build1' },
    hosts, agents, gone, inbox, messages, locks, wakes, jobs, runs, jobCosts,
    history, settings,
  };
};
