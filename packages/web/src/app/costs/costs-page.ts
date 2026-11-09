/*
 * The Costs page (tier 0g; the owner, 2026-11-08): every registered agent's
 * spend today and in total, and its daily cap with the share used and what
 * is left today (its context is on the Agents tab), refreshed every 5 s (one
 * refresh at a time) so it follows each model step, with when the data was
 * read. Days shows an agent's spend per day, newest first; agent IDs link to
 * the Agents page. Unregistered agents with spend show too, marked; the Agent
 * filter (an ID pattern, kept in the address) applies a second after the last
 * key; a totals row adds up what is listed (the owner, 2026-11-08). The
 * agent a link led to (?agent=, the Agents tab's Spend) is highlighted. The
 * Unregistered box (on by default) shows the gone agents, whose IDs lead to
 * the Agents tab with its own box on; "X days" makes Total and the totals
 * the last X days (empty: all time).
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FILTER_DELAY_MS } from '../agents/agents-page';
import {
  type AgentCost,
  Api,
  type CostDays,
  type CostsView,
  errorText,
} from '../api';
import { clockText, dotClass } from '../format';
import { costText } from '../jobs/jobs-page';
import { AgentLink, highlightParam, scrollToHighlight } from '../links';
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

@Component({
  selector: 'app-costs-page',
  imports: [AgentLink, Updated],
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
  protected readonly rows = computed(() =>
    (this.view()?.agents ?? []).filter((a) => a.registered || this.showGone()),
  );
  protected readonly totals = computed(() => {
    const rows = this.rows();
    const sum = (key: 'today_usd' | 'total_usd') =>
      Math.round(rows.reduce((n, a) => n + a[key], 0) * 1e6) / 1e6;
    return {
      agents: rows.length,
      today_usd: sum('today_usd'),
      total_usd: sum('total_usd'),
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
  protected readonly shareText = shareText;
  protected readonly tokensText = tokensText;

  private inFlight = 0;
  private typing?: ReturnType<typeof setTimeout>;
  private loaded = false;

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

  protected async refresh(): Promise<void> {
    const match = this.match();
    const days = this.days();
    this.inFlight++;
    try {
      const view = await this.api.costs(match, days);
      if (match !== this.match() || days !== this.days()) return;
      this.view.set(view);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (match === this.match() && days === this.days())
        this.error.set(errorText(err));
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
      const days = await this.api.costDays(agent);
      if (this.open() === agent) this.perDay.set(days);
    } catch (err) {
      if (this.open() === agent) this.daysError.set(errorText(err));
    }
  }
}
