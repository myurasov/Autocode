/*
 * Unit tests of the Costs page (tier 0g; the owner, 2026-11-08) against a
 * mocked server: every agent's spend today and in total, its daily cap with
 * the share used and what is left, its context with the compaction threshold
 * and the share used; an agent's spend per day on a click; links to the
 * Agents page; the day and zone; the empty page; "Updated" in the footer; and
 * the live refresh (every 5 s, one at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { el, settle, setup, signedIn, text } from '../../testing/helpers';
import type { AgentCost, CostsView } from '../api';
import { COSTS_REFRESH_MS, CostsPage, shareText } from './costs-page';

const BASE: AgentCost = {
  agent: '',
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
    ],
  };
}

describe('CostsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<CostsPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  async function open(start = view()): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(CostsPage);
    http.expectOne('/v1/costs').flush(start);
    await settle(fixture);
    return el(fixture);
  }

  const row = (page: HTMLElement, agent: string) =>
    page.querySelector(`table.costs tr[data-agent="${agent}"]`)!;
  const cell = (page: HTMLElement, agent: string, name: string) =>
    text(row(page, agent).querySelector(`td.${name}`));

  it('lists every agent: today, cap, left, total, context and threshold', async () => {
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
      'Compaction At',
      '',
    ]);
    expect(cell(page, 'kaggle:lead', 'today')).toBe('$1.50');
    expect(cell(page, 'kaggle:lead', 'cap')).toBe('$2.00 75.0%');
    expect(cell(page, 'kaggle:lead', 'left')).toBe('$0.50');
    expect(cell(page, 'kaggle:lead', 'total')).toBe('$12.35');
    expect(cell(page, 'kaggle:lead', 'context')).toBe('80,000 of 200,000');
    expect(cell(page, 'kaggle:lead', 'threshold')).toBe('100,000 80.0%');
    // the bars: the cap's share used, the threshold's share used
    const bar = (agent: string, name: string) =>
      row(page, agent).querySelector(`td.${name} .bar > span`) as HTMLElement;
    expect(bar('kaggle:lead', 'cap').style.width).toBe('75%');
    expect(bar('kaggle:lead', 'threshold').style.width).toBe('80%');
    expect(bar('kaggle:lead', 'threshold').parentElement!.classList).toContain(
      'near',
    );
    // no cap, no threshold yet
    expect(cell(page, 'kaggle:worker', 'cap')).toBe('off');
    expect(cell(page, 'kaggle:worker', 'left')).toBe('—');
    expect(cell(page, 'kaggle:worker', 'context')).toBe('9,000');
    expect(cell(page, 'kaggle:worker', 'threshold')).toBe('—');
    expect(bar('kaggle:worker', 'cap')).toBeNull();
    // agent IDs link to the Agents page
    expect(
      row(page, 'kaggle:lead')
        .querySelector('td.agent a')!
        .getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    expect(text(page.querySelector('p.day'))).toBe(
      'Today is 2026-11-08 (America/Los_Angeles); the totals count every day.',
    );
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

  it('says when there are no agents', async () => {
    const page = await open({ ...view(), agents: [] });
    expect(text(page.querySelector('table.costs tbody'))).toBe(
      'No agents are registered.',
    );
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
      http.expectOne('/v1/costs').flush(view());
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS - 1);
      http.expectNone('/v1/costs');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne('/v1/costs');
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS);
      http.expectNone('/v1/costs');
      req.flush(view());
      await vi.advanceTimersByTimeAsync(COSTS_REFRESH_MS);
      http.expectOne('/v1/costs').flush(view());
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
