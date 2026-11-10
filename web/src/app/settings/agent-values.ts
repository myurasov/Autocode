/*
 * The Settings page's section for agents' own values: lists them (each ID
 * links to the Agents page), adds one for an agent ID (known IDs are offered),
 * and changes or removes one; each change is saved on the server at once.
 */

import {
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import type { SettingValue } from '../api';
import { IdParts } from '../breaks';
import { valueText } from '../format';
import { AgentLink } from '../links';
import { SettingsMessage } from './settings-message';
import { type Draft, draftOf, SettingsState } from './settings-state';
import { ValueInput } from './value-input';

interface Row {
  agent: string;
  key: string;
  value: SettingValue;
}

// Agents' own values: they count more than the rules and the server's values.
@Component({
  selector: 'app-agent-values',
  imports: [AgentLink, IdParts, ValueInput, SettingsMessage],
  templateUrl: './agent-values.html',
})
export class AgentValues {
  protected readonly state = inject(SettingsState);
  protected readonly valueText = valueText;

  protected readonly rows = computed<Row[]>(() => {
    const agents = this.state.view()?.agents ?? {};
    return Object.keys(agents)
      .sort()
      .flatMap((agent) =>
        Object.entries(agents[agent] ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => ({ agent, key, value })),
      );
  });

  // Known agent IDs, offered while typing one (the page loads them).
  protected readonly known = this.state.agents;

  protected readonly newAgent = signal('');
  protected readonly newKey = linkedSignal(
    () => this.state.agentKeys()[0] ?? '',
  );
  // Starts at the server's value of the picked setting; picking another setting
  // starts over.
  protected readonly newValue = linkedSignal<string, Draft>({
    source: this.newKey,
    computation: (key) => untracked(() => draftOf(this.state.serverValue(key))),
  });

  protected readonly editing = signal<{
    agent: string;
    key: string;
    value: Draft;
  } | null>(null);

  protected async add(): Promise<void> {
    const agent = this.newAgent().trim();
    const key = this.newKey();
    if (!agent || !key) {
      this.state.refuse('agents', 'Type an agent ID and pick a setting.');
      return;
    }
    const ok = await this.state.change(
      { agents: { [agent]: { [key]: this.newValue() } } },
      `Set ${key} for ${agent}.`,
      'agents',
    );
    if (ok) this.newAgent.set('');
  }

  protected startEdit(row: Row): void {
    this.editing.set({
      agent: row.agent,
      key: row.key,
      value: draftOf(row.value),
    });
  }

  protected isEditing(row: Row): boolean {
    const e = this.editing();
    return e?.agent === row.agent && e.key === row.key;
  }

  protected setEditValue(value: Draft): void {
    this.editing.update((e) => e && { ...e, value });
  }

  protected async saveEdit(): Promise<void> {
    const e = this.editing();
    if (!e) return;
    const ok = await this.state.change(
      { agents: { [e.agent]: { [e.key]: e.value } } },
      `Set ${e.key} for ${e.agent}.`,
      'agents',
    );
    if (ok) this.editing.set(null);
  }

  protected async remove(row: Row): Promise<void> {
    await this.state.change(
      { agents: { [row.agent]: { [row.key]: null } } },
      `Removed ${row.key} from ${row.agent}.`,
      'agents',
    );
  }
}
