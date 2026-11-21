/*
 * Unit tests of the Help page: its route and no calls to the server; the
 * numbered contents (sections, subsections indented), each entry a link to a
 * heading with the same number and title, in the owner's order (every day's
 * work before the reference, installing last); what Autocode is for (agents
 * that work on their own for days or weeks), which feature serves which need
 * and the words it uses; every day's work (the statuses, Pause and Stop All,
 * the Inbox, spend and the daily cap, context and compaction, retries); asks
 * (questions, permissions, approvals) for agents and in the Inbox; text-only
 * messages and their patterns, wakes without an end that merge by name, locks
 * without a wait in the tool call; the facts the owner looks up most (the
 * wake triggers and a check, a job's worked example, the owner's commands,
 * the settings with their defaults, the troubleshooting rows); locks, for
 * agents and on the Locks tab; the web UI's long texts and ID links; links
 * between sections that lead somewhere; no hyphen where a dash belongs.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { el, settle, setup, signedIn, text } from '../../testing/helpers';
import { routes } from '../app.routes';
import { HelpPage, SECTIONS } from './help-page';

/*
 * The contents, in the owner's order (the documentation pass for 1.0.0,
 * 2026-11-17): what he does every day first, what is needed once last. No
 * label comes twice: a thing's idea is "Wakes", its tab "Wakes Tab".
 */
const CONTENTS = [
  ['1', 'What Autocode Is'],
  ['1.1', 'Words Used Here'],
  ['2', 'Every Day'],
  ['2.1', 'Statuses'],
  ['2.2', 'Pause, Resume and Stop All'],
  ['2.3', 'The Inbox'],
  ['2.4', 'Spend and the Daily Cap'],
  ['2.5', 'Context and Compaction'],
  ['2.6', 'Failed Turns and Retries'],
  ['3', 'Working With Agents'],
  ['3.1', 'Asking an Agent to Register'],
  ['3.2', 'Wakes'],
  ['3.3', 'Messages'],
  ['3.4', 'Locks'],
  ['3.5', 'Questions, Permissions and Approvals'],
  ['3.6', 'Jobs'],
  ['3.7', 'What an Agent Sees'],
  ['3.8', 'How Agents Learn Autocode'],
  ['4', 'The Web UI'],
  ['4.1', 'Hosts Tab'],
  ['4.2', 'Agents Tab'],
  ['4.3', 'Inbox Tab'],
  ['4.4', 'Messages Tab'],
  ['4.5', 'Locks Tab'],
  ['4.6', 'Wakes Tab'],
  ['4.7', 'Jobs Tab'],
  ['4.8', 'Costs Tab'],
  ['4.9', 'History Tab'],
  ['4.10', 'Settings Tab'],
  ['5', 'Settings'],
  ['6', 'Troubleshooting'],
  ['7', 'The CLI'],
  ['7.1', 'Your Commands'],
  ['7.2', "In an Agent's Shell"],
  ['8', 'Install and Connect'],
  ['8.1', 'Install the Server'],
  ['8.2', "Connect a Machine's OpenCode"],
  ['8.3', 'Sign In'],
  ['8.4', 'Tokens'],
];

