/*
 * The value input of the Settings page's forms: the setting's kind picks a
 * checkbox, a list, a mode's two lists or a text box.
 */

import {
  Component,
  computed,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import type { SettingDef } from '../api';
import { type Draft, SettingsState } from './settings-state';

// A mode's open choices (tier 0d): an agent or a job answers.
const TARGETS = [
  { prefix: 'agent:', label: 'Agent…', what: 'Agent' },
  { prefix: 'job:', label: 'Job…', what: 'Job' },
] as const;

/*
 * One setting's value: a checkbox for switches, a list for choices, text for
 * the rest (the server checks the text). A mode (the owner, 2026-11-08) is a
 * list of its own values, Agent… and Job…; the last two add a list of the
 * registered agents or the defined jobs. A saved agent or job that is gone
 * still shows, marked.
 */
@Component({
  selector: 'app-value-input',
  template: `
    @switch (def().kind) {
      @case ('bool') {
        <input
          type="checkbox"
          [checked]="value() === true"
          (change)="value.set($any($event.target).checked)"
          [attr.aria-label]="label()"
        />
      }
      @case ('enum') {
        <select
          (change)="value.set($any($event.target).value)"
          [attr.aria-label]="label()"
        >
          @for (option of options(); track option) {
            <option [value]="option" [selected]="option === value()">
              {{ option }}
            </option>
          }
        </select>
      }
      @case ('mode') {
        <select
          class="mode-kind"
          (change)="pickKind($any($event.target).value)"
          [attr.aria-label]="label()"
        >
          @for (option of modeOptions(); track option.value) {
            <option
              [value]="option.value"
              [selected]="option.value === kind()"
            >
              {{ option.label }}
            </option>
          }
        </select>
        @if (target(); as t) {
          <select
            class="mode-target"
            (change)="value.set(t.prefix + $any($event.target).value)"
            [attr.aria-label]="t.what + ' for ' + (setting() || label())"
          >
            <option value="" [selected]="!picked()">pick one</option>
            @for (option of targetOptions(); track option.value) {
              <option
                [value]="option.value"
                [selected]="option.value === picked()"
              >
                {{ option.label }}
              </option>
            }
          </select>
        }
      }
      @default {
        <input
          type="text"
          spellcheck="false"
          [value]="text()"
          (input)="value.set($any($event.target).value)"
          (keydown.enter)="enter.emit()"
          [attr.aria-label]="label()"
        />
      }
    }
  `,
})
export class ValueInput {
  private readonly state = inject(SettingsState);
  readonly def = input.required<SettingDef>();
  readonly value = model<Draft>('');
  readonly label = input('');
  // The setting's key: the second list of a mode is "Agent for KEY"
  readonly setting = input('');
  readonly enter = output<void>();

  protected readonly text = computed(() => String(this.value()));
  // A value outside the list (from an older server) still shows.
  protected readonly options = computed(() => {
    const values = this.def().values ?? [];
    const current = String(this.value());
    return current && !values.includes(current) ? [current, ...values] : values;
  });

  // A mode's first list: its own value, or the prefix of an agent or job.
  protected readonly kind = computed(() => {
    const value = this.text();
    return TARGETS.find((t) => value.startsWith(t.prefix))?.prefix ?? value;
  });
  protected readonly target = computed(() =>
    TARGETS.find((t) => t.prefix === this.kind()),
  );
  // The agent or job picked (empty: none yet).
  protected readonly picked = computed(() =>
    this.target() ? this.text().slice(this.kind().length) : '',
  );

  protected readonly modeOptions = computed(() => {
    const own = this.def().values ?? [];
    const value = this.text();
    // a value of its own outside the list (an older server's) still shows
    const extra =
      value && !own.includes(value) && !this.target() ? [value] : [];
    return [
      ...[...extra, ...own].map((v) => ({ value: v, label: v })),
      ...TARGETS.map((t) => ({ value: t.prefix, label: t.label })),
    ];
  });

  protected readonly targetOptions = computed(() => {
    const t = this.target();
    if (!t) return [];
    const known =
      t.prefix === 'agent:' ? this.state.agents() : this.state.jobs();
    const picked = this.picked();
    const not = t.prefix === 'agent:' ? 'not registered' : 'not defined';
    const gone =
      picked && !known.includes(picked)
        ? [{ value: picked, label: `${picked} (${not})` }]
        : [];
    return [...gone, ...known.map((v) => ({ value: v, label: v }))];
  });

  // Agent… or Job… waits for its second list; an own value is the value.
  protected pickKind(kind: string): void {
    this.value.set(kind);
  }
}
