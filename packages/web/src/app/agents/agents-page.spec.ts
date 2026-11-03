/*
 * Unit tests of the Agents page against a mocked server: the agents by machine,
 * where long values may wrap, the filter and a bad pattern, the 10 s refresh
 * (one at a time), editing a description, New token and Unregister, each after
 * a confirmation, each status's dot, Pause and Resume, and Stop All (after a
 * confirmation) and Resume All, with each action's result in the toolbar and
 * "Updated" in the footer.
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  apiError,
  button,
  el,
  press,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import type { Agent } from '../api';
import { localTime } from '../format';
import { AgentsPage, FILTER_DELAY_MS, REFRESH_MS } from './agents-page';

const AGENTS: Agent[] = [
  {
    id: 'kaggle:lead',
    description: 'leads the team',
    status: 'idle',
    session: 'ses_lead',
    host: 'myspark3:1',
    machine: 'myspark3',
    directory: '/home/misha/kaggle',
    registered_at: '2026-10-28T10:00:00.000Z',
    last_active: '2026-10-28T11:30:00.000Z',
  },
  {
    id: 'kaggle:worker',
    description: '',
    status: 'offline',
    session: 'ses_worker',
    host: 'mymbp4:1',
    machine: 'mymbp4',
    directory: '/Users/misha/work',
    registered_at: '2026-10-27T09:00:00.000Z',
    last_active: '2026-10-27T09:05:00.000Z',
  },
];

describe('AgentsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<AgentsPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(agents = AGENTS, match?: string): void {
    const req = http.expectOne((r) => r.url === '/v1/agents');
    expect(req.request.params.get('match')).toBe(match ?? null);
    req.flush({ agents });
  }

  async function open(): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(AgentsPage);
    load();
    await settle(fixture);
    return el(fixture);
  }

  it('lists agents by machine with status, folder, session and local times (ISO in the tooltip)', async () => {
    const page = await open();
    expect(page.querySelector('h2')).toBeNull();
    expect(page.querySelector('td.machine')).toBeNull();
    // When the list last loaded: in the footer, the page's last item.
    expect(page.querySelector('.toolbar app-updated')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(text(page)).not.toContain('refreshes every');
    const machines = [
      ...page.querySelectorAll('table.agents tbody[data-machine]'),
    ];
    expect(machines.map((m) => m.getAttribute('data-machine'))).toEqual([
      'mymbp4',
      'myspark3',
    ]);
    expect(text(machines[0]!.querySelector('tr.group'))).toBe('mymbp4');
    expect(machines[0]!.querySelectorAll('tr[data-agent]').length).toBe(1);
    const lead = machines[1]!.querySelector('tr[data-agent="kaggle:lead"]')!;
    expect(text(lead.querySelector('td.id'))).toBe('kaggle:lead');
    expect(text(lead.querySelector('td.desc'))).toBe('leads the team');
    expect(text(lead.querySelector('td.status'))).toBe('idle');
    expect(lead.querySelector('.dot')!.classList).toContain('ok');
    expect(text(lead.querySelector('td.folder'))).toBe('/home/misha/kaggle');
    expect(text(lead.querySelector('td.session'))).toBe('ses_lead');
    const [registered, active] = [...lead.querySelectorAll('td.time')];
    expect(text(registered)).toBe(localTime('2026-10-28T10:00:00.000Z'));
    expect(active!.getAttribute('title')).toBe('2026-10-28T11:30:00.000Z');
    expect(text(active)).toBe(localTime('2026-10-28T11:30:00.000Z'));
    const worker = page.querySelector('tr[data-agent="kaggle:worker"]')!;
    expect(worker.querySelector('.dot')!.classList).toContain('off');
  });

  it('lets IDs, folders and sessions wrap after ":", "/" and "_" (the text stays the same)', async () => {
    const page = await open();
    const lead = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    const code = (cell: string) => lead.querySelector(`td.${cell} code`)!;
    expect(code('id').innerHTML).toBe('kaggle:<wbr>lead');
    expect(code('folder').innerHTML).toBe('/<wbr>home/<wbr>misha/<wbr>kaggle');
    expect(code('session').innerHTML).toBe('ses_<wbr>lead');
    expect(code('folder').textContent).toBe('/home/misha/kaggle');
    // A time wraps only between its date and its clock, which keeps its zone.
    const time = lead.querySelector('td.time')!;
    const [date, clock, zone] = localTime('2026-10-28T10:00:00.000Z').split(
      ' ',
    );
    expect(zone).toBeTruthy();
    expect(
      [...time.querySelectorAll('span')].map((s) => s.textContent),
    ).toEqual([date, `${clock} ${zone}`]);
  });

  it('filters by pattern on Enter and on Refresh, and shows a bad pattern error', async () => {
    const page = await open();
    const input = page.querySelector('#match');
    type(input, 'kaggle:lead,x:*');
    press(input, 'Enter');
    load([AGENTS[0]!], 'kaggle:lead,x:*');
    await settle(fixture);
    expect(
      page.querySelectorAll('table.agents tbody tr[data-agent]').length,
    ).toBe(1);

    type(input, 'a b');
    button(page, 'Refresh')!.click();
    const req = http.expectOne((r) => r.url === '/v1/agents');
    expect(req.request.params.get('match')).toBe('a b');
    apiError(
      req,
      400,
      'bad_pattern',
      'a pattern is one or more IDs with * wildcards',
    );
    await settle(fixture);
    expect(text(page.querySelector('.errmsg'))).toContain(
      'a pattern is one or more IDs',
    );

    type(input, 'nobody:*');
    press(input, 'Enter');
    load([], 'nobody:*');
    await settle(fixture);
    expect(text(page.querySelector('table.agents tbody'))).toBe(
      'No agent matches nobody:*.',
    );
  });

  it('applies the filter as the owner types, a second after the last key', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(AgentsPage);
      load();
      await vi.advanceTimersByTimeAsync(0);
      const input = el(fixture).querySelector('#match');
      type(input, 'kag');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 400);
      type(input, 'kaggle:*');
      await vi.advanceTimersByTimeAsync(FILTER_DELAY_MS - 1);
      http.expectNone((r) => r.url === '/v1/agents');
      await vi.advanceTimersByTimeAsync(1);
      load([AGENTS[0]!], 'kaggle:*');
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(button(el(fixture), 'Show All')!.classList).not.toContain('small');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(AgentsPage);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone((r) => r.url === '/v1/agents');
      await vi.advanceTimersByTimeAsync(1);
      const agents = http.expectOne((r) => r.url === '/v1/agents');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone((r) => r.url === '/v1/agents');
      agents.flush({ agents: AGENTS });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('admin edits a description', async () => {
    const page = await open();
    const lead = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    button(lead, 'Edit')!.click();
    await settle(fixture);
    type(
      lead.querySelector('input[aria-label="Description"]'),
      'runs the show',
    );
    button(lead, 'Save')!.click();
    const req = http.expectOne('/v1/agents/kaggle%3Alead');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ description: 'runs the show' });
    req.flush({ agent: { ...AGENTS[0], description: 'runs the show' } });
    await settle(fixture);
    expect(
      text(page.querySelector('tr[data-agent="kaggle:lead"] td.desc')),
    ).toBe('runs the show');
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'Saved the description of kaggle:lead.',
    );
  });

  it('admin rotates a token and unregisters, each after a confirmation', async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const lead = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    button(lead, 'New Token')!.click();
    button(lead, 'Unregister')!.click();
    expect(confirm).toHaveBeenCalledTimes(2);
    http.expectNone('/v1/agents/kaggle%3Alead/token/rotate');
    http.expectNone('/v1/agents/kaggle%3Alead');

    confirm.mockReturnValue(true);
    button(lead, 'New Token')!.click();
    const rotate = http.expectOne('/v1/agents/kaggle%3Alead/token/rotate');
    expect(rotate.request.method).toBe('POST');
    rotate.flush({ rotated: true, agent: 'kaggle:lead', session: 'ses_lead' });
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'kaggle:lead has a new token.',
    );

    button(lead, 'Unregister')!.click();
    const del = http.expectOne('/v1/agents/kaggle%3Alead');
    expect(del.request.method).toBe('DELETE');
    del.flush({ unregistered: 'kaggle:lead' });
    await settle(fixture);
    expect(page.querySelector('tr[data-agent="kaggle:lead"]')).toBeNull();
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'Unregistered kaggle:lead.',
    );
    confirm.mockRestore();
  });

  it('shows each status with its dot: idle and working green, paused amber, offline red', async () => {
    signedIn();
    fixture = TestBed.createComponent(AgentsPage);
    const statuses = ['idle', 'working', 'paused', 'offline'];
    load(
      statuses.map((status) => ({
        ...AGENTS[0]!,
        id: `s:${status}`,
        status,
        paused: status === 'paused' ? 'owner' : '',
      })),
    );
    await settle(fixture);
    const row = (status: string) =>
      el(fixture).querySelector(`tr[data-agent="s:${status}"]`)!;
    const dots = statuses.map((s) => [
      ...row(s).querySelector('td.status .dot')!.classList,
    ]);
    expect(dots).toEqual([
      ['dot', 'ok'],
      ['dot', 'ok'],
      ['dot', 'warn'],
      ['dot', 'off'],
    ]);
    expect(
      statuses.map((s) => text(row(s).querySelector('td.status'))),
    ).toEqual(statuses);
    expect(
      row('paused').querySelector('td.status')!.getAttribute('title'),
    ).toBe('Paused by the owner');
    expect(row('idle').querySelector('td.status')!.getAttribute('title')).toBe(
      null,
    );
  });

  it('admin pauses and resumes an agent, and the list refreshes after each', async () => {
    const page = await open();
    const lead = () => page.querySelector('tr[data-agent="kaggle:lead"]')!;
    expect(button(lead(), 'Resume')).toBeUndefined();
    button(lead(), 'Pause')!.click();
    const pause = http.expectOne('/v1/agents/kaggle%3Alead/pause');
    expect(pause.request.method).toBe('POST');
    const paused = { ...AGENTS[0]!, status: 'paused', paused: 'owner' };
    pause.flush({ agent: paused });
    await settle(fixture);
    load([paused, AGENTS[1]!]);
    await settle(fixture);
    expect(text(lead().querySelector('td.status'))).toBe('paused');
    expect(button(lead(), 'Pause')).toBeUndefined();
    // The result shows in the toolbar, right after its buttons, not on a line
    // of its own.
    const toolbar = page.querySelector('.toolbar')!;
    const notice = toolbar.querySelector('.notice')!;
    expect(text(notice)).toBe('Paused kaggle:lead.');
    expect(
      button(toolbar, 'Resume All')!.nextElementSibling!.contains(notice),
    ).toBe(true);
    expect(page.querySelector('p.notice')).toBeNull();

    button(lead(), 'Resume')!.click();
    const resume = http.expectOne('/v1/agents/kaggle%3Alead/resume');
    expect(resume.request.method).toBe('POST');
    resume.flush({ agent: AGENTS[0] });
    await settle(fixture);
    load();
    await settle(fixture);
    expect(text(lead().querySelector('td.status'))).toBe('idle');
    expect(button(lead(), 'Pause')).toBeDefined();
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'Resumed kaggle:lead.',
    );
  });

  it('an offline agent that is paused offers Resume', async () => {
    signedIn();
    fixture = TestBed.createComponent(AgentsPage);
    load([{ ...AGENTS[1]!, paused: 'stop-all' }]);
    await settle(fixture);
    const row = el(fixture).querySelector('tr[data-agent="kaggle:worker"]')!;
    expect(text(row.querySelector('td.status'))).toBe('offline');
    expect(row.querySelector('td.status')!.getAttribute('title')).toBe(
      'Paused by Stop All',
    );
    expect(button(row, 'Resume')).toBeDefined();
    expect(button(row, 'Pause')).toBeUndefined();
  });

  it('admin stops all after a confirmation and resumes all, and the list refreshes after each', async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    button(page.querySelector('.toolbar')!, 'Stop All')!.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain('interrupt');
    http.expectNone('/v1/stop-all');

    confirm.mockReturnValue(true);
    button(page, 'Stop All')!.click();
    const stop = http.expectOne('/v1/stop-all');
    expect(stop.request.method).toBe('POST');
    stop.flush({
      paused: ['kaggle:lead', 'kaggle:worker'],
      interrupted: ['kaggle:lead'],
    });
    await settle(fixture);
    load(
      AGENTS.map((a) => ({
        ...a,
        status: a.status === 'offline' ? 'offline' : 'paused',
        paused: 'stop-all',
      })),
    );
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'Stop All paused 2 agents and interrupted 1 session.',
    );
    const lead = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    expect(lead.querySelector('td.status')!.getAttribute('title')).toBe(
      'Paused by Stop All',
    );

    button(page.querySelector('.toolbar')!, 'Resume All')!.click();
    expect(confirm).toHaveBeenCalledTimes(2);
    const resume = http.expectOne('/v1/resume-all');
    expect(resume.request.method).toBe('POST');
    resume.flush({ resumed: ['kaggle:lead', 'kaggle:worker'] });
    await settle(fixture);
    load();
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'Resumed 2 agents.',
    );

    button(page, 'Resume All')!.click();
    http.expectOne('/v1/resume-all').flush({ resumed: [] });
    await settle(fixture);
    load();
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'No agent was paused by Stop All.',
    );
    confirm.mockRestore();
  });

  it('shows why a pause failed', async () => {
    const page = await open();
    button(
      page.querySelector('tr[data-agent="kaggle:lead"]')!,
      'Pause',
    )!.click();
    apiError(
      http.expectOne('/v1/agents/kaggle%3Alead/pause'),
      404,
      'not_registered',
      'no agent kaggle:lead',
    );
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
      'no agent kaggle:lead',
    );
    expect(page.querySelector('p.errmsg')).toBeNull();
    http.expectNone((r) => r.url === '/v1/agents');
  });
});
