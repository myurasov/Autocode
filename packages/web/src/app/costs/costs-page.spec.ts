/*
 * Unit tests of the Costs page (tier 0g; the owner, 2026-11-08) against a
 * mocked server: every agent's spend today and in total, its daily cap with
 * the share used and what is left, its context with the compaction threshold
 * and the share used; an agent's spend per day on a click; links to the
 * Agents page; the day and zone; unregistered agents with spend (marked, no
 * link); the Agent filter (a pattern, in the address); the totals row; the
 * empty page; "Updated" in the footer; and the live refresh (every 5 s, one
 * at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { el, settle, setup, signedIn, text, type } from '../../testing/helpers';
import { FILTER_DELAY_MS } from '../agents/agents-page';
import type { AgentCost, CostsView } from '../api';
import { COSTS_REFRESH_MS, CostsPage, shareText } from './costs-page';

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
};

function view(): CostsView {
  return {
    day: '2026-11-08',
    // 17:02:03 PST on Nov 8 in the server's zone
    time: '2026-11-09T01:02:03.000Z',
    timezone: 'America/Los_Angeles',
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
      },
      {
        ...BASE,
        agent: 'kaggle:worker',
        today_usd: 0.04,
        total_usd: 0.04,
        context: 9000,
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

  function load(start = view(), match?: string): void {
    const req = http.expectOne((r) => r.url === '/v1/costs');
    expect(req.request.params.get('match')).toBe(match ?? null);
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

  it('lists every agent: today, cap, left, total and context', async () => {
    const page = await open();
    expect(
      [...page.querySelectorAll('table.costs thead th')].map((th) => text(th)),
    ).toEqual([
      'Agent',
      'Status',
      'Today',
      'Daily Cap',
      'Left Today',
      'Total',
      'Context',
      '',
    ]);
    expect(cell(page, 'kaggle:lead', 'today')).toBe('$1.50');
    expect(cell(page, 'kaggle:lead', 'cap')).toBe('$2.00 75.0%');
    expect(cell(page, 'kaggle:lead', 'left')).toBe('$0.50');
    expect(cell(page, 'kaggle:lead', 'total')).toBe('$12.35');
    // the owner, 2026-11-08: one Context column, "share of the threshold
    // (max the model's window)" with a bar of that share
    expect(cell(page, 'kaggle:lead', 'context')).toBe(
      '80.0% of 100,000 (max 200,000)',
    );
    expect(
      row(page, 'kaggle:lead')
        .querySelector('td.context')!
        .getAttribute('title'),
    ).toBe('80,000 tokens; compacted past 100,000 (compact_at)');
    // the bars: the cap's share used, the threshold's share used
    const bar = (agent: string, name: string) =>
      row(page, agent).querySelector(`td.${name} .bar > span`) as HTMLElement;
    expect(bar('kaggle:lead', 'cap').style.width).toBe('75%');
    expect(bar('kaggle:lead', 'context').style.width).toBe('80%');
    expect(bar('kaggle:lead', 'context').parentElement!.classList).toContain(
      'near',
    );
    // no cap, no threshold yet
    expect(cell(page, 'kaggle:worker', 'cap')).toBe('off');
    expect(cell(page, 'kaggle:worker', 'left')).toBe('—');
    // no threshold known: the tokens alone, no bar
    expect(cell(page, 'kaggle:worker', 'context')).toBe('9,000 tokens');
    expect(bar('kaggle:worker', 'context')).toBeNull();
    expect(bar('kaggle:worker', 'cap')).toBeNull();
    // agent IDs link to the Agents page
    expect(
      row(page, 'kaggle:lead')
        .querySelector('td.agent a')!
        .getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    // the server's time in its zone, right of Refresh (the owner, 2026-11-08)
    const toolbar = page.querySelector('.toolbar')!;
    expect(text(toolbar.firstElementChild)).toBe('Refresh');
    const clock = toolbar.firstElementChild!.nextElementSibling!;
    expect(clock.classList).toContain('clock');
    expect(text(clock)).toBe('17:02:03 Nov 8 2026 PST');
    expect(page.querySelector('p.day')).toBeNull();
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
  });

  it("a click on Days shows an agent's spend per day, newest first; again hides it", async () => {
    const page = await open();
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
    ).toEqual(['2026-11-08 $1.50 30', '2026-11-07 $10.85 210']);
    (
      row(page, 'kaggle:lead').querySelector('button.days') as HTMLElement
    ).click();
    await settle(fixture);
    expect(days()).toBeNull();
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
      ['dot', 'ok'],
      ['dot', 'ok'],
      ['dot', 'warn'],
      ['dot', 'off'],
      ['dot', 'err'],
      ['dot'],
    ]);
    expect(cell(page, 's:working', 'status')).toBe('working');
  });

  it('an unregistered agent with spend shows, marked, without a link to Agents', async () => {
    const page = await open();
    const gone = row(page, 'old:one');
    expect(gone.classList).toContain('gone');
    expect(text(gone.querySelector('td.agent'))).toBe('old:one');
    expect(gone.querySelector('td.agent a')).toBeNull();
    expect(text(gone.querySelector('td.status'))).toBe('unregistered');
    expect(gone.querySelector('td.status .dot')).toBeNull();
    expect(cell(page, 'old:one', 'total')).toBe('$3.50');
  });

  it('a totals row adds up what is listed', async () => {
    const page = await open();
    const total = page.querySelector('table.costs tfoot tr.totals')!;
    expect(text(total.querySelector('td.agent'))).toBe('Total (3 agents)');
    expect(text(total.querySelector('td.today'))).toBe('$1.54');
    expect(text(total.querySelector('td.total'))).toBe('$15.89');
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

  it('says when there are no agents', async () => {
    const page = await open({ ...view(), agents: [] });
    expect(text(page.querySelector('table.costs tbody'))).toBe(
      'No agent has spent anything or is registered.',
    );
    expect(page.querySelector('table.costs tfoot')).toBeNull();
  });

  it('the clock goes on between loads, a second at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(CostsPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const clock = () => text(el(fixture).querySelector('.toolbar .clock'));
      expect(clock()).toBe('17:02:03 Nov 8 2026 PST');
      await vi.advanceTimersByTimeAsync(2000);
      fixture.detectChanges();
      expect(clock()).toBe('17:02:05 Nov 8 2026 PST');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
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
