/*
 * The web UI's light/dark theme: a "dark" class on <html>, with the choice
 * saved in this browser.
 */

import { DOCUMENT, Injectable, effect, inject, signal } from '@angular/core';

export const THEME_KEY = 'autocode.theme';

// Light or dark, like AISee: the saved choice wins, dark otherwise.
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly document = inject(DOCUMENT);
  readonly dark = signal(readTheme() !== 'light');

  constructor() {
    effect(() => {
      const dark = this.dark();
      this.document.documentElement.classList.toggle('dark', dark);
      try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
      } catch {
        // Storage can be off; the choice then lasts until the page closes.
      }
    });
  }

  toggle(): void {
    this.dark.update((dark) => !dark);
  }
}

function readTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}
