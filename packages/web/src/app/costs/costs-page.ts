/*
 * The Costs page (tier 0g; the owner, 2026-11-08): every registered agent's
 * spend today and in total, its daily cap with the share used and what is
 * left today, and its context with the compaction threshold and the share
 * used, refreshed every 5 s (one refresh at a time) so it follows each model
 * step. Days shows an agent's spend per day, newest first; agent IDs link to
 * the Agents page.
 */

import { Component, DestroyRef, inject, signal } from '@angular/core';
import {
  type AgentCost,
  Api,
  type CostDays,
  type CostsView,
  errorText,
} from '../api';
import { costText } from '../jobs/jobs-page';
import { AgentLink } from '../links';
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

  protected readonly view = signal<CostsView | null>(null);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  // The agent whose days are open, and its days once loaded.
  protected readonly open = signal<string | null>(null);
  protected readonly days = signal<CostDays | null>(null);
  protected readonly daysError = signal('');
  protected readonly costText = costText;
  protected readonly shareText = shareText;
  protected readonly tokensText = tokensText;

  private inFlight = 0;

  constructor() {
    void this.refresh();
    // A tick is skipped while the last refresh is still out.
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, COSTS_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async refresh(): Promise<void> {
    this.inFlight++;
    try {
      this.view.set(await this.api.costs());
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.inFlight--;
    }
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
