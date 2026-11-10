/*
 * The Settings page's lookup of one agent ID: the values the server resolves
 * for it and where each comes from (the ID links to the Agents page).
 */

import { Component, computed, inject, signal } from '@angular/core';
import { Api, errorText, type ResolvedSettings } from '../api';
import { IdParts } from '../breaks';
import { valueText } from '../format';
import { AgentLink } from '../links';

// Where a resolved value comes from, in plain words.
export function sourceText(source: string | undefined): string {
  if (source === 'default') return 'built-in default';
  if (source === 'server') return 'set server-wide';
  if (source === 'agent') return "the agent's own value";
  return source ?? '';
}

// The values one agent ID ends up with, and where each comes from.
@Component({
  selector: 'app-resolved-lookup',
  imports: [AgentLink, IdParts],
  templateUrl: './resolved.html',
})
export class ResolvedLookup {
  private readonly api = inject(Api);
  protected readonly valueText = valueText;
  protected readonly sourceText = sourceText;

  protected readonly agent = signal('');
  protected readonly result = signal<ResolvedSettings | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly keys = computed(() =>
    Object.keys(this.result()?.values ?? {}),
  );

  protected async lookup(): Promise<void> {
    const agent = this.agent().trim();
    if (!agent) {
      this.error.set('Type an agent ID.');
      return;
    }
    this.busy.set(true);
    try {
      this.result.set(await this.api.resolved(agent));
      this.error.set('');
    } catch (err) {
      this.result.set(null);
      this.error.set(errorText(err));
    } finally {
      this.busy.set(false);
    }
  }
}
