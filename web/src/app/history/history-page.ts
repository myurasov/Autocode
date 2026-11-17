/*
 * The History page (the owner, 2026-11-04): every server event, newest first,
 * loaded 100 at a time and shown 25 at a time ("...": 25 more, then the next
 * 100 from the server; the owner, 2026-11-09), filtered by an agent
 * pattern and a kind (a group like wake.*, or one kind), both kept in the
 * address; each entry's time, kind, agent and host (links to their pages),
 * session and a summary of its data, the whole data as JSON on a click
 * anywhere in its cell. Refreshed every 10 s (one refresh at a time): the
 * newest page merges at the top, keeping what was loaded and what is open.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FILTER_DELAY_MS, REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type HistoryEntry, type HistoryKind } from '../api';
import { IdParts, TimeText } from '../breaks';
import { folded } from '../format';
import { AgentLink, HostLink } from '../links';
import { contains } from '../filter';
import { Latest } from '../latest';
import { MoreRow, PAGE_ROWS, Paged, paged } from '../more';
import { SortHead, Sorting } from '../sort';
import { Updated } from '../updated';

// How many entries a page has.
export const PAGE = 100;

// An entry's data in one line: its key: value pairs, joined.
export function dataSummary(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([key, value]) => {
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${shown}`;
    })
    .join(', ')
    .replace(/\s+/g, ' ');
}

// The groups of the Kind list: the prefixes of the kinds there are (wake.*).
export function kindGroups(kinds: HistoryKind[]): string[] {
  const groups = kinds
    .filter((k) => k.kind.includes('.'))
    .map((k) => `${k.kind.split('.')[0]}.*`);
  return [...new Set(groups)].sort();
}

/*
 * The newest page merged into what is shown: its entries at the top and the
 * older ones Older loaded after them; a page with none of what is shown (more
 * than a page came since) takes its place.
 */
export function mergeNewest(
  shown: HistoryEntry[],
  page: HistoryEntry[],
): { entries: HistoryEntry[]; replaced: boolean } {
  const ids = new Set(page.map((e) => e.id));
  if (!shown.some((e) => ids.has(e.id)))
    return { entries: page, replaced: true };
  return {
    entries: [...page, ...shown.filter((e) => !ids.has(e.id))],
    replaced: false,
  };
}

