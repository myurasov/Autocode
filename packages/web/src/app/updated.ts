/*
 * "Updated Xs ago.": how many seconds ago a page last loaded its data,
 * counting up every second; nothing before the first load.
 */

import {
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-updated',
  template: `@if (seconds() !== null) {Updated {{ seconds() }}s ago.}`,
})
export class Updated {
  // When the page last loaded its data (Date.now()), or null before that.
  readonly at = input<number | null>(null);

  private readonly now = signal(Date.now());
  protected readonly seconds = computed(() => {
    const at = this.at();
    if (at === null) return null;
    return Math.max(0, Math.floor((this.now() - at) / 1000));
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
