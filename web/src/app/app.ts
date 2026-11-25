/*
 * The root component, the app shell: shows the server's ID and version, checks
 * the saved token at start, and shows the sign-in form or the pages, with Sign
 * out and the light/dark switch. While signed in it asks every 10 seconds how
 * much waits for the owner in the Inbox: the Inbox tab's top edge is red-pink
 * while anything does (1.1.0-rc2; the owner, 2026-11-20), and the page's icon
 * is lit (the owner, 2026-11-24).
 */

import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { REFRESH_MS } from './agents/agents-page';
import { Api, type Info } from './api';
import { Auth } from './auth';
import { Favicon } from './favicon';
import { versionText } from './format';
import { InboxCount } from './inbox-count';
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
  // How much waits for the owner in the Inbox, and the tab's tooltip for it.
  protected readonly waiting = inject(InboxCount);
  protected readonly waitingText = computed(() => {
    const n = this.waiting.open();
    if (n <= 0) return null;
    return n === 1 ? '1 item waits for you' : `${n} items wait for you`;
  });
  private counting?: ReturnType<typeof setInterval>;
  private asking = false;
  private readonly favicon = inject(Favicon);

  constructor() {
    void this.loadInfo();
    void this.auth.restore();
    // the page's icon is lit while anything waits (the owner, 2026-11-24)
    effect(() => this.favicon.show(this.waiting.open() > 0));
    // signed in: ask now, then every 10 seconds; signed out: nothing waits
    effect(() => {
      const signedIn = this.auth.signedIn();
      clearInterval(this.counting);
      this.counting = undefined;
      if (!signedIn) {
        this.waiting.open.set(0);
        return;
      }
      void this.count();
      this.counting = setInterval(() => void this.count(), REFRESH_MS);
    });
    inject(DestroyRef).onDestroy(() => clearInterval(this.counting));
  }

  // One request at a time; a failed one keeps what the tab showed.
  private async count(): Promise<void> {
    if (this.asking) return;
    this.asking = true;
    try {
      await this.api.inboxCount();
    } catch {
    } finally {
      this.asking = false;
    }
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
