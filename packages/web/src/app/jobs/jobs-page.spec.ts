/*
 * Unit tests of the Jobs page against a mocked server: the jobs (where they
 * run, model, trigger, next run, destination, last run linked to its row)
 * with Run Now (and the text typed beside it), Edit and Delete; the Set a Job
 * form (collapsed; its fields, defaults, the body it sends, the server's
 * error), filled by Edit; the runs, newest first (who started them, state,
 * times, cost, result folded at 200 characters, reason) with Delete Session
 * for a failed run's kept session; the Job filter; "Updated" in the footer;
 * and the 10 s refresh (one at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  apiError,
  button,
  choose,
  el,
  parts,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import { REFRESH_MS } from '../agents/agents-page';
import type { Host, Job, Run } from '../api';
import { localTime } from '../format';
import { costText, JobsPage, stateText } from './jobs-page';

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

// Two jobs: one every hour on an online host, with a variant and a cap; one
// fire-only on an offline host, with an OpenCode agent, for another agent.
function jobs(): Job[] {
  return [
    {
      name: 'mail',
      description: "Summarizes the day's mail",
      host: 'm:1',
      machine: 'laptop',
      directory: '/Users/someone/mail',
      online: true,
      model: 'openai/gpt-5',
      variant: 'high',
      prompt: "Summarize today's mail in five lines.",
      trigger: 'every 1h',
      next: at(570_000),
      to: 'owner',
      timeout: '1h',
      run_usd: 2,
      delete_session: true,
      last_run: {
        id: 'mail:2026-11-08T09:00',
        state: 'succeeded',
        started: '2026-11-08T09:00:00.000Z',
      },
      created_at: '2026-11-07T09:00:00.000Z',
      updated_at: '2026-11-07T09:00:00.000Z',
    },
    {
      name: 'team:nightly',
      description: '',
      host: 'm:2',
      machine: 'machine-a',
      directory: '/home/someone/work',
      online: false,
      model: 'anthropic/claude-sonnet',
      agent: 'build',
      prompt: 'Build and test.',
      trigger: 'fire-only',
      next: null,
      to: 'team:lead',
      timeout: '30m',
      run_usd: 'off',
      delete_session: false,
      last_run: null,
      created_at: '2026-11-07T09:00:00.000Z',
      updated_at: '2026-11-07T09:00:00.000Z',
    },
  ];
}

const RESULT = `Five lines: ${'all quiet on the mail front. '.repeat(10)}`;

const RUNS: Run[] = [
  {
    id: 'mail:2026-11-08T09:00',
    job: 'mail',
    by: 'schedule',
    session: 'ses_1',
    state: 'succeeded',
    reason: null,
    result: RESULT,
    cost: 0.1234,
    started: '2026-11-08T09:00:00.000Z',
    ended: '2026-11-08T09:03:00.000Z',
    session_kept: false,
  },
  {
    id: 'team:nightly:2026-11-08T02:00',
    job: 'team:nightly',
    by: 'team:lead',
    text: 'Only the tests.',
    session: 'ses_2',
    state: 'failed',
    reason: 'time limit (30m)',
    result: null,
    cost: 1.5,
    started: '2026-11-08T02:00:00.000Z',
    ended: '2026-11-08T02:30:00.000Z',
    session_kept: true,
  },
  {
    id: 'mail:2026-11-08T08:00:skipped',
    job: 'mail',
    by: 'schedule',
    session: null,
    state: 'skipped',
    reason: 'mail:2026-11-08T07:00 still works',
    result: null,
    cost: 0,
    started: '2026-11-08T08:00:00.000Z',
    ended: '2026-11-08T08:00:00.000Z',
    session_kept: false,
  },
];

const HOST = {
  instance: 'i1',
  opencode_version: '2.2.0',
  plugin_version: '0.1.0',
  process_kind: 'service',
  process_pid: 1,
  shell_values: true,
  first_seen: '2026-11-07T09:00:00.000Z',
  last_seen: '2026-11-08T09:00:00.000Z',
};
const HOSTS: Host[] = [
  {
    ...HOST,
    id: 'm:1',
    machine: 'laptop',
    directory: '/Users/someone/mail',
    online: true,
  },
  {
    ...HOST,
    id: 'm:2',
    machine: 'machine-a',
    directory: '/home/someone/work',
    online: false,
  },
  {
    ...HOST,
    id: 'm:3',
    machine: 'machine-a',
    directory: '/home/someone/other',
    online: true,
  },
];

describe('JobsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<JobsPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  // One refresh: the jobs, the runs (of one job, or all) and the hosts.
  function load(
    list: Job[] = jobs(),
    runs: Run[] = RUNS,
    job: string | null = null,
  ): void {
    http.expectOne('/v1/jobs').flush({ jobs: list });
    const req = http.expectOne((r) => r.url === '/v1/runs');
    expect(req.request.params.get('job')).toBe(job);
    req.flush({ runs });
    http.expectOne('/v1/hosts').flush({ hosts: HOSTS });
  }

  async function open(list = jobs(), runs = RUNS): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(JobsPage);
    await settle(fixture);
    load(list, runs);
    await settle(fixture);
    return el(fixture);
  }

  const job = (page: HTMLElement, name: string) =>
    page.querySelector(`table.jobs tr[data-job="${name}"]`)!;
  const run = (page: HTMLElement, id: string) =>
    page.querySelector(`table.runs tr[data-run="${id}"]`)!;
  const cell = (row: Element, name: string) =>
    text(row.querySelector(`td.${name}`));
  const notice = (page: HTMLElement) =>
    text(page.querySelector('.toolbar .notice'));
  const form = (page: HTMLElement) =>
    page.querySelector('details.panel') as HTMLDetailsElement;
  const value = (page: HTMLElement, selector: string) =>
    (page.querySelector(selector) as HTMLInputElement).value;

  it('lists the jobs: name, where, model, trigger, next run, destination and last run, with Run Now, Edit and Delete', async () => {
    const list = jobs();
    const page = await open(list);
    expect(page.querySelector('h2.first')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.jobs thead th')].map((th) => text(th)),
    ).toEqual([
      'Name',
      'Where',
      'Model',
      'Trigger',
      'Next',
      'To',
      'Last Run',
      '',
    ]);
    const mail = job(page, 'mail');
    expect(mail.querySelector('td.name')!.classList).toContain('id-like');
    expect(parts(mail.querySelector('td.name code'))).toEqual(['mail']);
    expect(mail.querySelector('td.name')!.getAttribute('title')).toBe(
      "Summarizes the day's mail",
    );
    expect(cell(mail, 'where')).toBe('laptop /Users/someone/mail');
    expect(mail.querySelector('td.where .offline')).toBeNull();
    expect(cell(mail, 'model')).toBe('openai/gpt-5 variant high');
    expect(cell(mail, 'trigger')).toBe('every 1h');
    const next = mail.querySelector('td.next')!;
    expect(text(next)).toBe(`${localTime(list[0]!.next)} (in 9m)`);
    expect(next.getAttribute('title')).toBe(list[0]!.next);
    expect(cell(mail, 'to')).toBe('owner');
    // The last run: its state and time, a link to its row below.
    const last = mail.querySelector('td.last a.run-link')!;
    // (The page's own address; /jobs in the app.)
    expect(last.getAttribute('href')).toBe('/?run=mail:2026-11-08T09:00');
    expect(cell(mail, 'last')).toBe(
      `Succeeded ${localTime('2026-11-08T09:00:00.000Z')}`,
    );
    for (const name of ['Run Now', 'Edit', 'Delete'])
      expect(button(mail, name), name).toBeDefined();
    const field = mail.querySelector('input[aria-label="Text for the run"]');
    expect(field!.nextElementSibling).toBe(button(mail, 'Run Now'));

    const nightly = job(page, 'team:nightly');
    expect(parts(nightly.querySelector('td.name code'))).toEqual([
      'team:',
      'nightly',
    ]);
    expect(nightly.querySelector('td.name')!.getAttribute('title')).toBeNull();
    expect(cell(nightly, 'where')).toBe('machine-a /home/someone/work offline');
    expect(cell(nightly, 'model')).toBe('anthropic/claude-sonnet agent build');
    expect(cell(nightly, 'next')).toBe('—');
    expect(nightly.querySelector('td.to a.id-link')!.getAttribute('href')).toBe(
      '/agents?agent=team:lead',
    );
    expect(cell(nightly, 'last')).toBe('—');
  });

  it("lists the runs, newest first: who started them, state, times, cost, result and reason; Delete Session for a failed run's kept session", async () => {
    const page = await open();
    expect(text(page.querySelector('h2'))).toBe('Runs');
    expect(
      [...page.querySelectorAll('table.runs thead th')].map((th) => text(th)),
    ).toEqual([
      'Run',
      'Started By',
      'State',
      'Started',
      'Ended',
      'Cost',
      'Result',
      'Reason',
      '',
    ]);
    expect(
      [...page.querySelectorAll('table.runs tr[data-run]')].map((r) =>
        r.getAttribute('data-run'),
      ),
    ).toEqual(RUNS.map((r) => r.id));
    const done = run(page, 'mail:2026-11-08T09:00');
    expect(parts(done.querySelector('td.id code'))).toEqual([
      'mail:',
      '2026-11-08T09:',
      '00',
    ]);
    expect(cell(done, 'by')).toBe('schedule');
    expect(cell(done, 'state')).toBe('Succeeded');
    expect(cell(done, 'started')).toBe(localTime('2026-11-08T09:00:00.000Z'));
    expect(cell(done, 'ended')).toBe(localTime('2026-11-08T09:03:00.000Z'));
    expect(cell(done, 'cost')).toBe('$0.12');
    expect(cell(done, 'reason')).toBe('—');
    expect(button(done, 'Delete Session')).toBeUndefined();
    const failed = run(page, 'team:nightly:2026-11-08T02:00');
    expect(failed.querySelector('td.by a.id-link')!.getAttribute('href')).toBe(
      '/agents?agent=team:lead',
    );
    expect(cell(failed, 'state')).toBe('Failed');
    expect(cell(failed, 'cost')).toBe('$1.50');
    expect(cell(failed, 'result')).toBe('—');
    expect(cell(failed, 'reason')).toBe('time limit (30m)');
    expect(button(failed, 'Delete Session')).toBeDefined();
    const skipped = run(page, 'mail:2026-11-08T08:00:skipped');
    expect(cell(skipped, 'state')).toBe('Skipped');
    expect(cell(skipped, 'reason')).toBe('mail:2026-11-08T07:00 still works');
    expect(button(skipped, 'Delete Session')).toBeUndefined();
  });

  it('says a state in Title Case and a cost in dollars', () => {
    expect(
      ['starting', 'running', 'succeeded', 'failed', 'skipped'].map(stateText),
    ).toEqual(['Starting', 'Running', 'Succeeded', 'Failed', 'Skipped']);
    expect(costText(0)).toBe('$0.00');
    expect(costText(0.005)).toBe('$0.01');
    expect(costText(12.3)).toBe('$12.30');
  });

  it('a long result shows its first 200 characters; a click anywhere in its cell shows it whole, the next folds it', async () => {
    expect(RESULT.length).toBeGreaterThan(200);
    const page = await open();
    const td = () =>
      run(page, 'mail:2026-11-08T09:00').querySelector(
        'td.result',
      ) as HTMLElement;
    const more = () => td().querySelector('.more') as HTMLElement;
    expect(td().classList).toContain('folds');
    expect(more().textContent).toBe(`${RESULT.slice(0, 200).trimEnd()}…`);
    td().click();
    await settle(fixture);
    expect(more().textContent).toBe(RESULT);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    more().click();
    await settle(fixture);
    expect(more().textContent).toBe(`${RESULT.slice(0, 200).trimEnd()}…`);
  });

  it("Run Now starts a run, with the text typed beside it; a job already running is refused with the server's message", async () => {
    const page = await open();
    type(
      job(page, 'mail').querySelector('input[aria-label="Text for the run"]'),
      ' Only today. ',
    );
    await settle(fixture);
    button(job(page, 'mail'), 'Run Now')!.click();
    const req = http.expectOne('/v1/jobs/mail/run');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ text: 'Only today.' });
    req.flush({ run: { ...RUNS[0]!, id: 'mail:2026-11-08T10:00' } });
    await settle(fixture);
    load();
    await settle(fixture);
    expect(notice(page)).toBe('Started run mail:2026-11-08T10:00.');
    expect(
      value(page, 'tr[data-job="mail"] input[aria-label="Text for the run"]'),
    ).toBe('');

    button(job(page, 'team:nightly'), 'Run Now')!.click();
    const busy = http.expectOne('/v1/jobs/team%3Anightly/run');
    expect(busy.request.body).toEqual({});
    apiError(
      busy,
      409,
      'job_busy',
      'job team:nightly is running: team:nightly:2026-11-08T10:00, ' +
        'started by the owner',
    );
    await settle(fixture);
    load();
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
      'job team:nightly is running: team:nightly:2026-11-08T10:00, ' +
        'started by the owner',
    );
  });

  it('Set a Job: a form that opens from its title; its fields and defaults; it sends what was filled and shows the result', async () => {
    const page = await open();
    const panel = form(page);
    expect(panel.open).toBe(false);
    expect(text(panel.querySelector('summary'))).toBe('Set a Job');
    panel.querySelector('summary')!.click();
    await settle(fixture);
    expect(panel.open).toBe(true);
    expect([...panel.querySelectorAll('label')].map((l) => text(l))).toEqual([
      'Name',
      'Description',
      'Host',
      'Model',
      'Variant',
      'Agent',
      'Prompt',
      'Trigger',
      'To',
      'Time Limit',
      'Run Cap',
      'Delete Session',
    ]);
    // Online hosts only, by machine and folder.
    const host = panel.querySelector('#job-host') as HTMLSelectElement;
    expect([...host.options].map((o) => [o.value, text(o)])).toEqual([
      ['', 'Choose a host'],
      ['m:1', 'laptop — /Users/someone/mail'],
      ['m:3', 'machine-a — /home/someone/other'],
    ]);
    expect(value(page, '#job-to')).toBe('owner');
    expect(value(page, '#job-timeout')).toBe('1h');
    expect(value(page, '#job-run-usd')).toBe('off');
    const keep = panel.querySelector('#job-delete') as HTMLInputElement;
    expect(keep.checked).toBe(true);
    const set = () => button(panel, 'Set Job')!;
    expect(set().disabled).toBe(true);
    type(panel.querySelector('#job-name'), ' report ');
    choose(host, 'm:3');
    type(panel.querySelector('#job-model'), 'openai/gpt-5');
    type(panel.querySelector('#job-prompt'), 'Report on the runs.');
    type(panel.querySelector('#job-trigger'), 'every 1h');
    type(panel.querySelector('#job-run-usd'), '$2.50');
    await settle(fixture);
    expect(set().disabled).toBe(false);
    set().click();
    const put = http.expectOne('/v1/jobs/report');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      host: 'm:3',
      model: 'openai/gpt-5',
      prompt: 'Report on the runs.',
      trigger: 'every 1h',
      to: 'owner',
      timeout: '1h',
      run_usd: 2.5,
      delete_session: true,
    });
    put.flush(
      { job: { ...jobs()[0]!, name: 'report' } },
      { status: 201, statusText: 'Created' },
    );
    await settle(fixture);
    load();
    await settle(fixture);
    expect(text(panel.querySelector('.notice'))).toBe('Set job report.');
    expect(value(page, '#job-name')).toBe('');
    expect(value(page, '#job-prompt')).toBe('');

    // The server refuses: its message, and what was typed stays.
    type(panel.querySelector('#job-name'), 'idle');
    type(panel.querySelector('#job-model'), 'openai/gpt-5');
    type(panel.querySelector('#job-prompt'), 'Go on.');
    type(panel.querySelector('#job-trigger'), 'idle 30m');
    type(panel.querySelector('#job-run-usd'), 'off');
    keep.checked = false;
    keep.dispatchEvent(new Event('change'));
    await settle(fixture);
    set().click();
    const bad = http.expectOne('/v1/jobs/idle');
    expect(bad.request.body).toMatchObject({
      run_usd: 'off',
      delete_session: false,
    });
    apiError(
      bad,
      400,
      'bad_trigger',
      "a job's trigger is every, at, cron or fire-only",
    );
    await settle(fixture);
    expect(text(panel.querySelector('.errmsg'))).toBe(
      "a job's trigger is every, at, cron or fire-only",
    );
    expect(value(page, '#job-trigger')).toBe('idle 30m');
    http.expectNone('/v1/jobs');
  });

  it('Edit fills the form with the job, its host even when offline, and opens it; Set Job replaces the job', async () => {
    const page = await open();
    button(job(page, 'team:nightly'), 'Edit')!.click();
    await settle(fixture);
    const panel = form(page);
    expect(panel.open).toBe(true);
    expect(value(page, '#job-name')).toBe('team:nightly');
    const host = panel.querySelector('#job-host') as HTMLSelectElement;
    expect(host.value).toBe('m:2');
    expect(text(host.selectedOptions[0]!)).toBe(
      'machine-a — /home/someone/work (offline)',
    );
    expect(value(page, '#job-model')).toBe('anthropic/claude-sonnet');
    expect(value(page, '#job-variant')).toBe('');
    expect(value(page, '#job-agent')).toBe('build');
    expect(value(page, '#job-prompt')).toBe('Build and test.');
    expect(value(page, '#job-trigger')).toBe('fire-only');
    expect(value(page, '#job-to')).toBe('team:lead');
    expect(value(page, '#job-timeout')).toBe('30m');
    expect(value(page, '#job-run-usd')).toBe('off');
    expect(
      (panel.querySelector('#job-delete') as HTMLInputElement).checked,
    ).toBe(false);
    button(panel, 'Set Job')!.click();
    const put = http.expectOne('/v1/jobs/team%3Anightly');
    expect(put.request.body).toEqual({
      host: 'm:2',
      model: 'anthropic/claude-sonnet',
      agent: 'build',
      prompt: 'Build and test.',
      trigger: 'fire-only',
      to: 'team:lead',
      timeout: '30m',
      run_usd: 'off',
      delete_session: false,
    });
    put.flush({ job: jobs()[1] });
    await settle(fixture);
    load();
    await settle(fixture);

    // A job with a description, a variant and a cap keeps them.
    button(job(page, 'mail'), 'Edit')!.click();
    await settle(fixture);
    expect(value(page, '#job-description')).toBe("Summarizes the day's mail");
    expect(value(page, '#job-variant')).toBe('high');
    expect(value(page, '#job-run-usd')).toBe('2');
    button(panel, 'Set Job')!.click();
    expect(http.expectOne('/v1/jobs/mail').request.body).toMatchObject({
      description: "Summarizes the day's mail",
      variant: 'high',
      run_usd: 2,
      delete_session: true,
    });
  });

  it("Delete asks first, then deletes the job; its runs' history stays", async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      button(job(page, 'mail'), 'Delete')!.click();
      expect(confirm).toHaveBeenCalledWith(
        "Delete job mail?\n\nIts runs' history stays.",
      );
      http.expectNone('/v1/jobs/mail');
      confirm.mockReturnValue(true);
      button(job(page, 'mail'), 'Delete')!.click();
      const del = http.expectOne('/v1/jobs/mail');
      expect(del.request.method).toBe('DELETE');
      del.flush({ deleted: 'mail' });
      await settle(fixture);
      load([jobs()[1]!]);
      await settle(fixture);
      expect(notice(page)).toBe('Deleted job mail.');
      expect(page.querySelector('tr[data-job="mail"]')).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it("Delete Session asks first, then deletes a failed run's kept session", async () => {
    const page = await open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const id = 'team:nightly:2026-11-08T02:00';
    try {
      button(run(page, id), 'Delete Session')!.click();
      expect(confirm).toHaveBeenCalledWith(`Delete the session of run ${id}?`);
      http.expectNone((r) => r.url.endsWith('/session'));
      confirm.mockReturnValue(true);
      button(run(page, id), 'Delete Session')!.click();
      const del = http.expectOne(
        '/v1/runs/team%3Anightly%3A2026-11-08T02%3A00/session',
      );
      expect(del.request.method).toBe('DELETE');
      del.flush({ deleted: 'ses_2' });
      await settle(fixture);
      load(jobs(), [RUNS[0]!, { ...RUNS[1]!, session_kept: false }]);
      await settle(fixture);
      expect(notice(page)).toBe(`Deleted the session of run ${id}.`);
      expect(button(run(page, id), 'Delete Session')).toBeUndefined();
    } finally {
      confirm.mockRestore();
    }
  });

  it("the Job filter shows one job's runs; a last run's link shows all again and highlights its row", async () => {
    const page = await open();
    const filter = page.querySelector('#runs-job') as HTMLSelectElement;
    expect(text(page.querySelector('label[for="runs-job"]'))).toBe('Job');
    expect([...filter.options].map((o) => [o.value, text(o)])).toEqual([
      ['', 'All jobs'],
      ['mail', 'mail'],
      ['team:nightly', 'team:nightly'],
    ]);
    choose(filter, 'team:nightly');
    await settle(fixture);
    load(jobs(), [RUNS[1]!], 'team:nightly');
    await settle(fixture);
    expect(page.querySelectorAll('table.runs tr[data-run]').length).toBe(1);

    // The mail job's last run: the filter goes, its row is highlighted.
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      (job(page, 'mail').querySelector('a.run-link') as HTMLElement).click();
      await settle(fixture);
      load();
      await settle(fixture);
      expect(TestBed.inject(Router).url).toBe('/?run=mail:2026-11-08T09:00');
      expect(filter.value).toBe('');
      const row = run(page, 'mail:2026-11-08T09:00');
      expect(row.classList).toContain('highlight');
      expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('says when there are no jobs and no runs', async () => {
    const page = await open([], []);
    expect(text(page.querySelector('table.jobs tbody'))).toBe(
      'No jobs yet. Set a Job above, or use autocode job set.',
    );
    expect(text(page.querySelector('table.runs tbody'))).toBe('No runs yet.');
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(JobsPage);
      await vi.advanceTimersByTimeAsync(0);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone('/v1/jobs');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne('/v1/jobs');
      http.expectOne((r) => r.url === '/v1/runs').flush({ runs: RUNS });
      http.expectOne('/v1/hosts').flush({ hosts: HOSTS });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone('/v1/jobs');
      req.flush({ jobs: jobs() });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
