/*
 * The Jobs page (tier 0f): the jobs, each a fresh agent run on a host (an
 * OpenCode folder of a machine) with a model and a prompt, on its trigger or
 * when started: where it runs, its model, trigger, next run, where its result
 * goes and its last run (a link to that run's row). The owner starts a run
 * now (with text added to its prompt), edits a job in the Set a Job form or
 * deletes it (after a confirmation). Below, the runs, newest first, of every
 * job or one: who started each, its state, times, cost, result and reason; a
 * failed run's kept session can be deleted (after a confirmation). Refreshed
 * every 10 s (one refresh at a time); each action's result in the toolbar.
 */

import {
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { REFRESH_MS } from '../agents/agents-page';
import {
  Api,
  errorText,
  type Host,
  type Job,
  type JobInput,
  type Run,
} from '../api';
import { Breaks, IdParts, TimeText } from '../breaks';
import { FOLD_CHARS, folded } from '../format';
import { AgentLink, highlightParam, scrollToHighlight } from '../links';
import { leftText } from '../locks/locks-page';
import { TRIGGER_HINT } from '../wakes/wakes-page';
import { Updated } from '../updated';

// A run's state as the page says it: Starting, Running, Succeeded...
export function stateText(state: string): string {
  return state ? state[0]!.toUpperCase() + state.slice(1) : state;
}

// A cost in dollars, to the cent.
export function costText(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// A run cap as typed: dollars (a $ before is fine), or off.
function capOf(text: string): number | 'off' {
  const cap = text.trim().replace(/^\$/, '');
  if (!cap || cap.toLowerCase() === 'off') return 'off';
  const usd = Number(cap);
  // Not a number: as typed, for the server to say what it takes.
  return Number.isFinite(usd) ? usd : (cap as unknown as number);
}

// Who started a run, when not an agent: the owner, a schedule or an ask.
const STARTERS = ['owner', 'schedule', 'ask'];

@Component({
  selector: 'app-jobs-page',
  imports: [AgentLink, Breaks, IdParts, RouterLink, TimeText, Updated],
  templateUrl: './jobs-page.html',
})
export class JobsPage {
  private readonly api = inject(Api);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly jobs = signal<Job[]>([]);
  protected readonly runs = signal<Run[]>([]);
  protected readonly hosts = signal<Host[]>([]);
  protected readonly loaded = signal(false);
  // Why the lists did not load.
  protected readonly error = signal('');
  // How the last action went, shown in the toolbar.
  protected readonly notice = signal('');
  protected readonly failed = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);
  // The runs shown: every job's (''), or one job's.
  protected readonly filter = signal('');
  // The text typed for a run, by job.
  protected readonly runTexts = signal<Record<string, string>>({});
  // The long results opened whole, by run.
  protected readonly opened = signal<ReadonlySet<string>>(new Set());
  // The run a link led to (?run=): highlighted, and scrolled into view.
  protected readonly target = highlightParam('run');

  // The Set a Job form, and how its last try went.
  protected readonly form = {
    open: signal(false),
    name: signal(''),
    description: signal(''),
    host: signal(''),
    model: signal(''),
    variant: signal(''),
    agent: signal(''),
    prompt: signal(''),
    trigger: signal(''),
    to: signal('owner'),
    timeout: signal('1h'),
    runUsd: signal('off'),
    deleteSession: signal(true),
  };
  protected readonly setting = signal(false);
  protected readonly set = signal('');
  protected readonly setError = signal('');
  protected readonly triggerHint = TRIGGER_HINT.replace(', idle 30m', '');

  /*
   * The form's hosts: the online ones, by machine and folder; and the host a
   * job being edited has, when it is offline (or gone).
   */
  protected readonly hostOptions = computed(() => {
    const label = (h: Host) => `${h.machine} — ${h.directory}`;
    const options = this.hosts()
      .filter((h) => h.online)
      .map((h) => ({ id: h.id, label: label(h) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const chosen = this.form.host();
    if (chosen && !options.some((o) => o.id === chosen)) {
      const known = this.hosts().find((h) => h.id === chosen);
      options.push({
        id: chosen,
        label: known ? `${label(known)} (offline)` : chosen,
      });
    }
    return options;
  });

  protected readonly stateText = stateText;
  protected readonly costText = costText;
  private inFlight = 0;

  constructor() {
    void this.refresh();
    // A tick is skipped while the last refresh is still out.
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    scrollToHighlight(
      this.target,
      (id) => this.runs().some((r) => r.id === id),
      'data-run',
    );
  }

  protected async refresh(): Promise<void> {
    const job = this.filter();
    this.inFlight++;
    try {
      const [jobs, runs, hosts] = await Promise.all([
        this.api.jobs(),
        this.api.runs(job || undefined),
        this.api.hosts(),
      ]);
      if (job !== this.filter()) return;
      this.jobs.set(jobs);
      this.runs.set(runs);
      this.hosts.set(hosts);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (job === this.filter()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }

  // How long until a time, as of the lists' last load.
  protected left(time: string | null): string {
    const now = this.updatedAt() ?? Date.now();
    return leftText(Date.parse(time ?? '') - now);
  }

  // A destination that is one agent (a link), not the owner or a pattern.
  protected isAgent(to: string): boolean {
    return !STARTERS.includes(to) && !/[*,]/.test(to);
  }

  protected chooseJob(job: string): void {
    this.filter.set(job);
    void this.refresh();
  }

  // A job's last run: shown below with every job's runs.
  protected showRun(job: Job): void {
    if (!this.filter() || this.filter() === job.name) return;
    this.chooseJob('');
  }

  protected runText(job: Job): string {
    return this.runTexts()[job.name] ?? '';
  }

  protected setRunText(job: Job, text: string): void {
    this.runTexts.update((all) => ({ ...all, [job.name]: text }));
  }

  // A run now, with the text typed beside Run Now.
  protected async runNow(job: Job): Promise<void> {
    await this.act(async () => {
      const run = await this.api.runJob(
        job.name,
        this.runText(job).trim() || undefined,
      );
      this.setRunText(job, '');
      return `Started run ${run.id}.`;
    });
    await this.refresh();
  }

  protected async remove(job: Job): Promise<void> {
    if (!confirm(`Delete job ${job.name}?\n\nIts runs' history stays.`)) return;
    await this.act(async () => {
      await this.api.deleteJob(job.name);
      return `Deleted job ${job.name}.`;
    });
    await this.refresh();
  }

  protected async deleteSession(run: Run): Promise<void> {
    if (!confirm(`Delete the session of run ${run.id}?`)) return;
    await this.act(async () => {
      await this.api.deleteRunSession(run.id);
      return `Deleted the session of run ${run.id}.`;
    });
    await this.refresh();
  }

  protected isLong(run: Run): boolean {
    return (run.result?.length ?? 0) > FOLD_CHARS;
  }

  protected isOpen(run: Run): boolean {
    return this.opened().has(run.id);
  }

  // A long result's cell: the whole when opened, else its first 200
  // characters.
  protected shown(run: Run): string {
    const result = run.result ?? '';
    return this.isOpen(run) ? result : folded(result);
  }

  protected toggle(run: Run): void {
    const opened = new Set(this.opened());
    if (!opened.delete(run.id)) opened.add(run.id);
    this.opened.set(opened);
  }

  // A click anywhere in a long result's cell, but not one that ends a
  // selection.
  protected cellClick(run: Run): void {
    if (!this.isLong(run)) return;
    if (window.getSelection()?.toString()) return;
    this.toggle(run);
  }

  // Edit: the form, open, with the job in it.
  protected edit(job: Job): void {
    const f = this.form;
    f.name.set(job.name);
    f.description.set(job.description ?? '');
    f.host.set(job.host);
    f.model.set(job.model);
    f.variant.set(job.variant ?? '');
    f.agent.set(job.agent ?? '');
    f.prompt.set(job.prompt);
    f.trigger.set(job.trigger);
    f.to.set(job.to);
    f.timeout.set(job.timeout);
    f.runUsd.set(String(job.run_usd));
    f.deleteSession.set(job.delete_session);
    f.open.set(true);
    this.set.set('');
    this.setError.set('');
    this.host.nativeElement
      .querySelector('details.panel')
      ?.scrollIntoView?.({ block: 'start' });
  }

  protected canSet(): boolean {
    const f = this.form;
    return (
      !this.setting() &&
      [f.name, f.host, f.model, f.prompt, f.trigger].every(
        (field) => !!field().trim(),
      )
    );
  }

  protected async setJob(): Promise<void> {
    if (!this.canSet()) return;
    const f = this.form;
    const name = f.name().trim();
    const job: JobInput = {
      host: f.host(),
      model: f.model().trim(),
      prompt: f.prompt(),
      trigger: f.trigger().trim(),
      to: f.to().trim() || 'owner',
      timeout: f.timeout().trim() || '1h',
      run_usd: capOf(f.runUsd()),
      delete_session: f.deleteSession(),
    };
    for (const [key, field] of [
      ['description', f.description],
      ['variant', f.variant],
      ['agent', f.agent],
    ] as const)
      if (field().trim()) job[key] = field().trim();
    this.setting.set(true);
    this.set.set('');
    this.setError.set('');
    try {
      await this.api.setJob(name, job);
      this.set.set(`Set job ${name}.`);
      for (const field of [
        f.name,
        f.description,
        f.variant,
        f.agent,
        f.prompt,
        f.trigger,
      ])
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
