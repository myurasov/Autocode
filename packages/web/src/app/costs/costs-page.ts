/*
 * The Costs page (tier 0g; the owner, 2026-11-08): every registered agent's
 * spend today and in total, and its daily cap with the share used and what
 * is left today (its context is on the Agents tab), refreshed every 5 s (one
 * refresh at a time) so it follows each model step, with when the data was
 * read. Days shows an agent's spend per day, newest first; agent IDs link to
 * the Agents page. Unregistered agents with spend show too, marked; the Agent
 * filter (an ID pattern, kept in the address) applies a second after the last
 * key; a totals row adds up what is listed (the owner, 2026-11-08). The
 * agent a link led to (?agent=, the Agents tab's Spend) is highlighted.
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
import { IdParts } from '../breaks';
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
  imports: [AgentLink, IdParts, Updated],
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

  protected readonly view = signal<CostsView | null>(null);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  // The agent whose days are open, and its days once loaded.
  protected readonly open = signal<string | null>(null);
  protected readonly days = signal<CostDays | null>(null);
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
      this.pattern.set(match);
      if (this.loaded && match === this.match()) return;
      this.match.set(match);
      void this.refresh();
    });
    scrollToHighlight(
      this.target,
      (id) => !!this.view()?.agents.some((a) => a.agent === id),
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
    this.inFlight++;
    try {
      const view = await this.api.costs(match);
      if (match !== this.match()) return;
      this.view.set(view);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (match === this.match()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded = true;
    }
  }

  // The pattern as typed applies a second after the last key.
  protected typed(value: string): void {
    this.pattern.set(value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.applyMatch(), FILTER_DELAY_MS);
  }

  // The filter goes into the address, which sets it (and keeps it for Back).
  protected applyMatch(): void {
    clearTimeout(this.typing);
    const match = this.pattern().trim();
    if (match === this.match()) {
      void this.refresh();
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { match: match || null },
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
    this.days.set(null);
    this.daysError.set('');
    try {
      const days = await this.api.costDays(agent);
      if (this.open() === agent) this.days.set(days);
    } catch (err) {
      if (this.open() === agent) this.daysError.set(errorText(err));
    }
  }
}
