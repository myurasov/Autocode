/*
 * The Agents page: the agents (optionally filtered by an ID pattern) by
 * machine, refreshed every 10 s. The owner can edit an agent's description,
 * give it a new token or unregister it; the last two ask for a confirmation
 * first.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { type Agent, Api, errorText } from '../api';
import { Breaks, TimeText } from '../breaks';
import { Updated } from '../updated';

export const REFRESH_MS = 10_000;
// How long after the last key the typed filter applies.
export const FILTER_DELAY_MS = 1000;

@Component({
  selector: 'app-agents-page',
  imports: [Breaks, TimeText, Updated],
  templateUrl: './agents-page.html',
})
export class AgentsPage {
  private readonly api = inject(Api);

  protected readonly agents = signal<Agent[]>([]);
  // The agents by machine: machines in alphabetical order, agents in the
  // server's order within each.
  protected readonly machines = computed(() => {
    const by = new Map<string, Agent[]>();
    for (const a of this.agents()) {
      const machine = a.machine ?? '';
      by.set(machine, [...(by.get(machine) ?? []), a]);
    }
    return [...by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([machine, agents]) => ({ machine, agents }));
  });
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);

  // The filter as typed, and the one the table shows (applied with Enter or
  // Refresh).
  protected readonly pattern = signal('');
  protected readonly applied = signal('');

  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');

  private inFlight = 0;
  private typing?: ReturnType<typeof setTimeout>;

  constructor() {
    void this.refresh();
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
    const match = this.applied();
    this.inFlight++;
    try {
      const agents = await this.api.agents(match);
      if (match !== this.applied()) return;
      this.agents.set(agents);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (match === this.applied()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }

  // The filter as typed applies a second after the last key.
  protected typed(value: string): void {
    this.pattern.set(value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.applyFilter(), FILTER_DELAY_MS);
  }

  protected applyFilter(): void {
    clearTimeout(this.typing);
    this.applied.set(this.pattern().trim());
    this.notice.set('');
    void this.refresh();
  }

  protected clearFilter(): void {
    this.pattern.set('');
    this.applyFilter();
  }

  protected startEdit(agent: Agent): void {
    this.editing.set(agent.id);
    this.draft.set(agent.description);
  }

  protected cancelEdit(): void {
    this.editing.set(null);
  }

  protected async saveDescription(agent: Agent): Promise<void> {
    await this.act(async () => {
      const changed = await this.api.setDescription(agent.id, this.draft());
      this.agents.update((list) =>
        list.map((a) => (a.id === changed.id ? changed : a)),
      );
      this.editing.set(null);
      return `Saved the description of ${agent.id}.`;
    });
  }

  protected async rotate(agent: Agent): Promise<void> {
    const ok = confirm(
      `Give ${agent.id} a new token?\n\n` +
        "The plugin hands the new token to the agent's session; " +
        'the old token stops working at once.',
    );
    if (!ok) return;
    await this.act(async () => {
      await this.api.rotateToken(agent.id);
      return `${agent.id} has a new token.`;
    });
  }

  protected async unregister(agent: Agent): Promise<void> {
    const ok = confirm(
      `Unregister ${agent.id}?\n\n` +
        'Its session keeps running, without the agent ID.',
    );
    if (!ok) return;
    await this.act(async () => {
      await this.api.unregister(agent.id);
      this.agents.update((list) => list.filter((a) => a.id !== agent.id));
      if (this.editing() === agent.id) this.editing.set(null);
      return `Unregistered ${agent.id}.`;
    });
  }

  private async act(work: () => Promise<string>): Promise<void> {
    this.busy.set(true);
    this.notice.set('');
    try {
      this.notice.set(await work());
      this.error.set('');
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }
}
