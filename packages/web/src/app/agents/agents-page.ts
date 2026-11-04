/*
 * The Agents page: the agents (optionally filtered by an ID pattern) by
 * machine, with their hosts (links to the Hosts page), refreshed every 10 s;
 * the agent a link led to (?agent=) highlighted and scrolled into view, a
 * filter that would hide it cleared, or a line that says it is not there.
 * The owner can edit an agent's description,
 * pause or resume its injections, give it a new token or unregister it (the
 * last two ask for a confirmation first), and stop all agents (after a
 * confirmation) or resume the ones Stop All paused; each action's result shows
 * in the toolbar.
 */

import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { type Agent, Api, errorText } from '../api';
import { Breaks, IdParts, TimeText } from '../breaks';
import { HostLink, highlightParam, scrollToHighlight } from '../links';
import { Updated } from '../updated';

export const REFRESH_MS = 10_000;
// How long after the last key the typed filter applies.
export const FILTER_DELAY_MS = 1000;

// Who paused an agent, for its status's tooltip ('' when it is not paused).
export function pausedText(agent: Agent): string {
  if (!agent.paused) return '';
  return agent.paused === 'stop-all'
    ? 'Paused by Stop All'
    : 'Paused by the owner';
}

// Whether a filter shows an ID: IDs with * wildcards, separated by commas.
export function matchesPattern(pattern: string, id: string): boolean {
  return pattern
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const parts = part
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp(`^${parts.join('.*')}$`).test(id);
    });
}

// "1 agent", "2 agents".
function count(n: number, thing: string): string {
  return `${n} ${thing}${n === 1 ? '' : 's'}`;
}

@Component({
  selector: 'app-agents-page',
  imports: [Breaks, HostLink, IdParts, TimeText, Updated],
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
  // Why the list did not load.
  protected readonly error = signal('');
  // How the last action went, shown in the toolbar.
  protected readonly notice = signal('');
  protected readonly failed = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);

  // The filter as typed, and the one the table shows (applied with Enter or
  // Refresh).
  protected readonly pattern = signal('');
  protected readonly applied = signal('');

  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly pausedText = pausedText;

  // The agent a link led to, and the filter the list on show was loaded with.
  protected readonly target = highlightParam('agent');
  private readonly listedFor = signal<string | null>(null);
  // The agent a link led to when the list (for this filter) does not have it.
  protected readonly missing = computed(() => {
    const id = this.target();
    const applied = this.applied();
    if (!id || this.listedFor() !== applied) return null;
    if (this.agents().some((a) => a.id === id)) return null;
    return applied && !matchesPattern(applied, id) ? null : id;
  });

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
    scrollToHighlight(
      this.target,
      (id) => this.agents().some((a) => a.id === id),
      'data-agent',
    );
    // A filter that would hide the agent a link leads to goes.
    effect(() => {
      const id = this.target();
      untracked(() => {
        const applied = this.applied();
        if (id && applied && !matchesPattern(applied, id)) this.clearFilter();
      });
    });
  }

  protected async refresh(): Promise<void> {
    const match = this.applied();
    this.inFlight++;
    try {
      const agents = await this.api.agents(match);
      if (match !== this.applied()) return;
      this.agents.set(agents);
      this.listedFor.set(match);
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
    this.failed.set('');
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

  protected async pause(agent: Agent): Promise<void> {
    const done = await this.act(async () => {
      await this.api.pause(agent.id);
      return `Paused ${agent.id}.`;
    });
    if (done) await this.refresh();
  }

  protected async resume(agent: Agent): Promise<void> {
    const done = await this.act(async () => {
      await this.api.resume(agent.id);
      return `Resumed ${agent.id}.`;
    });
    if (done) await this.refresh();
  }

  protected async stopAll(): Promise<void> {
    const ok = confirm(
      'Stop all agents?\n\n' +
        'Every agent is paused (nothing is typed into its session) and ' +
        'every running turn is interrupted. Resume All resumes them.',
    );
    if (!ok) return;
    const done = await this.act(async () => {
      const { paused, interrupted } = await this.api.stopAll();
      return (
        `Stop All paused ${count(paused.length, 'agent')} and ` +
        `interrupted ${count(interrupted.length, 'session')}.`
      );
    });
    if (done) await this.refresh();
  }

  protected async resumeAll(): Promise<void> {
    const done = await this.act(async () => {
      const { resumed } = await this.api.resumeAll();
      return resumed.length
        ? `Resumed ${count(resumed.length, 'agent')}.`
        : 'No agent was paused by Stop All.';
    });
    if (done) await this.refresh();
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
