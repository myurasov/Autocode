/*
 * A grouped table's groups fold and open (the owner, 2026-11-09: "make groups
 * collapsible on group row click and remember the collapse state for each
 * group"): a click (or Enter) on its heading row; the folded ones kept per
 * table in localStorage; a link to a row of a folded group opens it.
 */

import { Component, input, output, signal } from '@angular/core';

const KEY = (table: string) => `autocode.fold.${table}`;

// The folded groups of one table (agents, hosts, wakes).
export class Folds {
  private readonly set = signal<ReadonlySet<string>>(new Set());

  constructor(private readonly table: string) {
    try {
      const v = JSON.parse(localStorage.getItem(KEY(table)) ?? '[]');
      if (Array.isArray(v)) this.set.set(new Set(v.map(String)));
    } catch {
      // not a list: nothing folded
    }
  }

  folded(group: string): boolean {
    return this.set().has(group);
  }

  toggle(group: string): void {
    const next = new Set(this.set());
    if (next.has(group)) next.delete(group);
    else next.add(group);
    this.save(next);
  }

  // A link into the group: it opens.
  open(group: string): void {
    if (!this.folded(group)) return;
    const next = new Set(this.set());
    next.delete(group);
    this.save(next);
  }

  private save(next: Set<string>) {
    this.set.set(next);
    try {
      localStorage.setItem(KEY(this.table), JSON.stringify([...next].sort()));
    } catch {
      // storage full or off: kept for this page only
    }
  }
}

// A group's heading row: its name (the content), a chevron, and when folded
// how many rows it hides.
@Component({
  selector: 'tr[app-fold]',
  host: { class: 'group', '[class.folded]': 'folded()' },
  template: `<th
    class="id-like"
    scope="rowgroup"
    role="button"
    tabindex="0"
    [attr.colspan]="columns()"
    [attr.aria-expanded]="!folded()"
    (click)="clicked($event)"
    (keydown.enter)="toggle.emit()"
    (keydown.space)="$event.preventDefault(); toggle.emit()"
  >
    <span class="chevron" aria-hidden="true"></span><ng-content />@if (folded()) {
      <span class="fold-count muted">{{ count() }}</span>
    }
  </th>`,
})
export class FoldRow {
  readonly columns = input.required<number>();
  readonly folded = input.required<boolean>();
  readonly count = input<number>(0);
  readonly toggle = output<void>();

  // A link in the heading (an agent's ID) still leads where it goes.
  protected clicked(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('a')) return;
    this.toggle.emit();
  }
}
