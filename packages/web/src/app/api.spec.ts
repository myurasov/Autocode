/*
 * Unit tests of the API client against a mocked server: each call's method,
 * path, token and body, the filter as ?match=, failures that carry the server's
 * message, and the 15 s timeout.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ADMIN, apiError, setup, signedIn } from '../testing/helpers';
import { API_TIMEOUT_MS, Api, ApiError } from './api';

describe('Api', () => {
  let http: HttpTestingController;
  let api: Api;

  beforeEach(() => {
    http = setup();
    api = TestBed.inject(Api);
  });

  afterEach(() => http.verify());

  it('reads the server ID and version without a token', async () => {
    const info = api.info();
    const req = http.expectOne('/v1/info');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ id: 'web-smoke', version: '0.1.0' });
    expect(await info).toEqual({ id: 'web-smoke', version: '0.1.0' });
  });

  it('checks a given token with whoami', async () => {
    const who = api.whoami('acs_some_session');
    const req = http.expectOne('/v1/whoami');
    expect(req.request.headers.get('Authorization')).toBe(
      'Bearer acs_some_session',
    );
    req.flush({ kind: 'session', session: 'ses_1' });
    expect(await who).toEqual({ kind: 'session', session: 'ses_1' });
  });

  it('sends the signed-in token, and the filter as ?match=', async () => {
    signedIn();
    const all = api.agents();
    const plain = http.expectOne((r) => r.url === '/v1/agents');
    expect(plain.request.params.has('match')).toBe(false);
    expect(plain.request.headers.get('Authorization')).toBe(`Bearer ${ADMIN}`);
    plain.flush({ agents: [] });
    expect(await all).toEqual([]);

    const some = api.agents('  kaggle:*,a:b ');
    const filtered = http.expectOne((r) => r.url === '/v1/agents');
    expect(filtered.request.params.get('match')).toBe('kaggle:*,a:b');
    filtered.flush({
      agents: [
        { id: 'kaggle:lead', description: '', status: 'idle', last_active: '' },
      ],
    });
    expect((await some).map((a) => a.id)).toEqual(['kaggle:lead']);
  });

  it('changes, rotates and unregisters agents with the right calls', async () => {
    signedIn();
    const described = api.setDescription('kaggle:lead', 'leads the team');
    const patch = http.expectOne('/v1/agents/kaggle%3Alead');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ description: 'leads the team' });
    patch.flush({
      agent: { id: 'kaggle:lead', description: 'leads the team' },
    });
    expect((await described).description).toBe('leads the team');

    const rotated = api.rotateToken('kaggle:lead');
    const post = http.expectOne('/v1/agents/kaggle%3Alead/token/rotate');
    expect(post.request.method).toBe('POST');
    post.flush({ rotated: true, agent: 'kaggle:lead', session: 'ses_1' });
    expect((await rotated).rotated).toBe(true);

    const gone = api.unregister('kaggle:lead');
    const del = http.expectOne('/v1/agents/kaggle%3Alead');
    expect(del.request.method).toBe('DELETE');
    del.flush({ unregistered: 'kaggle:lead' });
    expect(await gone).toEqual({ unregistered: 'kaggle:lead' });
  });

  it('reads hosts and settings, one agent resolved, and patches settings', async () => {
    signedIn();
    const hosts = api.hosts();
    http.expectOne('/v1/hosts').flush({ hosts: [{ id: 'h:1' }] });
    expect((await hosts).length).toBe(1);

    const resolved = api.resolved('kaggle:lead');
    const get = http.expectOne((r) => r.url === '/v1/settings');
    expect(get.request.params.get('agent')).toBe('kaggle:lead');
    get.flush({ agent: 'kaggle:lead', values: {}, sources: {} });
    expect((await resolved).agent).toBe('kaggle:lead');

    const changed = api.changeSettings({
      server: { min_interval: '90s', history_days: null },
    });
    const patch = http.expectOne('/v1/settings');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      server: { min_interval: '90s', history_days: null },
    });
    patch.flush({
      defaults: { min_interval: '1m30s' },
      server: {},
      rules: [],
      agents: {},
      schema: {},
    });
    expect((await changed).defaults['min_interval']).toBe('1m30s');
  });

  it("turns failures into errors that carry the server's message", async () => {
    signedIn();
    const refused = api.changeSettings({
      server: { question_mode: 'sometimes' },
    });
    apiError(
      http.expectOne('/v1/settings'),
      400,
      'bad_setting',
      'question_mode: expected one of ask, auto',
    );
    const err = await refused.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'bad_setting' });
    expect((err as ApiError).message).toBe(
      'question_mode: expected one of ask, auto',
    );

    const down = api.hosts();
    http
      .expectOne('/v1/hosts')
      .error(new ProgressEvent('error'), { status: 0 });
    await expect(down).rejects.toMatchObject({
      status: 0,
      message: 'The server did not answer.',
    });
  });

  it('gives up on a call the server does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const slow = api.info();
      const req = http.expectOne('/v1/info');
      vi.advanceTimersByTime(API_TIMEOUT_MS - 1);
      expect(req.cancelled).toBe(false);
      vi.advanceTimersByTime(1);
      await expect(slow).rejects.toMatchObject({
        code: 'timeout',
        message: 'The server did not answer within 15 s.',
      });
      expect(req.cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
