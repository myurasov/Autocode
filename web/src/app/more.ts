/*
 * At most 25 rows of a table, then a "..." row that shows 25 more (the owner,
 * 2026-11-09). A grouped table counts each group on its own. A row a link
 * points at (?agent=, ?host=, ?run=) always shows, so a link never leads to a
 * hidden row.
 */

import { Component, input, output, signal } from '@angular/core';

export const PAGE_ROWS = 25;

// The rows to show of a list, and how many are left after them.
export function paged<T>(
  rows: readonly T[],
  count: number,
  keep?: (row: T) => boolean,
): { rows: T[]; left: number } {
  const shown = rows.slice(0, count);
  const extra = keep ? rows.slice(count).filter(keep) : [];
  return {
    rows: [...shown, ...extra],
    left: Math.max(0, rows.length - count - extra.length),
  };
}

// How many rows each list (by a key: a table, or a group of one) shows.
export class Paged {
  private readonly counts = signal<Record<string, number>>({});

  count(key: string): number {
    return this.counts()[key] ?? PAGE_ROWS;
  }

  more(key: string): void {
    this.counts.update((c) => ({ ...c, [key]: this.count(key) + PAGE_ROWS }));
  }

  // A new list: back to the first 25.
  reset(key: string): void {
    this.counts.update(({ [key]: _, ...rest }) => rest);
  }
}

/*
 * The "..." row: one cell across the table's columns, only its dots (the
 * owner, 2026-11-09: no count, which History could not know; not a button).
 * The cell takes a click, Enter or Space.
 */
@Component({
  selector: 'tr[app-more]',
  host: { class: 'more-rows' },
  template: `<td
    [attr.colspan]="columns()"
    role="button"
    tabindex="0"
    aria-label="Show more"
    title="Show more"
    (click)="more.emit()"
    (keydown.enter)="more.emit()"
    (keydown.space)="$event.preventDefault(); more.emit()"
  ><span class="dots">...</span></td>`,
})
export class MoreRow {
  readonly columns = input.required<number>();
  // How many are left: whether there are more (it is not shown).
  readonly left = input.required<number>();
  readonly more = output<void>();
}
