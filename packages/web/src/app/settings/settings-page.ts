/*
 * The Settings page: edits the server-wide values and holds the sections for
 * rules, agents' own values and resolved values. It provides the SettingsState
 * that its editing sections share.
 */

import { Component, inject, linkedSignal } from '@angular/core';
import type { SettingsView } from '../api';
import { IdParts } from '../breaks';
import { AgentValues } from './agent-values';
import { ResolvedLookup } from './resolved';
import { Rules } from './rules';
import { SettingsMessage } from './settings-message';
import {
  type Draft,
  draftOf,
  incomplete,
  SettingsState,
} from './settings-state';
import { ValueInput } from './value-input';

@Component({
  selector: 'app-settings-page',
  imports: [
    IdParts,
    ValueInput,
    SettingsMessage,
    Rules,
    AgentValues,
    ResolvedLookup,
  ],
  providers: [SettingsState],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  protected readonly state = inject(SettingsState);

  /*
   * What the owner typed per key. When the server's view changes (a save), a
   * row whose server value changed shows the new value; a row the owner typed
   * in but did not save keeps what was typed.
   */
  protected readonly drafts = linkedSignal<
    SettingsView | null,
    Record<string, Draft>
  >({
    source: () => this.state.view(),
    computation: (view, previous) => {
      const out: Record<string, Draft> = {};
      for (const key of Object.keys(view?.schema ?? {})) {
        const fresh = draftOf(view?.defaults[key]);
        const typed = previous?.value[key];
        const before = draftOf(previous?.source?.defaults[key]);
        out[key] =
          typed !== undefined && typed !== before && before === fresh
            ? typed
            : fresh;
      }
      return out;
    },
  });

  constructor() {
    void this.state.load();
  }

  protected isSet(key: string): boolean {
    return Object.hasOwn(this.state.view()?.server ?? {}, key);
  }

  protected changed(key: string): boolean {
    const draft = this.drafts()[key] ?? '';
    return draft !== draftOf(this.state.serverValue(key)) && !incomplete(draft);
  }

  protected setDraft(key: string, value: Draft): void {
    this.drafts.update((drafts) => ({ ...drafts, [key]: value }));
  }

  protected async save(key: string): Promise<void> {
    const value = this.drafts()[key];
    if (value === undefined || !this.changed(key)) return;
    await this.state.change(
      { server: { [key]: value } },
      `Saved ${key}.`,
      'server',
    );
  }

  protected async reset(key: string): Promise<void> {
    await this.state.change(
      { server: { [key]: null } },
      `${key} is back to its built-in default.`,
      'server',
    );
  }
}
