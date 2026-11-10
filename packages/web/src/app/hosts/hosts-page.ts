/*
 * The Hosts page: one row per OpenCode server folder that the Autocode plugin
 * connects from, by machine, with the OpenCode process it runs in (marked when
 * its shells get no Autocode values), refreshed every 10 s (one refresh at a
 * time); offline ones only with the Offline box (off by default; the owner,
 * 2026-11-08); the host a link led to (?host=) highlighted and scrolled into
 * view (the box goes on when it is offline), or a line that says it is not
 * there.
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
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Host } from '../api';
import { Breaks, IdParts, TimeText } from '../breaks';
import { versionText } from '../format';
import { highlightParam, scrollToHighlight } from '../links';
import { FoldRow, Folds } from '../fold';
import { MoreRow, Paged, paged } from '../more';
import { Updated } from '../updated';

// What each kind of OpenCode process is called on the page.
const PROCESS: Record<string, string> = {
  service: 'bg service',
  serve: 'opencode serve',
};

// A host's OpenCode process, like "bg service (2164472)".
export function processText(host: Host): string {
  if (!host.process_kind) return '';
  const name = PROCESS[host.process_kind] ?? host.process_kind;
  return host.process_pid ? `${name} (${host.process_pid})` : name;
}

// Shown, as a tooltip, on a host whose shells get no Autocode values.
export const NO_SHELL_VALUES =
  "The plugin cannot reach this OpenCode server's local API, so its shells " +
  'get no Autocode values.';

@Component({
  selector: 'app-hosts-page',
  imports: [Breaks, FoldRow, IdParts, MoreRow, TimeText, Updated],
  templateUrl: './hosts-page.html',
})
export class HostsPage {
  private readonly api = inject(Api);

  protected readonly hosts = signal<Host[]>([]);
  // Offline hosts too (the owner, 2026-11-08: off by default).
  protected readonly showOffline = signal(false);
  // The hosts by machine, as on the Agents page: machines in alphabetical
  // order, hosts in the server's order within each; offline ones only when
  // asked for.
  protected readonly machines = computed(() => {
    const by = new Map<string, Host[]>();
    for (const h of this.hosts())
      if (h.online || this.showOffline())
        by.set(h.machine, [...(by.get(h.machine) ?? []), h]);
    return [...by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([machine, hosts]) => ({ machine, hosts }));
  });
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly processText = processText;
  protected readonly versionText = versionText;
  protected readonly noShellValues = NO_SHELL_VALUES;
  private inFlight = 0;

  // The host a link led to, and whether the list on show lacks it.
  protected readonly target = highlightParam('host');
  // folded groups and at most 25 rows a group (the owner, 2026-11-09)
  protected readonly folds = new Folds('hosts');
  protected readonly paging = new Paged();
  protected groupRows(group: string, rows: Host[]) {
    if (this.folds.folded(group)) return { rows: [], left: 0 };
    return paged(rows, this.paging.count(group), (h) => h.id === this.target());
  }
  protected readonly missing = computed(() => {
    const id = this.target();
    if (!id || this.updatedAt() === null) return null;
    return this.hosts().some((h) => h.id === id) ? null : id;
  });

  constructor() {
    // a link to an offline host shows the offline ones
    effect(() => {
      const id = this.target();
      const host = this.hosts().find((h) => h.id === id);
      if (host && !host.online) untracked(() => this.showOffline.set(true));
      // and a link into a folded group opens it
      if (host) untracked(() => this.folds.open(host.machine));
    });
    void this.refresh();
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    scrollToHighlight(
      this.target,
      (id) => this.hosts().some((h) => h.id === id),
      'data-host',
    );
  }

  private async refresh(): Promise<void> {
    this.inFlight++;
    try {
      this.hosts.set(await this.api.hosts());
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }
}
