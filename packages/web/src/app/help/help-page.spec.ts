/*
 * Unit tests of the Help page: its route and no calls to the server; the
 * numbered contents (sections, subsections indented), each entry a link to a
 * heading with the same number and title; what Autocode is for (long-term,
 * agentic autonomy) and which feature serves which need; asks (questions,
 * permissions, approvals) for agents and in the Inbox; text-only messages,
 * wakes without an end that merge by name, locks without a wait in the tool
 * call; the facts the owner looks up most
 * (the wake triggers, the owner's commands, the settings in use with their
 * defaults, the troubleshooting rows for agents and wakes); locks, for agents
 * and on the Locks tab; the web UI's long texts and ID links; no hyphen where
 * a dash belongs.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { el, settle, setup, signedIn, text } from '../../testing/helpers';
import { routes } from '../app.routes';
import { HelpPage, SECTIONS } from './help-page';

// The contents, as the owner asked for them (2026-11-02).
const CONTENTS = [
  ['1', 'What Autocode Is'],
  ['2', 'Getting Started'],
  ['2.1', 'Install the Server'],
  ['2.2', "Connect a Machine's OpenCode"],
  ['2.3', 'Sign In'],
  ['2.4', 'Tokens'],
  ['3', 'Using It From OpenCode'],
  ['3.1', 'How Agents Learn Autocode'],
  ['3.2', 'Asking an Agent to Register'],
  ['3.3', 'Wakes'],
  ['3.4', 'Messages'],
  ['3.5', 'Locks'],
  ['3.6', 'Questions, Permissions and Approvals'],
  ['3.7', 'Jobs'],
  ['3.8', 'What an Agent Sees'],
  ['4', 'The CLI'],
  ['4.1', 'Your Commands'],
  ['4.2', "In an Agent's Shell"],
  ['5', 'The Web UI'],
  ['5.1', 'Hosts'],
  ['5.2', 'Agents'],
  ['5.3', 'Inbox'],
  ['5.4', 'Messages'],
  ['5.5', 'Locks'],
  ['5.6', 'Wakes'],
  ['5.7', 'Jobs'],
  ['5.8', 'Costs'],
  ['5.9', 'History'],
  ['5.10', 'Settings'],
  ['5.11', 'Help'],
  ['6', 'Settings'],
  ['7', 'Troubleshooting'],
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
  const rows = (table: Element | null) =>
    [...(table?.querySelectorAll('tbody tr') ?? [])].map((r) =>
      [...r.querySelectorAll('td')].map((td) => text(td)),
    );

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

  it('says what Autocode is for: long-term, agentic autonomy, which decides its features', async () => {
    const page = await open();
    const what = section(page, 'what');
    for (const part of [
      'a framework for long-term, agentic autonomy',
      'days or weeks',
      'coordinate with each other',
      'under your control',
      'decides which features it has',
      'left out or kept small',
      // The two parts, and the owner's control, as before.
      'a server, which keeps the state and serves this web UI',
      'a plugin',
      'You control it all here',
    ])
      expect(what, part).toContain(part);
    // Locks and retries are here now, not in a later tier.
    expect(what).not.toContain('Later tiers add locks');
    expect(what).not.toMatch(/kaggle|casmi/i);
    // What an autonomous agent needs, and the feature that serves it.
    const needs = page.querySelector('#what ~ table.needs')!;
    expect(
      [...needs.querySelectorAll('thead th')].map((th) => text(th)),
    ).toEqual(['What an Agent Needs', 'What Autocode Has']);
    const serves = (need: string) =>
      rows(needs).find((r) => r[0]!.includes(need))?.[1] ?? '';
    const map: [string, string[]][] = [
      ['come back later', ['wakes', 'checks']],
      ['background job ends', ['fire-only']],
      ['other agents', ['messages', 'discovery']],
      ['scarce resources', ['locks and semaphores']],
      ['something breaks', ['retries', 'resumes']],
      ['decision', ['Inbox', 'another agent']],
      ['limits', ['daily cost cap', 'compaction', 'expiry']],
      ['fresh agent', ['jobs']],
      ['control', ['pause', 'Stop All', 'web UI', 'history']],
    ];
    expect(rows(needs).length).toBe(map.length);
    for (const [need, features] of map)
      for (const feature of features)
        expect(serves(need), `${need}: ${feature}`).toContain(feature);
    // Every row is built now (tiers 0d to 0f): none is marked for later.
    expect(text(needs)).not.toContain('later tier');
  });

  // The owner, 2026-11-08: a mode setting's lists.
  it('says how a mode setting picks an agent or a job on the Settings tab', async () => {
    const page = await open();
    expect(section(page, 'web-settings')).toContain(
      'A mode setting (question_mode, permission_mode, approval_mode)',
    );
    expect(section(page, 'web-settings')).toContain(
      'Agent… or Job… adds a list of the registered agents or the jobs',
    );
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
  });

  it('gives every wake trigger, with idle counted from the end of the last turn', async () => {
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
    ]);
    const idle = rows(table)[4]![1]!;
    expect(idle).toContain('end of its last turn');
    expect(idle).toContain('never from before the wake was set');
    expect(idle).toContain('from the last time it fell due');
    const checks = text(page.querySelector('ul.checks'));
    expect(checks).toContain('exit 0 wakes the agent');
    expect(checks).toContain('exit 1 skips');
    expect(checks).toContain('three in a row');
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
      'autocode inbox [--all]',
      'autocode answer ITEM TEXT...',
      'autocode pause AGENT / resume AGENT',
      'autocode stop-all / resume-all',
      'autocode wakes [AGENT]',
      'autocode fire AGENT WAKE [--text TEXT]',
      'autocode send TO TEXT...',
      'autocode messages',
      'autocode locks [PATTERN]',
      'autocode locks release NAME AGENT',
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
  });

  it('gives the settings in use with their defaults', async () => {
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
      'read once',
      'when you answer or close its Inbox item',
    ])
      expect(messages).toContain(part);
    const settings = rows(page.querySelector('table.settings-help'));
    expect(settings.map((r) => r.slice(0, 2))).toEqual([
      ['min_interval', '1m'],
      ['check_timeout', '60s'],
      ['check_output', '2000'],
      ['max_tool_wait', '5m'],
      ['timezone', "the server machine's"],
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
      ['compact_at', '50% max 500000'],
      ['daily_usd', 'off'],
      ['cap_warn', '90%'],
      ['expire_after', '14d'],
    ]);
    for (const mode of ['question_mode', 'permission_mode', 'approval_mode'])
      expect(settings.find((r) => r[0] === mode)![2], mode).toContain(
        'agent:<id>',
      );
    const attempts = settings.find((r) => r[0] === 'retry_attempts')!;
    expect(attempts[2]).toContain('0: no limit');
    // Every setting is used now: none is kept for a later tier.
    const after = text(page.querySelector('table.settings-help + p'));
    expect(after).not.toContain('later tier');
    expect(after).toContain('listen');
  });

  it('explains jobs: for agents, on the Jobs tab and in the commands', async () => {
    const page = await open();
    const jobs = section(page, 'jobs');
    // a run's ID is its start minute in UTC (the review of 0b2)
    expect(jobs).toContain('its start minute in UTC');
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
    ])
      expect(jobs, part).toContain(part);
    expect(jobs).not.toMatch(/kaggle|casmi/i);
    const tab = section(page, 'web-jobs');
    for (const part of [
      'Run Now',
      'Set a Job',
      'Edit',
      'Delete',
      'runs',
      'Delete Session',
      'Job',
      'Last Run',
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
      'only you allow always',
      'waiting',
    ])
      expect(asks, part).toContain(part);
    expect(asks).not.toMatch(/kaggle|casmi/i);
    expect(text(page.querySelector('#learn + ul'))).toContain(
      'autocode_approval',
    );
    const inbox = section(page, 'web-inbox');
    // the box is "Closed" (the owner, 2026-11-09)
    expect(inbox).toContain('The Closed box lists');
    expect(inbox).not.toContain('Show Closed');
    for (const part of [
      'questions',
      'permission prompts',
      'approvals',
      'Sent To',
      'note',
      'the first answer counts',
      'Allow Once',
      'Allow Always',
      'OpenCode saves the rule for the project',
      'only you',
      'Reject',
      'Approve',
      'expire',
    ])
      expect(inbox, part).toContain(part);
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
      'puts the agent in the queue',
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
      'pattern',
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
      'right after it its last 7 days, a bar per day',
      'its value and date show at once',
      'every 5 seconds',
      'Days',
      'unregistered',
      'Agent filters by an ID pattern',
      'the total of what is listed',
      'Days makes Total and the totals the last so many days',
      'Unregistered box is on (it is by default)',
      "when the data was read (the server's time, in its zone) is right of " +
        'Refresh',
    ])
      expect(costs).toContain(part);
    const agents = section(page, 'web-agents');
    for (const part of ['model', 'Spend', 'Context', 'the Unregistered box'])
      expect(agents).toContain(part);
    expect(section(page, 'web-hosts')).toContain('the Offline box');
    expect(costs).toContain("a click on an agent's Spend there leads here");
    expect(agents).toContain('854K/777K/1M');
    // a bar under the context (the owner, 2026-11-09)
    expect(agents).toContain(
      "under it a bar of the threshold's share, amber from 75%, red from 100%",
    );
    expect(section(page, 'commands')).toContain(
      'autocode costs [AGENT] [--match PATTERN]',
    );
    const sees = section(page, 'sees');
    expect(sees).toContain('[autocode] compaction next');
    expect(sees).toContain('a stable state');
    // the owner, 2026-11-09: also to an idle agent with nothing waiting
    expect(sees).toContain('also when nothing else waits for it');
  });

  it('tells what the History tab shows, its filters and Older', async () => {
    const page = await open();
    const history = text(page.querySelector('#web-history + p'));
    for (const part of [
      'newest first',
      'Agent',
      'pattern',
      'Kind',
      'wake.*',
      'Older',
      '100',
      'click',
    ])
      expect(history, part).toContain(part);
  });

  it('explains the error state, Retry and the failures not retried', async () => {
    const page = await open();
    const agents = text(page.querySelector('#web-agents + p'));
    expect(agents).toContain('error');
    expect(agents).toContain('Retry');
    const trouble = rows(page.querySelector('table.trouble'));
    const why = trouble.find((r) => r[0] === 'An agent shows error')?.[1] ?? '';
    for (const part of [
      'failed',
      'retry_interval',
      'wakes and messages',
      'Retry',
      'autocode retry AGENT',
      'provider.auth',
      'provider.invalid-request',
      'provider.content-filter',
      'provider.unknown',
    ])
      expect(why, part).toContain(part);
    const commands = rows(page.querySelector('table.commands')).map(
      (r) => r[0],
    );
    expect(commands).toContain('autocode retry AGENT');
  });

  it('helps when an agent ignores Autocode or a wake does not come', async () => {
    const page = await open();
    const trouble = rows(page.querySelector('table.trouble'));
    const row = (symptom: string) => trouble.find((r) => r[0] === symptom);
    expect(row('An agent seems to ignore Autocode')?.[1]).toContain(
      'autocode_me action=help',
    );
    const wake = row('A wake does not come')?.[1] ?? '';
    for (const cause of ['paused', 'offline', 'busy', 'check', 'min_interval'])
      expect(wake, cause).toContain(cause);
    expect(row('A host is offline')).toBeDefined();
  });

  it("tells how long texts fold and that agent and host IDs lead to their pages' rows", async () => {
    const page = await open();
    const after = (id: string) => text(page.querySelector(`#${id} + p`));
    expect(after('web')).toContain(
      'An agent or host ID links to its page, which highlights its row',
    );
    // every date the same way (the owner, 2026-11-09)
    expect(after('web')).toContain('Dates read like 05-Nov-26');
    expect(after('web-hosts')).toContain('highlighted');
    const agents = after('web-agents');
    expect(agents).toContain('host');
    expect(agents).toContain('Hosts page');
    const messages = after('web-messages');
    expect(messages).toContain('first 200 characters');
    expect(messages).toContain('anywhere in its cell');
    // one state, read, with how (the owner, 2026-11-09)
    expect(messages).toContain('queued, read (how: prompt, steer, read, wait');
    expect(messages).not.toContain('delivered');
    const wakes = after('web-wakes');
    expect(wakes).toContain('first 200 characters');
    expect(wakes).toContain('anywhere in its cell');
    expect(wakes).toContain('fixed-width font');
    expect(wakes).toContain('Last Set:');
  });

  it('writes no hyphen where a dash belongs', async () => {
    const page = await open();
    expect(page.textContent!.match(/\S - \S/g) ?? []).toEqual([]);
  });
});
