/*
 * The Costs page (tier 0g; the owner, 2026-11-08): every registered agent's
 * spend today and in total, its daily cap with the share used, and its last
 * 7 days as a bar per day right after it, each day's value on hover (the
 * owner, 2026-11-09, in place of Left Today; its context is on the Agents
 * tab), refreshed every 5 s (one
 * refresh at a time) so it follows each model step, with when the data was
 * read. Details shows an agent's spend per day, newest first; agent IDs link to
 * the Agents page. Unregistered agents with spend show too, marked; the Agent
 * filter (an ID pattern, kept in the address) applies a second after the last
 * key; a totals row adds up what is listed (the owner, 2026-11-08). The
 * agent a link led to (?agent=, the Agents tab's Spend) is highlighted. The
 * Unregistered box (on by default) shows the gone agents, whose IDs lead to
 * the Agents tab with its own box on; "X days" makes Total and the totals
 * the last X days (empty: all time). By kind and by cause (1.1.0-rc7): a
 * Split bar per agent (cache writes, cache reads, input, output, and what
 * could not be split, of the period's spend) with its dollars on hover, the
 * Subagents' part, and under Details what started the agent's turns and each
 * day's kinds.
 */

import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FILTER_DELAY_MS } from '../agents/agents-page';
import {
  type AgentCost,
  Api,
  type CostCause,
  type CostDay,
  type CostDayRow,
  type CostDays,
  type CostSplit,
  type CostsView,
  errorText,
} from '../api';
import { clockText, dayText, dotClass } from '../format';
import { AgentId } from '../breaks';
import { costText } from '../jobs/jobs-page';
import { AgentLink, highlightParam, scrollToHighlight } from '../links';
import { contains } from '../filter';
import { Latest } from '../latest';
import { MoreRow, Paged, paged } from '../more';
import { SortHead, Sorting } from '../sort';
import { Updated } from '../updated';

// The page follows each model step: a refresh every 5 s.
export const COSTS_REFRESH_MS = 5000;

// A share as a percentage to a tenth ('' for none).
export function shareText(share: number | null): string {
  return share === null ? '' : `${share.toFixed(1)}%`;
}

// Tokens with separators.
export function tokensText(n: number): string {
  return n.toLocaleString('en-US');
}

// A bar of Last 7 Days: its day, spend and height (a percentage of the top
// day, to a tenth; 0 when nothing was spent).
export interface WeekBar extends CostDay {
  height: number;
}

export function weekBars(week: CostDay[]): WeekBar[] {
  const top = Math.max(0, ...week.map((d) => d.usd));
  return week.map((d) => ({
    ...d,
    height: top > 0 ? Math.round((d.usd / top) * 1000) / 10 : 0,
  }));
}

// A part of a split: its key (the bar's segment), what it is called, its
// dollars and its share of the split's dollars (a percentage to a tenth).
export interface SplitPart {
  key: 'write' | 'read' | 'input' | 'output' | 'rest';
  label: string;
  usd: number;
  share: number;
}

/*
 * A split's parts for its bar (1.1.0-rc7): cache writes, cache reads, new
 * input and output, then what could not be split when that is a cent or
 * more; none for a split without dollars (and for an older server's row).
 */
export function splitParts(s: CostSplit | null | undefined): SplitPart[] {
  if (!s || !(s.usd > 0)) return [];
  const share = (usd: number) => Math.round((usd / s.usd) * 1000) / 10;
  const kinds: [SplitPart['key'], string, number][] = [
    ['write', 'Cache Writes', s.cache_write_usd],
    ['read', 'Cache Reads', s.cache_read_usd],
    ['input', 'Input', s.input_usd],
    ['output', 'Output', s.output_usd],
  ];
  const rest = Math.max(0, s.usd - kinds.reduce((n, k) => n + k[2], 0));
  if (rest >= 0.005) kinds.push(['rest', 'Not Split', rest]);
  return kinds.map(([key, label, usd]) => ({
    key,
    label,
    usd,
    share: share(usd),
  }));
}

// A share as a whole percentage.
export function percentText(share: number): string {
  return `${Math.round(share)}%`;
}

// The Subagents' part of a split: its dollars and its share; '' for none.
export function subagentsText(s: CostSplit | null | undefined): string {
  if (!s || !(s.usd > 0)) return '';
  return (
    `${costText(s.subagents_usd)} ` +
    `(${percentText((s.subagents_usd / s.usd) * 100)})`
  );
}

// What started a turn, as the page calls each cause.
const CAUSES: Record<string, string> = {
  wake: 'Wake',
  message: 'Message',
  owner: 'Owner',
  compaction: 'Compaction',
  job: 'Job Result',
  ask: 'Ask',
  retry: 'Retry',
  run: 'Job Runs',
  earlier: 'Before Registration',
  // what a session spends between its turns (1.1.2)
  warming: 'Cache Warming',
  other: 'Other',
};
export function causeText(cause: string): string {
  return CAUSES[cause] ?? cause;
}

