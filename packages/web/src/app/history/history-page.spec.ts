/*
 * Unit tests of the History page against a mocked server: the newest entries
 * with their time, kind, agent and host (links), session and a summary of
 * their data (200 characters, the whole data as JSON on a click anywhere in
 * the cell); the Agent filter and the Kind list (groups, then each kind with
 * its count), both in the address; a bad pattern's error; Older, which
 * appends the next page; the refresh, which merges the newest page at the top
 * and keeps what Older loaded and what was opened.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  apiError,
  button,
  choose,
  el,
  parts,
  press,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import { FILTER_DELAY_MS, REFRESH_MS } from '../agents/agents-page';
import type { HistoryEntry, HistoryKind } from '../api';
import { localTime } from '../format';
import { dataSummary, HistoryPage, PAGE } from './history-page';

// An entry; a higher ID is newer.
function entry(id: number, change: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    at: new Date(Date.UTC(2026, 9, 28, 12) + id * 1000).toISOString(),
    kind: 'wake.fired',
    agent: 'kaggle:lead',
    host: 'myspark3:1',
    session: 'ses_lead',
    data: { name: 'standup', by: 'owner' },
    ...change,
  };
}

// n entries from ID from down, newest first.
const run = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => entry(from - i));

const ENTRIES: HistoryEntry[] = [
  entry(3),
  entry(2, {
    kind: 'host.online',
    agent: undefined,
    session: undefined,
    data: {},
  }),
  entry(1, {
    kind: 'agent.registered',
    host: undefined,
    data: { id: 'kaggle:lead', description: 'leads the team' },
  }),
];

const KINDS: HistoryKind[] = [
  { kind: 'wake.fired', count: 12 },
  { kind: 'wake.set', count: 5 },
  { kind: 'agent.registered', count: 3 },
  { kind: 'host.online', count: 2 },
  { kind: 'stop_all', count: 1 },
];

describe('HistoryPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<HistoryPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  // A page of the history (and the kinds, which come with each first page).
  function load(
    entries: HistoryEntry[] = ENTRIES,
    query: { match?: string; kind?: string; before?: number } = {},
  ): void {
    const req = http.expectOne((r) => r.url === '/v1/history');
    const params = req.request.params;
    expect(params.get('match')).toBe(query.match ?? null);
    expect(params.get('kind')).toBe(query.kind ?? null);
    expect(params.get('before')).toBe(
      query.before === undefined ? null : String(query.before),
    );
    expect(params.get('limit')).toBe(String(PAGE));
    req.flush({ history: entries });
    if (query.before === undefined)
      http.expectOne('/v1/history/kinds').flush({ kinds: KINDS });
  }

  async function open(entries = ENTRIES): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(HistoryPage);
    await settle(fixture);
    load(entries);
    await settle(fixture);
    return el(fixture);
  }

  const rows = (page: HTMLElement) => [
    ...page.querySelectorAll('table.history tr[data-entry]'),
  ];
  const row = (page: HTMLElement, id: number) =>
    page.querySelector(`table.history tr[data-entry="${id}"]`)!;
  const ids = (page: HTMLElement) =>
    rows(page).map((r) => Number(r.getAttribute('data-entry')));

  it('lists the newest entries with time, kind, agent and host links, session and data', async () => {
    const page = await open();
    expect(page.querySelector('h2')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.history thead th')].map((th) =>
        text(th),
      ),
    ).toEqual(['Time', 'Kind', 'Agent', 'Host', 'Session', 'Data']);
    expect(ids(page)).toEqual([3, 2, 1]);
    const fired = row(page, 3);
    const time = fired.querySelector('td.time')!;
    expect(time.getAttribute('title')).toBe(ENTRIES[0]!.at);
    expect(text(time)).toBe(localTime(ENTRIES[0]!.at));
    expect(parts(fired.querySelector('td.kind code'))).toEqual(['wake.fired']);
    expect(
      fired.querySelector('td.agent a.id-link')!.getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    expect(fired.querySelector('td.host a.id-link')!.getAttribute('href')).toBe(
      '/hosts?host=myspark3:1',
    );
    expect(parts(fired.querySelector('td.session code'))).toEqual([
      'ses_',
      'lead',
    ]);
    for (const c of ['kind', 'agent', 'host', 'session'])
      expect(fired.querySelector(`td.${c}`)!.classList, c).toContain('id-like');
    expect(fired.querySelector('td.data')!.classList).not.toContain('id-like');
    expect(text(fired.querySelector('td.data'))).toBe(
      'name: standup, by: owner',
    );
    // What an entry does not have stays empty; no data shows a dash.
    const online = row(page, 2);
    expect(text(online.querySelector('td.agent'))).toBe('');
    expect(text(online.querySelector('td.session'))).toBe('');
    expect(text(online.querySelector('td.data'))).toBe('—');
    expect(online.querySelector('td.data')!.classList).not.toContain('folds');
    expect(text(row(page, 1).querySelector('td.host'))).toBe('');
    // A short page: nothing older to load.
    expect(button(page, 'Older')).toBeUndefined();
  });

  it('sums up the data in one line: key: value, joined', () => {
    expect(dataSummary({ name: 'standup', by: 'owner' })).toBe(
      'name: standup, by: owner',
    );
    expect(
      dataSummary({ n: 3, ok: true, to: ['a:b', 'c:d'], why: { x: 1 } }),
    ).toBe('n: 3, ok: true, to: ["a:b","c:d"], why: {"x":1}');
    expect(dataSummary({ output: 'line one\nline  two' })).toBe(
      'output: line one line two',
    );
    expect(dataSummary({})).toBe('');
  });

  it('offers all kinds, the groups by prefix, then each kind with its count', async () => {
    const page = await open();
    const select = page.querySelector('#history-kind') as HTMLSelectElement;
    expect(text(page.querySelector('label[for="history-kind"]'))).toBe('Kind');
    expect([...select.options].map((o) => [o.value, text(o)])).toEqual([
      ['', 'All kinds'],
      ['agent.*', 'agent.*'],
      ['host.*', 'host.*'],
      ['wake.*', 'wake.*'],
      ['wake.fired', 'wake.fired (12)'],
      ['wake.set', 'wake.set (5)'],
      ['agent.registered', 'agent.registered (3)'],
      ['host.online', 'host.online (2)'],
      ['stop_all', 'stop_all (1)'],
    ]);
    expect(select.value).toBe('');
  });

  it('filters by an agent pattern and by kind; the filters go into the address, and the address sets them', async () => {
    const page = await open();
    const router = TestBed.inject(Router);
    const input = page.querySelector('#history-match') as HTMLInputElement;
    expect(text(page.querySelector('label[for="history-match"]'))).toBe(
      'Agent',
    );
    type(input, 'kaggle:*');
    press(input, 'Enter');
    await settle(fixture);
    expect(router.url).toBe('/?match=kaggle:*');
    load([ENTRIES[0]!], { match: 'kaggle:*' });
    await settle(fixture);
    expect(ids(page)).toEqual([3]);

    const select = page.querySelector('#history-kind') as HTMLSelectElement;
    choose(select, 'wake.*');
    await settle(fixture);
    expect(router.url).toBe('/?match=kaggle:*&kind=wake.*');
    load([ENTRIES[0]!], { match: 'kaggle:*', kind: 'wake.*' });
    await settle(fixture);

    // A link or Back: the toolbar follows the address.
    await router.navigateByUrl('/?kind=agent.registered');
    await settle(fixture);
    load([ENTRIES[2]!], { kind: 'agent.registered' });
    await settle(fixture);
    expect(input.value).toBe('');
    expect(select.value).toBe('agent.registered');
    expect(ids(page)).toEqual([1]);

    // A kind there is none of now still shows as chosen.
    await router.navigateByUrl('/?kind=retry.*');
    await settle(fixture);
    load([], { kind: 'retry.*' });
    await settle(fixture);
    expect(select.value).toBe('retry.*');
    expect(text(page.querySelector('table.history tbody'))).toBe(
      'No entries match these filters.',
    );
  });

  it('applies the typed pattern a second after the last key', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(HistoryPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const input = el(fixture).querySelector('#history-match');
      type(input, 'kag');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 400);
      type(input, 'kaggle:*');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 1);
      http.expectNone((r) => r.url === '/v1/history');
      await vi.advanceTimersByTimeAsync(1);
      load([ENTRIES[0]!], { match: 'kaggle:*' });
      await vi.advanceTimersByTimeAsync(0);
      expect(TestBed.inject(Router).url).toBe('/?match=kaggle:*');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it("shows a bad pattern's error in the toolbar", async () => {
    const page = await open();
    const input = page.querySelector('#history-match');
    type(input, 'a b');
    press(input, 'Enter');
    await settle(fixture);
    apiError(
      http.expectOne((r) => r.url === '/v1/history'),
      400,
      'bad_pattern',
      'a pattern is one or more IDs with * wildcards',
    );
    http.expectOne('/v1/history/kinds').flush({ kinds: KINDS });
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .result .errmsg'))).toBe(
      'a pattern is one or more IDs with * wildcards',
    );
  });

  it('folds a long summary at 200 characters; a click anywhere in the cell shows the whole data as JSON, the next folds it; it stays open across the refresh', async () => {
    const long = entry(4, { data: { output: 'x'.repeat(250), exit: 1 } });
    const page = await open([long, ...ENTRIES]);
    const td = () => row(page, 4).querySelector('td.data') as HTMLElement;
    const more = () => td().querySelector('.more') as HTMLElement;
    const summary = `output: ${'x'.repeat(250)}, exit: 1`;
    expect(td().classList).toContain('folds');
    expect(more().getAttribute('role')).toBe('button');
    expect(more().getAttribute('tabindex')).toBe('0');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(more().textContent).toBe(`${summary.slice(0, 200)}…`);
    td().click();
    await settle(fixture);
    expect(more().textContent).toBe(JSON.stringify(long.data, null, 2));
    expect(more().classList).toContain('json');
    expect(more().getAttribute('aria-expanded')).toBe('true');
    button(page, 'Refresh')!.click();
    await settle(fixture);
    load([long, ...ENTRIES]);
    await settle(fixture);
    expect(more().textContent).toBe(JSON.stringify(long.data, null, 2));
    // A click on the text itself folds it once; Enter opens it.
    more().click();
    await settle(fixture);
    expect(more().textContent).toBe(`${summary.slice(0, 200)}…`);
    more().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    expect(more().classList).toContain('json');
    // A short summary opens too.
    const short = row(page, 3).querySelector('td.data') as HTMLElement;
    expect(short.classList).toContain('folds');
    short.click();
    await settle(fixture);
    expect(short.querySelector('.more')!.textContent).toBe(
      JSON.stringify(ENTRIES[0]!.data, null, 2),
    );
  });

  it('Older loads the 100 before the last entry and appends them; it goes when a page comes back short', async () => {
    const page = await open(run(300, PAGE));
    expect(rows(page).length).toBe(100);
    button(page, 'Older')!.click();
    await settle(fixture);
    load(run(200, 30), { before: 201 });
    await settle(fixture);
    expect(rows(page).length).toBe(130);
    expect(ids(page).at(-1)).toBe(171);
    expect(button(page, 'Older')).toBeUndefined();
  });

  it('the refresh merges the newest page at the top and keeps what Older loaded', async () => {
    const page = await open(run(300, PAGE));
    button(page, 'Older')!.click();
    await settle(fixture);
    load(run(200, 30), { before: 201 });
    await settle(fixture);
    button(page, 'Refresh')!.click();
    await settle(fixture);
    load([entry(302), entry(301), ...run(300, 98)]);
    await settle(fixture);
    expect(rows(page).length).toBe(132);
    expect(ids(page).slice(0, 3)).toEqual([302, 301, 300]);
    expect(ids(page).at(-1)).toBe(171);
    expect(new Set(ids(page)).size).toBe(132);
    expect(button(page, 'Older')).toBeUndefined();

    // A newest page with none of what is shown: it replaces the list, and
    // Older comes back for what lies between.
    button(page, 'Refresh')!.click();
    await settle(fixture);
    load(run(600, PAGE));
    await settle(fixture);
    expect(ids(page)[0]).toBe(600);
    expect(rows(page).length).toBe(100);
    expect(button(page, 'Older')).toBeDefined();
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(HistoryPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone((r) => r.url === '/v1/history');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne((r) => r.url === '/v1/history');
      http.expectOne('/v1/history/kinds').flush({ kinds: KINDS });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone((r) => r.url === '/v1/history');
      req.flush({ history: ENTRIES });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
