/*
 * Unit tests of the Costs page (tier 0g; the owner, 2026-11-08) against a
 * mocked server: every agent's spend today and in total, its daily cap with
 * the share used and what is left (no context: it is on Agents); an agent's
 * spend per day on a click; links to the Agents page, and the row a link led
 * to highlighted; when the data was read; unregistered agents with spend
 * (marked, no link); the Agent filter (a pattern, in the address); the
 * totals row; the empty page; "Updated" in the footer; and the live refresh
 * (every 5 s, one at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  button,
  el,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import { FILTER_DELAY_MS } from '../agents/agents-page';
import type { AgentCost, CostSplit, CostsView } from '../api';
import { contains } from '../filter';
import {
  COSTS_REFRESH_MS,
  CostsPage,
  causeText,
  shareText,
  splitParts,
  splitSum,
  subagentsText,
  weekBars,
  weekTotals,
} from './costs-page';

// A period's spend by kind (1.1.0-rc7): $10, of which $4.50 cache writes,
// $2.90 cache reads, $0.10 input, $2.00 output, $0.50 uncategorized; $3.10
// of it the Subagents'.
const SPLIT: CostSplit = {
  usd: 10,
  cache_write_usd: 4.5,
  cache_read_usd: 2.9,
  input_usd: 0.1,
  output_usd: 2,
  cache_write_tokens: 900_000,
  cache_read_tokens: 9_000_000,
  input_tokens: 20_000,
  output_tokens: 100_000,
  subagents_usd: 3.1,
  reload_usd: 4,
  turns: 20,
};

const BASE: AgentCost = {
  agent: '',
  registered: true,
  status: 'idle',
  machine: 'machine-a',
  today_usd: 0,
  total_usd: 0,
  daily_usd: 'off',
  left_usd: null,
  context: null,
  context_limit: null,
  compact_at: null,
  context_share: null,
  week: [],
};

function view(): CostsView {
  return {
    day: '2026-11-08',
    // 17:02:03 PST on Nov 8 in the server's zone
    time: '2026-11-09T01:02:03.000Z',
    timezone: 'America/Los_Angeles',
    days: null,
    agents: [
      {
        ...BASE,
        agent: 'kaggle:lead',
        status: 'working',
        today_usd: 1.5,
        total_usd: 12.3456,
        daily_usd: 2,
        left_usd: 0.5,
        context: 80_000,
        context_limit: 200_000,
        compact_at: 100_000,
        context_share: 80,
        week: [
          { day: '2026-11-02', usd: 0.5 },
          { day: '2026-11-03', usd: 0 },
          { day: '2026-11-04', usd: 2 },
          { day: '2026-11-05', usd: 1 },
          { day: '2026-11-06', usd: 0.25 },
          { day: '2026-11-07', usd: 4 },
          { day: '2026-11-08', usd: 1.5 },
        ],
      },
      {
        ...BASE,
        agent: 'kaggle:worker',
        today_usd: 0.04,
        total_usd: 0.04,
        context: 9000,
        // up to 7: from its first day
        week: [
          { day: '2026-11-07', usd: 0 },
          { day: '2026-11-08', usd: 0.04 },
        ],
      },
      // gone, with its spend kept (the owner, 2026-11-08)
      {
        ...BASE,
        agent: 'old:one',
        registered: false,
        status: 'unregistered',
        today_usd: 0,
        total_usd: 3.5,
      },
    ],
    totals: { agents: 3, today_usd: 1.54, total_usd: 15.8856 },
  };
}

describe('CostsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<CostsPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(start = view(), match?: string, days?: string): void {
    const req = http.expectOne((r) => r.url === '/v1/costs');
    // what was typed, matched anywhere (the owner, 2026-11-17)
    expect(req.request.params.get('match')).toBe(
      match ? contains(match) : null,
    );
    expect(req.request.params.get('days')).toBe(days ?? null);
    req.flush(start);
  }

  async function open(start = view()): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(CostsPage);
    await settle(fixture);
    load(start);
    await settle(fixture);
    return el(fixture);
  }

  const row = (page: HTMLElement, agent: string) =>
    page.querySelector(`table.costs tr[data-agent="${agent}"]`)!;
  const cell = (page: HTMLElement, agent: string, name: string) =>
    text(row(page, agent).querySelector(`td.${name}`));

  it('lists every agent: today, cap, the last 7 days and total (no Context, no Left Today: the owner)', async () => {
    const page = await open();
    expect(
      [...page.querySelectorAll('table.costs thead th')].map((th) => text(th)),
    ).toEqual([
      'Agent',
      'Status',
      'Today',
      'Daily Cap',
      'Last 7 Days',
      'Total',
      // 1.1.0-rc7: the period's spend by kind, and the Subagents' part
      'Split',
      'Subagents',
      '',
    ]);
    expect(cell(page, 'kaggle:lead', 'today')).toBe('$1.50');
    expect(cell(page, 'kaggle:lead', 'cap')).toBe('$2.00 75.0%');
    // the cap and its share on one line, the share at its right (the owner,
    // 2026-11-09), the bar under both
    const line = row(page, 'kaggle:lead').querySelector('td.cap .cap-line')!;
    expect([...line.children].map((c) => [c.className, text(c)])).toEqual([
      ['amount', '$2.00'],
      ['share', '75.0%'],
    ]);
    // no Left Today (the owner, 2026-11-09)
    expect(row(page, 'kaggle:lead').querySelector('td.left')).toBeNull();
    expect(cell(page, 'kaggle:lead', 'total')).toBe('$12.35');
    expect(row(page, 'kaggle:lead').querySelector('td.context')).toBeNull();
    // the bar: the cap's share used
    const bar = (agent: string, name: string) =>
      row(page, agent).querySelector(`td.${name} .bar > span`) as HTMLElement;
    expect(bar('kaggle:lead', 'cap').style.width).toBe('75%');
    // no cap
    expect(cell(page, 'kaggle:worker', 'cap')).toBe('off');
    expect(bar('kaggle:worker', 'cap')).toBeNull();
    // agent IDs link to the Agents page
    expect(
      row(page, 'kaggle:lead')
        .querySelector('td.agent a')!
        .getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    // when the data was read: the server's time in its zone, right of
    // Refresh (the owner, 2026-11-08), dated as every page (2026-11-09)
    const toolbar = page.querySelector('.toolbar')!;
    expect(text(toolbar.firstElementChild)).toBe('Refresh');
    const clock = toolbar.firstElementChild!.nextElementSibling!;
    expect(clock.classList).toContain('clock');
    expect(text(clock)).toBe('08-Nov-26 17:02:03 PT');
    expect(page.querySelector('p.day')).toBeNull();
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
  });

  // The button is called Details (the owner, 2026-11-27: "rename Days
  // button on cost to Details"): it opens what started the turns too.
  it("a click on Details shows an agent's spend per day, newest first; again hides it", async () => {
    const page = await open();
    expect(
      [...page.querySelectorAll('table.costs td.actions button')].map((b) =>
        text(b),
      ),
    ).toEqual(['Details', 'Details', 'Details']);
    const days = () =>
      page.querySelector('tr.days[data-agent="kaggle:lead"]') as HTMLElement;
    expect(days()).toBeNull();
    (
      row(page, 'kaggle:lead').querySelector('button.days') as HTMLElement
    ).click();
    http.expectOne('/v1/costs/kaggle%3Alead').flush({
      agent: 'kaggle:lead',
      registered: true,
      day: '2026-11-08',
      timezone: 'America/Los_Angeles',
      cost: view().agents[0],
      days: [
        { day: '2026-11-08', usd: 1.5, steps: 30 },
        { day: '2026-11-07', usd: 10.8456, steps: 210 },
      ],
    });
    await settle(fixture);
    expect(
      [...days().querySelectorAll('table.cost-days tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => text(td)).join(' '),
      ),
      // days as 05-Nov-26 (the owner, 2026-11-09)
    ).toEqual(['08-Nov-26 $1.50 30', '07-Nov-26 $10.85 210']);
    (
      row(page, 'kaggle:lead').querySelector('button.days') as HTMLElement
    ).click();
    await settle(fixture);
    expect(days()).toBeNull();
  });

  // The owner, 2026-11-17: sorting by a heading. Agents have no date: by
  // Agent; an agent's days by Day, newest first.
  it('sorts the agents by Agent by default, by Status, Today, Daily Cap and Total too; the days by Day, Spend and Steps', async () => {
    const page = await open();
    const order = () =>
      [...page.querySelectorAll('table.costs > tbody > tr[data-agent]')]
        .filter((r) => !r.classList.contains('days'))
        .map((r) => r.getAttribute('data-agent'));
    expect(order()).toEqual(['kaggle:lead', 'kaggle:worker', 'old:one']);
    const heads = [...page.querySelectorAll('table.costs > thead th')];
    expect(
      heads.filter((h) => h.querySelector('button.sort')).map((h) => text(h)),
    ).toEqual([
      'Agent',
      'Status',
      'Today',
      'Daily Cap',
      'Total',
      // 1.1.0-rc7
      'Subagents',
    ]);
    const total = heads.find((h) => text(h) === 'Total')!;
    (total.querySelector('button.sort') as HTMLButtonElement).click();
    await settle(fixture);
    expect(order()).toEqual(['kaggle:lead', 'old:one', 'kaggle:worker']);
    (
      row(page, 'kaggle:lead').querySelector('button.days') as HTMLElement
    ).click();
    http.expectOne('/v1/costs/kaggle%3Alead').flush({
      agent: 'kaggle:lead',
      registered: true,
      day: '2026-11-08',
      timezone: 'America/Los_Angeles',
      cost: view().agents[0],
      days: [
        { day: '2026-11-07', usd: 10.8456, steps: 210 },
        { day: '2026-11-08', usd: 1.5, steps: 30 },
      ],
    });
    await settle(fixture);
    const days = () =>
      [...page.querySelectorAll('table.cost-days tbody tr')].map((tr) =>
        text(tr.querySelector('td')),
      );
    expect(days()).toEqual(['08-Nov-26', '07-Nov-26']);
    const spend = [...page.querySelectorAll('table.cost-days thead th')].find(
      (h) => text(h) === 'Spend',
    )!;
    (spend.querySelector('button.sort') as HTMLButtonElement).click();
    await settle(fixture);
    expect(days()).toEqual(['07-Nov-26', '08-Nov-26']);
  });

  // The owner, 2026-11-08: the status with its dot, as on the other tabs.
  it("shows each agent's status with its dot, as the Agents tab does", async () => {
    const statuses = [
      'idle',
      'working',
      'paused',
      'offline',
      'error',
      'waiting',
    ];
    const page = await open({
      ...view(),
      agents: statuses.map((status) => ({
        ...BASE,
        agent: `s:${status}`,
        status,
      })),
    });
    const dot = (status: string) => [
      ...row(page, `s:${status}`).querySelector('td.status .dot')!.classList,
    ];
    expect(statuses.map(dot)).toEqual([
      ['dot', 'idle'],
      ['dot', 'ok'],
      ['dot', 'warn'],
      ['dot', 'off'],
      ['dot', 'err'],
      ['dot'],
    ]);
    expect(cell(page, 's:working', 'status')).toBe('working');
  });

  // The owner, 2026-11-08: an unregistered agent's ID links to Agents, which
  // turns its Unregistered box on to show and highlight it; the Costs tab's
  // own Unregistered box (on by default) hides the gone ones.
  it('an unregistered agent with spend shows, marked, its ID a link to Agents with the box on', async () => {
    const page = await open();
    const gone = row(page, 'old:one');
    expect(gone.classList).toContain('gone');
    expect(text(gone.querySelector('td.agent'))).toBe('old:one');
    expect(gone.querySelector('td.agent a')!.getAttribute('href')).toBe(
      '/agents?agent=old:one&unregistered=1',
    );
    expect(text(gone.querySelector('td.status'))).toBe('unregistered');
    expect(gone.querySelector('td.status .dot')).toBeNull();
    expect(cell(page, 'old:one', 'total')).toBe('$3.50');
  });

  // The owner, 2026-11-09 (rc2): runs no agent started count for their
  // job's row; an agent's tooltip says how much of its spend was its runs'.
  it("a job's row: its ID a link to Jobs, the status job, no cap; it stays with the Unregistered box off", async () => {
    const start = view();
    start.agents.push({
      ...BASE,
      agent: 'job:nightly',
      job: 'nightly',
      registered: false,
      status: 'job',
      today_usd: 0.4,
      total_usd: 2.4,
    });
    const page = await open(start);
    const job = row(page, 'job:nightly');
    expect(job.classList).not.toContain('gone');
    const link = job.querySelector('td.agent a')!;
    expect(text(link)).toBe('job:nightly');
    expect(link.getAttribute('href')).toBe('/jobs?job=nightly');
    // the Agent column breaks only at punctuation (the owner, 2026-11-23)
    expect(link.querySelector('code')!.classList).toContain('agent-id');
    expect(
      row(page, 'kaggle:lead').querySelector('td.agent code')!.classList,
    ).toContain('agent-id');
    expect(text(job.querySelector('td.status'))).toBe('job');
    expect(job.querySelector('td.status .dot')).toBeNull();
    expect(cell(page, 'job:nightly', 'cap')).toBe('off');
    const box = page.querySelector('#costs-unregistered') as HTMLInputElement;
    box.click();
    await settle(fixture);
    expect(row(page, 'job:nightly')).not.toBeNull();
  });

  it("an agent's Today and Total say how much was its runs'", async () => {
    const start = view();
    Object.assign(start.agents[0]!, {
      runs_today_usd: 0.5,
      runs_total_usd: 4.25,
    });
    const page = await open(start);
    const lead = row(page, 'kaggle:lead');
    expect(lead.querySelector('td.today')!.getAttribute('title')).toBe(
      '$0.50 of it its runs',
    );
    expect(lead.querySelector('td.total')!.getAttribute('title')).toBe(
      '$4.25 of it its runs',
    );
    // none: no tooltip
    expect(
      row(page, 'kaggle:worker')
        .querySelector('td.today')!
        .getAttribute('title'),
    ).toBeNull();
  });

  it('the Unregistered box, on by default, hides the gone agents when off; the totals follow', async () => {
    const page = await open();
    const box = page.querySelector(
      '.toolbar #costs-unregistered',
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(text(box.closest('label'))).toBe('Unregistered');
    box.click();
    await settle(fixture);
    expect(page.querySelector('tr[data-agent="old:one"]')).toBeNull();
    // what is listed: the two registered ones
    expect(text(page.querySelector('tfoot tr.totals td.agent'))).toBe(
      'Total (2 agents)',
    );
    expect(text(page.querySelector('tfoot tr.totals td.today'))).toBe('$1.54');
    expect(text(page.querySelector('tfoot tr.totals td.total'))).toBe('$12.39');
  });

  // The owner, 2026-11-08: "X days" right after the filter: Total and the
  // totals over the last X days (empty: all time).
  it('the days field, right after the filter, asks for the total over the last days', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(CostsPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      const page = el(fixture);
      // "Days", then the field (the owner, 2026-11-09: "Days X")
      const field = page.querySelector('#cost-days') as HTMLInputElement;
      const label = field.previousElementSibling!;
      expect(label.tagName).toBe('LABEL');
      expect(label.getAttribute('for')).toBe('cost-days');
      expect(text(label)).toBe('Days');
      expect(label.previousElementSibling!.id).toBe('cost-match');
      expect(field.nextElementSibling!.getAttribute('for')).toBe(
        'costs-unregistered',
      );
      expect(field.value).toBe('');
      type(field, '7');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS);
      expect(TestBed.inject(Router).url).toBe('/?days=7');
      await vi.advanceTimersByTimeAsync(0);
      load({ ...view(), days: 7 }, undefined, '7');
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(text(page.querySelector('table.costs thead th.total'))).toBe(
        'Last 7 Days',
      );
      expect(text(page.querySelector('tfoot tr.totals td.agent'))).toBe(
        'Total (3 agents, last 7 days)',
      );
      // one day: singular
      type(field, '1');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      load({ ...view(), days: 1 }, undefined, '1');
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(text(page.querySelector('table.costs thead th.total'))).toBe(
        'Last Day',
      );
      expect(text(page.querySelector('tfoot tr.totals td.agent'))).toBe(
        'Total (3 agents, last day)',
      );
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('a totals row adds up what is listed', async () => {
    const page = await open();
    const total = page.querySelector('table.costs tfoot tr.totals')!;
    expect(text(total.querySelector('td.agent'))).toBe('Total (3 agents)');
    expect(text(total.querySelector('td.today'))).toBe('$1.54');
    expect(text(total.querySelector('td.total'))).toBe('$15.89');
  });

  // The owner, 2026-11-09: "a col with last 7 (up to) daily spend bar graph
  // 'Last 7 Days'"; "on hover over the bar, its daily value sould be shown";
  // "move it right after daily cap".
  it("Last 7 Days, right after Daily Cap: a bar per day of the agent's spend, oldest first, scaled to its top day", async () => {
    const page = await open();
    const days = (tr: Element) =>
      [...tr.querySelectorAll('td.week .graph > .col')] as HTMLElement[];
    const heights = (tr: Element) =>
      days(tr).map(
        (d) => (d.querySelector('.fill') as HTMLElement).style.height,
      );
    const tips = (tr: Element) =>
      days(tr).map((d) => text(d.querySelector('.tip')));
    const lead = row(page, 'kaggle:lead');
    expect(
      lead.querySelector('td.cap')!.nextElementSibling!.className,
    ).toContain('week');
    expect(heights(lead)).toEqual([
      '12.5%',
      '0%',
      '50%',
      '25%',
      '6.3%',
      '100%',
      '37.5%',
    ]);
    // each day's value and date in its tip, shown on hover; a day without
    // spend is marked
    expect(tips(lead)).toEqual([
      '$0.50 02-Nov-26',
      '$0.00 03-Nov-26',
      '$2.00 04-Nov-26',
      '$1.00 05-Nov-26',
      '$0.25 06-Nov-26',
      '$4.00 07-Nov-26',
      '$1.50 08-Nov-26',
    ]);
    expect(days(lead).map((d) => text(d.querySelector('.tip .usd')))).toEqual([
      '$0.50',
      '$0.00',
      '$2.00',
      '$1.00',
      '$0.25',
      '$4.00',
      '$1.50',
    ]);
    expect(days(lead).map((d) => d.classList.contains('zero'))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // the same said to a screen reader and the keyboard; no browser title
    // (it would show late, over the tip)
    expect(days(lead)[6]!.getAttribute('aria-label')).toBe('08-Nov-26: $1.50');
    expect(days(lead)[6]!.tabIndex).toBe(0);
    expect(lead.querySelectorAll('td.week [title]').length).toBe(0);
    // up to 7: from its first day, today last; none without spend
    expect(tips(row(page, 'kaggle:worker'))).toEqual([
      '$0.00 07-Nov-26',
      '$0.04 08-Nov-26',
    ]);
    expect(days(row(page, 'old:one'))).toEqual([]);
    // the totals row: the listed agents' spend per day
    const total = page.querySelector('table.costs tfoot tr.totals')!;
    expect(
      total.querySelector('td.total')!.previousElementSibling!.className,
    ).toContain('week');
    expect(tips(total)).toEqual([
      '$0.50 02-Nov-26',
      '$0.00 03-Nov-26',
      '$2.00 04-Nov-26',
      '$1.00 05-Nov-26',
      '$0.25 06-Nov-26',
      '$4.00 07-Nov-26',
      '$1.54 08-Nov-26',
    ]);
    expect(heights(total)[5]).toBe('100%');
  });

  it('a share as a bar height: to a tenth of the top day, 0 when nothing was spent', () => {
    expect(weekBars([])).toEqual([]);
    expect(
      weekBars([
        { day: '2026-11-07', usd: 0 },
        { day: '2026-11-08', usd: 0 },
      ]).map((b) => b.height),
    ).toEqual([0, 0]);
    expect(
      weekBars([
        { day: '2026-11-07', usd: 1 },
        { day: '2026-11-08', usd: 3 },
      ]).map((b) => b.height),
    ).toEqual([33.3, 100]);
    // the days of several agents, added up by day
    expect(
      weekTotals([
        [
          { day: '2026-11-07', usd: 1 },
          { day: '2026-11-08', usd: 0.1 },
        ],
        [{ day: '2026-11-08', usd: 0.2 }],
        [],
      ]),
    ).toEqual([
      { day: '2026-11-07', usd: 1 },
      { day: '2026-11-08', usd: 0.3 },
    ]);
  });

  it('the Agent filter takes a pattern, a second after the last key, and keeps it in the address', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(CostsPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      const field = el(fixture).querySelector('#cost-match')!;
      type(field, 'kaggle:*');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 1);
      http.expectNone((r) => r.url === '/v1/costs');
      await vi.advanceTimersByTimeAsync(1);
      expect(TestBed.inject(Router).url).toBe('/?match=kaggle:*');
      await vi.advanceTimersByTimeAsync(0);
      load({ ...view(), agents: view().agents.slice(0, 2) }, 'kaggle:*');
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(
        [
          ...el(fixture).querySelectorAll('table.costs tbody tr[data-agent]'),
        ].map((r) => r.getAttribute('data-agent')),
      ).toEqual(['kaggle:lead', 'kaggle:worker']);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  // The review before 1.0.0.
  it('an older answer does not replace a newer view', async () => {
    const page = await open();
    button(page, 'Refresh')!.click();
    button(page, 'Refresh')!.click();
    const [slow, fast] = http.match((r) => r.url === '/v1/costs');
    fast!.flush({ ...view(), agents: [] });
    await settle(fixture);
    slow!.flush(view());
    await settle(fixture);
    expect(text(page.querySelector('table.costs tbody'))).toBe(
      'No agent has spent anything or is registered.',
    );
  });

  it('says when there are no agents', async () => {
    const page = await open({ ...view(), agents: [] });
    expect(text(page.querySelector('table.costs tbody'))).toBe(
      'No agent has spent anything or is registered.',
    );
    expect(page.querySelector('table.costs tfoot')).toBeNull();
  });

  it('the time is when the data was read: the same until the next load', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(CostsPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const clock = () => text(el(fixture).querySelector('.toolbar .clock'));
      expect(clock()).toBe('08-Nov-26 17:02:03 PT');
      await vi.advanceTimersByTimeAsync(2000);
      fixture.detectChanges();
      expect(clock()).toBe('08-Nov-26 17:02:03 PT');
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS - 2000);
      load({ ...view(), time: '2026-11-09T01:02:08.000Z' });
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(clock()).toBe('08-Nov-26 17:02:08 PT');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  // The owner, 2026-11-08: a click on an agent's Spend on Agents leads here
  // with its row highlighted.
  it('highlights the agent a link led to (?agent=), and scrolls it into view', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    signedIn();
    await TestBed.inject(Router).navigateByUrl('/?agent=kaggle:worker');
    fixture = TestBed.createComponent(CostsPage);
    await settle(fixture);
    load();
    await settle(fixture);
    const page = el(fixture);
    const worker = row(page, 'kaggle:worker');
    expect(worker.classList).toContain('highlight');
    expect(worker.getAttribute('aria-current')).toBe('true');
    expect(page.querySelectorAll('tr.highlight').length).toBe(1);
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
  });

  /*
   * 1.1.0-rc7 (the owner, 2026-11-27, from a review of real sessions: cache
   * writes were about half of the spend and nothing showed it): each agent's
   * spend by kind as one bar, its parts on hover and focus; the Subagents'
   * part; the totals row adds them up; a dash where nothing is known.
   */
  it('Split: a bar per agent of its spend by kind, the parts in its tip; Subagents: their dollars and share', async () => {
    const start = view();
    start.agents[0]!.split = SPLIT;
    // nothing counted in the period
    start.agents[1]!.split = Object.fromEntries(
      Object.keys(SPLIT).map((key) => [key, 0]),
    ) as unknown as CostSplit;
    const page = await open(start);
    const bar = row(page, 'kaggle:lead').querySelector(
      'td.split .split-bar',
    ) as HTMLElement;
    expect(
      [...bar.querySelectorAll(':scope > .seg')].map((x) => [
        [...x.classList].filter((c) => c !== 'seg').join(' '),
        (x as HTMLElement).style.width,
      ]),
    ).toEqual([
      ['write', '45%'],
      ['read', '29%'],
      ['input', '1%'],
      ['output', '20%'],
      ['rest', '5%'],
    ]);
    expect(bar.getAttribute('tabindex')).toBe('0');
    // an image with a label, to a screen reader; its tip is for the eye
    expect(bar.getAttribute('role')).toBe('img');
    expect(bar.querySelector('.tip')!.getAttribute('aria-hidden')).toBe('true');
    expect(bar.getAttribute('aria-label')).toBe(
      'Cache Writes $4.50 (45%), Cache Reads $2.90 (29%), Input $0.10 (1%), ' +
        'Output $2.00 (20%), Uncategorized $0.50 (5%)',
    );
    expect([...bar.querySelectorAll('.tip .line')].map((x) => text(x))).toEqual(
      [
        'Cache Writes$4.5045%',
        'Cache Reads$2.9029%',
        'Input$0.101%',
        'Output$2.0020%',
        'Uncategorized$0.505%',
      ],
    );
    // the period's total is more than the split knows: said under the parts
    expect(text(bar.querySelector('.tip .of'))).toBe(
      'of $10.00; $2.35 more was spent before the split was kept',
    );
    // no browser tooltip: the page's own tip shows at once
    expect(bar.getAttribute('title')).toBeNull();
    expect(cell(page, 'kaggle:lead', 'subagents')).toBe('$3.10 (31%)');
    // nothing counted in the period, and an older server's row: a dash
    expect(cell(page, 'kaggle:worker', 'split')).toBe('—');
    expect(cell(page, 'kaggle:worker', 'subagents')).toBe('');
    expect(cell(page, 'old:one', 'split')).toBe('—');
    // the totals row adds up what is listed
    const totals = page.querySelector('table.costs tfoot tr.totals')!;
    expect(
      (totals.querySelector('td.split .seg.write') as HTMLElement).style.width,
    ).toBe('45%');
    expect(text(totals.querySelector('td.subagents'))).toBe('$3.10 (31%)');
    // by Subagents, largest first
    (
      page.querySelector('table.costs thead th.subagents button') as HTMLElement
    ).click();
    await settle(fixture);
    expect(
      page.querySelector('table.costs tbody tr')!.getAttribute('data-agent'),
    ).toBe('kaggle:lead');
  });

  it('Days: what started its turns over the period, above its days with their kinds', async () => {
    // the page's period: the last 7 days, typed into Days
    const page = await open();
    type(page.querySelector('#cost-days') as HTMLInputElement, '7');
    (button(page, 'Refresh') as HTMLElement).click();
    await settle(fixture);
    load({ ...view(), days: 7 }, undefined, '7');
    await settle(fixture);
    (
      row(page, 'kaggle:lead').querySelector('button.days') as HTMLElement
    ).click();
    // over the page's own period
    const req = http.expectOne(
      (r) =>
        r.url === '/v1/costs/kaggle%3Alead' ||
        r.url === '/v1/costs/kaggle:lead',
    );
    expect(req.request.params.get('days')).toBe('7');
    const cause = (name: string, turns: number, usd: number) => ({
      cause: name,
      turns,
      steps: turns * 5,
      usd,
      subagents_usd: usd / 10,
      reload_usd: usd / 2,
      cache_write_usd: 0,
      cache_read_usd: 0,
      input_usd: 0,
      output_usd: 0,
    });
    req.flush({
      agent: 'kaggle:lead',
      registered: true,
      day: '2026-11-08',
      timezone: 'America/Los_Angeles',
      cost: view().agents[0],
      period_days: 7,
      split: SPLIT,
      causes: [
        cause('wake', 8, 6),
        cause('owner', 4, 3),
        cause('run', 0, 0.8),
        cause('ask', 1, 0.25),
        // 1.1.2: OpenCode's cache warming, no turn of the agent's
        cause('warming', 0, 0.2),
      ],
      days: [
        { day: '2026-11-08', usd: 1.5, steps: 30, split: SPLIT },
        { day: '2026-11-07', usd: 8.5, steps: 210 },
      ],
    });
    await settle(fixture);
    const opened = page.querySelector(
      'tr.days[data-agent="kaggle:lead"]',
    ) as HTMLElement;
    expect(text(opened.querySelector('.causes-title'))).toBe(
      'What Started the Turns Last 7 Days',
    );
    const rows = (table: string) =>
      [...opened.querySelectorAll(`table.${table} tbody tr`)].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => text(td)).join(' | '),
      );
    expect(
      [...opened.querySelectorAll('table.cost-causes thead th')].map((th) =>
        text(th),
      ),
    ).toEqual([
      'Started By',
      'Turns',
      'Spend',
      'Per Turn',
      'Reload',
      'Subagents',
    ]);
    // largest first; no dollars a turn for what has no turns
    expect(rows('cost-causes')).toEqual([
      'Wake | 8 | $6.00 | $0.75 | $3.00 | $0.60',
      'Owner | 4 | $3.00 | $0.75 | $1.50 | $0.30',
      'Job Runs | 0 | $0.80 | — | $0.40 | $0.08',
      'Ask | 1 | $0.25 | $0.25 | $0.13 | $0.03',
      'Cache Warming | 0 | $0.20 | — | $0.10 | $0.02',
    ]);
    // each day with its kinds; a day without a split: zeros
    const days = [...opened.querySelectorAll('table.cost-days tbody tr')].map(
      (tr) => [...tr.querySelectorAll('td')].map((td) => text(td)).join(' | '),
    );
    expect(days).toEqual([
      '08-Nov-26 | $1.50 | 30 | $4.50 | $2.90 | $0.10 | $2.00 | $3.10',
      '07-Nov-26 | $8.50 | 210 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00',
    ]);
    // by Turns
    (
      opened.querySelector(
        'table.cost-causes thead th:nth-child(2) button',
      ) as HTMLElement
    ).click();
    await settle(fixture);
    expect(rows('cost-causes')[0]).toMatch(/^Wake \| 8 /);
  });

  it('a split as its parts, the Subagents as text, a cause by its name, splits added up', () => {
    expect(splitParts(SPLIT).map((p) => [p.key, p.usd, p.share])).toEqual([
      ['write', 4.5, 45],
      ['read', 2.9, 29],
      ['input', 0.1, 1],
      ['output', 2, 20],
      ['rest', 0.5, 5],
    ]);
    // all of it split: no rest; none of it: the rest alone has it all
    const whole = { ...SPLIT, usd: 9.5 };
    expect(splitParts(whole).map((p) => p.key)).toEqual([
      'write',
      'read',
      'input',
      'output',
    ]);
    expect(splitParts(whole)[0]!.share).toBe(47.4);
    expect(
      splitParts({
        ...SPLIT,
        cache_write_usd: 0,
        cache_read_usd: 0,
        input_usd: 0,
        output_usd: 0,
      }).at(-1),
    ).toEqual({ key: 'rest', label: 'Uncategorized', usd: 10, share: 100 });
    for (const none of [undefined, null, { ...SPLIT, usd: 0 }])
      expect(splitParts(none)).toEqual([]);
    expect(subagentsText(SPLIT)).toBe('$3.10 (31%)');
    expect(subagentsText({ ...SPLIT, subagents_usd: 0 })).toBe('$0.00 (0%)');
    expect(subagentsText(undefined)).toBe('');
    expect(subagentsText({ ...SPLIT, usd: 0 })).toBe('');
    expect(
      ['wake', 'message', 'owner', 'compaction', 'job', 'ask', 'retry'].map(
        causeText,
      ),
    ).toEqual([
      'Wake',
      'Message',
      'Owner',
      'Compaction',
      'Job Result',
      'Ask',
      'Retry',
    ]);
    expect(['run', 'earlier', 'other', 'new-one'].map(causeText)).toEqual([
      'Job Runs',
      'Before Registration',
      'Other',
      'new-one',
    ]);
    // 1.1.2: what a session spends between its turns
    expect(causeText('warming')).toBe('Cache Warming');
    expect(splitSum([SPLIT, undefined, SPLIT])).toMatchObject({
      usd: 20,
      cache_write_usd: 9,
      subagents_usd: 6.2,
      turns: 40,
    });
    expect(splitSum([undefined])).toBeUndefined();
    expect(splitSum([])).toBeUndefined();
  });

  it('a share as a percentage to a tenth', () => {
    expect(shareText(null)).toBe('');
    expect(shareText(75)).toBe('75.0%');
    expect(shareText(112.34)).toBe('112.3%');
  });

  it('refreshes every 5 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(CostsPage);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne((r) => r.url === '/v1/costs').flush(view());
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS - 1);
      http.expectNone((r) => r.url === '/v1/costs');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne((r) => r.url === '/v1/costs');
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS);
      http.expectNone((r) => r.url === '/v1/costs');
      req.flush(view());
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS);
      http.expectOne((r) => r.url === '/v1/costs').flush(view());
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
