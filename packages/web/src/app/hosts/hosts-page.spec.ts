/*
 * Unit tests of the Hosts page against a mocked server: the hosts table, where
 * long IDs and folders may wrap, a failed load, and the 10 s refresh (one at a
 * time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  apiError,
  el,
  settle,
  setup,
  signedIn,
  text,
} from '../../testing/helpers';
import { REFRESH_MS } from '../agents/agents-page';
import type { Host } from '../api';
import { localTime } from '../format';
import { HostsPage } from './hosts-page';

const HOSTS: Host[] = [
  {
    id: 'myspark3:1',
    machine: 'myspark3',
    directory: '/home/misha/kaggle',
    online: true,
    instance: 'i1',
    opencode_version: '2.2.0',
    plugin_version: '0.1.0-build12',
    process_kind: 'service',
    process_pid: 2164472,
    shell_values: true,
    first_seen: '2026-10-28T09:00:00.000Z',
    last_seen: '2026-10-28T11:31:00.000Z',
  },
  {
    id: 'mymbp4:project:6f3d676f',
    machine: 'mymbp4',
    directory: '/Users/misha/work',
    online: false,
    instance: 'i2',
    opencode_version: '2.2.0',
    plugin_version: '0.1.0',
    process_kind: '',
    process_pid: null,
    shell_values: null,
    first_seen: '2026-10-27T09:00:00.000Z',
    last_seen: '2026-10-27T09:05:00.000Z',
  },
];

describe('HostsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<HostsPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(hosts = HOSTS): void {
    http.expectOne('/v1/hosts').flush({ hosts });
  }

  async function open(): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(HostsPage);
    load();
    await settle(fixture);
    return el(fixture);
  }

  it('lists hosts by machine with folder, status, process, versions and last seen (ISO in the tooltip)', async () => {
    const page = await open();
    expect(page.querySelector('h2')).toBeNull();
    expect(
      [...page.querySelectorAll('table.hosts thead th')].map((th) => text(th)),
    ).toEqual([
      'ID',
      'Folder',
      'Status',
      'Process',
      'OpenCode',
      'Plugin',
      'Last Seen',
    ]);
    expect(text(page.querySelector('p.muted'))).toBe(
      'One per OpenCode server folder that the Autocode plugin connects ' +
        'from. Updated 0s ago.',
    );
    expect(page.querySelector('td.machine')).toBeNull();
    // machines in alphabetical order, each with a header row
    const machines = [
      ...page.querySelectorAll('table.hosts tbody[data-machine]'),
    ];
    expect(machines.map((m) => m.getAttribute('data-machine'))).toEqual([
      'mymbp4',
      'myspark3',
    ]);
    expect(text(machines[0]!.querySelector('tr.group'))).toBe('mymbp4');
    expect(machines[0]!.querySelectorAll('tr[data-host]').length).toBe(1);
    const row = machines[1]!.querySelector('tr[data-host="myspark3:1"]')!;
    expect(text(row.querySelector('td.folder'))).toBe('/home/misha/kaggle');
    expect(text(row.querySelector('td.status'))).toBe('online');
    expect(row.querySelector('.dot')!.classList).toContain('ok');
    expect(text(row.querySelector('td.opencode'))).toBe('v2.2.0');
    expect(text(row.querySelector('td.plugin'))).toBe('v0.1.0-build12');
    // shells that get their values: nothing more to say
    expect(text(row.querySelector('td.process'))).toBe('bg service (2164472)');
    expect(row.querySelector('td.shell')).toBeNull();
    const seen = row.querySelector('td.time')!;
    expect(seen.getAttribute('title')).toBe('2026-10-28T11:31:00.000Z');
    expect(text(seen)).toBe(localTime('2026-10-28T11:31:00.000Z'));
    const off = page.querySelector('tr[data-host="mymbp4:project:6f3d676f"]')!;
    expect(off.querySelector('.dot')!.classList).toContain('off');
    expect(text(off.querySelector('td.status'))).toBe('offline');
    // A plugin from before hosts reported their process and shell values.
    expect(text(off.querySelector('td.process'))).toBe('');
  });

  it('names each kind of OpenCode process', async () => {
    const kinds: [string, string][] = [
      ['service', 'bg service (7)'],
      ['serve', 'opencode serve (7)'],
      ['other', 'other (7)'],
    ];
    signedIn();
    fixture = TestBed.createComponent(HostsPage);
    load(
      kinds.map(([kind], i) => ({
        ...HOSTS[0]!,
        id: `m:${i}`,
        process_kind: kind,
        process_pid: 7,
      })),
    );
    await settle(fixture);
    const shown = [...el(fixture).querySelectorAll('td.process')].map((td) =>
      text(td),
    );
    expect(shown).toEqual(kinds.map(([, label]) => label));
  });

  it('marks a host whose shells get no Autocode values in its Process cell, and says why', async () => {
    signedIn();
    fixture = TestBed.createComponent(HostsPage);
    load([
      { ...HOSTS[0]!, id: 'm:1', process_kind: 'serve', shell_values: false },
      { ...HOSTS[0]!, id: 'm:2', process_kind: '', shell_values: false },
      { ...HOSTS[0]!, id: 'm:3', shell_values: true },
      { ...HOSTS[0]!, id: 'm:4', shell_values: null },
    ]);
    await settle(fixture);
    const cell = (id: string) =>
      el(fixture).querySelector(`tr[data-host="${id}"] td.process`)!;
    const mark = cell('m:1').querySelector('.no-shell')!;
    expect(text(mark)).toBe('no shell values');
    expect(mark.getAttribute('title')).toBe(
      "The plugin cannot reach this OpenCode server's local API, so its " +
        'shells get no Autocode values.',
    );
    expect(text(cell('m:1'))).toBe('opencode serve (2164472) no shell values');
    expect(text(cell('m:2'))).toBe('no shell values');
    expect(cell('m:3').querySelector('.no-shell')).toBeNull();
    expect(cell('m:4').querySelector('.no-shell')).toBeNull();
    expect(el(fixture).querySelector('th.shell, td.shell')).toBeNull();
  });

  it('lets IDs and folders wrap after ":" and "/" (the text stays the same)', async () => {
    const page = await open();
    const row = page.querySelector('tr[data-host="mymbp4:project:6f3d676f"]')!;
    expect(row.querySelector('td.id code')!.innerHTML).toBe(
      'mymbp4:<wbr>project:<wbr>6f3d676f',
    );
    expect(row.querySelector('td.folder code')!.innerHTML).toBe(
      '/<wbr>Users/<wbr>misha/<wbr>work',
    );
  });

  it('shows why the hosts did not load', async () => {
    signedIn();
    fixture = TestBed.createComponent(HostsPage);
    apiError(http.expectOne('/v1/hosts'), 500, 'internal', 'database locked');
    await settle(fixture);
    expect(text(el(fixture).querySelector('.errmsg'))).toBe('database locked');
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(HostsPage);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone('/v1/hosts');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne('/v1/hosts');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone('/v1/hosts');
      req.flush({ hosts: HOSTS });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
