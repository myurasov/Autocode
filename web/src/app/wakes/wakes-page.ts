/*
 * The Wakes page: every agent's wakes, by agent (a link to the agent on the
 * Agents page), refreshed every 10 s (one refresh at a time); a long text or
 * check shows its first 200 characters until a click anywhere in its cell
 * opens it (it stays open across refreshes). The owner fires a wake now or
 * cancels it (after a confirmation; the result shows in the toolbar), and sets
 * a wake for any agent in a form that opens from its title; the list refreshes
 * after each. The table sorts by a click on a heading, within each agent, by
 * Last Set (newest first) by default (the owner, 2026-11-17). Last 7 Days
 * says what each wake cost: the dollars of the turns its prompts started and
 * the turns (1.1.0; the owner, 2026-11-20); a check shows its own time limit.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Wake, type WakeInput } from '../api';
import { AgentId, Breaks, IdParts, TimeText } from '../breaks';
import { FOLD_CHARS, folded, localTime } from '../format';
import { costText } from '../jobs/jobs-page';
import { AgentLink } from '../links';
import { FoldRow, Folds } from '../fold';
import { MoreRow, Paged, paged } from '../more';
import { SortHead, Sorting } from '../sort';
import { Updated } from '../updated';

// The parts of a wake that fold when long.
type Field = 'text' | 'check';

export const TRIGGER_HINT =
  'every 30m [until 2027-03-01], at 09:00, cron "0 9 * * 1-5", ' +
  'idle 30m, fire-only';

/*
 * What a wake cost in the last 7 days (1.1.0; the owner, 2026-11-20): the
 * dollars of the turns its prompts started, the turns, and for the tooltip
 * how often it fell due and its check skipped it; null for a wake with
 * nothing to show.
 */
export function weekOf(
  w: Wake,
): { usd: string; turns: string; title: string } | null {
  const k = w.week;
  if (!k || !(k.due || k.skipped || k.turns || k.usd)) return null;
  const usd = costText(k.usd);
  const turns = `${k.turns} turn${k.turns === 1 ? '' : 's'}`;
  return {
    usd,
    turns,
    title:
      `Last 7 days: ${turns}, ${usd}. It fell due ${k.due} ` +
      `time${k.due === 1 ? '' : 's'}; its check skipped ${k.skipped}.`,
  };
}

// A trigger as the page shows it: a one-time one, and a periodic one's end
// (1.1.0-rc5), at the viewer's local time.
export function triggerText(trigger: string): string {
  const at = /^at (\d{4}-\d\d-\d\dT\S+)$/.exec(trigger);
  if (at) return `at ${localTime(at[1])}`;
  const end = / until (\d{4}-\d\d-\d\dT\S+)$/.exec(trigger)?.[1];
  return end ? trigger.slice(0, -end.length) + localTime(end) : trigger;
}

@Component({
  selector: 'app-wakes-page',
  imports: [
    AgentId,
    AgentLink,
    Breaks,
    FoldRow,
    IdParts,
    MoreRow,
    SortHead,
    TimeText,
    Updated,
  ],
  templateUrl: './wakes-page.html',
})
export class WakesPage {
  private readonly api = inject(Api);

