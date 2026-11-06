/*
 * Unit tests of the API client against a mocked server: each call's method,
 * path, token and body, the filter as ?match=, the inbox's closed items as
 * ?all=1, failures that carry the server's message, and the 15 s timeout.
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

  it("reads the locks (by name pattern) and releases an agent's hold", async () => {
    signedIn();
    const all = api.locks();
    const plain = http.expectOne((r) => r.url === '/v1/locks');
    expect(plain.request.method).toBe('GET');
    expect(plain.request.params.keys()).toEqual([]);
    plain.flush({ locks: [{ name: 'gpu-0', max: 1, holders: [], queue: [] }] });
    expect((await all).map((l) => l.name)).toEqual(['gpu-0']);

    const some = api.locks(' gpu-* ');
    const filtered = http.expectOne((r) => r.url === '/v1/locks');
    expect(filtered.request.params.get('match')).toBe('gpu-*');
    filtered.flush({ locks: [] });
    expect(await some).toEqual([]);

    const released = api.releaseLock('gpu:0', 'team:a');
    const post = http.expectOne('/v1/locks/gpu%3A0/release');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ agent: 'team:a' });
    post.flush({ released: 'held' });
    expect(await released).toEqual({ released: 'held' });
  });

  it('reads the history: a page by agent pattern, kind and before, and the kinds there are', async () => {
    signedIn();
    const all = api.history();
    const plain = http.expectOne((r) => r.url === '/v1/history');
    expect(plain.request.method).toBe('GET');
    expect(plain.request.params.keys()).toEqual([]);
    plain.flush({ history: [{ id: 1, kind: 'server.started', data: {} }] });
    expect((await all).map((e) => e.id)).toEqual([1]);

    const some = api.history({
      match: ' kaggle:* ',
      kind: 'wake.*',
      before: 41,
      limit: 100,
    });
    const filtered = http.expectOne((r) => r.url === '/v1/history');
    expect(filtered.request.params.get('match')).toBe('kaggle:*');
    expect(filtered.request.params.get('kind')).toBe('wake.*');
    expect(filtered.request.params.get('before')).toBe('41');
    expect(filtered.request.params.get('limit')).toBe('100');
    filtered.flush({ history: [] });
    expect(await some).toEqual([]);

    const kinds = api.historyKinds();
    http
      .expectOne('/v1/history/kinds')
      .flush({ kinds: [{ kind: 'wake.fired', count: 3 }] });
    expect(await kinds).toEqual([{ kind: 'wake.fired', count: 3 }]);
  });

  it("asks for a retry of an agent's failed turn now", async () => {
    signedIn();
    const retried = api.retry('kaggle:lead');
    const post = http.expectOne('/v1/agents/kaggle%3Alead/retry');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({});
    post.flush({ agent: { id: 'kaggle:lead', status: 'error' } });
    expect((await retried).status).toBe('error');
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

  it('pauses and resumes an agent, stops all and resumes all', async () => {
    signedIn();
    const paused = api.pause('kaggle:lead');
    const pause = http.expectOne('/v1/agents/kaggle%3Alead/pause');
    expect(pause.request.method).toBe('POST');
    pause.flush({
      agent: { id: 'kaggle:lead', status: 'paused', paused: 'owner' },
    });
    expect((await paused).paused).toBe('owner');

    const resumed = api.resume('kaggle:lead');
    const resume = http.expectOne('/v1/agents/kaggle%3Alead/resume');
    expect(resume.request.method).toBe('POST');
    resume.flush({ agent: { id: 'kaggle:lead', status: 'idle', paused: '' } });
    expect((await resumed).status).toBe('idle');

    const stopped = api.stopAll();
    const stop = http.expectOne('/v1/stop-all');
    expect(stop.request.method).toBe('POST');
    stop.flush({ paused: ['a:b'], interrupted: ['a:b'] });
    expect(await stopped).toEqual({ paused: ['a:b'], interrupted: ['a:b'] });

    const back = api.resumeAll();
    const all = http.expectOne('/v1/resume-all');
    expect(all.request.method).toBe('POST');
    all.flush({ resumed: ['a:b'] });
    expect(await back).toEqual({ resumed: ['a:b'] });
  });

  it('lists, sets, fires and cancels wakes', async () => {
    signedIn();
    const list = api.wakes();
    const get = http.expectOne('/v1/wakes');
    expect(get.request.method).toBe('GET');
    get.flush({ wakes: [{ agent: 'a:b', name: 'standup' }] });
    expect((await list).map((w) => w.name)).toEqual(['standup']);

    const set = api.setWake('kaggle:lead', 'standup', {
      text: 'Report.',
      trigger: 'every 30m',
      check: 'test -f go',
    });
    const put = http.expectOne('/v1/agents/kaggle%3Alead/wakes/standup');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      text: 'Report.',
      trigger: 'every 30m',
      check: 'test -f go',
    });
    put.flush(
      { wake: { agent: 'kaggle:lead', name: 'standup' } },
      { status: 201, statusText: 'Created' },
    );
    expect((await set).name).toBe('standup');

    const fired = api.fireWake('kaggle:lead', 'standup');
    const fire = http.expectOne('/v1/agents/kaggle%3Alead/wakes/standup/fire');
    expect(fire.request.method).toBe('POST');
    expect(fire.request.body).toEqual({});
    fire.flush({ fired: 'standup', agent: 'kaggle:lead' });
    expect(await fired).toEqual({ fired: 'standup', agent: 'kaggle:lead' });

    const cancelled = api.cancelWake('kaggle:lead', 'standup');
    const del = http.expectOne('/v1/agents/kaggle%3Alead/wakes/standup');
    expect(del.request.method).toBe('DELETE');
    del.flush({ cancelled: 'standup' });
    expect(await cancelled).toEqual({ cancelled: 'standup' });
  });

  it('lists messages and sends as the owner, to one ID or a list', async () => {
    signedIn();
    const list = api.messages();
    const get = http.expectOne('/v1/messages');
    expect(get.request.method).toBe('GET');
    get.flush({ messages: [{ id: 'msg_1' }] });
    expect((await list).map((m) => m.id)).toEqual(['msg_1']);

    const sent = api.send({ to: 'team:*', text: 'Status?' });
    const post = http.expectOne('/v1/messages');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ to: 'team:*', text: 'Status?' });
    post.flush(
      {
        send_id: 'snd_1',
        recipients: ['team:a'],
        messages: [{ id: 'msg_2', to: 'team:a' }],
      },
      { status: 201, statusText: 'Created' },
    );
    expect((await sent).recipients).toEqual(['team:a']);

    const listed = api.send({
      to: ['a:b', 'c:d'],
      subject: 'Plan',
      text: 'Go.',
    });
    const many = http.expectOne('/v1/messages');
    expect(many.request.body).toEqual({
      to: ['a:b', 'c:d'],
      subject: 'Plan',
      text: 'Go.',
    });
    many.flush({ send_id: 'snd_2', recipients: ['a:b', 'c:d'], messages: [] });
    expect((await listed).recipients).toEqual(['a:b', 'c:d']);
  });

  it('reads the inbox (closed items too with ?all=1), answers and closes items', async () => {
    signedIn();
    const open = api.inbox();
    const get = http.expectOne((r) => r.url === '/v1/inbox');
    expect(get.request.method).toBe('GET');
    expect(get.request.params.has('all')).toBe(false);
    get.flush({ items: [] });
    expect(await open).toEqual([]);

    const all = api.inbox(true);
    const getAll = http.expectOne((r) => r.url === '/v1/inbox');
    expect(getAll.request.params.get('all')).toBe('1');
    getAll.flush({ items: [{ id: 'ib_1' }] });
    expect((await all).map((i) => i.id)).toEqual(['ib_1']);

    const answered = api.answer('ib_1', 'Yes, go on.');
    const answer = http.expectOne('/v1/inbox/ib_1/answer');
    expect(answer.request.method).toBe('POST');
    expect(answer.request.body).toEqual({ text: 'Yes, go on.' });
    answer.flush({ item: { id: 'ib_1', answer: 'Yes, go on.' } });
    expect((await answered).answer).toBe('Yes, go on.');

    const closed = api.closeItem('ib_2');
    const close = http.expectOne('/v1/inbox/ib_2/close');
    expect(close.request.method).toBe('POST');
    close.flush({ item: { id: 'ib_2', closed_at: '2026-10-28T10:00:00Z' } });
    expect((await closed).closed_at).toBe('2026-10-28T10:00:00Z');
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