describe('HelpPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  async function open(): Promise<HTMLElement> {
    signedIn();
    const fixture = TestBed.createComponent(HelpPage);
    await settle(fixture);
    return el(fixture);
  }

  // The cells of a table's body rows.
  // A table's rows as their cells' texts (a group's heading row has none).
  const rows = (table: Element | null) =>
    [...(table?.querySelectorAll('tbody tr') ?? [])]
      .map((r) => [...r.querySelectorAll('td')].map((td) => text(td)))
      .filter((cells) => cells.length > 0);

  // A section's text: what comes after its heading, up to the next one.
  const section = (page: HTMLElement, id: string) => {
    const out: string[] = [];
    let node = page.querySelector(`#${id}`)!.nextElementSibling;
    while (node && !/^H[23]$/.test(node.tagName)) {
      out.push(text(node));
      node = node.nextElementSibling;
    }
    return out.join(' ');
  };

  it('is the /help route and asks the server for nothing', async () => {
    expect(routes.find((r) => r.path === 'help')?.component).toBe(HelpPage);
    await open();
    http.expectNone(() => true);
  });

  it('lists the sections in numbered contents, subsections indented, each a link to its heading', async () => {
    const page = await open();
    const toc = page.querySelector('nav.toc')!;
    expect(toc.getAttribute('aria-label')).toBe('Contents');
    const links = [...toc.querySelectorAll('a')];
    expect(
      links.map((a) => [
        text(a.querySelector('.n')),
        text(a)
          .slice(text(a.querySelector('.n')).length)
          .trim(),
      ]),
    ).toEqual(CONTENTS);
    expect(SECTIONS.map((s) => [s.n, s.label])).toEqual(CONTENTS);
    for (const [i, a] of links.entries()) {
      const s = SECTIONS[i]!;
      const sub = s.n.includes('.');
      expect(a.getAttribute('href'), s.n).toBe(`/help#${s.id}`);
      expect(a.classList.contains('sub'), s.n).toBe(sub);
      // Its heading: a section's h2 or a subsection's h3, with the number
      // apart (shown faint) and the same title.
      const heading = page.querySelector(`article #${s.id}`)!;
      expect(heading.tagName, s.n).toBe(sub ? 'H3' : 'H2');
      expect(text(heading.querySelector('.n')), s.n).toBe(s.n);
      expect(text(heading), s.n).toBe(`${s.n} ${s.label}`);
    }
    expect(page.querySelectorAll('article h2, article h3').length).toBe(
      SECTIONS.length,
    );
  });

  it('says what Autocode is: a long-term autonomy support framework, for agents that work on their own for days or weeks, and what it provides', async () => {
    const page = await open();
    const what = section(page, 'what');
    // the owner, 2026-11-17: "update docs to say that Autocode is long-term
    // autonomy support framework"; the first words of the page
    expect(
      what.startsWith(
        'Autocode is a long-term autonomy support framework for OpenCode 2 ' +
          'agents.',
      ),
    ).toBe(true);
    for (const part of [
      'to work on their own for days or weeks, alone or as a team',
      'under your control',
      // the list is framed by it
      'What it provides, each for work that goes on with nobody watching',
      // The two parts, and the owner's control, as before.
      'a server, which keeps the state and serves this web UI',
      'a plugin',
      'You control it all here',
    ])
      expect(what, part).toContain(part);
    // Locks and retries are here now, not in a later tier.
    expect(what).not.toContain('Later tiers add locks');
    // no design notes in what the owner reads (the 1.0.0 documentation pass)
    expect(what).not.toContain('left out or kept small');
    // focused: the whole part, its list included, is under 290 words (it
    // was 351)
    expect(what.split(/\s+/).length).toBeLessThan(290);
    expect(what).not.toMatch(/kaggle|casmi/i);
    // What Autocode provides, as a list (the owner, 2026-11-09: in place of
    // the "What an Agent Needs / What Autocode Has" table).
    expect(page.querySelector('table.needs')).toBeNull();
    const provides = [...page.querySelectorAll('#what ~ ul.provides > li')].map(
      (li) => text(li),
    );
    const features: [string, string[]][] = [
      ['Wakes', ['schedule', 'idle', 'check can skip']],
      // "Long commands", not "Background jobs": a job is an Autocode job
      ['Long commands', ['fire-only', 'woken when it ends']],
      ['Messages', ['other agents', 'discovery']],
      ['Locks and semaphores', ['scarce']],
      ['Recovery', ['retries', 'resumes']],
      ['The Inbox', ['questions', 'permissions', 'approvals', 'another agent']],
      ['Limits', ['daily cost cap', 'compaction', 'expiry']],
      ['Jobs', ['fresh']],
      ['Control', ['pause', 'Stop All', 'web UI', 'history']],
    ];
    expect(provides.length).toBe(features.length);
    features.forEach(([name, words], i) => {
      expect(provides[i], name).toMatch(new RegExp(`^${name}:`));
      for (const w of words) expect(provides[i], `${name}: ${w}`).toContain(w);
    });
    // what it is, in plain words, comes before the list of what it provides
    expect(what.indexOf('It has two parts')).toBeLessThan(
      what.indexOf('What it provides'),
    );
    // a newcomer is sent to the install steps, which come last
    expect(what).toContain('Start with Install and Connect');
  });

  // The 1.0.0 documentation pass: every word the page uses is said once.
  it('explains its words in plain terms, each once', async () => {
    const page = await open();
    const words = [...page.querySelectorAll('#words + ul > li')].map((li) =>
      text(li),
    );
    const said = (word: string) =>
      words.find((w) => w.startsWith(`${word}:`)) ?? '';
    for (const [word, part] of [
      ['owner', 'the person who runs Autocode'],
      ['session', 'one OpenCode conversation'],
      ['turn', 'from a prompt until the model stops and waits'],
      ['step', 'one model call inside a turn'],
      ['agent', 'a session that has registered'],
      ['Subagent', 'a helper session'],
      ['host', 'A host is not a machine'],
      ['TUI', "OpenCode's own screen in a terminal"],
      ['wake', 'a prompt that Autocode types'],
      ['check', 'Its exit code decides'],
      // not "deliver now": a fired wake still waits for an idle session
      ['fire', 'make a wake due now, without its check'],
      ['message', 'text that an agent or you send'],
      ['notice', 'a message that Autocode itself sends to an agent'],
      ['alert', 'an Inbox item that Autocode raises for you'],
      ['ask', 'a question, a permission prompt or an approval'],
      ['lock', 'a named mutex or semaphore'],
      ['job', 'A run is one execution of a job'],
      ['token', 'two different things'],
    ] as const)
      expect(said(word), word).toContain(part);
    // context and compaction are defined once, where they are explained
    expect(words).toContain(
      'context and compaction: see Context and Compaction.',
    );
    expect(words.length).toBe(19);
  });

  // The owner's daily work comes first (the 1.0.0 documentation pass).
  it('tells what each status means and what to do, and what Pause and Stop All do', async () => {
    const page = await open();
    const statuses = rows(page.querySelector('table.statuses'));
    expect(statuses.map((r) => r[0])).toEqual([
      'idle',
      'working',
      'waiting',
      'error',
      'paused',
      'offline',
    ]);
    const todo = (status: string) =>
      statuses
        .find((r) => r[0] === status)!
        .slice(1)
        .join(' ');
    expect(todo('working')).toContain('Messages join it at its next step');
    expect(todo('waiting')).toContain('It has an ask open');
    expect(todo('waiting')).toContain('Answer the ask in The Inbox');
    expect(todo('error')).toContain('Its last turn failed');
    expect(todo('error')).toContain('fix the cause and click Retry');
    expect(todo('paused')).toContain(
      'who paused it: you, Stop All or its daily cost cap',
    );
    expect(todo('paused')).toContain('Click Resume');
    expect(todo('offline')).toContain(
      'Its host is offline, or its session was deleted',
    );
    // which status wins, in the table's own order (offline, paused,
    // waiting, working, error, idle), and what shows while a retry runs
    expect(section(page, 'statuses')).toContain(
      'the later row of the table wins, except that working and waiting win ' +
        'over error',
    );
    expect(section(page, 'statuses')).toContain(
      'While a retry runs, the status reads working, with the error type ' +
        'and "retrying now" still under it',
    );
    expect(todo('offline')).toContain(
      'While the host is offline, its wakes and messages wait',
    );
    expect(section(page, 'web-agents')).toContain(
      'Status: idle, working, waiting, error, paused or offline',
    );
    // the CLI's path, before the first command
    expect(section(page, 'daily')).toContain(
      'The commands are those of the CLI, ~/.autocode/bin/autocode; see The ' +
        'CLI',
    );
    const pause = section(page, 'pause');
    for (const part of [
      "Pause is in the agent's row on the Agents tab",
      'autocode pause AGENT',
      "Autocode stops typing into this agent's session",
      'Its wakes, messages and retries wait; nothing is lost',
      // what a pause does to a turn that runs
      'A turn that is already running goes on to its end',
      // and to its Subagents (OpenCode 2.3: they work in the background)
      'Subagents it started go on too',
      'OpenCode starts a turn in the agent to hand over the result; ' +
        'Autocode does not stop that turn',
      'It delivers what waited',
      'Stop All is at the top of the Agents tab',
      'autocode stop-all',
      'it pauses every agent and interrupts every running turn',
      // proven on OpenCode 2.3.0 (tests/e2e/stop-all)
      'Subagents that work for an agent are interrupted too',
      "and so is a job's run that was working",
      'Agents you paused yourself stay paused',
      // after Resume All: an interrupted turn is not started again
      'It resumes the agents that Stop All paused and delivers what waited',
      'A turn that Stop All interrupted is not started again',
      'The agent goes on at its next wake, message or retry, or when you ' +
        'prompt it in OpenCode',
      'only then can its job run again',
      // what Stop All does not stop
      'Stop All leaves these running',
      'Autocode stops turns, not processes',
      'OpenCode sessions that are not registered as agents',
      "The jobs' schedules",
      'it fails when its time limit passes',
      'no button that interrupts the turn of one agent only',
    ])
      expect(pause, part).toContain(part);
  });

  // The owner, 2026-11-08: a mode setting's lists.
  it('says how a mode setting picks an agent or a job on the Settings tab', async () => {
    const page = await open();
    expect(section(page, 'web-settings')).toContain(
      'A mode setting (question_mode, permission_mode, approval_mode)',
    );
    expect(section(page, 'web-settings')).toContain(
      'Pick Agent… or Job… and a second list shows the registered agents or ' +
        'the jobs',
    );
    // the tab's four parts, by their headings there
    for (const part of [
      'Server Settings',
      'Rules',
      "Agents' Own Values",
      'Resolved for an Agent',
      'Add a Rule',
      'Save Rule',
    ])
      expect(section(page, 'web-settings'), part).toContain(part);
  });

  it('keeps to what Autocode has: messages are text, a wake has no end and merges by name', async () => {
    const page = await open();
    const messages = section(page, 'messages');
    expect(messages).toContain('A message is a text');
    expect(messages).not.toMatch(/\bfiles?\b/);
    const wakes = section(page, 'wakes');
    expect(wakes).toContain('merged only when they have the same name');
    expect(wakes).not.toContain('same text');
    expect(wakes).not.toContain('end time');
    expect(section(page, 'web-wakes')).not.toMatch(/\bend\b/);
    // the review of 0b2: Fire waits for an idle session too
    expect(wakes).not.toContain('Fire delivers a wake at once');
    expect(wakes).toContain(
      'Fire delivers a wake as soon as the session is idle',
    );
    // so nothing says that Fire delivers "now"
    expect(page.textContent).not.toMatch(/delivers? (a|the) wake now/);
    expect(section(page, 'web-wakes')).toContain('Fire makes the wake due now');
    // 1.1.0 (the owner, 2026-11-20): what each wake costs, and a check's own
    // time limit
    expect(section(page, 'web-wakes')).toContain(
      'Last 7 Days: what the wake cost: the dollars of the turns that its ' +
        'prompts started, and the turns under them.',
    );
    expect(section(page, 'web-wakes')).toContain(
      'A wake that costs much and mostly finds nothing to do belongs in a ' +
        'check',
    );
    expect(section(page, 'web-wakes')).toContain(
      'Agent ID, Name, Trigger and Text, and Check and Check Timeout if ' +
        'you want them',
    );
    // an offline agent's wakes wait, like a paused one's
    expect(wakes).toContain(
      'a wake waits while the agent works, waits for an answer, is paused or ' +
        'is offline',
    );
    // what you type is in the server's zone, what you read in the browser's
    expect(section(page, 'web-wakes')).toContain(
      "A time you type in Trigger is in the server's time zone. The times " +
        "the tab shows are in your browser's",
    );
  });

  it('gives every wake trigger, with idle counted from the end of the last turn, and a check that wakes only when a file changed', async () => {
    const page = await open();
    const table = page.querySelector('table.triggers')!;
    const examples = [...table.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td:first-child code')].map((c) => c.textContent),
    );
    expect(examples).toEqual([
      ['every 30m', 'every 2h from 09:00'],
      ['in 45m'],
      ['at 09:00', 'at 2026-11-30 18:00'],
      ['cron "0 9 * * 1-5"', 'cron "0 9 * * 1-5" Europe/Berlin'],
      ['idle 30m', 'idle 30m repeat'],
      ['fire-only'],
      // 1.1.0 (the owner, 2026-11-20): fired once, then removed
      ['fire-only once'],
    ]);
    expect(rows(table)[6]![1]!).toContain(
      'the same, for one fire: the wake is removed when it is fired',
    );
    // 1.1.0 (the owner, 2026-11-20): an agent is renamed in place, and
    // unregistering keeps its unread messages to the owner
    expect(section(page, 'register')).toContain(
      'To change an agent\'s ID, rename it: ask the agent ("Rename ' +
        'yourself to kaggle:lead"), or run autocode agents rename AGENT ' +
        'NEW-ID.',
    );
    expect(section(page, 'register')).toContain(
      'A message sent to the old ID still reaches the agent.',
    );
    expect(section(page, 'web-agents')).toContain(
      'Its messages to you that you have not answered or closed stay in ' +
        'the Inbox.',
    );
    expect(section(page, 'commands')).toContain(
      'autocode agents rename AGENT NEW-ID',
    );
    // 1.1.0 (the owner, 2026-11-20): a check may do the routine pass,
    // with its own time limit
    expect(section(page, 'wakes')).toContain(
      'A check may do the routine pass itself.',
    );
    expect(section(page, 'wakes')).toContain(
      'a wake can carry its own time limit, at most 10 minutes ' +
        '(check_timeout_max)',
    );
    expect(section(page, 'commands')).toContain('[--check-timeout DURATION]');
    // 1.1.0 (the owner, 2026-11-20): what ends every prompt
    expect(section(page, 'wakes')).toContain(
      "Every prompt from Autocode ends with two lines: the server's time, " +
        "the agent's context and what it spent today; then that the " +
        'prompt comes from Autocode, not from you.',
    );
    const idle = rows(table)[4]![1]!;
    expect(idle).toContain('end of its last turn');
    // never from before the wake was set
    expect(idle).toContain('or from when the wake was set if that is later');
    // once in each stretch; with repeat, again within one
    expect(idle).toContain('once in each idle stretch');
    expect(idle).toContain('also of a turn this wake started');
    expect(idle).toContain(
      'With repeat, again within one stretch, each time that long passes',
    );
    expect(rows(table)[2]![1]).toContain('a time that has passed is refused');
    const checks = text(page.querySelector('ul.checks'));
    expect(checks).toContain('exit 0 wakes the agent');
    expect(checks).toContain('exit 1 skips');
    expect(checks).toContain('three in a row');
    // a worked check, with its exit codes beside it (the 1.0.0 pass)
    const wakes = section(page, 'wakes');
    for (const part of [
      'autocode wake set kaggle:lead results --trigger "every 30m"',
      '--check "test results.csv -nt .seen && touch .seen"',
      'exits 0 only when results.csv is newer than the marker .seen',
      'Otherwise the check exits 1',
      'A check costs no model calls',
      // -nt is bash's: the check runs with bash -c
      'The check runs in bash',
    ])
      expect(wakes, part).toContain(part);
  });

  it("lists the owner's commands and the ones for an agent's scripts", async () => {
    const page = await open();
    const commands = rows(page.querySelector('table.commands')).map(
      (r) => r[0],
    );
    for (const command of [
      'autocode info',
      'autocode agents [PATTERN]',
      'autocode hosts',
      'autocode inbox [--all] [--match PATTERN]',
      'autocode inbox close --all [--match PATTERN]',
      'autocode answer ITEM TEXT...',
      'autocode pause AGENT / resume AGENT',
      'autocode stop-all / resume-all',
      'autocode wakes [AGENT]',
      'autocode fire AGENT WAKE [--text TEXT]',
      'autocode send TO TEXT...',
      'autocode messages [--from PATTERN] [--to PATTERN]',
      'autocode locks [PATTERN]',
      'autocode locks release NAME AGENT',
      // the 1.0.0 pass: the commands the tasks need were not in the table
      'autocode settings set KEY VALUE [--agent ID | --match PATTERN]',
      'autocode settings unset KEY [--agent ID | --match PATTERN]',
      'autocode token rotate AGENT',
      'autocode token rotate --admin / --consumer',
      'autocode job delete-session RUN',
      'autocode messages read ID',
    ])
      expect(commands, command).toContain(command);
    // Gone (the owner, 2026-11-07): files, a wake's end, a read to a file.
    for (const flag of ['--file', '--end', '--out'])
      expect(commands.join(' '), flag).not.toContain(flag);
    // In an agent's shell the CLI is me, fire and send only.
    expect(
      [...page.querySelectorAll('ul.scripts li > code:first-child')].map((c) =>
        text(c),
      ),
    ).toEqual([
      'autocode me',
      'autocode fire me NAME [--text TEXT]',
      'autocode send TO TEXT... [--subject S] [--reply-to ID]',
    ]);
    expect(text(page.querySelector('#scripts ~ pre'))).toContain(
      'autocode fire me',
    );
    // where the binary is, and which token the CLI uses (1.0.0)
    const cli = section(page, 'cli');
    for (const part of [
      '~/.autocode/bin/autocode',
      'echo \'export PATH="$HOME/.autocode/bin:$PATH"\' >> ~/.bashrc',
      'the admin token in the client config',
      "the server's own ~/.autocode/admin.token, when the URL is this " +
        "machine's (127.0.0.1 or localhost)",
      // what the consumer token opens, and nothing else
      'the consumer token in the client config, which is enough for info, ' +
        'hosts, agents, costs, settings (to read) and history; every other ' +
        'command is refused',
      "when its client config's URL is http://127.0.0.1:4848",
      'Every command that prints data takes --json',
    ])
      expect(cli, part).toContain(part);
    expect(section(page, 'scripts')).toContain(
      'puts ~/.autocode/bin first in their PATH',
    );
    expect(section(page, 'scripts')).toContain(
      'In the shells of every session of a connected folder, and in wake ' +
        'checks',
    );
    expect(section(page, 'scripts')).toContain(
      "three commands for the agent, besides info and the machine's set-up " +
        'commands',
    );
    // how to type an answer, one form per kind
    const answer = rows(page.querySelector('table.commands')).find(
      (r) => r[0] === 'autocode answer ITEM TEXT...',
    )![1];
    expect(answer).toContain('autocode answer ITEM once');
    expect(answer).toContain('autocode answer ITEM reject too risky');
    expect(commands).toContain('autocode costs AGENT');
    expect(commands).toContain('autocode costs --days N');
  });

  it('gives the settings with their defaults, and how to set one for an agent', async () => {
    const page = await open();
    // messages come whole; into a running turn at its next step; list, read
    // and wait (the owner, 2026-11-09)
    const messages = section(page, 'messages');
    expect(messages).toContain('whole');
    expect(messages).not.toContain('inline_limit');
    for (const part of [
      'at its next step',
      'action=list',
      'action=read',
      'action=wait',
      'processed once',
      // the owner, 2026-11-09: how agents write to you
      'Agents are told to write to you briefly',
      // a message's state is processed, never "read" (2026-11-10)
      'The Messages tab shows what became of each message',
    ])
      expect(messages).toContain(part);
    // a message to the owner is processed when it is answered or closed:
    // said once, with the other ways, on the Messages tab
    expect(section(page, 'web-messages')).toContain(
      'inbox: you answered or closed it in the Inbox',
    );
    const settings = rows(page.querySelector('table.settings-help'));
    expect(settings.map((r) => r.slice(0, 2))).toEqual([
      ['min_interval', '1m'],
      ['check_timeout', '60s'],
      // 1.1.0 (the owner, 2026-11-20): a check may do the routine pass
      ['check_timeout_max', '10m'],
      ['check_output', '2000'],
      ['max_tool_wait', '5m'],
      ['timezone', "the server machine's"],
      // 1.0.1 (the owner, 2026-11-19: "fix for stale host records")
      ['host_expire_after', '1d'],
      ['history_days', '30'],
      ['retry_interval', '1m'],
      ['retry_attempts', '0'],
      ['question_mode', 'ask'],
      [
        'auto_answer_text',
        'Act according to your best judgement and safe practices to ' +
          'achieve my goals.',
      ],
      ['permission_mode', 'ask'],
      ['approval_mode', 'ask'],
      // rc2 and rc3 (the owner, 2026-11-09)
      ['job_mode', 'ask'],
      ['filter_recovery', 'retry compact'],
      ['compact_at', '50% max 500000'],
      ['daily_usd', 'off'],
      ['cap_warn', '90%'],
      ['expire_after', '14d'],
    ]);
    for (const mode of ['question_mode', 'permission_mode', 'approval_mode']) {
      const does = settings.find((r) => r[0] === mode)![2];
      expect(does, mode).toContain('agent:<id>');
      expect(does, mode).toContain('job:<name>');
    }
    const attempts = settings.find((r) => r[0] === 'retry_attempts')!;
    expect(attempts[2]).toContain('0: no limit');
    // what history_days keeps, and that a day's spend stays 31 days at least
    // (the page said "at least 31 days" beside a default of 30)
    const kept = settings.find((r) => r[0] === 'history_days')![2];
    for (const part of [
      'the history, messages, closed Inbox items, answered asks and ended ' +
        'runs',
      'Spend per day is kept that long too, and 31 days at least',
      'totals are kept for good',
    ])
      expect(kept, part).toContain(part);
    // Every setting is used now: none is kept for a later tier; listen is
    // said whole, not as a line on its own.
    const after = text(page.querySelector('table.settings-help + p'));
    expect(after).not.toContain('later tier');
    expect(after).toContain('listen');
    // read at the start, unless the service was installed with --listen
    expect(after).toContain(
      'is read when the server starts, but only if the service was ' +
        'installed without --listen',
    );
    // which value counts, in order, and how to set each kind
    const intro = section(page, 'settings');
    expect(intro).not.toContain('These are in use now');
    expect(
      [...page.querySelectorAll('#settings + p + ol > li')].map((li) =>
        text(li),
      ),
    ).toEqual([
      "the agent's own value;",
      'the first rule whose pattern matches its ID, like kaggle:*;',
      'the server-wide value;',
      'the built-in default.',
    ]);
    for (const part of [
      'autocode settings set min_interval 5m',
      "autocode settings set daily_usd 20 --match 'kaggle:*'",
      'autocode settings set daily_usd 50 --agent kaggle:lead',
      'autocode settings unset daily_usd --agent kaggle:lead',
      'autocode settings --agent kaggle:lead',
    ])
      expect(intro, part).toContain(part);
  });

  it('explains jobs: a worked example, for agents, on the Jobs tab and in the commands', async () => {
    const page = await open();
    const jobs = section(page, 'jobs');
    // a run's ID is its start minute in UTC (the review of 0b2)
    expect(jobs).toContain('the minute it started, in UTC');
    expect(jobs).toContain('daily-report:2026-11-08T17:00');
    expect(jobs).not.toContain('daily-report:2026-11-08T09:00');
    for (const part of [
      'fresh session',
      'autocode_me action=jobs',
      'autocode_me action=run job=',
      'text=',
      '[autocode] result of run',
      'autocode_me action=finish result=',
      'one run at a time',
      // the owner, 2026-11-09 (rc2): whom a run counts for; agents' jobs
      "A run of an agent's own job counts for that agent, whoever started " +
        'it; scheduled runs too',
      'A run of a job of yours counts for the agent that started it',
      'One started by another run counts as that run does',
      'one that answers an ask counts for the agent that asked',
      "the job's own row on Costs, job:",
      'autocode_me action=job_set',
      'job_mode',
      'the job exists once you approve it',
      // the 1.0.0 pass: every morning at 9, the result to the owner
      'autocode job set daily-report --host HOST --model MODEL',
      '--trigger \'cron "0 9 * * *"\'',
      'HOST is the ID of the folder the job runs in',
      'MODEL is provider/model',
      "The job runs every day at 09:00, in the server's time zone",
      'Without --to the result goes to you',
      'once, at the next 09:00; the job stays, with no next run',
    ])
      expect(jobs, part).toContain(part);
    expect(jobs).not.toMatch(/kaggle|casmi/i);
    const tab = section(page, 'web-jobs');
    for (const part of [
      'Run Now',
      'Set a Job',
      'Set Job',
      'Edit',
      'Delete',
      'runs',
      'Delete Session',
      'Job',
      'Last Run',
      'Set By',
    ])
      expect(tab, part).toContain(part);
    const commands = rows(page.querySelector('table.commands')).map(
      (r) => r[0],
    );
    for (const command of [
      'autocode job set NAME --host H --model M --prompt P --trigger T ' +
        '[--to TO] [--timeout 1h] [--run-usd 2] [--keep-session]',
      'autocode job list',
      'autocode job run NAME [--text T]',
      'autocode job runs [NAME]',
      'autocode job delete NAME',
    ])
      expect(commands, command).toContain(command);
    expect(text(page.querySelector('#learn + ul'))).toContain('action=jobs');
  });

  it('explains asks: questions, permissions and approvals, for agents and in the Inbox', async () => {
    const page = await open();
    const asks = section(page, 'asks');
    for (const part of [
      'question tool',
      'question_mode',
      'auto_answer_text',
      'permission_mode',
      'approval_mode',
      'autocode_approval action=ask',
      'action=wait',
      '[autocode] approval "deploy the new model" approved',
      'agent:team:lead',
      'job:<name>',
      'autocode_message action=answer',
      'action=escalate',
      'the first answer counts',
      'Only you can answer Allow Always',
      'waiting',
    ])
      expect(asks, part).toContain(part);
    expect(asks).not.toMatch(/kaggle|casmi/i);
    expect(text(page.querySelector('#learn + ul'))).toContain(
      'autocode_approval',
    );
    const tab = section(page, 'web-inbox');
    // the box is "Closed" (the owner, 2026-11-09)
    expect(tab).toContain('The Closed box lists');
    expect(tab).not.toContain('Show Closed');
    // the Agent filter (the owner, 2026-11-17)
    expect(tab).toContain(
      'Agent filters by agent ID: the agent of an item, or the agent an ask was sent to',
    );
    // Close All (the owner, 2026-11-17): the messages and alerts shown, of
    // the Agent filter's agents; asks stay open
    expect(tab).toContain(
      'Close All closes every open message and alert shown, after you confirm',
    );
    expect(tab).toContain("With an Agent filter, only that filter's items");
    expect(tab).toContain(
      'Close All never closes questions, permissions or approvals',
    );
    for (const part of [
      'questions',
      'permission prompts',
      'approvals',
      'Sent To',
      'note',
      'the first answer counts',
    ])
      expect(tab, part).toContain(part);
    // how to answer each kind is with the day's work now (The Inbox)
    const inbox = section(page, 'inbox');
    for (const part of [
      'Allow Once',
      'Allow Always',
      'OpenCode saves the rule for the project',
      'only you',
      'Reject',
      'Approve',
      'expire',
      // how the owner learns that an item came
      'Autocode sends you no notification',
      // an ask that is ignored (the 1.0.0 pass)
      'If you do not answer',
      'An approval with an expiry is rejected when the time passes',
      'One without an expiry waits until you answer',
      // a Subagent's ask outlives its agent's turn (OpenCode 2.3)
      "One that a Subagent asked stays open after its agent's turn ended, " +
        'until it is answered or the Subagent stops',
      // the approval of an agent's job holds nothing up
      'The approval of a job that an agent set is the exception',
    ])
      expect(inbox, part).toContain(part);
    expect(rows(page.querySelector('table.kinds')).map((r) => r[0])).toEqual([
      'message',
      'alert',
      'question',
      'permission',
      'approval',
    ]);
    expect(section(page, 'web-agents')).toContain('waiting');
    const commands = rows(page.querySelector('table.commands'));
    const answer = commands.find(
      (r) => r[0] === 'autocode answer ITEM TEXT...',
    )?.[1];
    for (const part of [
      'question',
      'once',
      'always',
      'reject: why',
      'approve',
      'an option and a note',
    ])
      expect(answer, part).toContain(part);
  });

  // The 1.0.0 pass: whom a pattern reaches, with examples.
  it('shows whom a message reaches: an ID, a pattern, a list', async () => {
    const page = await open();
    const patterns = rows(page.querySelector('table.patterns'));
    expect(patterns.map((r) => r[0])).toEqual([
      'kaggle:lead',
      'kaggle:*',
      '*:lead',
      'kaggle:lead,kaggle:worker',
      'owner',
    ]);
    // a * crosses the levels of an ID
    expect(patterns[1]![1]).toContain('every agent whose ID starts with');
    expect(patterns[1]![1]).toContain('and also kaggle:housing:lead');
    const messages = section(page, 'messages');
    expect(messages).toContain('The sender never gets its own message');
    expect(messages).toContain(
      'autocode send \'kaggle:*\' "The deadline moved to Friday."',
    );
    // and how to send one from the Messages tab
    const tab = section(page, 'web-messages');
    expect(tab).toContain('click the heading Send a Message');
    expect(tab).toContain('several, split by commas');
  });

  it('tells agents how to use locks, and the owner what the Locks tab shows', async () => {
    const page = await open();
    const locks = section(page, 'locks');
    for (const part of [
      'autocode_lock',
      'action=acquire',
      'ttl',
      'max',
      'mode=queue',
      'mode=try',
      'renew',
      'release',
      'list',
      '[autocode] lock "gpu-0" granted',
      '[autocode] lock "gpu-0" expired',
      '[autocode] lock "gpu-0": out of the queue',
      // mode=queue: the agent is put in the queue, in arrival order
      'Otherwise it joins the queue, in arrival order',
      'leave the queue',
    ])
      expect(locks, part).toContain(part);
    // No waiting for a lock inside the tool call (the owner, 2026-11-07).
    expect(locks).not.toMatch(/mode=wait|seconds|max_tool_wait/);
    // Generic examples: no project's names.
    expect(locks).not.toMatch(/kaggle|casmi/i);
    expect(text(page.querySelector('#learn + ul'))).toContain('autocode_lock');
    expect(text(page.querySelector('#sees ~ pre'))).toContain(
      '[autocode] lock "gpu-0" granted',
    );
    const tab = section(page, 'web-locks');
    for (const part of [
      'type',
      'holders',
      'queue',
      'Mutex',
      'places',
      'Release',
      'told',
      'next in the queue',
      'Remove',
      'out of the queue',
      'move up',
      'The Lock filter matches lock names',
    ])
      expect(tab, part).toContain(part);
    const commands = rows(page.querySelector('table.commands'));
    const does = (command: string) =>
      commands.find((r) => r[0] === command)?.[1] ?? '';
    expect(does('autocode locks [PATTERN]')).toContain('queue');
    expect(does('autocode locks release NAME AGENT')).toContain(
      'take it out of the queue',
    );
    // A lock's waiting agents are its queue now, not its line (the owner,
    // 2026-11-05).
    for (const [where, words] of [
      ['locks', locks],
      ['web-locks', tab],
      ['commands', does('autocode locks [PATTERN]')],
      ['release', does('autocode locks release NAME AGENT')],
    ])
      expect(words, where).not.toMatch(/\bline\b/);
  });

  // Tier 0g (the owner, 2026-11-08).
  it('explains spend and context: the Costs tab, the Agents column, the CLI and the notice before a compaction', async () => {
    const page = await open();
    const costs = section(page, 'web-costs');
    for (const part of [
      'spend today',
      'in total',
      'daily cap',
      // its last 7 days, a bar per day, right after the cap
      'Last 7 Days is a chart, one bar per day, today at the right',
      // a day's value and date show on hover
      'Hover over a bar, or tab to it, to see its date and spend',
      'every 5 seconds',
      'Days',
      'unregistered',
      'Agent filters by agent ID',
      'the total of what is listed',
      // the two things called Days, told apart
      'Enter a number in the Days field above the table: Total and the ' +
        'totals row then count only that many last days',
      "The Days button in a row opens that agent's spend per day",
      'The Unregistered box, on by default, keeps the unregistered agents ' +
        'that spent something',
      "right of Refresh is when the data was read, in the server's time " +
        'and zone',
    ])
      expect(costs, part).toContain(part);
    const agents = section(page, 'web-agents');
    for (const part of [
      'model',
      'Spend',
      'Context',
      'The Unregistered box (off by default) adds the unregistered agents ' +
        'that spent something',
    ])
      expect(agents, part).toContain(part);
    // the owner, 2026-11-17: the model by its name ("why it doesnt say
    // fable 5.2")
    expect(agents).toContain(
      'its provider in grey, a slash and the model, like claude-agent/fable',
    );
    // the owner, 2026-11-17: "i want provider to be reflected in model cols"
    expect(agents).toContain(
      'Hover for its name where OpenCode has one, like Fable 5.2.',
    );
    // the owner, 2026-11-17: "for claude-agent provider also add version in
    // (), like claude-agent/fable (5.2)"
    expect(agents).toContain(
      'A claude-agent model also shows its version, like ' +
        'claude-agent/fable (5.2).',
    );
    // and "i want models/efforts tho be shown in the same way on agents
    // and jobs tabs"
    expect(section(page, 'web-jobs')).toContain(
      'Model and Effort (both as on the Agents tab)',
    );
    // the owner, 2026-11-17: "add col in agents tab for model effort"
    expect(agents).toContain(
      'Effort: how hard the model is set to think, like high or max',
    );
    expect(agents).toContain('You set it in OpenCode, not here');
    // the owner, 2026-11-17: "working agent is active by definition"
    expect(agents).toContain(
      'Last Active: when its session last started or ended a turn, ran a ' +
        'step or called Autocode. A working agent is active now.',
    );
    expect(section(page, 'web-hosts')).toContain('the Offline box');
    // the two warnings a host's row can carry
    expect(section(page, 'web-hosts')).toContain(
      '"too old", under the OpenCode version',
    );
    expect(section(page, 'web-hosts')).toContain(
      '"no shell values", under the process',
    );
    expect(section(page, 'web-hosts')).toContain(
      'A host marked "too old" shows either way',
    );
    // 1.0.1 (the owner, 2026-11-19: "fix for stale host records")
    expect(section(page, 'web-hosts')).toContain(
      'An offline host leaves the list a day after it was last heard ' +
        'from (host_expire_after)',
    );
    expect(section(page, 'settings')).toContain(
      'forget a host this long after it was last heard from',
    );
    expect(section(page, 'commands')).toContain('autocode hosts rm HOST');
    // the owner, 2026-11-17: OpenCode 2.3.0 is the minimum
    expect(section(page, 'connect')).toContain('(2.3.0 or later)');
    expect(section(page, 'trouble')).toContain(
      'A host is marked "too old", or a tool says "this OpenCode is v2.2.0; ' +
        'Autocode needs v2.3.0 or later"',
    );
    // nothing on it is served; one alert, which does not come again
    const old =
      rows(page.querySelector('table.trouble')).find((r) =>
        r[0]!.startsWith('A host is marked "too old"'),
      )?.[1] ?? '';
    for (const part of [
      "Its sessions' tokens stop working",
      'tools answer with the reason',
      'its shells get no Autocode values',
      // what still works, and what waits
      'the mark names the version it needs',
      'opencode service restart',
      "the agents' wakes and messages wait until it is back",
      'OpenCode itself still works',
      "other machines' hosts are not touched",
      'You get one Inbox alert for the host and its OpenCode version; once ' +
        'closed it does not come again for history_days days',
      'The Hosts tab keeps the mark',
    ])
      expect(old, part).toContain(part);
    // and a run waits for its Subagents (OpenCode 2.3 runs them in the
    // background)
    expect(section(page, 'jobs')).toContain(
      'A run does not end while a Subagent it started still works, or ' +
        "while OpenCode's image tool is still making an image for it",
    );
    // the owner, 2026-11-17: a registered session's title is its ID
    expect(section(page, 'register')).toContain(
      "the session's title becomes @ and its ID, like @kaggle:housing:lead",
    );
    // the owner, 2026-11-17: a click on its description edits it; no Edit
    expect(agents).toContain('A click on a description edits it');
    expect(agents).not.toContain('Edit a description');
    // sorting, newest first by default; the Closed box keeps open items
    const web = section(page, 'web');
    expect(web).toContain('A click on a column heading sorts the table by it');
    expect(web).toContain('newest first');
    expect(web).toContain('History sorts what is loaded');
    // filters match anywhere; Messages has From and To (the owner, 2026-11-17)
    expect(web).toContain(
      'A filter field matches what you type anywhere in an ID',
    );
    // what is not true of every tab, and what a * does in a filter
    for (const part of [
      'the Costs tab every 5',
      'Hosts has no Refresh; Settings loads when you open it',
      'The Settings tables and the text columns do not sort',
      'A * inside what you type stands for any characters; the match is ' +
        'still anywhere in the ID',
      'The Agents tab is the exception: its filter is not kept',
    ])
      expect(web, part).toContain(part);
    expect(section(page, 'web-messages')).toContain(
      'The list holds the newest 200',
    );
    // the reserved IDs, and who is not unregistered after 14 days
    expect(section(page, 'register')).toContain(
      'owner, autocode and IDs that start with job: are reserved',
    );
    expect(section(page, 'register')).toContain(
      'unless you or Stop All paused it',
    );
    // "Agent" on the Jobs tab is OpenCode's, not Autocode's
    expect(section(page, 'web-jobs')).toContain(
      "Agent (OpenCode's own kind of agent, such as build; not an Autocode " +
        'agent)',
    );
    expect(section(page, 'web-inbox')).toContain(
      'hands the ask back to you, with a note that shows in the Item column',
    );
    // when a filter applies is said once, here, not on every tab
    expect(web).toContain('A filter applies a second after you stop typing');
    expect(
      page.textContent!.match(/a second after you stop typing/g)?.length,
    ).toBe(1);
    expect(section(page, 'web-messages')).toContain(
      'From and To filter by sender and recipient',
    );
    expect(section(page, 'web-inbox')).toContain(
      'the open ones always show, however many closed ones there are',
    );
    // an agent's Spend leads to its row on the Costs tab: said on Agents
    expect(agents).toContain("A click shows the agent's row on the Costs tab");
    // a normal case: below the threshold; and what it means above it
    expect(agents).toContain('312K/500K/1M');
    expect(agents).toContain(
      'A first number above the second means that compaction comes when the ' +
        'turn ends',
    );
    // Effort is the model's variant: one thing, said once
    expect(agents).toContain(
      "OpenCode calls it the model's variant; it is the Variant of a job " +
        'and --variant in the CLI',
    );
    // a bar under the context (the owner, 2026-11-09): what the three
    // numbers and the bar mean is with the day's work now
    expect(agents).toContain('with a bar under them');
    const context = section(page, 'compaction');
    for (const part of [
      '312K/500K/1M',
      'what the session holds now',
      'the size at which Autocode compacts it (compact_at)',
      'the most the model can hold, its window',
      'The bar under them shows how close the session is to compaction: ' +
        'amber from 75%, red from 100%',
      'When the first number passes the second, compaction is due',
      // what compaction is, said once in plain words
      'everything the model reads again at each step',
      'OpenCode replaces the older part of the session with a summary',
      "half of the model's window, but at most 500,000 tokens",
      'autocode settings set compact_at 90% --agent kaggle:lead',
      // the notices, explained here once (they were under What an Agent
      // Sees): before it, a stable state
      '[autocode] compaction next',
      'a stable state',
      // the owner, 2026-11-09: also to an idle agent with nothing waiting
      'If the session is idle, for example after a turn you ran yourself ' +
        'in OpenCode, it comes as a prompt of its own',
      // the owner, 2026-11-17: after it, go on; only after one that happened
      '[autocode] compaction done follows',
      'goes on with the steps that are left',
      // one that OpenCode could not do
      'If OpenCode cannot do the compaction, nothing is compacted and no ' +
        'compaction done comes',
      'It waits while the agent is paused or offline',
      'autocode_me action=compact',
      '[autocode] compaction failed',
    ])
      expect(context, part).toContain(part);
    // the daily cap for one agent, in the web UI and with the CLI
    const spend = section(page, 'spend');
    for (const part of [
      'hover over the second bar from the right',
      "Open the Settings tab and go to Agents' Own Values",
      'enter kaggle:lead in Agent ID, pick daily_usd in Setting and enter ' +
        '20 in Value',
      'Click Add',
      'autocode settings set daily_usd 20 --agent kaggle:lead',
      'There is no cap on their sum',
      'the agent is paused when its turn ends, and you get an alert',
    ])
      expect(spend, part).toContain(part);
    expect(section(page, 'commands')).toContain(
      'autocode costs [--match PATTERN]',
    );
    // what an agent sees names the three notices and points there
    const sees = section(page, 'sees');
    expect(sees).toContain('[autocode] compaction next');
    expect(sees).toContain('[autocode] compaction done');
    expect(sees).toContain('[autocode] compaction failed');
    expect(sees).toContain(
      'The three compaction notices are explained under Context and ' +
        'Compaction',
    );
  });

  it('tells what the History tab shows, its filters and how older entries load', async () => {
    const page = await open();
    const history = section(page, 'web-history');
    for (const part of [
      'newest first',
      'Agent filters by agent ID',
      'Kind',
      'wake.*',
      // the "..." row, in place of an Older button (the owner, 2026-11-09)
      'it loads the next 100 older ones',
      '100',
      'click',
    ])
      expect(history, part).toContain(part);
    expect(history).not.toContain('Older loads');
  });

  it('explains the error state, Retry and the failures not retried', async () => {
    const page = await open();
    const agents = section(page, 'web-agents');
    expect(agents).toContain('error');
    expect(agents).toContain('Retry');
    const trouble = rows(page.querySelector('table.trouble'));
    const why = trouble.find((r) => r[0] === 'An agent shows error')?.[1] ?? '';
    for (const part of [
      'failed',
      'Retry',
      'autocode retry AGENT',
      'not retried',
      'retries ran out',
      'What each error type means is under Failed Turns and Retries',
    ])
      expect(why, part).toContain(part);
    // the rest is said once, with the day's work (Failed Turns and Retries)
    const retries = section(page, 'retries');
    for (const part of [
      'failed',
      'Autocode retries by itself',
      'retry_interval',
      'retry_attempts',
      'The messages and the wakes that waited come with it; a wake with a ' +
        'check waits until the agent works again',
      'A blocked reply has "blocked:" before it',
      'not retried',
      'retries ran out',
      'autocode retry AGENT',
      'provider.auth',
      'provider.invalid-request',
      'provider.unknown',
      'provider.unsupported-operation',
      'provider.content-filter',
      'filter_recovery',
      'The alert closes by itself once the agent works again',
      '[autocode] resume',
    ])
      expect(retries, part).toContain(part);
    const commands = rows(page.querySelector('table.commands')).map(
      (r) => r[0],
    );
    expect(commands).toContain('autocode retry AGENT');
  });

  it('helps when an agent ignores Autocode, a wake does not come, a host is offline or the owner cannot sign in', async () => {
    const page = await open();
    const trouble = rows(page.querySelector('table.trouble'));
    const row = (symptom: string) => trouble.find((r) => r[0] === symptom);
    expect(row('An agent seems to ignore Autocode')?.[1]).toContain(
      'autocode_me action=help',
    );
    const wake = row('A wake does not come')?.[1] ?? '';
    for (const cause of [
      'paused',
      'offline',
      'working',
      'check',
      'min_interval',
    ])
      expect(wake, cause).toContain(cause);
    // the checks for an offline host, in order (the 1.0.0 pass)
    const offline = row('A host is offline')?.[1] ?? '';
    const order = [
      'A host is one folder, not the machine',
      'Is OpenCode running on that machine',
      'Was the folder unused for an hour',
      'Is the host marked "too old"',
      'Can that machine reach the server',
      'autocode info',
      '~/.autocode/logs/plugin.log',
    ].map((part) => offline.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the rows in groups, by where the symptom shows
    expect(
      [...page.querySelectorAll('table.trouble tr.group th')].map((th) =>
        text(th),
      ),
    ).toEqual([
      'Signing In',
      'Agents',
      'Wakes',
      'Hosts and Machines',
      "The Plugin's Log, ~/.autocode/logs/plugin.log",
    ]);
    // Stop All: what to do when something goes wrong
    expect(
      row('Something is going wrong and everything should stop')?.[1],
    ).toContain('Click Stop All');
    expect(offline).toContain(
      'The Hosts tab lists an offline one only with the Offline box ticked',
    );
    // a lost admin token: the file, a new token, and what cannot be done
    const signIn =
      row('I cannot sign in, or I lost the admin token')?.[1] ?? '';
    for (const part of [
      'cat ~/.autocode/admin.token',
      'autocode token rotate --admin',
      'The old token stops working at once',
      // no copy left: the server makes a new one at its next start
      'no command recovers it',
      'systemctl --user stop autocode',
      'cp -p ~/.autocode/autocode.db ~/.autocode/autocode-backup.db',
      'sqlite3 "$HOME/.autocode/autocode.db" \\ "DELETE FROM tokens WHERE ' +
        "kind = 'admin'\"",
      'systemctl --user start autocode',
      'The server makes a new admin.token when it starts',
      'It is not lost while its file exists',
      'stop the autocode service',
      'After an install with --data DIR, the database and admin.token are in ' +
        'DIR',
    ])
      expect(signIn, part).toContain(part);
    // every row that was there stays
    for (const symptom of [
      'A machine has no hosts',
      'The plugin\'s log says "no client config"',
      'The plugin\'s log says "the server at … is X, not Y"',
      'The plugin\'s log says "superseded by a newer instance"',
      'An agent shows offline',
      'Registering says id_taken',
      'A tool says session_gone',
      'A shell has no AUTOCODE_TOKEN',
      'The CLI says "the server at … is X, not Y"',
      'autocode install waits and fails',
    ])
      expect(row(symptom), symptom).toBeDefined();
  });

  // The 1.0.0 pass: the owner's tokens can be replaced.
  it('tells how to install, connect and sign in, and how to replace a token', async () => {
    const page = await open();
    expect(text(page.querySelector('#install ~ pre'))).toBe(
      'dist/autocode install --id home --listen localhost,tailscale:4848',
    );
    const install = section(page, 'install');
    for (const part of [
      '--listen 0.0.0.0:4848',
      // the reader has no README at hand: where it is
      'The README at github.com/myurasov/Autocode says how',
      // with --data the tokens are there, and the CLI does not look there
      "--data DIR keeps the server's data, with admin.token and " +
        'consumer.token, in DIR',
      '--admin-token-file DIR/admin.token',
      // no PATH yet at this point: the whole path
      '~/.autocode/bin/autocode uninstall removes the service',
    ])
      expect(install, part).toContain(part);
    const connect = section(page, 'connect');
    for (const part of [
      'Add ~/.autocode/bin to your PATH first (see The CLI), or type the ' +
        'whole path',
      // on the server machine
      'autocode plugin install --url http://127.0.0.1:4848 --server-id home',
      // on a second machine: the binary and the token first
      'scp -p machine-a:.autocode/bin/autocode ~/autocode',
      'scp -p machine-a:.autocode/consumer.token ~/.autocode/consumer.token',
      '~/autocode plugin install --url http://machine-a:4848 --server-id home',
      '--consumer-token-file ~/.autocode/consumer.token',
      'copies the binary to ~/.autocode/bin/autocode',
      'On machine-b you can delete ~/autocode after it',
      'On machine-a every command of yours works',
      'lists the folder as online',
    ])
      expect(connect, part).toContain(part);
    expect(section(page, 'sign-in')).toContain('Stay signed in');
    expect(rows(page.querySelector('table.tokens')).map((r) => r[0])).toEqual([
      'admin',
      'consumer',
      'session',
    ]);
    const tokens = section(page, 'tokens');
    for (const part of [
      'autocode token rotate AGENT',
      'autocode token rotate --consumer',
      'autocode token rotate --admin',
      'print that path, never the token',
      // with the consumer token go the session tokens
      'Every session token stops working with it',
      'Until a machine has the new token, its hosts are offline',
      // a running plugin reads the new token itself
      'OpenCode needs no restart',
      'if that config has the URL the command used',
      // shells and checks after it; a command left running keeps the old one
      'shells and checks that start afterwards carry the new token',
      'its autocode fire me ... is refused',
      'fire that wake yourself with autocode fire AGENT WAKE',
      // a lost token is not lost while its file exists
      'The admin token is not lost while its file exists',
      'follow "I cannot sign in, or I lost the admin token" in ' +
        'Troubleshooting',
      'sign in to the web UI again',
      // a leaked admin token: both
      'If it leaked, replace the consumer token too',
    ])
      expect(tokens, part).toContain(part);
    // no internals: a hash means nothing to the owner
    expect(tokens).not.toContain('hash');
  });

  it("tells how long texts fold and that agent and host IDs lead to their tabs' rows", async () => {
    const page = await open();
    const web = section(page, 'web');
    expect(web).toContain(
      'An agent or host ID links to its tab, which highlights its row',
    );
    // every date the same way (the owner, 2026-11-09)
    expect(web).toContain('Dates read like 05-Nov-26');
    // 25 rows, "...", folding groups (the owner, 2026-11-09)
    expect(web).toContain('A table shows 25 rows at first');
    expect(web).toContain("a click on a group's heading folds");
    expect(section(page, 'web-hosts')).toContain(
      'A link to an offline host ticks the Offline box',
    );
    const agents = section(page, 'web-agents');
    expect(agents).toContain('Host (a link to its row on the Hosts tab)');
    const messages = section(page, 'web-messages');
    expect(messages).toContain('first 200 characters');
    expect(messages).toContain('anywhere in its cell');
    // one state, with how (the owner, 2026-11-09); processed, not read
    // (2026-11-10): each way in a line of its own
    expect(messages).toContain('State is queued');
    expect(messages).toContain('processed, or dropped');
    expect(
      [...page.querySelectorAll('#web-messages + ul ul > li > code')].map((c) =>
        text(c),
      ),
    ).toEqual(['prompt', 'steer', 'read', 'wait', 'inbox']);
    // as markdown; the Processed box (the owner, 2026-11-09, 2026-11-10)
    expect(messages).toContain('Text is shown as markdown');
    expect(messages).toContain('Tick Processed (off by default)');
    expect(messages).not.toContain('delivered');
    const wakes = section(page, 'web-wakes');
    expect(wakes).toContain('first 200 characters');
    expect(wakes).toContain('anywhere in its cell');
    expect(wakes).toContain('fixed-width font');
    expect(wakes).toContain('Last Set:');
  });

  // A thing's idea and its tab point at each other (the 1.0.0 pass).
  it('links its sections to each other, each link to a section that exists', async () => {
    const page = await open();
    const ids = new Set(SECTIONS.map((s) => s.id));
    const links = [...page.querySelectorAll('article a')].map(
      (a) => a.getAttribute('href') ?? '',
    );
    expect(links.length).toBeGreaterThan(30);
    for (const href of links) {
      expect(href, href).toMatch(/^\/help#/);
      expect(ids.has(href.slice('/help#'.length)), href).toBe(true);
    }
    // The links of a section: what comes after its heading, up to the next.
    const to = (from: string) => {
      const out: string[] = [];
      let node = page.querySelector(`#${from}`)!.nextElementSibling;
      while (node && !/^H[23]$/.test(node.tagName)) {
        for (const a of [...node.querySelectorAll('a')])
          out.push(a.getAttribute('href') ?? '');
        node = node.nextElementSibling;
      }
      return out;
    };
    for (const [idea, tab] of [
      ['wakes', 'web-wakes'],
      ['messages', 'web-messages'],
      ['locks', 'web-locks'],
      ['jobs', 'web-jobs'],
      ['inbox', 'web-inbox'],
      ['settings', 'web-settings'],
    ] as const) {
      expect(to(idea), idea).toContain(`/help#${tab}`);
      expect(to(tab), tab).toContain(`/help#${idea}`);
    }
  });

  it('uses generic names in its examples', async () => {
    const page = await open();
    expect(page.textContent).not.toMatch(/casmi/i);
    expect(section(page, 'register')).toContain(
      'Register with Autocode as kaggle:housing:lead',
    );
  });

  it('writes no hyphen where a dash belongs', async () => {
    const page = await open();
    expect(page.textContent!.match(/\S - \S/g) ?? []).toEqual([]);
  });
});
