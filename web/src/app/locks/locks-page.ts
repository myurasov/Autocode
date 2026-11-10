/*
 * The Locks page (tier 0c): every lock and semaphore the agents share, by
 * name, filtered by a name pattern kept in the address, refreshed every 10 s
 * (one refresh at a time). Each shows its type (a mutex, or N places), its
 * holders (links to the Agents page) until when, and its queue in order. The
 * owner releases a hold, or takes an agent out of a queue, after a
 * confirmation: the agent is told, and the next in the queue gets the hold or
 * the others move up; the result shows in the toolbar and the list reloads.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FILTER_DELAY_MS, REFRESH_MS } from '../agents/agents-page';
import {
  Api,
  errorText,
  type Lock,
  type LockHolder,
  type LockWaiter,
} from '../api';
import { IdParts, TimeText } from '../breaks';
import { AgentLink } from '../links';
import { MoreRow, Paged, paged } from '../more';
import { Updated } from '../updated';

// A lock's type, by its capacity: a mutex (1), or so many places.
export function capacityText(max: number): string {
  return max === 1 ? 'Mutex' : `${max} places`;
}

/*
 * How long a hold has left, as people say it: "in 40s", "in 9m", "in 1h 5m",
 * "in 1d 1h" (whole minutes, hours and days); "now" once it is up.
 */
export function leftText(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `in ${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

@Component({
  selector: 'app-locks-page',
  imports: [AgentLink, IdParts, MoreRow, TimeText, Updated],
  templateUrl: './locks-page.html',
})
export class LocksPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly locks = signal<Lock[]>([]);
  // at most 25 rows, then "..." (the owner, 2026-11-09)
  protected readonly paging = new Paged();
  protected readonly page = computed(() =>
    paged(this.locks(), this.paging.count('locks')),
  );
  // The filter in the address, and as typed.
  protected readonly match = signal('');
  protected readonly pattern = signal('');
  protected readonly loaded = signal(false);
  // Why the list did not load, and how the last Release went.
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly failed = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly capacityText = capacityText;

  private inFlight = 0;
  private typing?: ReturnType<typeof setTimeout>;

  constructor() {
    // The address sets the filter (a link, Back, or the toolbar's own).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const match = params.get('match') ?? '';
      this.pattern.set(match);
      if (this.loaded() && match === this.match()) return;
      this.match.set(match);
      void this.refresh();
    });
    // A tick is skipped while the last refresh is still out.
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.typing);
    });
  }

  protected async refresh(): Promise<void> {
    const match = this.match();
    this.inFlight++;
    try {
      const locks = await this.api.locks(match);
      if (match !== this.match()) return;
      this.locks.set(locks);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (match === this.match()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }

  // How long a hold has left, as of the list's last load.
  protected left(holder: LockHolder): string {
    const now = this.updatedAt() ?? Date.now();
    return leftText(Date.parse(holder.expires) - now);
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
    this.notice.set('');
    this.failed.set('');
    const match = this.pattern().trim();
    // The same filter again: the address stays, the list reloads.
    if (match === this.match()) {
      void this.refresh();
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { match: match || null },
    });
  }

  // The owner frees a hold, after a confirmation.
  protected async release(lock: Lock, holder: LockHolder): Promise<void> {
    const ok = confirm(
      `Release ${holder.agent}'s hold on ${lock.name}?\n\n` +
        'The agent is told and the next in the queue gets it.',
    );
    if (ok) await this.free(lock, holder.agent);
  }

  // The owner takes an agent out of the queue, after a confirmation.
  protected async remove(lock: Lock, waiter: LockWaiter): Promise<void> {
    const ok = confirm(
      `Take ${waiter.agent} out of the queue of ${lock.name}?\n\n` +
        'The agent is told; the others move up.',
    );
    if (ok) await this.free(lock, waiter.agent);
  }

  /*
   * Frees an agent's hold or its place in the queue (the server says which: its
   * turn may have come meanwhile); the result in the toolbar, then the list
   * reloads.
   */
  private async free(lock: Lock, agent: string): Promise<void> {
    this.busy.set(true);
    this.notice.set('');
    this.failed.set('');
    try {
      const { released } = await this.api.releaseLock(lock.name, agent);
      this.notice.set(
        released === 'queued'
          ? `Took ${agent} out of the queue of ${lock.name}.`
          : `Released ${agent}'s hold on ${lock.name}.`,
      );
    } catch (err) {
      this.failed.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
    await this.refresh();
  }
}
