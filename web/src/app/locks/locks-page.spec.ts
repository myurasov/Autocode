/*
 * Unit tests of the Locks page against a mocked server: each lock with its
 * type (a mutex, or N places), its holders (links to the Agents page, until
 * when and how long that is from now, each with Release) and its queue in
 * order (each with Remove); the Lock filter, in the address; a bad
 * pattern's error; Release and Remove after a confirmation, their calls and
 * results, and the reload; the empty page; "Updated" in the footer; and the
 * 10 s refresh (one at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  apiError,
  button,
  el,
  parts,
  press,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import { FILTER_DELAY_MS, REFRESH_MS } from '../agents/agents-page';
import type { Lock } from '../api';
import { localTime } from '../format';
import { capacityText, leftText, LocksPage } from './locks-page';

// The locks as the server has them now: a mutex with a holder and two in its
// queue, and a semaphore of 2 places, both taken.
function locks(): Lock[] {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  return [
    {
      name: 'gpu-0',
      max: 1,
      created_at: at(-600_000),
      holders: [
        {
          agent: 'team:a',
          since: at(-60_000),
          expires: at(570_000),
          ttl: '10m',
        },
      ],
      queue: [
        { agent: 'team:b', position: 1, since: at(-30_000), ttl: '1h' },
        { agent: 'team:c', position: 2, since: at(-10_000), ttl: '1h' },
      ],
    },
    {
      name: 'gpu-pool',
      max: 2,
      created_at: at(-900_000),
      holders: [
        {
          agent: 'team:a',
          since: at(-300_000),
          expires: at(3_900_000),
          ttl: '2h',
        },
        {
          agent: 'team:c',
          since: at(-200_000),
          expires: at(90_000_000),
          ttl: '1d',
        },
      ],
      queue: [],
    },
  ];
}

describe('LocksPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<LocksPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(list: Lock[] = locks(), match?: string): void {
    const req = http.expectOne((r) => r.url === '/v1/locks');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('match')).toBe(match ?? null);
    req.flush({ locks: list });
  }

  async function open(list = locks()): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(LocksPage);
    await settle(fixture);
    load(list);
    await settle(fixture);
    return el(fixture);
  }

  const row = (page: HTMLElement, name: string) =>
    page.querySelector(`table.locks tr[data-lock="${name}"]`)!;
  const names = (page: HTMLElement) =>
    [...page.querySelectorAll('table.locks tr[data-lock]')].map((r) =>
      r.getAttribute('data-lock'),
    );

  it('lists each lock with its type, its holders until when, and its queue', async () => {
    const list = locks();
    const page = await open(list);
    expect(page.querySelector('h2')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.locks thead th')].map((th) => text(th)),
    ).toEqual(['Lock', 'Type', 'Holders', 'Queue']);
    expect(names(page)).toEqual(['gpu-0', 'gpu-pool']);

    const mutex = row(page, 'gpu-0');
    const name = mutex.querySelector('td.name')!;
    expect(name.classList).toContain('id-like');
    expect(parts(name.querySelector('code'))).toEqual(['gpu-0']);
    expect(text(mutex.querySelector('td.capacity'))).toBe('Mutex');
    const [held] = list[0]!.holders;
    const holders = [...mutex.querySelectorAll('td.holders .holder')];
    expect(holders.map((h) => h.getAttribute('data-agent'))).toEqual([
      'team:a',
    ]);
    const link = holders[0]!.querySelector('a.id-link')!;
    expect(link.getAttribute('href')).toBe('/agents?agent=team:a');
    expect(link.closest('app-agent-link')!.classList).toContain('id-like');
    const until = holders[0]!.querySelector('.until')!;
    expect(text(until)).toBe(`until ${localTime(held!.expires)} (in 9m)`);
    expect(until.getAttribute('title')).toBe(held!.expires);
    expect(button(holders[0]!, 'Release')).toBeDefined();
    expect(button(holders[0]!, 'Remove')).toBeUndefined();
    // The queue, in order: its place, the agent, since when, Remove.
    const queued = [...mutex.querySelectorAll('td.queue .waiter')];
    const queue = list[0]!.queue;
    expect(queued.map((w) => text(w))).toEqual([
      `1. team:b (since ${localTime(queue[0]!.since)}) Remove`,
      `2. team:c (since ${localTime(queue[1]!.since)}) Remove`,
    ]);
    for (const waiter of queued)
      expect(
        button(waiter, 'Remove')!.getAttribute('type'),
        waiter.getAttribute('data-agent')!,
      ).toBe('button');
    expect(queued[0]!.querySelector('.since')!.getAttribute('title')).toBe(
      queue[0]!.since,
    );
    expect(queued[1]!.querySelector('a.id-link')!.getAttribute('href')).toBe(
      '/agents?agent=team:c',
    );
    expect(button(mutex.querySelector('td.queue')!, 'Release')).toBeUndefined();

    const pool = row(page, 'gpu-pool');
    expect(text(pool.querySelector('td.capacity'))).toBe('2 places');
    expect(
      [...pool.querySelectorAll('td.holders .until')].map((u) => text(u)),
    ).toEqual(
      list[1]!.holders.map(
        (h, i) => `until ${localTime(h.expires)} (in ${['1h 5m', '1d 1h'][i]})`,
      ),
    );
    expect(pool.querySelectorAll('td.holders button').length).toBe(2);
    expect(text(pool.querySelector('td.queue'))).toBe('—');
  });

  it("says a lock's type by its capacity: a mutex, or so many places", () => {
    expect(capacityText(1)).toBe('Mutex');
    expect(capacityText(2)).toBe('2 places');
    expect(capacityText(1000)).toBe('1000 places');
  });

  it('says how long a hold has left: seconds, minutes, hours, days, or now', () => {
    expect(leftText(40_000)).toBe('in 40s');
    expect(leftText(39_200)).toBe('in 40s');
    expect(leftText(60_000)).toBe('in 1m');
    expect(leftText(570_000)).toBe('in 9m');
    expect(leftText(3_600_000)).toBe('in 1h');
    expect(leftText(3_900_000)).toBe('in 1h 5m');
    expect(leftText(86_400_000)).toBe('in 1d');
    expect(leftText(90_000_000)).toBe('in 1d 1h');
    expect(leftText(0)).toBe('now');
    expect(leftText(-5_000)).toBe('now');
  });

  it('filters by a lock pattern; the filter goes into the address, and the address sets it', async () => {
    const page = await open();
    const router = TestBed.inject(Router);
    const input = page.querySelector('#lock-match') as HTMLInputElement;
    expect(text(page.querySelector('label[for="lock-match"]'))).toBe('Lock');
    type(input, 'gpu-p*');
    press(input, 'Enter');
    await settle(fixture);
    expect(router.url).toBe('/?match=gpu-p*');
    load([locks()[1]!], 'gpu-p*');
    await settle(fixture);
    expect(names(page)).toEqual(['gpu-pool']);

    // A link or Back: the field follows the address.
    await router.navigateByUrl('/?match=gpu-0');
    await settle(fixture);
    load([locks()[0]!], 'gpu-0');
    await settle(fixture);
    expect(input.value).toBe('gpu-0');
    expect(names(page)).toEqual(['gpu-0']);
    await router.navigateByUrl('/');
    await settle(fixture);
    load();
    await settle(fixture);
    expect(input.value).toBe('');
    expect(names(page)).toEqual(['gpu-0', 'gpu-pool']);
  });

  it('applies the typed pattern a second after the last key', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(LocksPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const input = el(fixture).querySelector('#lock-match');
      type(input, 'gp');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 400);
      type(input, 'gpu-*');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 1);
      http.expectNone((r) => r.url === '/v1/locks');
      await vi.advanceTimersByTimeAsync(1);
      load(locks(), 'gpu-*');
      await vi.advanceTimersByTimeAsync(0);
      expect(TestBed.inject(Router).url).toBe('/?match=gpu-*');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it("shows a bad pattern's error in the toolbar", async () => {
    const page = await open();
    const input = page.querySelector('#lock-match');
    type(input, 'a b');
    press(input, 'Enter');
    await settle(fixture);
    apiError(
      http.expectOne((r) => r.url === '/v1/locks'),
      400,
      'bad_pattern',
      'a pattern is one or more IDs with * wildcards',
    );
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .result .errmsg'))).toBe(
      'a pattern is one or more IDs with * wildcards',
    );
  });

  it("admin releases an agent's hold after a confirmation; the result shows in the toolbar and the list reloads", async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const holder = row(page, 'gpu-0').querySelector('.holder')!;
      button(holder, 'Release')!.click();
      expect(confirm).toHaveBeenCalledWith(
        "Release team:a's hold on gpu-0?\n\n" +
          'The agent is told and the next in the queue gets it.',
      );
      http.expectNone((r) => r.url.endsWith('/release'));

      confirm.mockReturnValue(true);
      button(holder, 'Release')!.click();
      const req = http.expectOne('/v1/locks/gpu-0/release');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ agent: 'team:a' });
      req.flush({ released: 'held' });
      await settle(fixture);
      // The queue moved up: team:b holds it now.
      const after = locks();
      after[0]!.holders = [{ ...after[0]!.holders[0]!, agent: 'team:b' }];
      after[0]!.queue = [{ ...after[0]!.queue[1]!, position: 1 }];
      load(after);
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .notice'))).toBe(
        "Released team:a's hold on gpu-0.",
      );
      expect(
        row(page, 'gpu-0').querySelector('.holder')!.getAttribute('data-agent'),
      ).toBe('team:b');
      expect(
        [...row(page, 'gpu-0').querySelectorAll('td.queue .waiter')].map((w) =>
          text(w).slice(0, 10),
        ),
      ).toEqual(['1. team:c ']);

      // The agent had left the hold for the queue meanwhile.
      button(
        row(page, 'gpu-pool').querySelector('.holder')!,
        'Release',
      )!.click();
      http
        .expectOne('/v1/locks/gpu-pool/release')
        .flush({ released: 'queued' });
      await settle(fixture);
      load();
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .notice'))).toBe(
        'Took team:a out of the queue of gpu-pool.',
      );
    } finally {
      confirm.mockRestore();
    }
  });

  it('admin takes an agent out of the queue after a confirmation; the result shows in the toolbar and the list reloads', async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const waiter = (lock: string, agent: string) =>
      row(page, lock).querySelector(`td.queue .waiter[data-agent="${agent}"]`)!;
    try {
      button(waiter('gpu-0', 'team:b'), 'Remove')!.click();
      expect(confirm).toHaveBeenCalledWith(
        'Take team:b out of the queue of gpu-0?\n\n' +
          'The agent is told; the others move up.',
      );
      http.expectNone((r) => r.url.endsWith('/release'));
      http.expectNone((r) => r.url === '/v1/locks');

      confirm.mockReturnValue(true);
      button(waiter('gpu-0', 'team:b'), 'Remove')!.click();
      const req = http.expectOne('/v1/locks/gpu-0/release');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ agent: 'team:b' });
      req.flush({ released: 'queued' });
      await settle(fixture);
      // The others moved up: team:c is next now.
      const after = locks();
      after[0]!.queue = [{ ...after[0]!.queue[1]!, position: 1 }];
      load(after);
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .notice'))).toBe(
        'Took team:b out of the queue of gpu-0.',
      );
      expect(
        [...row(page, 'gpu-0').querySelectorAll('td.queue .waiter')].map((w) =>
          text(w).slice(0, 10),
        ),
      ).toEqual(['1. team:c ']);
      expect(
        row(page, 'gpu-0').querySelector('.holder')!.getAttribute('data-agent'),
      ).toBe('team:a');

      // Its turn came meanwhile: the server freed its hold, and says so.
      button(waiter('gpu-0', 'team:c'), 'Remove')!.click();
      http.expectOne('/v1/locks/gpu-0/release').flush({ released: 'held' });
      await settle(fixture);
      load();
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .notice'))).toBe(
        "Released team:c's hold on gpu-0.",
      );
    } finally {
      confirm.mockRestore();
    }
  });

  it("shows the server's message when a Remove is refused, and reloads", async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      button(
        row(page, 'gpu-0').querySelector('td.queue .waiter')!,
        'Remove',
      )!.click();
      apiError(
        http.expectOne('/v1/locks/gpu-0/release'),
        404,
        'not_held',
        'team:b does not hold lock gpu-0 and is not in its queue',
      );
      await settle(fixture);
      load();
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
        'team:b does not hold lock gpu-0 and is not in its queue',
      );
      expect(page.querySelector('.toolbar .notice')).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it("shows the server's message when a release is refused, and reloads", async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      button(row(page, 'gpu-0').querySelector('.holder')!, 'Release')!.click();
      apiError(
        http.expectOne('/v1/locks/gpu-0/release'),
        404,
        'not_held',
        'team:a does not hold lock gpu-0 and is not in its queue',
      );
      await settle(fixture);
      load([locks()[1]!]);
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
        'team:a does not hold lock gpu-0 and is not in its queue',
      );
      expect(page.querySelector('.toolbar .notice')).toBeNull();
      expect(names(page)).toEqual(['gpu-pool']);
    } finally {
      confirm.mockRestore();
    }
  });

  it('says when there are no locks, and when none matches the filter', async () => {
    const page = await open([]);
    const empty = page.querySelector('table.locks tbody td')!;
    expect(empty.getAttribute('colspan')).toBe('4');
    expect(text(empty)).toBe(
      'No locks. Agents create one with autocode_lock action=acquire; ' +
        'it is gone when nobody holds it or waits.',
    );
    expect(text(empty.querySelector('code'))).toBe(
      'autocode_lock action=acquire',
    );
    await TestBed.inject(Router).navigateByUrl('/?match=disk-*');
    await settle(fixture);
    load([], 'disk-*');
    await settle(fixture);
    expect(text(page.querySelector('table.locks tbody td'))).toBe(
      'No lock matches disk-*.',
    );
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(LocksPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone((r) => r.url === '/v1/locks');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne((r) => r.url === '/v1/locks');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone((r) => r.url === '/v1/locks');
      req.flush({ locks: locks() });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