// The days of several agents added up by day, oldest first.
export function weekTotals(weeks: CostDay[][]): CostDay[] {
  const sum = new Map<string, number>();
  for (const d of weeks.flat()) sum.set(d.day, (sum.get(d.day) ?? 0) + d.usd);
  return [...sum.keys()]
    .sort()
    .map((day) => ({ day, usd: Math.round(sum.get(day)! * 1e6) / 1e6 }));
}

// Several splits added up (the totals row): none when no row has one.
export function splitSum(
  splits: (CostSplit | undefined)[],
): CostSplit | undefined {
  const known = splits.filter((s): s is CostSplit => !!s);
  if (!known.length) return undefined;
  const keys = Object.keys(known[0]) as (keyof CostSplit)[];
  const sum = {} as CostSplit;
  for (const key of keys)
    sum[key] =
      Math.round(known.reduce((n, s) => n + (s[key] ?? 0), 0) * 1e6) / 1e6;
  return sum;
}

@Component({
  selector: 'app-costs-page',
  imports: [
    AgentId,
    AgentLink,
    MoreRow,
    NgTemplateOutlet,
    RouterLink,
    SortHead,
    Updated,
  ],
  templateUrl: './costs-page.html',
})
export class CostsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  // The agent a link led to (the Agents tab's Spend), highlighted.
  protected readonly target = highlightParam('agent');

  // The filter in the address, and as typed.
  protected readonly match = signal('');
  protected readonly pattern = signal('');
  // The days Total counts back, in the address and as typed (the owner,
  // 2026-11-08: empty is all time).
  protected readonly days = signal('');
  protected readonly daysTyped = signal('');
  // The agents that unregistered too (on by default here).
  protected readonly showGone = signal(true);
  // What is listed, and its totals (the gone ones only with the box).
  // A job's row is not a gone agent: it stays with the box off.
  protected readonly rows = computed(() =>
    (this.view()?.agents ?? []).filter(
      (a) => a.registered || !!a.job || this.showGone(),
    ),
  );

  // How much of a spend was the agent's runs' (the owner, 2026-11-09).
  protected runsTip(usd: number | undefined): string | null {
    return usd && usd > 0 ? `${costText(usd)} of it its runs` : null;
  }
  // at most 25 rows, then "..."; the agent a link led to always shows (the
  // owner, 2026-11-09)
  protected readonly paging = new Paged();
  // by a heading (the owner, 2026-11-17): agents have no date, so by Agent;
  // an agent's days by Day, newest first
  protected readonly sorting = new Sorting<AgentCost>('costs', {
    columns: {
      agent: { text: (a) => a.agent },
      status: { text: (a) => a.status },
      today: { number: (a) => a.today_usd },
      cap: { number: (a) => (a.daily_usd === 'off' ? null : a.daily_usd) },
      total: { number: (a) => a.total_usd },
      subagents: { number: (a) => a.split?.subagents_usd ?? null },
    },
    by: 'agent',
  });
  // what started the turns, largest first as the server lists them
  protected readonly causeSorting = new Sorting<CostCause>('cost-causes', {
    columns: {
      cause: { text: (c) => causeText(c.cause) },
      turns: { number: (c) => c.turns },
      usd: { number: (c) => c.usd },
      turn: { number: (c) => (c.turns > 0 ? c.usd / c.turns : null) },
      reload: { number: (c) => c.reload_usd },
      subagents: { number: (c) => c.subagents_usd },
    },
    by: 'usd',
  });
  protected readonly daySorting = new Sorting<CostDayRow>('cost-days', {
    columns: {
      day: { text: (d) => d.day, first: 'desc' },
      usd: { number: (d) => d.usd },
      steps: { number: (d) => d.steps },
    },
    by: 'day',
  });
  protected readonly page = computed(() =>
    paged(
      this.sorting.sort(this.rows()),
      this.paging.count('costs'),
      (a) => a.agent === this.target(),
    ),
  );
  protected dayRows(days: readonly CostDayRow[]) {
    return paged(this.daySorting.sort(days), this.paging.count('days'));
  }
  protected causeRows(causes: readonly CostCause[]) {
    return this.causeSorting.sort(causes);
  }
  protected readonly totals = computed(() => {
    const rows = this.rows();
    const sum = (key: 'today_usd' | 'total_usd') =>
      Math.round(rows.reduce((n, a) => n + a[key], 0) * 1e6) / 1e6;
    return {
      agents: rows.length,
      today_usd: sum('today_usd'),
      total_usd: sum('total_usd'),
      week: weekBars(weekTotals(rows.map((a) => a.week))),
      split: splitSum(rows.map((a) => a.split)),
    };
  });

  protected readonly view = signal<CostsView | null>(null);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  // The agent whose days are open, and its days once loaded.
  protected readonly open = signal<string | null>(null);
  protected readonly perDay = signal<CostDays | null>(null);
  protected readonly daysError = signal('');
  protected readonly costText = costText;
  protected readonly dotClass = dotClass;
  protected readonly dayText = dayText;
  protected readonly shareText = shareText;
  protected readonly tokensText = tokensText;
  protected readonly weekBars = weekBars;
  protected readonly splitParts = splitParts;
  protected readonly percentText = percentText;
  protected readonly subagentsText = subagentsText;
  protected readonly causeText = causeText;

  // A cause's dollars per turn: none without a turn (a run's steps, the
  // steps from before the session registered).
  protected perTurn(c: CostCause): string {
    return c.turns > 0 ? costText(c.usd / c.turns) : '—';
  }

  // What a bar says to a screen reader: its parts in words.
  protected splitLabel(parts: SplitPart[]): string {
    return parts
      .map((p) => `${p.label} ${costText(p.usd)} (${percentText(p.share)})`)
      .join(', ');
  }

  /*
   * Under a bar's parts: the dollars they are parts of, and, where the
   * period's spend is more than that, why (the numbers start with
   * v1.1.0-rc7).
   */
  protected splitOf(split: CostSplit, total: number): string {
    return total - split.usd >= 0.005
      ? `of ${costText(split.usd)}; ${costText(total - split.usd)} ` +
          'more was spent before the split was kept'
      : `of ${costText(split.usd)}`;
  }

  // The period of an agent's split and causes: "All Time", "Last 7 Days".
  protected periodOf(d: CostDays): string {
    const n = d.period_days;
    return !n ? 'All Time' : n === 1 ? 'Last Day' : `Last ${n} Days`;
  }

  private inFlight = 0;
  private typing?: ReturnType<typeof setTimeout>;
  private loaded = false;

  // Total's title and the totals' note for a period: "Last 7 Days", "Last
  // Day"; ", last 7 days", ", last day".
  protected readonly periodTitle = computed(() => {
    const n = this.view()?.days;
    return !n ? 'Total' : n === 1 ? 'Last Day' : `Last ${n} Days`;
  });
  protected readonly periodNote = computed(() => {
    const n = this.view()?.days;
    return !n ? '' : n === 1 ? ', last day' : `, last ${n} days`;
  });

  // When the data was read: the server's time then, in its zone.
  protected readonly clock = computed(() => {
    const v = this.view();
    return v?.time ? clockText(Date.parse(v.time), v.timezone) : '';
  });

  constructor() {
    // The address sets the filter (a link, Back, or the toolbar's own).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const match = params.get('match') ?? '';
      const days = params.get('days') ?? '';
      this.pattern.set(match);
      this.daysTyped.set(days);
      if (this.loaded && match === this.match() && days === this.days()) return;
      this.match.set(match);
      this.days.set(days);
      void this.refresh();
    });
    scrollToHighlight(
      this.target,
      (id) => this.rows().some((a) => a.agent === id),
      'data-agent',
    );
    // A tick is skipped while the last refresh is still out.
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, COSTS_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.typing);
    });
  }

  private readonly latest = new Latest();

  protected async refresh(): Promise<void> {
    const match = this.match();
    const days = this.days();
    // the filters' own answer, and not one older than the view on show
    const sent = this.latest.next();
    const mine = () =>
      match === this.match() && days === this.days() && this.latest.take(sent);
    this.inFlight++;
    try {
      // what was typed matches anywhere (the owner, 2026-11-17)
      const view = await this.api.costs(contains(match), days);
      if (!mine()) return;
      this.view.set(view);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (mine()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded = true;
    }
  }

  // The pattern or the days as typed apply a second after the last key.
  protected typed(value: string): void {
    this.pattern.set(value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.applyMatch(), FILTER_DELAY_MS);
  }

  protected typedDays(value: string): void {
    this.daysTyped.set(value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.applyMatch(), FILTER_DELAY_MS);
  }

  // The filter and the days go into the address, which sets them (and keeps
  // them for Back).
  protected applyMatch(): void {
    clearTimeout(this.typing);
    const match = this.pattern().trim();
    const days = this.daysTyped().trim();
    if (match === this.match() && days === this.days()) {
      void this.refresh();
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { match: match || null, days: days || null },
      queryParamsHandling: 'merge',
    });
  }

  // The share of the daily cap spent today (null without a cap).
  protected capShare(a: AgentCost): number | null {
    if (a.daily_usd === 'off' || a.daily_usd <= 0) return null;
    return Math.round((a.today_usd / a.daily_usd) * 1000) / 10;
  }

  // A bar's width: the share, at most the whole bar.
  protected width(share: number): string {
    return `${Math.min(100, Math.max(0, share))}%`;
  }

  // Days opens an agent's spend per day; again closes it.
  protected async toggle(agent: string): Promise<void> {
    if (this.open() === agent) {
      this.open.set(null);
      return;
    }
    this.open.set(agent);
    this.perDay.set(null);
    this.daysError.set('');
    try {
      // over the page's own period (1.1.0-rc7)
      const days = await this.api.costDays(agent, this.days());
      if (this.open() === agent) this.perDay.set(days);
    } catch (err) {
      if (this.open() === agent) this.daysError.set(errorText(err));
    }
  }
}
