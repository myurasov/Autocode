/*
 * Unit tests of the Wakes page against a mocked server: every wake by agent
 * (a link to the agent on the Agents page) with its trigger, next time, text
 * and check (a long one's first 200 characters, whole on a click anywhere in
 * its cell; the check as code), setter (an agent's a link), when it was set
 * and last firing (a wake has no end); Fire, and Cancel after a confirmation
 * (the list refreshes after each), with the result in the toolbar; the Set a
 * Wake form, collapsed until opened, for any agent (and the server's message
 * when it refuses); "Updated" in the footer; and the 10 s refresh (one at a
 * time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  apiError,
  button,
  el,
  parts,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import { REFRESH_MS } from '../agents/agents-page';
import type { Wake } from '../api';
import { localTime } from '../format';
import { triggerText, WakesPage } from './wakes-page';

const BASE = {
  created_at: '2026-10-28T09:00:00.000Z',
  updated_at: '2026-10-28T09:00:00.000Z',
  check_failures: 0,
};

const WAKES: Wake[] = [
  {
    ...BASE,
    agent: 'kaggle:lead',
    name: 'standup',
    text: 'Report your progress.\nThen go on.',
    trigger: 'every 30m',
    check: 'test -f /tmp/go',
    next: '2026-10-28T12:00:00.000Z',
    set_by: 'owner',
    last_fired_at: '2026-10-28T11:30:00.000Z',
  },
  {
    ...BASE,
    agent: 'kaggle:lead',
    name: 'nightly',
    text: 'Clean up.',
    trigger: 'cron "0 2 * * *" UTC',
    check: null,
    next: '2026-10-29T02:00:00.000Z',
    set_by: 'kaggle:lead',
    last_fired_at: null,
  },
  {
    ...BASE,
    agent: 'alpha:one',
    name: 'ping',
    text: 'Ping.',
    trigger: 'fire-only',
    check: null,
    next: null,
    set_by: 'alpha:one',
    last_fired_at: null,
  },
  // an idle wake: no time of its own, but when it falls due if the session
  // stays idle (the server's `due`)
  {
    ...BASE,
    agent: 'alpha:one',
    name: 'nudge',
    text: 'Nudge.',
    trigger: 'idle 30m',
    check: null,
    next: null,
    due: '2026-10-28T12:15:00.000Z',
    set_by: 'alpha:one',
    last_fired_at: null,
  },
];

// What a field of the page holds.
const value = (page: HTMLElement, selector: string) =>
  (page.querySelector(selector) as HTMLInputElement).value;

describe('WakesPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<WakesPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(wakes = WAKES): void {
    http.expectOne('/v1/wakes').flush({ wakes });
  }

  async function open(wakes = WAKES): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(WakesPage);
    load(wakes);
    await settle(fixture);
    return el(fixture);
  }

  const row = (page: HTMLElement, agent: string, name: string) =>
    page.querySelector(
      `table.wakes tbody[data-agent="${agent}"] tr[data-wake="${name}"]`,
    )!;

  it('lists every wake by agent with its trigger, times, text, check and setter', async () => {
    const page = await open();
    // When the list last loaded: in the footer, the page's last item.
    expect(page.querySelector('.toolbar app-updated')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.wakes thead th')].map((th) => text(th)),
    ).toEqual([
      'Name',
      'Trigger',
      'Next',
      'Text',
      'Check',
      'Set By',
      'Last Set',
      'Last Fired',
      '',
    ]);
    // Agents in alphabetical order, each with a header row, wakes in the
    // server's order.
    const groups = [...page.querySelectorAll('table.wakes tbody[data-agent]')];
    expect(groups.map((g) => g.getAttribute('data-agent'))).toEqual([
      'alpha:one',
      'kaggle:lead',
    ]);
    expect(text(groups[1]!.querySelector('tr.group'))).toBe('kaggle:lead');
    // The agent's heading links to its row on the Agents page, as plain text.
    const heading = groups[1]!.querySelector('tr.group a.id-link')!;
    expect(heading.getAttribute('href')).toBe('/agents?agent=kaggle:lead');
    expect(heading.querySelector('code')).toBeNull();
    expect(
      [...groups[1]!.querySelectorAll('tr[data-wake]')].map((r) =>
        r.getAttribute('data-wake'),
      ),
    ).toEqual(['standup', 'nightly']);

    const standup = row(page, 'kaggle:lead', 'standup');
    const cell = (r: Element, c: string) => text(r.querySelector(`td.${c}`));
    expect(cell(standup, 'name')).toBe('standup');
    expect(cell(standup, 'trigger')).toBe('every 30m');
    expect(cell(standup, 'next')).toBe(localTime('2026-10-28T12:00:00.000Z'));
    expect(standup.querySelector('td.next')!.getAttribute('title')).toBe(
      '2026-10-28T12:00:00.000Z',
    );
    // A short text whole, its lines kept; nothing to open.
    const short = standup.querySelector('td.text')!;
    expect(short.textContent).toBe('Report your progress.\nThen go on.');
    expect(short.querySelector('.more')).toBeNull();
    expect(short.getAttribute('title')).toBeNull();
    expect(cell(standup, 'check')).toBe('test -f /tmp/go');
    // A wake has no end (the owner, 2026-11-07).
    expect(standup.querySelector('td.end')).toBeNull();
    expect(cell(standup, 'by')).toBe('owner');
    expect(standup.querySelector('td.by code')).toBeNull();
    expect(standup.querySelector('td.by a')).toBeNull();
    // A short check whole, as code; nothing to open.
    expect(standup.querySelector('td.check code')!.textContent).toBe(
      'test -f /tmp/go',
    );
    expect(standup.querySelector('td.check .more')).toBeNull();
    expect(standup.querySelector('td.check')!.classList).not.toContain('folds');
    // When it was last set: its schedule counts from then.
    expect(cell(standup, 'set')).toBe(localTime('2026-10-28T09:00:00.000Z'));
    expect(standup.querySelector('td.set')!.getAttribute('title')).toBe(
      '2026-10-28T09:00:00.000Z',
    );
    expect(cell(standup, 'fired')).toBe(localTime('2026-10-28T11:30:00.000Z'));
    expect(button(standup, 'Fire')).toBeDefined();
    expect(button(standup, 'Cancel')).toBeDefined();

    // What is not there shows as a dash.
    const ping = row(page, 'alpha:one', 'ping');
    expect(cell(ping, 'next')).toBe('—');
    expect(cell(ping, 'check')).toBe('—');
    expect(cell(ping, 'fired')).toBe('—');
    expect(cell(ping, 'text')).toBe('Ping.');
    expect(parts(ping.querySelector('td.by code'))).toEqual(['alpha:', 'one']);
    // IDs and wake names break only after ":" or "_" (the owner,
    // 2026-11-03); texts, checks, triggers and times wrap.
    expect(groups[1]!.querySelector('tr.group th')!.classList).toContain(
      'id-like',
    );
    for (const c of ['name', 'by'])
      expect(standup.querySelector(`td.${c}`)!.classList, c).toContain(
        'id-like',
      );
    expect(parts(standup.querySelector('td.name code'))).toEqual(['standup']);
    expect(parts(standup.querySelector('td.by'))).toEqual(['owner']);
    expect(
      groups[1]!.querySelector('tr.group th')!.getAttribute('colspan'),
    ).toBe('9');
    expect(parts(groups[1]!.querySelector('tr.group th'))).toEqual([
      'kaggle:',
      'lead',
    ]);
    for (const c of ['trigger', 'next', 'text', 'check', 'set'])
      expect(standup.querySelector(`td.${c}`)!.classList, c).not.toContain(
        'id-like',
      );
    // An agent that set a wake links to its row on the Agents page.
    expect(ping.querySelector('td.by a.id-link')!.getAttribute('href')).toBe(
      '/agents?agent=alpha:one',
    );
  });

  // A text longer than 200 characters, with its lines.
  const LONG =
    'Check the training run in runs/latest and act on the result:\n' +
    'restart it when it stopped, tune the learning rate when it diverges, ' +
    'and write down what you changed and why in runs/latest/NOTES.md, ' +
    'with the step and the loss at that step.';
  const CHECK =
    "test -n \"$(find /home/someone/kaggle/runs/latest -name '*.ckpt' " +
    '-newer /home/someone/kaggle/runs/latest/.last-check -print -quit)" && ' +
    'touch /home/someone/kaggle/runs/latest/.last-check && ' +
    'grep -q DONE /home/someone/kaggle/runs/latest/status.txt';

  it("shows a long text's first 200 characters; a click anywhere in its cell shows it whole, the next folds it; it stays open across the refresh", async () => {
    expect(LONG.length).toBeGreaterThan(200);
    const wakes = [{ ...WAKES[1]!, text: LONG }, WAKES[0]!, WAKES[2]!];
    const page = await open(wakes);
    const td = () =>
      row(page, 'kaggle:lead', 'nightly').querySelector(
        'td.text',
      ) as HTMLElement;
    const more = () => td().querySelector('.more') as HTMLElement;
    expect(td().classList).toContain('folds');
    expect(more().getAttribute('role')).toBe('button');
    expect(more().getAttribute('tabindex')).toBe('0');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(more().textContent).toBe(`${LONG.slice(0, 200).trimEnd()}…`);
    // The cell itself, its padding included, takes the click.
    td().click();
    await settle(fixture);
    expect(more().textContent).toBe(LONG);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    button(page, 'Refresh')!.click();
    load(wakes);
    await settle(fixture);
    expect(more().textContent).toBe(LONG);
    // A click on the text itself folds it once, not twice.
    more().click();
    await settle(fixture);
    expect(more().textContent).toBe(`${LONG.slice(0, 200).trimEnd()}…`);
    // Enter (or Space) on the focusable text opens it.
    more().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    expect(more().textContent).toBe(LONG);
    // Another wake of the same agent stays as it was.
    const other = row(page, 'kaggle:lead', 'standup').querySelector('td.text')!;
    expect(other.querySelector('.more')).toBeNull();
    expect(other.classList).not.toContain('folds');
  });

  it('folds a long check the same way, in code', async () => {
    expect(CHECK.length).toBeGreaterThan(200);
    const wakes = [{ ...WAKES[1]!, check: CHECK }, WAKES[0]!, WAKES[2]!];
    const page = await open(wakes);
    const td = () =>
      row(page, 'kaggle:lead', 'nightly').querySelector(
        'td.check',
      ) as HTMLElement;
    const code = () => td().querySelector('code.more') as HTMLElement;
    expect(td().classList).toContain('folds');
    expect(code().getAttribute('role')).toBe('button');
    expect(code().getAttribute('tabindex')).toBe('0');
    expect(code().textContent).toBe(`${CHECK.slice(0, 200).trimEnd()}…`);
    // It still breaks after "/" where it must.
    expect(code().querySelector('wbr')).not.toBeNull();
    td().click();
    await settle(fixture);
    expect(code().textContent).toBe(CHECK);
    expect(code().getAttribute('aria-expanded')).toBe('true');
    // The text of the same wake stays as it was.
    expect(
      row(page, 'kaggle:lead', 'nightly').querySelector('td.text .more'),
    ).toBeNull();
    code().dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    await settle(fixture);
    expect(code().textContent).toBe(`${CHECK.slice(0, 200).trimEnd()}…`);
  });

  // The review of 0b2: the owner sees an idle wake's due time too.
  it("shows an idle wake's due time in Next, marked if idle", async () => {
    const page = await open();
    const nudge = row(page, 'alpha:one', 'nudge');
    const next = nudge.querySelector('td.next')!;
    expect(text(next)).toBe(`${localTime('2026-10-28T12:15:00.000Z')} if idle`);
    expect(next.getAttribute('title')).toBe(
      '2026-10-28T12:15:00.000Z, if the session stays idle',
    );
    expect(text(row(page, 'alpha:one', 'ping').querySelector('td.next'))).toBe(
      '—',
    );
  });

  it('shows a one-time trigger at its local time', () => {
    expect(triggerText('at 2026-10-28T12:00:00.000Z')).toBe(
      `at ${localTime('2026-10-28T12:00:00.000Z')}`,
    );
    expect(triggerText('every 30m from 09:00')).toBe('every 30m from 09:00');
    expect(triggerText('idle 30m repeat')).toBe('idle 30m repeat');
  });

  it('says when there are no wakes yet', async () => {
    const page = await open([]);
    expect(text(page.querySelector('table.wakes tbody'))).toBe('No wakes yet.');
  });

  it('admin fires a wake, and the list refreshes', async () => {
    const page = await open();
    button(row(page, 'kaggle:lead', 'standup'), 'Fire')!.click();
    const req = http.expectOne('/v1/agents/kaggle%3Alead/wakes/standup/fire');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ fired: 'standup', agent: 'kaggle:lead' });
    await settle(fixture);
    load();
    await settle(fixture);
    // The result shows in the toolbar, right after Refresh.
    const toolbar = page.querySelector('.toolbar')!;
    const notice = toolbar.querySelector('.notice')!;
    expect(text(notice)).toBe("Fired kaggle:lead's wake standup.");
    expect(
      button(toolbar, 'Refresh')!.nextElementSibling!.contains(notice),
    ).toBe(true);
    expect(page.querySelector('p.notice')).toBeNull();
  });

  it('admin cancels a wake after a confirmation, and the list refreshes', async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const standup = row(page, 'kaggle:lead', 'standup');
    button(standup, 'Cancel')!.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain(
      "Cancel kaggle:lead's wake standup?",
    );
    http.expectNone('/v1/agents/kaggle%3Alead/wakes/standup');

    confirm.mockReturnValue(true);
    button(standup, 'Cancel')!.click();
    const req = http.expectOne('/v1/agents/kaggle%3Alead/wakes/standup');
    expect(req.request.method).toBe('DELETE');
    req.flush({ cancelled: 'standup' });
    await settle(fixture);
    load(WAKES.slice(1));
    await settle(fixture);
    expect(page.querySelector('tr[data-wake="standup"]')).toBeNull();
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      "Cancelled kaggle:lead's wake standup.",
    );
    confirm.mockRestore();
  });

  it('shows why a firing failed', async () => {
    const page = await open();
    button(row(page, 'alpha:one', 'ping'), 'Fire')!.click();
    apiError(
      http.expectOne('/v1/agents/alpha%3Aone/wakes/ping/fire'),
      404,
      'no_wake',
      'alpha:one has no wake ping',
    );
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
      'alpha:one has no wake ping',
    );
    expect(page.querySelector('p.errmsg')).toBeNull();
  });

  it('admin sets a wake for any agent; the optional fields go only when filled', async () => {
    const page = await open();
    // The form starts collapsed, its title a line that opens it.
    const form = page.querySelector('details.panel') as HTMLDetailsElement;
    expect(form.open).toBe(false);
    const title = form.querySelector('summary') as HTMLElement;
    expect(form.firstElementChild).toBe(title);
    expect(text(title)).toBe('Set a Wake');
    expect(form.querySelector('h3')).toBeNull();
    title.click();
    await settle(fixture);
    expect(form.open).toBe(true);
    expect(
      (page.querySelector('#wake-trigger') as HTMLInputElement).placeholder,
    ).toBe('every 30m, at 09:00, cron "0 9 * * 1-5", idle 30m, fire-only');
    // Its fields: no End, as a wake has none (the owner, 2026-11-07).
    expect([...form.querySelectorAll('label')].map((l) => text(l))).toEqual([
      'Agent ID',
      'Name',
      'Trigger',
      'Text',
      'Check',
    ]);
    expect(page.querySelector('#wake-end')).toBeNull();
    const set = () => button(form, 'Set Wake')!;
    expect(set().disabled).toBe(true);
    type(page.querySelector('#wake-agent'), ' kaggle:worker ');
    type(page.querySelector('#wake-name'), 'standup');
    type(page.querySelector('#wake-trigger'), 'every 1h');
    type(page.querySelector('#wake-text'), 'Report.');
    await settle(fixture);
    expect(set().disabled).toBe(false);
    set().click();
    const req = http.expectOne('/v1/agents/kaggle%3Aworker/wakes/standup');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ text: 'Report.', trigger: 'every 1h' });
    req.flush(
      { wake: { ...WAKES[0]!, agent: 'kaggle:worker' } },
      { status: 201, statusText: 'Created' },
    );
    await settle(fixture);
    load();
    await settle(fixture);
    // The result shows in the form, which stays open.
    expect(text(form.querySelector('.notice'))).toBe(
      "Set kaggle:worker's wake standup.",
    );
    expect(form.open).toBe(true);
    expect(page.querySelector('.toolbar .notice')).toBeNull();
    // The agent stays for the next wake; the rest goes.
    expect(value(page, '#wake-agent')).toBe(' kaggle:worker ');
    expect(value(page, '#wake-name')).toBe('');
    expect(value(page, '#wake-text')).toBe('');

    type(page.querySelector('#wake-name'), 'until');
    type(page.querySelector('#wake-trigger'), 'idle 30m');
    type(page.querySelector('#wake-text'), 'Go on.');
    type(page.querySelector('#wake-check'), 'test -f go');
    await settle(fixture);
    set().click();
    const full = http.expectOne('/v1/agents/kaggle%3Aworker/wakes/until');
    expect(full.request.body).toEqual({
      text: 'Go on.',
      trigger: 'idle 30m',
      check: 'test -f go',
    });
    full.flush({ wake: WAKES[0] });
    await settle(fixture);
    load();
    await settle(fixture);
  });

  it('shows why a wake was not set, and keeps what was typed', async () => {
    const page = await open();
    type(page.querySelector('#wake-agent'), 'kaggle:lead');
    type(page.querySelector('#wake-name'), 'bad');
    type(page.querySelector('#wake-trigger'), 'sometimes');
    type(page.querySelector('#wake-text'), 'Go.');
    await settle(fixture);
    button(page, 'Set Wake')!.click();
    apiError(
      http.expectOne('/v1/agents/kaggle%3Alead/wakes/bad'),
      400,
      'bad_trigger',
      'a trigger looks like every 30m',
    );
    await settle(fixture);
    expect(text(page.querySelector('details.panel .errmsg'))).toBe(
      'a trigger looks like every 30m',
    );
    expect(value(page, '#wake-trigger')).toBe('sometimes');
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(WakesPage);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone('/v1/wakes');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne('/v1/wakes');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone('/v1/wakes');
      req.flush({ wakes: WAKES });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
