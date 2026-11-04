/*
 * Unit tests of the app shell: the server ID and version, the favicon before
 * the title, admin sign-in kept for the tab or the browser, refused consumer
 * and session tokens, sign out, and the light/dark switch.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ADMIN,
  CONSUMER,
  button,
  el,
  settle,
  setup,
  text,
  type,
} from '../testing/helpers';
import { App } from './app';
import { TOKEN_KEY } from './auth';
import { THEME_KEY } from './theme';

describe('App (shell)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<App>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  async function start(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(App);
    http
      .expectOne('/v1/info')
      .flush({ id: 'web-smoke', version: '0.1.0-build12' });
    await settle(fixture);
    return el(fixture);
  }

  async function signIn(
    page: HTMLElement,
    token: string,
    kind: string,
    stay = false,
  ): Promise<void> {
    type(page.querySelector('#token'), token);
    if (stay) {
      const box = page.querySelector('label.check input') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
    }
    button(page, 'Sign In')!.click();
    http.expectOne('/v1/whoami').flush({ kind });
    await settle(fixture);
  }

  it('shows Autocode, its version, and the sign-in form', async () => {
    const page = await start();
    expect(text(page.querySelector('h1'))).toBe('Autocode v0.1.0-build12');
    expect(page.querySelector('#token')).not.toBeNull();
    expect(page.querySelector('nav')).toBeNull();
    // The form's texts (the owner, 2026-11-02): only its heading above the
    // field, no visible label on it (its name stays Token), a short checkbox
    // label.
    expect(page.querySelector('.sign-in p')).toBeNull();
    expect(page.querySelector('label[for=token]')).toBeNull();
    expect(page.querySelector('#token')!.getAttribute('aria-label')).toBe(
      'Token',
    );
    expect(page.querySelector('#token')!.getAttribute('placeholder')).toBe(
      'admin token',
    );
    expect(text(page.querySelector('.sign-in label.check'))).toBe(
      'Stay signed in',
    );
  });

  it('the header shows the favicon before "Autocode", hidden from assistive tech', async () => {
    const page = await start();
    const title = page.querySelector('header h1')!;
    const icon = title.querySelector('svg.logo')!;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    // First in the title, before the word Autocode.
    expect(title.firstElementChild).toBe(icon);
    const word = [...title.childNodes].find(
      (n) =>
        n.nodeType === Node.TEXT_NODE && n.textContent!.includes('Autocode'),
    )!;
    expect(
      icon.compareDocumentPosition(word) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The favicon's triangle: a 16 px grid, a 2 px outline, round corners.
    expect(icon.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(icon.getAttribute('fill')).toBe('none');
    expect(icon.getAttribute('stroke-width')).toBe('2');
    expect(icon.getAttribute('stroke-linejoin')).toBe('round');
    expect(icon.getAttribute('stroke-linecap')).toBe('round');
    const paths = [...icon.querySelectorAll('path')];
    expect(paths.map((p) => p.getAttribute('d'))).toEqual([
      'M8 2 14.5 13.5 1.5 13.5Z',
    ]);
    // It adds no text: the title still reads Autocode and its version.
    expect(icon.textContent).toBe('');
    expect(text(title)).toBe('Autocode v0.1.0-build12');
  });

  it('an admin token opens the pages with full control', async () => {
    const page = await start();
    await signIn(page, ADMIN, 'admin');
    expect(page.querySelector('#token')).toBeNull();
    expect([...page.querySelectorAll('nav a')].map((a) => text(a))).toEqual([
      'Hosts',
      'Agents',
      'Inbox',
      'Messages',
      'Wakes',
      'Settings',
      'Help',
    ]);
    expect(
      [...page.querySelectorAll('nav a')].map((a) => a.getAttribute('href')),
    ).toEqual([
      '/hosts',
      '/agents',
      '/inbox',
      '/messages',
      '/wakes',
      '/settings',
      '/help',
    ]);
    expect(text(page.querySelector('.who'))).toBe('admin');
    // kept for this tab only
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(ADMIN);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('"Stay signed in" keeps the token on this browser', async () => {
    const page = await start();
    await signIn(page, ADMIN, 'admin', true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(ADMIN);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('the consumer token is refused: the form stays and asks for the admin token', async () => {
    const page = await start();
    await signIn(page, CONSUMER, 'consumer', true);
    expect(page.querySelector('nav')).toBeNull();
    expect(page.querySelector('#token')).not.toBeNull();
    expect(text(page.querySelector('[role=alert]'))).toContain(
      'Sign in with the admin token.',
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('a session token is refused with a clear message', async () => {
    const page = await start();
    await signIn(page, 'acs_agent', 'session');
    expect(page.querySelector('nav')).toBeNull();
    expect(text(page.querySelector('[role=alert]'))).toContain(
      "agent's session token",
    );
  });

  it('sign out goes back to the sign-in form and forgets the token', async () => {
    const page = await start();
    await signIn(page, ADMIN, 'admin');
    button(page, 'Sign Out')!.click();
    await settle(fixture);
    expect(page.querySelector('#token')).not.toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('the light/dark switch changes the page and is remembered', async () => {
    const page = await start();
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    button(page, 'Light or dark')!.click();
    await settle(fixture);
    expect(root.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    button(page, 'Light or dark')!.click();
    await settle(fixture);
    expect(root.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });
});
