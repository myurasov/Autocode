/*
 * The Wakes page: every agent's wakes, by agent (a link to the agent on the
 * Agents page), refreshed every 10 s (one refresh at a time); a long text or
 * check shows its first 200 characters until a click anywhere in its cell
 * opens it (it stays open across refreshes). The owner fires a wake now or
 * cancels it (after a confirmation; the result shows in the toolbar), and sets
 * a wake for any agent in a form that opens from its title; the list refreshes
 * after each.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Wake, type WakeInput } from '../api';
import { Breaks, IdParts, TimeText } from '../breaks';
import { FOLD_CHARS, folded, localTime } from '../format';
import { AgentLink } from '../links';
import { Updated } from '../updated';

// The parts of a wake that fold when long.
type Field = 'text' | 'check';

export const TRIGGER_HINT =
  'every 30m, at 09:00, cron "0 9 * * 1-5", idle 30m, fire-only';

// A trigger as the page shows it: a one-time one at the viewer's local time.
export function triggerText(trigger: string): string {
  const at = /^at (\d{4}-\d\d-\d\dT\S+)$/.exec(trigger);
  return at ? `at ${localTime(at[1])}` : trigger;
}

@Component({
  selector: 'app-wakes-page',
  imports: [AgentLink, Breaks, IdParts, TimeText, Updated],
  templateUrl: './wakes-page.html',
})
export class WakesPage {
  private readonly api = inject(Api);

  protected readonly wakes = signal<Wake[]>([]);
  // The wakes by agent: agents in alphabetical order, wakes in the server's
  // order within each.
  protected readonly agents = computed(() => {
    const by = new Map<string, Wake[]>();
    for (const w of this.wakes())
      by.set(w.agent, [...(by.get(w.agent) ?? []), w]);
    return [...by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agent, wakes]) => ({ agent, wakes }));
  });
  protected readonly loaded = signal(false);
  // Why the list did not load.
  protected readonly error = signal('');
  // How the last action went, shown in the toolbar.
  protected readonly notice = signal('');
  protected readonly failed = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly triggerText = triggerText;
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
    end: signal(''),
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
    if (f.end().trim()) wake.end = f.end().trim();
    this.setting.set(true);
    this.set.set('');
    this.setError.set('');
    try {
      await this.api.setWake(agent, name, wake);
      this.set.set(`Set ${agent}'s wake ${name}.`);
      for (const field of [f.name, f.trigger, f.text, f.check, f.end])
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
