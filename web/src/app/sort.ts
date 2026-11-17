/*
 * A table sorts by its column headings (the owner, 2026-11-17: "where
 * applicable table headers should upon click sort tables. by default tabs
 * should be roted by date, from recent to oldest (where it makes sesne)"): a
 * click on a heading sorts by that column, again reverses it; a new column
 * starts at its natural direction (times and numbers largest first, text A to
 * Z); empty values go last either way; ties keep their order. The choice is
 * kept per table in localStorage, like the folded groups.
 */

import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  type WritableSignal,
} from '@angular/core';

export type Dir = 'asc' | 'desc';

// How a column reads its value from a row; first: the direction a click
// starts with, when not its natural one (a time to come: soonest first).
export type Column<T> = (
  | { text: (row: T) => string | null | undefined }
  | { time: (row: T) => string | number | null | undefined }
  | { number: (row: T) => number | null | undefined }
) & { first?: Dir };

export interface SortSpec<T> {
  columns: Record<string, Column<T>>;
  // The default column, and its direction (its natural one if left out).
  by: string;
  dir?: Dir;
}

const KEY = (table: string) => `autocode.sort.${table}`;
const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

// A row's value of a column, as a string or a number; null when empty.
function valueOf<T>(column: Column<T>, row: T): string | number | null {
  if ('text' in column) {
    const v = column.text(row);
    return v === null || v === undefined || v === '' ? null : String(v);
  }
  if ('time' in column) {
    const v = column.time(row);
    if (v === null || v === undefined || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const v = column.number(row);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// The sort of one table: its column and direction, and the rows in order.
export class Sorting<T> implements SortControl {
  private readonly state: WritableSignal<{ key: string; dir: Dir }>;
  readonly key = computed(() => this.state().key);
  readonly dir = computed(() => this.state().dir);

  constructor(
    private readonly table: string,
    readonly spec: SortSpec<T>,
  ) {
    const fallback = {
      key: spec.by,
      dir: spec.dir ?? this.natural(spec.by),
    };
    let start = fallback;
    try {
      const v = JSON.parse(localStorage.getItem(KEY(table)) ?? 'null');
      if (
        v &&
        typeof v.key === 'string' &&
        v.key in spec.columns &&
        (v.dir === 'asc' || v.dir === 'desc')
      )
        start = { key: v.key, dir: v.dir };
    } catch {
      // not JSON: the default
    }
    this.state = signal(start);
  }

  // Text A to Z; times and numbers largest (newest) first.
  natural(key: string): Dir {
    const column = this.spec.columns[key];
    if (column?.first) return column.first;
    return column && 'text' in column ? 'asc' : 'desc';
  }

  // A heading clicked: its column, or the other way if it is the sorted one.
  click(key: string): void {
    if (!(key in this.spec.columns)) return;
    const now = this.state();
    const next =
      now.key === key
        ? { key, dir: (now.dir === 'asc' ? 'desc' : 'asc') as Dir }
        : { key, dir: this.natural(key) };
    this.state.set(next);
    try {
      localStorage.setItem(KEY(this.table), JSON.stringify(next));
    } catch {
      // storage full or off: kept for this page only
    }
  }

  // The rows in this order (a new list; the one given stays as it was).
  sort(rows: readonly T[]): T[] {
    const { key, dir } = this.state();
    const column = this.spec.columns[key];
    if (!column) return [...rows];
    const keyed = rows.map((row) => ({ row, v: valueOf(column, row) }));
    const sign = dir === 'asc' ? 1 : -1;
    keyed.sort((a, b) => {
      if (a.v === null || b.v === null)
        return a.v === b.v ? 0 : a.v === null ? 1 : -1;
      const c =
        typeof a.v === 'string' || typeof b.v === 'string'
          ? COLLATOR.compare(String(a.v), String(b.v))
          : a.v - b.v;
      return sign * c;
    });
    return keyed.map((k) => k.row);
  }

  aria(key: string): 'ascending' | 'descending' | 'none' {
    const { key: sorted, dir } = this.state();
    if (sorted !== key) return 'none';
    return dir === 'asc' ? 'ascending' : 'descending';
  }
}

// What a heading needs of a table's sort, whatever its rows.
export interface SortControl {
  click(key: string): void;
  aria(key: string): 'ascending' | 'descending' | 'none';
}

/*
 * A sortable column heading: its text in a button, with an arrow that says
 * the direction when it is the sorted column (aria-sort says it too).
 */
@Component({
  selector: 'th[appSort]',
  host: {
    '[attr.aria-sort]': 'sorting().aria(appSort())',
    '[class.sortable]': 'true',
    '[class.sorted]': "sorting().aria(appSort()) !== 'none'",
    '[class.asc]': "sorting().aria(appSort()) === 'ascending'",
  },
  template: `<button
    type="button"
    class="sort"
    [title]="'Sort by ' + label()"
    (click)="sorting().click(appSort())"
  ><ng-content /><span class="arrow" aria-hidden="true"></span></button>`,
})
export class SortHead {
  readonly appSort = input.required<string>();
  readonly sorting = input.required<SortControl>();
  private readonly host = inject(ElementRef<HTMLElement>);

  protected label(): string {
    return (this.host.nativeElement.textContent ?? '').trim();
  }
}