@Component({
  selector: 'app-history-page',
  imports: [AgentLink, HostLink, IdParts, MoreRow, SortHead, TimeText, Updated],
  templateUrl: './history-page.html',
})
export class HistoryPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly entries = signal<HistoryEntry[]>([]);
  protected readonly kinds = signal<HistoryKind[]>([]);
  protected readonly groups = computed(() => kindGroups(this.kinds()));
  // The filters in the address, and the pattern as typed.
  protected readonly match = signal('');
  protected readonly kind = signal('');
  protected readonly pattern = signal('');
  // The chosen kind when the list does not have it (none of it now).
  protected readonly extraKind = computed(() => {
    const kind = this.kind();
    const listed =
      this.groups().includes(kind) || this.kinds().some((k) => k.kind === kind);
    return kind && !listed ? kind : null;
  });
  // Whether there may be older entries than those shown.
  protected readonly more = signal(false);
  // 25 rows at a time of what is loaded (the owner, 2026-11-09).
  protected readonly paging = new Paged();
  protected readonly pageSize = PAGE_ROWS;
  // by a heading, what is loaded; newest first by default (the owner,
  // 2026-11-17); the server pages newest first
  protected readonly sorting = new Sorting<HistoryEntry>('history', {
    columns: {
      time: { time: (e) => e.at },
      kind: { text: (e) => e.kind },
      agent: { text: (e) => e.agent },
      host: { text: (e) => e.host },
      session: { text: (e) => e.session },
    },
    by: 'time',
  });
  protected readonly page = computed(() =>
    paged(this.sorting.sort(this.entries()), this.paging.count('history')),
  );

  /*
   * "...": 25 more of what is loaded; past it, the next 100 from the server,
   * and as many more rows as keep the ones on show on show (oldest first,
   * the older entries sort above them; the review before 1.0.0).
   */
  protected async showMore(): Promise<void> {
    let by = PAGE_ROWS;
    if (!this.page().left && this.more()) {
      const shown = new Set(this.page().rows.map((e) => e.id));
      await this.older();
      const rows = this.sorting.sort(this.entries());
      let last = -1;
      rows.forEach((e, i) => {
        if (shown.has(e.id)) last = i;
      });
      by = Math.max(by, last + 1 - this.paging.count('history'));
    }
    this.paging.more('history', by);
  }
  protected readonly loaded = signal(false);
  protected readonly loadingOlder = signal(false);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  // The entries whose data is open, by ID; they stay open across refreshes.
  protected readonly opened = signal<ReadonlySet<number>>(new Set());

  private inFlight = 0;
  // an older answer never takes a newer one's place
  private readonly latest = new Latest();
  private typing?: ReturnType<typeof setTimeout>;

  constructor() {
    // The address sets the filters (a link, Back, or the toolbar's own).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const match = params.get('match') ?? '';
      const kind = params.get('kind') ?? '';
      this.pattern.set(match);
      if (this.loaded() && match === this.match() && kind === this.kind())
        return;
      this.match.set(match);
      this.kind.set(kind);
      void this.refresh(true);
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

  // The filters a list is for: a reply for other filters is dropped.
  private filters(): string {
    return `${this.match()}\n${this.kind()}`;
  }

  /*
   * The newest page (and the kinds there are): with reset, for new filters,
   * in place of what is shown; else merged at the top of it.
   */
  protected async refresh(reset = false): Promise<void> {
    const filters = this.filters();
    const sent = this.latest.next();
    this.inFlight++;
    const kinds = this.api.historyKinds().then(
      (list) => this.kinds.set(list),
      () => undefined,
    );
    try {
      // what was typed matches anywhere (the owner, 2026-11-17)
      const page = await this.api.history({
        match: contains(this.match()),
        kind: this.kind(),
        limit: PAGE,
      });
      if (filters !== this.filters() || !this.latest.take(sent)) return;
      const merged = reset
        ? { entries: page, replaced: true }
        : mergeNewest(this.entries(), page);
      this.entries.set(merged.entries);
      // a new list (new filters, or none of what was shown): 25 again
      if (merged.replaced) {
        this.more.set(page.length === PAGE);
        this.paging.reset('history');
      }
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (filters !== this.filters() || !this.latest.take(sent)) return;
      this.error.set(errorText(err));
      if (reset) {
        this.entries.set([]);
        this.more.set(false);
      }
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
    await kinds;
  }

  // The next page, before the last entry shown, appended.
  protected async older(): Promise<void> {
    const last = this.entries().at(-1);
    if (!last) return;
    const filters = this.filters();
    this.loadingOlder.set(true);
    try {
      const page = await this.api.history({
        match: contains(this.match()),
        kind: this.kind(),
        before: last.id,
        limit: PAGE,
      });
      if (filters !== this.filters()) return;
      const ids = new Set(this.entries().map((e) => e.id));
      this.entries.update((list) => [
        ...list,
        ...page.filter((e) => !ids.has(e.id)),
      ]);
      this.more.set(page.length === PAGE);
      this.error.set('');
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.loadingOlder.set(false);
    }
  }

  // The pattern as typed applies a second after the last key.
  protected typed(value: string): void {
    this.pattern.set(value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.applyMatch(), FILTER_DELAY_MS);
  }

  protected applyMatch(): void {
    clearTimeout(this.typing);
    this.go(this.pattern().trim(), this.kind());
  }

  protected chooseKind(kind: string): void {
    this.go(this.match(), kind);
  }

  // Filters go into the address, which sets them (and keeps them for Back).
  private go(match: string, kind: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { match: match || null, kind: kind || null },
    });
  }

  protected hasData(entry: HistoryEntry): boolean {
    return Object.keys(entry.data ?? {}).length > 0;
  }

  protected isOpen(entry: HistoryEntry): boolean {
    return this.opened().has(entry.id);
  }

  // A data cell: the whole data as JSON when open, else its summary.
  protected shown(entry: HistoryEntry): string {
    return this.isOpen(entry)
      ? JSON.stringify(entry.data, null, 2)
      : folded(dataSummary(entry.data));
  }

  protected toggle(entry: HistoryEntry): void {
    const opened = new Set(this.opened());
    if (!opened.delete(entry.id)) opened.add(entry.id);
    this.opened.set(opened);
  }

  // A click anywhere in a data cell, but not one that ends a selection.
  protected cellClick(entry: HistoryEntry): void {
    if (!this.hasData(entry)) return;
    if (window.getSelection()?.toString()) return;
    this.toggle(entry);
  }
}
