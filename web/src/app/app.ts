/*
 * The root component, the app shell: shows the server's ID and version, checks
 * the saved token at start, and shows the sign-in form or the pages, with Sign
 * out and the light/dark switch.
 */

import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Api, type Info } from './api';
import { Auth } from './auth';
import { versionText } from './format';
import { SignIn } from './sign-in/sign-in';
import { Theme } from './theme';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SignIn],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly auth = inject(Auth);
  protected readonly theme = inject(Theme);
  private readonly api = inject(Api);

  protected readonly info = signal<Info | null>(null);
  protected readonly infoError = signal('');
  protected readonly versionText = versionText;

  constructor() {
    void this.loadInfo();
    void this.auth.restore();
  }

  private async loadInfo(): Promise<void> {
    try {
      this.info.set(await this.api.info());
      this.infoError.set('');
    } catch (err) {
      this.infoError.set(`server not reachable: ${(err as Error).message}`);
    }
  }

  protected signOut(): void {
    this.auth.signOut();
  }
}
