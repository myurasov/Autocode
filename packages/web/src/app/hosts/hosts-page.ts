/*
 * The Hosts page: one row per OpenCode server folder that the Autocode plugin
 * connects from, by machine, with the OpenCode process it runs in (marked when
 * its shells get no Autocode values), refreshed every 10 s (one refresh at a
 * time).
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Host } from '../api';
import { Breaks, TimeText } from '../breaks';
import { versionText } from '../format';
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
  imports: [Breaks, TimeText, Updated],
  templateUrl: './hosts-page.html',
})
export class HostsPage {
  private readonly api = inject(Api);

  protected readonly hosts = signal<Host[]>([]);
  // The hosts by machine, as on the Agents page: machines in alphabetical
  // order, hosts in the server's order within each.
  protected readonly machines = computed(() => {
    const by = new Map<string, Host[]>();
    for (const h of this.hosts())
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

  constructor() {
    void this.refresh();
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
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
