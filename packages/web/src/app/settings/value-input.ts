/*
 * The value input of the Settings page's forms: the setting's kind picks a
 * checkbox, a list or a text box.
 */

import { Component, computed, input, model, output } from '@angular/core';
import type { SettingDef } from '../api';
import type { Draft } from './settings-state';

// One setting's value: a checkbox for switches, a list for choices, text for
// the rest (the server checks the text).
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
  readonly def = input.required<SettingDef>();
  readonly value = model<Draft>('');
  readonly label = input('');
  readonly enter = output<void>();

  protected readonly text = computed(() => String(this.value()));
  // A value outside the list (from an older server) still shows.
  protected readonly options = computed(() => {
    const values = this.def().values ?? [];
    const current = String(this.value());
    return current && !values.includes(current) ? [current, ...values] : values;
  });
}
