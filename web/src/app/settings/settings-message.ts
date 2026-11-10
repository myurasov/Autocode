/*
 * A small component for the Settings page: in each section, the error or notice
 * of the last change made there.
 */

import { Component, inject, input } from '@angular/core';
import { type Section, SettingsState } from './settings-state';

// The outcome of the last change, shown in the section that made it.
@Component({
  selector: 'app-settings-message',
  template: `
    @if (state.where() === where()) {
      @if (state.error()) {
        <p class="errmsg" role="alert">{{ state.error() }}</p>
      } @else if (state.notice()) {
        <p class="notice" role="status">{{ state.notice() }}</p>
      }
    }
  `,
})
export class SettingsMessage {
  protected readonly state = inject(SettingsState);
  readonly where = input.required<Section>();
}