  protected readonly wakes = signal<Wake[]>([]);
  // by a heading, within each agent; Last Set, newest first, by default (the
  // owner, 2026-11-17); Next starts soonest first
  protected readonly sorting = new Sorting<Wake>('wakes', {
    columns: {
      name: { text: (w) => w.name },
      trigger: { text: (w) => w.trigger },
      next: { time: (w) => w.next ?? w.due, first: 'asc' },
      // what it cost in the last 7 days, the costliest first (1.1.0)
      week: { number: (w) => w.week?.usd },
      by: { text: (w) => w.set_by },
      set: { time: (w) => w.updated_at },
      fired: { time: (w) => w.last_fired_at },
    },
    by: 'set',
  });
  // The wakes by agent: agents in alphabetical order, wakes in the table's
  // order within each.
  protected readonly agents = computed(() => {
    const by = new Map<string, Wake[]>();
    for (const w of this.sorting.sort(this.wakes()))
      by.set(w.agent, [...(by.get(w.agent) ?? []), w]);
    return [...by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agent, wakes]) => ({ agent, wakes }));
  });
  // folded groups and at most 25 rows a group (the owner, 2026-11-09)
  protected readonly folds = new Folds('wakes');
  protected readonly paging = new Paged();
  protected groupRows(group: string, rows: Wake[]) {
    if (this.folds.folded(group)) return { rows: [], left: 0 };
    return paged(rows, this.paging.count(group));
  }
  protected readonly loaded = signal(false);
  // Why the list did not load.
  protected readonly error = signal('');
  // How the last action went, shown in the toolbar.
  protected readonly notice = signal('');
  protected readonly failed = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly triggerText = triggerText;
  protected readonly weekOf = weekOf;
  protected readonly triggerHint = TRIGGER_HINT;
  private inFlight = 0;

  // The long texts and checks opened whole, by agent, wake name and field.
  protected readonly opened = signal<ReadonlySet<string>>(new Set());

  // The Set a Wake form, and how its last try went.
  protected readonly form = {
    agent: signal(''),
    name: signal(''),
    trigger: signal(''),
    text: signal(''),
    check: signal(''),
    // the check's own time limit, like 5m (1.1.0)
    checkTimeout: signal(''),
  };
  protected readonly setting = signal(false);
  protected readonly set = signal('');
  protected readonly setError = signal('');

  constructor() {
    void this.refresh();
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async refresh(): Promise<void> {
    this.inFlight++;
    try {
      this.wakes.set(await this.api.wakes());
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }

  protected isLong(value: string | null): boolean {
    return (value?.length ?? 0) > FOLD_CHARS;
  }

  protected isOpen(wake: Wake, field: Field): boolean {
    return this.opened().has(`${wake.agent}/${wake.name}/${field}`);
  }

  // A long text's or check's cell: the whole when opened, else its first 200
  // characters.
  protected shown(wake: Wake, field: Field): string {
    const value = wake[field] ?? '';
    return this.isOpen(wake, field) ? value : folded(value);
  }

  protected toggle(wake: Wake, field: Field): void {
    const key = `${wake.agent}/${wake.name}/${field}`;
    const opened = new Set(this.opened());
    if (!opened.delete(key)) opened.add(key);
    this.opened.set(opened);
  }

  // A click anywhere in a long one's cell, but not one that ends a selection.
  protected cellClick(wake: Wake, field: Field): void {
    if (!this.isLong(wake[field])) return;
    if (window.getSelection()?.toString()) return;
    this.toggle(wake, field);
  }

  protected async fire(wake: Wake): Promise<void> {
    const done = await this.act(async () => {
      await this.api.fireWake(wake.agent, wake.name);
      return `Fired ${wake.agent}'s wake ${wake.name}.`;
    });
    if (done) await this.refresh();
  }

  protected async cancel(wake: Wake): Promise<void> {
    const ok = confirm(
      `Cancel ${wake.agent}'s wake ${wake.name}?\n\n` +
        'It is deleted and does not fire again.',
    );
    if (!ok) return;
    const done = await this.act(async () => {
      await this.api.cancelWake(wake.agent, wake.name);
      return `Cancelled ${wake.agent}'s wake ${wake.name}.`;
    });
    if (done) await this.refresh();
  }

  protected canSet(): boolean {
    const f = this.form;
    return (
      !this.setting() &&
      [f.agent, f.name, f.trigger, f.text].every((field) => !!field().trim())
    );
  }

  protected async setWake(): Promise<void> {
    if (!this.canSet()) return;
    const f = this.form;
    const agent = f.agent().trim();
    const name = f.name().trim();
    const wake: WakeInput = { text: f.text(), trigger: f.trigger().trim() };
    if (f.check().trim()) wake.check = f.check().trim();
    if (f.checkTimeout().trim()) wake.check_timeout = f.checkTimeout().trim();
    this.setting.set(true);
    this.set.set('');
    this.setError.set('');
    try {
      await this.api.setWake(agent, name, wake);
      this.set.set(`Set ${agent}'s wake ${name}.`);
      for (const field of [f.name, f.trigger, f.text, f.check, f.checkTimeout])
        field.set('');
    } catch (err) {
      this.setError.set(errorText(err));
      return;
    } finally {
      this.setting.set(false);
    }
    await this.refresh();
  }

  // Runs an action and shows how it went; true when it worked.
  private async act(work: () => Promise<string>): Promise<boolean> {
    this.busy.set(true);
    this.notice.set('');
    this.failed.set('');
    try {
      this.notice.set(await work());
      return true;
    } catch (err) {
      this.failed.set(errorText(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
