/*
 * Unit tests of sign-in: the admin token is kept for the tab or the browser;
 * consumer, session and unknown tokens are refused; a saved token is checked at
 * start; a 401 signs out, but a late 401 for a replaced token does not.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ADMIN, apiError, CONSUMER, setup, signedIn } from '../testing/helpers';
import { Api } from './api';
import { Auth, TOKEN_KEY } from './auth';

describe('Auth (sign-in)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  async function signIn(
    auth: Auth,
    token: string,
    answer: () => void,
    remember = false,
  ): Promise<boolean> {
    const done = auth.signIn(token, remember);
    answer();
    return done;
  }

  const kept = () => ({
    browser: localStorage.getItem(TOKEN_KEY),
    tab: sessionStorage.getItem(TOKEN_KEY),
  });

  it('an admin token signs in with full control and is kept for this tab only', async () => {
    const auth = TestBed.inject(Auth);
    const ok = await signIn(auth, ` ${ADMIN} `, () => {
      const req = http.expectOne('/v1/whoami');
      expect(req.request.headers.get('Authorization')).toBe(`Bearer ${ADMIN}`);
      req.flush({ kind: 'admin' });
    });
    expect(ok).toBe(true);
    expect(auth.state()).toBe('signed-in');
    expect(kept()).toEqual({ browser: null, tab: ADMIN });
  });

  it('asked to stay signed in, the token is kept on this browser', async () => {
    const auth = TestBed.inject(Auth);
    await signIn(
      auth,
      ADMIN,
      () => http.expectOne('/v1/whoami').flush({ kind: 'admin' }),
      true,
    );
    expect(kept()).toEqual({ browser: ADMIN, tab: null });
    expect(auth.remember()).toBe(true);
  });

  it('the consumer token is refused with a clear message and not kept', async () => {
    const auth = TestBed.inject(Auth);
    const ok = await signIn(
      auth,
      CONSUMER,
      () => http.expectOne('/v1/whoami').flush({ kind: 'consumer' }),
      true,
    );
    expect(ok).toBe(false);
    expect(auth.state()).toBe('signed-out');
    expect(auth.token()).toBeNull();
    expect(auth.message()).toBe(
      'That is the consumer token, which the plugins connect with. ' +
        'Sign in with the admin token.',
    );
    expect(kept()).toEqual({ browser: null, tab: null });
  });

  it('a session token is refused with a clear message and not kept', async () => {
    const auth = TestBed.inject(Auth);
    const ok = await signIn(auth, 'acs_agent_token', () =>
      http.expectOne('/v1/whoami').flush({ kind: 'session', session: 'ses_1' }),
    );
    expect(ok).toBe(false);
    expect(auth.state()).toBe('signed-out');
    expect(auth.message()).toBe(
      "That is an agent's session token. Sign in with the admin token.",
    );
    expect(kept()).toEqual({ browser: null, tab: null });
  });

  it('a token the server does not know is refused', async () => {
    const auth = TestBed.inject(Auth);
    await signIn(auth, 'aca_wrong', () =>
      apiError(
        http.expectOne('/v1/whoami'),
        401,
        'unauthorized',
        'a valid token is required',
      ),
    );
    expect(auth.signedIn()).toBe(false);
    expect(auth.message()).toBe('The server did not accept that token.');
  });

  it('an empty token is not sent', async () => {
    const auth = TestBed.inject(Auth);
    expect(await auth.signIn('   ')).toBe(false);
    expect(auth.message()).toBe('Paste a token first.');
  });

  it('the token kept on this browser is checked when the app starts, and stays there', async () => {
    localStorage.setItem(TOKEN_KEY, ADMIN);
    const auth = TestBed.inject(Auth);
    expect(auth.state()).toBe('checking');
    const restored = auth.restore();
    http.expectOne('/v1/whoami').flush({ kind: 'admin' });
    await restored;
    expect(auth.signedIn()).toBe(true);
    expect(kept()).toEqual({ browser: ADMIN, tab: null });
  });

  it('a consumer token kept from an earlier sign-in is refused when the app starts, and forgotten', async () => {
    localStorage.setItem(TOKEN_KEY, CONSUMER);
    const auth = TestBed.inject(Auth);
    const restored = auth.restore();
    http.expectOne('/v1/whoami').flush({ kind: 'consumer' });
    await restored;
    expect(auth.state()).toBe('signed-out');
    expect(auth.message()).toContain('Sign in with the admin token.');
    expect(kept()).toEqual({ browser: null, tab: null });
  });

  it("the tab's token is checked when the page reloads", async () => {
    sessionStorage.setItem(TOKEN_KEY, ADMIN);
    const auth = TestBed.inject(Auth);
    const restored = auth.restore();
    http.expectOne('/v1/whoami').flush({ kind: 'admin' });
    await restored;
    expect(auth.signedIn()).toBe(true);
    expect(kept()).toEqual({ browser: null, tab: ADMIN });
  });

  it('keeps the saved token when the server cannot be reached', async () => {
    localStorage.setItem(TOKEN_KEY, ADMIN);
    const auth = TestBed.inject(Auth);
    const restored = auth.restore();
    http
      .expectOne('/v1/whoami')
      .error(new ProgressEvent('error'), { status: 0 });
    await restored;
    expect(auth.signedIn()).toBe(false);
    expect(auth.message()).toContain('The server did not answer.');
    expect(localStorage.getItem(TOKEN_KEY)).toBe(ADMIN);
  });

  it('a 401 from any call sends the owner back to sign-in', async () => {
    const auth = TestBed.inject(Auth);
    await signIn(auth, ADMIN, () =>
      http.expectOne('/v1/whoami').flush({ kind: 'admin' }),
    );
    const call = TestBed.inject(Api).hosts();
    const req = http.expectOne('/v1/hosts');
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${ADMIN}`);
    apiError(req, 401, 'unauthorized', 'a valid token is required');
    await expect(call).rejects.toMatchObject({ status: 401 });
    expect(auth.state()).toBe('signed-out');
    expect(auth.message()).toContain('Sign in again');
    expect(kept()).toEqual({ browser: null, tab: null });
  });

  it('a late 401 for a call sent with the old token does not sign out the owner who just signed in again', async () => {
    const auth = signedIn();
    const api = TestBed.inject(Api);
    // the Agents page refreshes agents and hosts together; the server no longer
    // knows ADMIN
    const agents = api.agents().catch(() => undefined);
    const hosts = api.hosts().catch(() => undefined);
    const agentsReq = http.expectOne((r) => r.url === '/v1/agents');
    const hostsReq = http.expectOne('/v1/hosts');
    apiError(agentsReq, 401, 'unauthorized', 'a valid token is required');
    await agents;
    expect(auth.state()).toBe('signed-out');
    // the owner pastes the new admin token at once
    const again = auth.signIn('aca_the_new_admin_token');
    http.expectOne('/v1/whoami').flush({ kind: 'admin' });
    expect(await again).toBe(true);
    // the other call of the old refresh is answered only now
    expect(hostsReq.request.headers.get('Authorization')).toBe(
      `Bearer ${ADMIN}`,
    );
    apiError(hostsReq, 401, 'unauthorized', 'a valid token is required');
    await hosts;
    expect({ state: auth.state(), token: auth.token() }).toEqual({
      state: 'signed-in',
      token: 'aca_the_new_admin_token',
    });
  });

  it('signing out forgets the token', async () => {
    const auth = TestBed.inject(Auth);
    await signIn(
      auth,
      ADMIN,
      () => http.expectOne('/v1/whoami').flush({ kind: 'admin' }),
      true,
    );
    auth.signOut();
    expect(auth.signedIn()).toBe(false);
    expect(auth.token()).toBeNull();
    expect(kept()).toEqual({ browser: null, tab: null });
  });
});
