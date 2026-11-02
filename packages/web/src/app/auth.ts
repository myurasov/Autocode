/*
 * The web UI's sign-in: the Auth service (admin token only), where it keeps the
 * token, and authInterceptor, which adds the token to API calls and sends the
 * owner back to the sign-in form when a call answers 401.
 */

import {
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Api, ApiError } from './api';

export const TOKEN_KEY = 'autocode.token';

export type AuthState = 'checking' | 'signed-out' | 'signed-in';

/*
 * The owner's sign-in, with the admin token only (full control). The token is
 * kept for this browser tab (sessionStorage), or on this browser when the owner
 * asks to stay signed in (localStorage).
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  private readonly stored = readStoredToken();

  readonly token = signal<string | null>(this.stored?.token ?? null);
  // Whether the token is kept on this browser beyond this tab.
  readonly remember = signal(this.stored?.remember ?? false);
  readonly state = signal<AuthState>(this.token() ? 'checking' : 'signed-out');
  // Why the owner is on the sign-in form (a refused token, an expired one).
  readonly message = signal('');
  readonly busy = signal(false);

  readonly signedIn = computed(() => this.state() === 'signed-in');

  // Checks the saved token, if any, once the app starts.
  async restore(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.state.set('signed-out');
      return;
    }
    await this.signIn(token, this.remember());
  }

  // Returns true when the token is the admin token; otherwise says why on the
  // sign-in form.
  async signIn(input: string, remember = false): Promise<boolean> {
    const token = input.trim();
    if (!token) {
      this.refuse('Paste a token first.');
      return false;
    }
    this.busy.set(true);
    try {
      const who = await this.api.whoami(token);
      if (who.kind === 'admin') {
        writeStoredToken(token, remember);
        this.remember.set(remember);
        this.token.set(token);
        this.message.set('');
        this.state.set('signed-in');
        return true;
      }
      if (who.kind === 'consumer')
        this.refuse(
          'That is the consumer token, which the plugins connect with. ' +
            'Sign in with the admin token.',
        );
      else if (who.kind === 'session')
        this.refuse(
          "That is an agent's session token. Sign in with the admin token.",
        );
      else this.refuse('The server did not say what kind of token that is.');
      return false;
    } catch (err) {
      const e = err instanceof ApiError ? err : undefined;
      if (e?.status === 401)
        this.refuse('The server did not accept that token.');
      else
        this.refuse(
          `Could not check the token: ${e?.message ?? String(err)}`,
          false,
        );
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  signOut(message = ''): void {
    writeStoredToken(null);
    this.token.set(null);
    this.message.set(message);
    this.state.set('signed-out');
  }

  /*
   * A call made with `token` answered 401: that token stopped working. A late
   * answer to a call made with an earlier token (the owner has signed in again
   * since) changes nothing.
   */
  expired(token: string | null = this.token()): void {
    if (this.state() === 'signed-out' || token !== this.token()) return;
    this.signOut('The server no longer accepts your token. Sign in again.');
  }

  // `forget` false keeps the saved token (the server could not be reached, so
  // the token may still be good).
  private refuse(message: string, forget = true): void {
    if (forget) {
      writeStoredToken(null);
      this.token.set(null);
    }
    this.message.set(message);
    this.state.set('signed-out');
  }
}

function readStoredToken(): { token: string; remember: boolean } | null {
  try {
    const kept = localStorage.getItem(TOKEN_KEY);
    if (kept) return { token: kept, remember: true };
    const tab = sessionStorage.getItem(TOKEN_KEY);
    return tab ? { token: tab, remember: false } : null;
  } catch {
    return null;
  }
}

// Null forgets the token everywhere.
function writeStoredToken(token: string | null, remember = false): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (token)
      (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be off (private windows); the token then lasts until the page
    // closes.
  }
}

/*
 * Adds the signed-in token to API calls and sends the owner back to sign-in
 * when a call answers 401. A call that carries its own token (the sign-in
 * check) is left alone.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/v1/') || req.headers.has('Authorization'))
    return next(req);
  const auth = inject(Auth);
  const token = auth.token();
  const sent = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;
  return next(sent).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && token)
        auth.expired(token);
      return throwError(() => err);
    }),
  );
};
