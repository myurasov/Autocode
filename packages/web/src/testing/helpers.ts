/*
 * Helpers for the web UI's unit tests: a clean setup with a mocked server, an
 * admin sign-in that skips the server, a wait for pending work, and DOM
 * shortcuts to read text and an ID's parts, find buttons, type, pick options
 * and press keys.
 */

import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import type { Provider } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Auth, authInterceptor } from '../app/auth';

export const ADMIN = 'aca_test_admin_token';
export const CONSUMER = 'acc_test_consumer_token';

// The app's HTTP setup with a mocked server; returns the mock. Resets first, so
// one failed test does not fail the next.
export function setup(providers: Provider[] = []): HttpTestingController {
  TestBed.resetTestingModule();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.classList.remove('dark');
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      provideRouter([]),
      ...providers,
    ],
  });
  return TestBed.inject(HttpTestingController);
}

// Signed in with the admin token without a round trip to the server.
export function signedIn(): Auth {
  const auth = TestBed.inject(Auth);
  auth.token.set(ADMIN);
  auth.state.set('signed-in');
  return auth;
}

// Lets pending promises, timers at 0 and change detection finish.
export async function settle(
  fixture?: ComponentFixture<unknown>,
): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (fixture) await fixture.whenStable();
  }
}

export function apiError(
  req: TestRequest,
  status: number,
  code: string,
  message: string,
): void {
  req.flush({ error: { code, message } }, { status, statusText: 'Error' });
}

export function el(fixture: ComponentFixture<unknown>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

export function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// An ID's parts as shown: the pieces it may break between (after ":" or "_").
export function parts(node: Element | null | undefined): string[] {
  return [...(node?.querySelectorAll('.id-part') ?? [])].map(
    (part) => part.textContent ?? '',
  );
}

export function button(
  root: Element,
  label: string,
): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find(
    (b) => text(b) === label || b.getAttribute('aria-label') === label,
  );
}

export function type(input: Element | null, value: string): void {
  const field = input as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

export function choose(select: Element | null, value: string): void {
  const field = select as HTMLSelectElement;
  field.value = value;
  field.dispatchEvent(new Event('change'));
}

export function press(input: Element | null, key: string): void {
  input?.dispatchEvent(new KeyboardEvent('keydown', { key }));
}
