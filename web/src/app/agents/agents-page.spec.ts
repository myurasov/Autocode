/*
 * Unit tests of the Agents page against a mocked server: the agents by machine,
 * IDs on one line and folders that wrap, the filter and a bad pattern, the
 * 10 s refresh (one at a time), editing a description, New token and
 * Unregister, each after a confirmation, each status's dot, Pause and Resume,
 * and Stop All (after a confirmation) and Resume All, with each action's
 * result in the toolbar and "Updated" in the footer; each agent's host, a link
 * to the Hosts page; the agent a link led to (?agent=): highlighted,
 * scrolled into view once, kept across the refresh, a filter that would hide
 * it cleared, or a line that says it is not there; and an agent in the error
 * state: its status, what is going on with its retries, and Retry.
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
import type { Agent, AgentError, CostNumbers } from '../api';
import { contextBar, contextShort, localTime, tokensShort } from '../format';
import {
  AgentsPage,
  FILTER_DELAY_MS,
  pausedText,
  REFRESH_MS,
  retryState,
} from './agents-page';

const AGENTS: Agent[] = [
  {
    id: 'kaggle:lead',
    description: 'leads the team',
    status: 'idle',
    session: 'ses_lead',
    host: 'machine-a:1',
    machine: 'machine-a',
    directory: '/home/someone/kaggle',
    registered_at: '2026-10-28T10:00:00.000Z',
    last_active: '2026-10-28T11:30:00.000Z',
    model: 'prov/claude-opus-5-5',
    cost: {
      today_usd: 1.5,
      total_usd: 12.3456,
      daily_usd: 2,
      left_usd: 0.5,
      context: 80_000,
      context_limit: 200_000,
      compact_at: 100_000,
      context_share: 80,
    },
  },
  {
    id: 'kaggle:worker',
    description: '',
    status: 'offline',
    session: 'ses_worker',
    host: 'laptop:1',
    machine: 'laptop',
    directory: '/Users/someone/work',
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

  function load(agents = AGENTS, match?: string, unregistered = false): void {
    const req = http.expectOne((r) => r.url === '/v1/agents');
    expect(req.request.params.get('match')).toBe(match ?? null);
    expect(req.request.params.get('unregistered')).toBe(
      unregistered ? '1' : null,
    );
    req.flush({ agents });
  }

  async function open(agents = AGENTS): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(AgentsPage);
    load(agents);
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
      'laptop',
      'machine-a',
    ]);
    expect(text(machines[0]!.querySelector('tr.group'))).toBe('laptop');
    expect(machines[0]!.querySelectorAll('tr[data-agent]').length).toBe(1);
    const lead = machines[1]!.querySelector('tr[data-agent="kaggle:lead"]')!;
    expect(text(lead.querySelector('td.id'))).toBe('kaggle:lead');
    expect(text(lead.querySelector('td.desc'))).toBe('leads the team');
    expect(text(lead.querySelector('td.status'))).toBe('idle');
    expect(lead.querySelector('.dot')!.classList).toContain('ok');
    expect(text(lead.querySelector('td.folder'))).toBe('/home/someone/kaggle');
    expect(text(lead.querySelector('td.session'))).toBe('ses_lead');
    const [registered, active] = [...lead.querySelectorAll('td.time')];
    expect(text(registered)).toBe(localTime('2026-10-28T10:00:00.000Z'));
    expect(active!.getAttribute('title')).toBe('2026-10-28T11:30:00.000Z');
    expect(text(active)).toBe(localTime('2026-10-28T11:30:00.000Z'));
    const worker = page.querySelector('tr[data-agent="kaggle:worker"]')!;
    expect(worker.querySelector('.dot')!.classList).toContain('off');
  });

  // The owner, 2026-11-08: Spend ("$1.50 today / $12.35 total") and Context
  // (its share of the compaction threshold) apart, both linking to the Costs
  // page; the agent's model.
  it("shows each agent's model, spend today and in total, and its context's share of the threshold", async () => {
    const page = await open();
    const row = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    // the model's name; the whole ID (its provider's path too) in the tooltip
    const model = row.querySelector('td.model')!;
    expect(text(model)).toBe('claude-opus-5-5');
    expect(model.getAttribute('title')).toBe('prov/claude-opus-5-5');
    // a click on Spend opens the Costs tab with this agent's row highlighted
    const spend = row.querySelector('td.spend')!;
    expect(text(spend)).toBe('$1.50 today / $12.35 total');
    expect(spend.querySelector('a')!.getAttribute('href')).toBe(
      '/costs?agent=kaggle:lead',
    );
    // the context, the threshold and the model's window, in K and M (the
    // owner, 2026-11-08)
    const context = row.querySelector('td.context')!;
    expect(text(context)).toBe('80K/100K/200K');
    expect(context.getAttribute('title')).toBe(
      '80,000 tokens now; compacted past 100,000 (compact_at); the ' +
        "model's window 200,000",
    );
    // under the numbers a bar of the threshold's share (the owner,
    // 2026-11-09), amber from 75%, as the Costs tab's Daily Cap
    expect(context.firstElementChild!.className).toBe('numbers');
    const bar = context.querySelector('.numbers + .bar') as HTMLElement;
    expect(bar.classList).toContain('near');
    expect(bar.classList).not.toContain('over');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('80%');
    // an agent with no cost or model yet: no bar
    const worker = page.querySelector('tr[data-agent="kaggle:worker"]')!;
    expect(text(worker.querySelector('td.spend'))).toBe('—');
    expect(text(worker.querySelector('td.context'))).toBe('—');
    expect(worker.querySelector('td.context .bar')).toBeNull();
    expect(text(worker.querySelector('td.model'))).toBe('—');
  });

  // The owner, 2026-11-09: "add bar under the context numbers on agents tab".
  it("the context's bar: its share of the threshold (amber from 75%, red from 100%, full at most); else of the window", () => {
    const k = (over: Partial<CostNumbers>): CostNumbers => ({
      today_usd: 0,
      total_usd: 0,
      daily_usd: 'off',
      left_usd: null,
      context: 50_000,
      context_limit: 200_000,
      compact_at: 100_000,
      context_share: 50,
      ...over,
    });
    expect(contextBar(k({}))).toEqual({ width: 50, near: false, over: false });
    expect(contextBar(k({ context: 75_000, context_share: 75 }))).toEqual({
      width: 75,
      near: true,
      over: false,
    });
    // past the threshold: a full bar, red
    expect(contextBar(k({ context: 109_900, context_share: 109.9 }))).toEqual({
      width: 100,
      near: true,
      over: true,
    });
    // no threshold (compact_at off): the window's share, never amber or red
    expect(
      contextBar(
        k({ context: 180_000, compact_at: null, context_share: null }),
      ),
    ).toEqual({ width: 90, near: false, over: false });
    // neither: no bar; nor before the first step
    expect(
      contextBar(
        k({ compact_at: null, context_share: null, context_limit: null }),
      ),
    ).toBeNull();
    expect(contextBar(k({ context: null, context_share: null }))).toBeNull();
  });

  // The owner, 2026-11-09: a group's heading folds and opens it, kept per
  // group; at most 25 rows a group, then "...".
  it('a click on a machine folds and opens its group, kept for the next visit', async () => {
    let page = await open();
    const heading = () =>
      page.querySelector(
        'tbody[data-machine="machine-a"] tr.group th',
      ) as HTMLElement;
    const rowsOf = () =>
      page.querySelectorAll('tbody[data-machine="machine-a"] tr[data-agent]')
        .length;
    expect(rowsOf()).toBe(1);
    heading().click();
    await settle(fixture);
    expect(rowsOf()).toBe(0);
    expect(heading().getAttribute('aria-expanded')).toBe('false');
    // the other group stays open
    expect(
      page.querySelectorAll('tbody[data-machine="laptop"] tr[data-agent]')
        .length,
    ).toBe(1);
    fixture.destroy();
    page = await open();
    expect(rowsOf()).toBe(0);
    heading().click();
    await settle(fixture);
    expect(rowsOf()).toBe(1);
  });

  it('shows at most 25 agents a machine, then a "..." row for 25 more', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...AGENTS[0]!,
      id: `team:a${String(i).padStart(2, '0')}`,
    }));
    const page = await open(many);
    const rows = () =>
      page.querySelectorAll('tbody[data-machine="machine-a"] tr[data-agent]');
    expect(rows().length).toBe(25);
    const more = page.querySelector(
      'tbody[data-machine="machine-a"] tr.more-rows',
    )!;
    expect(more.querySelector('td')!.getAttribute('colspan')).toBe('12');
    (more.querySelector('td') as HTMLElement).click();
    await settle(fixture);
    expect(rows().length).toBe(30);
    expect(
      page.querySelector('tbody[data-machine="machine-a"] tr.more-rows'),
    ).toBeNull();
  });

  it('tokens in K and M; the context without a threshold, or without a window', () => {
    expect(tokensShort(853_916)).toBe('854K');
    expect(tokensShort(999)).toBe('999');
    expect(tokensShort(1_000)).toBe('1K');
    expect(tokensShort(999_499)).toBe('999K');
    expect(tokensShort(999_500)).toBe('1M');
    expect(tokensShort(1_000_000)).toBe('1M');
    expect(tokensShort(1_048_576)).toBe('1.0M');
    expect(tokensShort(2_500_000)).toBe('2.5M');
    const k = (over: Partial<CostNumbers>): CostNumbers => ({
      today_usd: 0,
      total_usd: 0,
      daily_usd: 'off',
      left_usd: null,
      context: 853_916,
      context_limit: 1_000_000,
      compact_at: 777_000,
      context_share: 109.9,
      ...over,
    });
    expect(contextShort(k({}))).toBe('854K/777K/1M');
    // no threshold (compact_at off): the context and the window
    expect(contextShort(k({ compact_at: null, context_share: null }))).toBe(
      '854K/1M',
    );
    // no window known: the context and the threshold
    expect(contextShort(k({ context_limit: null }))).toBe('854K/777K');
    expect(contextShort(k({ context: null }))).toBe('—');
  });

  // The owner, 2026-11-08: an Unregistered box right of the filter, off by
  // default, asks for the gone agents too; a link to one turns it on.
  const GONE: Agent = {
    id: 'old:one',
    registered: false,
    description: '',
    status: 'unregistered',
    machine: 'machine-a',
    last_active: '2026-10-27T09:05:00.000Z',
    cost: {
      today_usd: 0,
      total_usd: 3.5,
      daily_usd: 'off',
      left_usd: null,
      context: null,
      context_limit: null,
      compact_at: null,
      context_share: null,
    },
  };

  it('the Unregistered box, right of the filter and off by default, shows the gone agents too', async () => {
    const page = await open();
    const box = page.querySelector(
      '.toolbar #show-unregistered',
    ) as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect(text(box.closest('label'))).toBe('Unregistered');
    // right after the filter field
    expect(box.closest('label')!.previousElementSibling!.id).toBe('match');
    box.click();
    await settle(fixture);
    load([...AGENTS, GONE], undefined, true);
    await settle(fixture);
    const gone = page.querySelector('tr[data-agent="old:one"]')!;
    // dimmed, as on Costs
    expect(gone.classList).toContain('gone');
    expect(text(gone.querySelector('td.status'))).toBe('unregistered');
    expect(gone.querySelector('td.status .dot')).toBeNull();
    // nothing to do with a gone agent
    expect(gone.querySelectorAll('td.actions button').length).toBe(0);
    expect(text(gone.querySelector('td.spend'))).toBe(
      '$0.00 today / $3.50 total',
    );
  });

  it('a link to an unregistered agent turns the box on and highlights it', async () => {
    signedIn();
    await TestBed.inject(Router).navigateByUrl(
      '/?agent=old:one&unregistered=1',
    );
    fixture = TestBed.createComponent(AgentsPage);
    await settle(fixture);
    load([...AGENTS, GONE], undefined, true);
    await settle(fixture);
    const page = el(fixture);
    expect(
      (page.querySelector('#show-unregistered') as HTMLInputElement).checked,
    ).toBe(true);
    expect(page.querySelector('tr[data-agent="old:one"]')!.classList).toContain(
      'highlight',
    );
  });

  it("shows each agent's host after its status, a link to the Hosts page", async () => {
    signedIn();
    fixture = TestBed.createComponent(AgentsPage);
    load([AGENTS[0]!, { ...AGENTS[1]!, host: undefined }]);
    await settle(fixture);
    const page = el(fixture);
    expect(
      [...page.querySelectorAll('table.agents thead th')].map((th) => text(th)),
    ).toEqual([
      'ID',
      'Description',
      'Status',
      'Model',
      'Spend',
      'Context',
      'Host',
      'Folder',
      'Session',
      'Registered',
      'Last Active',
      '',
    ]);
    const lead = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    expect(
      lead.querySelector(
        'td.status + td.model + td.spend + td.context + td.host',
      ),
    ).not.toBeNull();
    const link = lead.querySelector('td.host a.id-link')!;
    expect(link.getAttribute('href')).toBe('/hosts?host=machine-a:1');
    expect(parts(link.querySelector('code'))).toEqual(['machine-a:', '1']);
    // The agent's own ID is not a link here.
    expect(lead.querySelector('td.id a')).toBeNull();
    const worker = page.querySelector('tr[data-agent="kaggle:worker"]')!;
    expect(text(worker.querySelector('td.host'))).toBe('—');
    expect(worker.querySelector('td.host a')).toBeNull();
    expect(
      page.querySelector('table.agents tr.group th')!.getAttribute('colspan'),
    ).toBe('12');
  });

  /*
   * The page reads the agent to highlight from its address; jsdom has no
   * scrolling, so scrollIntoView is a spy here.
   */
  async function arrive(url: string, agents = AGENTS): Promise<HTMLElement> {
    signedIn();
    await TestBed.inject(Router).navigateByUrl(url);
    fixture = TestBed.createComponent(AgentsPage);
    load(agents);
    await settle(fixture);
    return el(fixture);
  }

  describe('the agent a link led to', () => {
    const scroll = vi.fn();
    beforeEach(() => {
      scroll.mockClear();
      Element.prototype.scrollIntoView = scroll;
    });
    afterEach(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });

    it('is highlighted and scrolled into view, centred, once; it stays highlighted across the refresh', async () => {
      const page = await arrive('/?agent=kaggle:worker');
      const row = (id: string) => page.querySelector(`tr[data-agent="${id}"]`)!;
      expect(row('kaggle:worker').classList).toContain('highlight');
      expect(page.querySelectorAll('tr.highlight').length).toBe(1);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(row('kaggle:worker'));
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
      expect(page.querySelector('p.missing')).toBeNull();
      button(page, 'Refresh')!.click();
      load();
      await settle(fixture);
      expect(row('kaggle:worker').classList).toContain('highlight');
      expect(scroll).toHaveBeenCalledTimes(1);
      // A link to another agent while on the page: that one now.
      await TestBed.inject(Router).navigateByUrl('/?agent=kaggle:lead');
      await settle(fixture);
      expect(row('kaggle:lead').classList).toContain('highlight');
      expect(row('kaggle:worker').classList).not.toContain('highlight');
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(scroll.mock.contexts[1]).toBe(row('kaggle:lead'));
      // The tab itself (no agent in the address): nothing highlighted.
      await TestBed.inject(Router).navigateByUrl('/');
      await settle(fixture);
      expect(page.querySelector('tr.highlight')).toBeNull();
    });

    it('says so when the agent is not there now', async () => {
      const page = await arrive('/?agent=kaggle:gone');
      expect(text(page.querySelector('p.missing'))).toBe(
        'No agent kaggle:gone now.',
      );
      expect(page.querySelector('tr.highlight')).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    });

    it('clears a filter that would hide it, and keeps one that shows it', async () => {
      const page = await arrive('/');
      const input = page.querySelector('#match') as HTMLInputElement;
      type(input, 'kaggle:lead');
      press(input, 'Enter');
      load([AGENTS[0]!], 'kaggle:lead');
      await settle(fixture);
      await TestBed.inject(Router).navigateByUrl('/?agent=kaggle:worker');
      await settle(fixture);
      load();
      await settle(fixture);
      expect(input.value).toBe('');
      expect(
        page.querySelector('tr[data-agent="kaggle:worker"]')!.classList,
      ).toContain('highlight');

      type(input, 'kaggle:*');
      press(input, 'Enter');
      load(AGENTS, 'kaggle:*');
      await settle(fixture);
      await TestBed.inject(Router).navigateByUrl('/?agent=kaggle:lead');
      await settle(fixture);
      http.expectNone((r) => r.url === '/v1/agents');
      expect(input.value).toBe('kaggle:*');
      expect(
        page.querySelector('tr[data-agent="kaggle:lead"]')!.classList,
      ).toContain('highlight');
    });
  });

  it('breaks IDs, hosts, sessions and machine names only after ":" or "_"; a folder wraps after "/" (the text stays the same)', async () => {
    const page = await open();
    const lead = page.querySelector('tr[data-agent="kaggle:lead"]')!;
    const code = (cell: string) => lead.querySelector(`td.${cell} code`)!;
    // An ID may break only right after a ":" or "_" (the owner, 2026-11-03).
    for (const cell of ['id', 'host', 'session'])
      expect(lead.querySelector(`td.${cell}`)!.classList, cell).toContain(
        'id-like',
      );
    expect(parts(code('id'))).toEqual(['kaggle:', 'lead']);
    expect(parts(code('session'))).toEqual(['ses_', 'lead']);
    expect(code('session').textContent).toBe('ses_lead');
    const machine = page.querySelector('table.agents tr.group th')!;
    expect(machine.classList).toContain('id-like');
    expect(parts(machine)).toEqual(['laptop']);
    // Not IDs: they wrap as before.
    for (const cell of ['desc', 'status', 'folder', 'time'])
      expect(lead.querySelector(`td.${cell}`)!.classList, cell).not.toContain(
        'id-like',
      );
    expect(code('folder').innerHTML).toBe(
      '/<wbr>home/<wbr>someone/<wbr>kaggle',
    );
    expect(code('folder').textContent).toBe('/home/someone/kaggle');
    // A time wraps between its date, its clock and its zone (the owner,
    // 2026-11-09: the Agents table fits a laptop).
    const time = lead.querySelector('td.time')!;
    const [date, clock, zone] = localTime('2026-10-28T10:00:00.000Z').split(
      ' ',
    );
    expect(zone).toBeTruthy();
    expect(
      [...time.querySelectorAll('span')].map((s) => s.textContent),
    ).toEqual([date, clock, zone]);
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

  it('shows each status with its dot: idle and working green, paused amber, offline red, error pink-red', async () => {
    signedIn();
    fixture = TestBed.createComponent(AgentsPage);
    const statuses = ['idle', 'working', 'paused', 'offline', 'error'];
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
      ['dot', 'err'],
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

  it('says who paused an agent: the owner, Stop All, or its daily cost cap', () => {
    const paused = (by: string) => pausedText({ ...AGENTS[0]!, paused: by });
    expect(paused('')).toBe('');
    expect(paused('owner')).toBe('Paused by the owner');
    expect(paused('stop-all')).toBe('Paused by Stop All');
    expect(paused('cap')).toBe('Paused by its daily cost cap');
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

  describe('an agent in the error state', () => {
    // An error with its next retry so long from now.
    const error = (next: number | null, change: Partial<AgentError> = {}) => ({
      type: 'provider.internal',
      since: '2026-10-28T11:00:00.000Z',
      at: '2026-10-28T11:20:00.000Z',
      retries: 2,
      next_retry:
        next === null ? null : new Date(Date.now() + next).toISOString(),
      retryable: true,
      ...change,
    });
    const failing = (next: number | null = 40_000): Agent => ({
      ...AGENTS[0]!,
      id: 'kaggle:failing',
      status: 'error',
      error: error(next),
    });

    it('shows its status, the error type and when the next retry comes (full times in the tooltip)', async () => {
      signedIn();
      fixture = TestBed.createComponent(AgentsPage);
      const agent = failing();
      load([agent, AGENTS[1]!]);
      await settle(fixture);
      const cell = el(fixture).querySelector(
        'tr[data-agent="kaggle:failing"] td.status',
      )!;
      expect([...cell.querySelector('.dot')!.classList]).toEqual([
        'dot',
        'err',
      ]);
      const detail = cell.querySelector('.error-detail')!;
      expect(detail.classList).toContain('muted');
      expect(text(detail.querySelector('.error-type'))).toBe(
        'provider.internal',
      );
      expect(text(detail.querySelector('.retry-state'))).toBe('retry 3 in 40s');
      expect(text(cell).replace(text(detail), '').trim()).toBe('error');
      expect(detail.getAttribute('title')).toBe(
        `Failing since ${localTime(agent.error!.since)}; last failure ` +
          `${localTime(agent.error!.at)}; 2 retries sent; next retry ` +
          `${localTime(agent.error!.next_retry)}`,
      );
      // An agent without an error has none of this.
      const other = el(fixture).querySelector(
        'tr[data-agent="kaggle:worker"] td.status',
      )!;
      expect(other.querySelector('.error-detail')).toBeNull();
    });

    it('says how the retries go: in how long, now, not retried, or ran out', () => {
      const now = Date.parse('2026-10-28T12:00:00.000Z');
      const at = (ms: number) => new Date(now + ms).toISOString();
      const agent = (status: string, change: Partial<AgentError>): Agent => ({
        ...AGENTS[0]!,
        status,
        error: { ...error(0), next_retry: at(40_000), ...change },
      });
      const state = (status: string, change: Partial<AgentError> = {}) =>
        retryState(agent(status, change), now);
      expect(state('error')).toBe('retry 3 in 40s');
      expect(state('error', { next_retry: at(39_200) })).toBe('retry 3 in 40s');
      expect(state('error', { next_retry: at(120_000) })).toBe('retry 3 in 2m');
      expect(state('error', { next_retry: at(150_000) })).toBe(
        'retry 3 in 2m 30s',
      );
      expect(state('error', { next_retry: at(3_900_000) })).toBe(
        'retry 3 in 1h 5m',
      );
      expect(state('error', { retries: 0 })).toBe('retry 1 in 40s');
      // Due, or sent and its turn running.
      expect(state('error', { next_retry: at(0) })).toBe('retrying now');
      expect(state('paused', { next_retry: at(-5_000) })).toBe('retrying now');
      expect(state('working', { next_retry: null })).toBe('retrying now');
      // A failure that comes back the same way.
      expect(
        state('error', {
          type: 'provider.auth',
          next_retry: null,
          retryable: false,
        }),
      ).toBe('not retried');
      // retry_attempts reached.
      expect(state('error', { next_retry: null })).toBe('retries ran out');
      expect(retryState(AGENTS[0]!, now)).toBe('');
      // Phase 2: a blocked reply's retry and compaction (the owner,
      // 2026-11-09)
      const blocked = { type: 'provider.content-filter', retries: 0 };
      expect(state('error', { ...blocked, recovery: 'retry' })).toBe(
        'blocked: retry 1 in 40s',
      );
      expect(
        state('error', { ...blocked, retries: 1, recovery: 'compact' }),
      ).toBe('blocked: compaction in 40s, then a retry');
      expect(
        state('error', {
          ...blocked,
          next_retry: null,
          retryable: false,
          recovery: null,
        }),
      ).toBe('not retried');
    });

    it('admin retries it now: the result shows in the toolbar and the list reloads; only an agent in error has Retry', async () => {
      signedIn();
      fixture = TestBed.createComponent(AgentsPage);
      load([failing(), AGENTS[1]!]);
      await settle(fixture);
      const page = el(fixture);
      const row = (id: string) => page.querySelector(`tr[data-agent="${id}"]`)!;
      expect(button(row('kaggle:worker'), 'Retry')).toBeUndefined();
      const retry = button(row('kaggle:failing'), 'Retry')!;
      expect(retry.closest('td.actions')).not.toBeNull();
      retry.click();
      const req = http.expectOne('/v1/agents/kaggle%3Afailing/retry');
      expect(req.request.method).toBe('POST');
      req.flush({ agent: failing(0) });
      await settle(fixture);
      load([failing(0), AGENTS[1]!]);
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .notice'))).toBe(
        'Retrying kaggle:failing.',
      );
      expect(text(row('kaggle:failing').querySelector('.retry-state'))).toBe(
        'retrying now',
      );

      // The server refuses: its message in the toolbar, no reload.
      button(row('kaggle:failing'), 'Retry')!.click();
      apiError(
        http.expectOne('/v1/agents/kaggle%3Afailing/retry'),
        409,
        'not_in_error',
        'kaggle:failing is not in the error state',
      );
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
        'kaggle:failing is not in the error state',
      );
      http.expectNone((r) => r.url === '/v1/agents');
    });
  });
});
