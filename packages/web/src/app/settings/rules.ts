/*
 * The Settings page's section for pattern rules: adding, editing, moving and
 * removing rules, with an editor that offers each setting once per rule.
 */

import { Component, computed, inject, signal } from '@angular/core';
import type { Rule } from '../api';
import { valueText } from '../format';
import { SettingsMessage } from './settings-message';
import { type Draft, draftOf, SettingsState } from './settings-state';
import { ValueInput } from './value-input';

interface DraftRule {
  // null while adding a new rule.
  index: number | null;
  match: string;
  items: { key: string; value: Draft }[];
}

// Pattern rules: an ordered list, first match wins. Every change sends the
// whole list.
@Component({
  selector: 'app-rules',
  imports: [ValueInput, SettingsMessage],
  templateUrl: './rules.html',
})
export class Rules {
  protected readonly state = inject(SettingsState);
  protected readonly valueText = valueText;

  protected readonly rules = computed(() => this.state.view()?.rules ?? []);
  protected readonly draft = signal<DraftRule | null>(null);

  protected entries(rule: Rule): [string, unknown][] {
    return Object.entries(rule.settings);
  }

  protected add(): void {
    this.draft.set({ index: null, match: '', items: [] });
    this.addItem();
  }

  protected edit(index: number): void {
    const rule = this.rules()[index];
    if (!rule) return;
    const items = Object.entries(rule.settings).map(([key, value]) => ({
      key,
      value: draftOf(value),
    }));
    this.draft.set({ index, match: rule.match, items });
  }

  protected cancel(): void {
    this.draft.set(null);
  }

  protected setMatch(match: string): void {
    this.draft.update((d) => d && { ...d, match });
  }

  protected addItem(): void {
    this.draft.update((d) => {
      if (!d) return d;
      const used = new Set(d.items.map((item) => item.key));
      const key = this.state.agentKeys().find((k) => !used.has(k));
      if (!key) return d;
      return {
        ...d,
        items: [
          ...d.items,
          { key, value: draftOf(this.state.serverValue(key)) },
        ],
      };
    });
  }

  protected setItemKey(n: number, key: string): void {
    if (!key) return;
    this.updateItem(n, () => ({
      key,
      value: draftOf(this.state.serverValue(key)),
    }));
  }

  protected setItemValue(n: number, value: Draft): void {
    this.updateItem(n, (item) => ({ ...item, value }));
  }

  protected removeItem(n: number): void {
    this.draft.update(
      (d) => d && { ...d, items: d.items.filter((_, i) => i !== n) },
    );
  }

  private updateItem(
    n: number,
    change: (item: { key: string; value: Draft }) => {
      key: string;
      value: Draft;
    },
  ) {
    this.draft.update(
      (d) =>
        d && {
          ...d,
          items: d.items.map((item, i) => (i === n ? change(item) : item)),
        },
    );
  }

  // The keys an item may switch to: its own and those no other item of the rule
  // uses.
  protected keysFor(n: number): string[] {
    const items = this.draft()?.items ?? [];
    const others = new Set(
      items.filter((_, i) => i !== n).map((item) => item.key),
    );
    return this.state.agentKeys().filter((key) => !others.has(key));
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    // A setting named twice would keep only one of its values: refuse instead
    // of dropping one silently.
    const seen = new Set<string>();
    const twice = d.items.find((item) => seen.size === seen.add(item.key).size);
    if (twice) {
      this.state.refuse(
        'rules',
        `${twice.key} is in this rule twice; keep one of them.`,
      );
      return;
    }
    const rule: Rule = {
      match: d.match.trim(),
      settings: Object.fromEntries(d.items.map((i) => [i.key, i.value])),
    };
    const list = [...this.rules()];
    if (d.index === null) list.push(rule);
    else list[d.index] = rule;
    const done =
      d.index === null
        ? `Added rule ${list.length}.`
        : `Saved rule ${d.index + 1}.`;
    if (await this.state.change({ rules: list }, done, 'rules'))
      this.draft.set(null);
  }

  protected async move(index: number, by: -1 | 1): Promise<void> {
    const list = [...this.rules()];
    const other = index + by;
    const a = list[index];
    const b = list[other];
    if (!a || !b) return;
    list[index] = b;
    list[other] = a;
    await this.state.change(
      { rules: list },
      `Moved rule ${index + 1} ${by < 0 ? 'up' : 'down'}.`,
      'rules',
    );
  }

  protected async remove(index: number): Promise<void> {
    const rule = this.rules()[index];
    if (!rule || !confirm(`Remove rule ${index + 1} (${rule.match})?`)) return;
    const list = this.rules().filter((_, i) => i !== index);
    await this.state.change(
      { rules: list },
      `Removed rule ${index + 1}.`,
      'rules',
    );
  }
}
