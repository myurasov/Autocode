/*
 * Unit tests of the Help page: its route and no calls to the server; the
 * numbered contents (sections, subsections indented), each entry a link to a
 * heading with the same number and title; the facts the owner looks up most
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
  ['3.6', 'What an Agent Sees'],
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
  ['5.7', 'History'],
  ['5.8', 'Settings'],
  ['5.9', 'Help'],
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
    const scripts = text(page.querySelector('ul.scripts'));
    for (const command of [
      'autocode me',
      'autocode wake set me',
      'autocode fire me',
      'autocode messages [--wait SECONDS]',
    ])
      expect(scripts, command).toContain(command);
  });

  it('gives the settings in use with their defaults', async () => {
    const page = await open();
    const settings = rows(page.querySelector('table.settings-help'));
    expect(settings.map((r) => r.slice(0, 2))).toEqual([
      ['min_interval', '1m'],
      ['inline_limit', '1024'],
      ['check_timeout', '60s'],
      ['check_output', '2000'],
      ['max_tool_wait', '5m'],
      ['timezone', "the server machine's"],
      ['history_days', '30'],
      ['retry_interval', '1m'],
      ['retry_attempts', '0'],
    ]);
    const attempts = settings.find((r) => r[0] === 'retry_attempts')!;
    expect(attempts[2]).toContain('0: no limit');
    // Retries are no longer among the settings kept for later tiers.
    expect(text(page.querySelector('table.settings-help + p'))).not.toContain(
      'retries',
    );
  });

  it('tells agents how to use locks, and the owner what the Locks tab shows', async () => {
    const page = await open();
    // A section's text: what comes after its heading, up to the next one.
    const section = (id: string) => {
      const out: string[] = [];
      let node = page.querySelector(`#${id}`)!.nextElementSibling;
      while (node && !/^H[23]$/.test(node.tagName)) {
        out.push(text(node));
        node = node.nextElementSibling;
      }
      return out.join(' ');
    };
    const locks = section('locks');
    for (const part of [
      'autocode_lock',
      'action=acquire',
      'ttl',
      'max',
      'mode=queue',
      'mode=try',
      'mode=wait',
      'renew',
      'release',
      'list',
      '[autocode] lock "gpu-0" granted',
      '[autocode] lock "gpu-0" expired',
      '[autocode] lock "gpu-0": out of the queue',
      'puts the agent in the queue',
      'stays in the queue',
      'leave the queue',
    ])
      expect(locks, part).toContain(part);
    // Generic examples: no project's names.
    expect(locks).not.toMatch(/kaggle|casmi/i);
    expect(text(page.querySelector('#learn + ul'))).toContain('autocode_lock');
    expect(text(page.querySelector('#sees ~ pre'))).toContain(
      '[autocode] lock "gpu-0" granted',
    );
    const tab = section('web-locks');
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
    expect(after('web-hosts')).toContain('highlighted');
    const agents = after('web-agents');
    expect(agents).toContain('host');
    expect(agents).toContain('Hosts page');
    const messages = after('web-messages');
    expect(messages).toContain('first 200 characters');
    expect(messages).toContain('anywhere in its cell');
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
