/*
 * Unit tests of the app shell: the server ID and version, the favicon before
 * the title, admin sign-in kept for the tab or the browser, refused consumer
 * and session tokens, sign out, the light/dark switch, and the Inbox tab's
 * highlight while something waits for the owner.
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
import { REFRESH_MS } from './agents/agents-page';
import { Api } from './api';
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
    // how much waits for the owner in the Inbox
    open = 0,
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
    // signed in, the shell asks at once what waits for the owner
    if (kind === 'admin') {
      http.expectOne('/v1/inbox/count').flush({ open });
      await settle(fixture);
    }
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
      'Locks',
      'Wakes',
      'Jobs',
      'Costs',
      'History',
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
      '/locks',
      '/wakes',
      '/jobs',
      '/costs',
      '/history',
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

  /*
   * 1.1.0-rc2 (the owner, 2026-11-20: "also, add red-pink hilight at the
   * top of inbox tab when it has messages for us", then "i dont see
   * red-pink hilight on inbox tab when we have messages").
   */
  describe("the Inbox tab's highlight", () => {
    const tab = (page: HTMLElement) =>
      [...page.querySelectorAll('nav a')].find((a) => text(a) === 'Inbox')!;

    it('is on while something waits for the owner, and says how much; no other tab has it', async () => {
      const page = await start();
      await signIn(page, ADMIN, 'admin', false, 3);
      expect(tab(page).classList).toContain('has-items');
      expect(tab(page).getAttribute('title')).toBe('3 items wait for you');
      expect(page.querySelectorAll('nav a.has-items').length).toBe(1);
    });

    it('is off with nothing waiting', async () => {
      const page = await start();
      await signIn(page, ADMIN, 'admin');
      expect(tab(page).classList).not.toContain('has-items');
      expect(tab(page).getAttribute('title')).toBeNull();
    });

    it('follows the Inbox list as it loads: an answer or a Close shows at once', async () => {
      const page = await start();
      await signIn(page, ADMIN, 'admin', false, 1);
      expect(tab(page).getAttribute('title')).toBe('1 item waits for you');
      // the Inbox page loads its list: the answer carries the number
      const list = TestBed.inject(Api).inbox();
      http.expectOne('/v1/inbox').flush({ items: [], open: 0 });
      await list;
      await settle(fixture);
      expect(tab(page).classList).not.toContain('has-items');
      // an older server's answer has no number: the tab stays as it is
      const again = TestBed.inject(Api).inbox();
      http.expectOne('/v1/inbox').flush({ items: [] });
      await again;
      await settle(fixture);
      expect(tab(page).classList).not.toContain('has-items');
    });

    it('asks again every 10 seconds, one request at a time; a failed one keeps what it showed; sign out ends it', async () => {
      // the clock is the test's from the start: the shell's timer is set
      // at the sign-in
      vi.useFakeTimers();
      const tick = async (ms = 0) => {
        await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 3; i++) {
          fixture.detectChanges();
          await vi.advanceTimersByTimeAsync(0);
        }
      };
      const count = () => http.expectOne('/v1/inbox/count');
      try {
        fixture = TestBed.createComponent(App);
        http
          .expectOne('/v1/info')
          .flush({ id: 'web-smoke', version: '0.1.0-build12' });
        await tick();
        const page = el(fixture);
        const signInNow = async (open: number) => {
          type(page.querySelector('#token'), ADMIN);
          button(page, 'Sign In')!.click();
          http.expectOne('/v1/whoami').flush({ kind: 'admin' });
          await tick();
          count().flush({ open });
          await tick();
        };
        await signInNow(2);
        expect(tab(page).getAttribute('title')).toBe('2 items wait for you');
        await tick(REFRESH_MS - 1);
        http.expectNone('/v1/inbox/count');
        await tick(1);
        const slow = count();
        await tick(REFRESH_MS);
        http.expectNone('/v1/inbox/count');
        slow.flush({ open: 0 });
        await tick();
        expect(tab(page).classList).not.toContain('has-items');
        await tick(REFRESH_MS);
        count().flush({ open: 5 });
        await tick();
        expect(tab(page).getAttribute('title')).toBe('5 items wait for you');
        // the server does not answer: the tab keeps what it showed
        await tick(REFRESH_MS);
        count().flush('down', { status: 502, statusText: 'Bad Gateway' });
        await tick();
        expect(tab(page).classList).toContain('has-items');
        button(page, 'Sign Out')!.click();
        await tick(3 * REFRESH_MS);
        http.expectNone('/v1/inbox/count');
        // signed in again, it starts from nothing
        await signInNow(0);
        expect(tab(page).classList).not.toContain('has-items');
      } finally {
        fixture.destroy();
        vi.useRealTimers();
      }
    });
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
