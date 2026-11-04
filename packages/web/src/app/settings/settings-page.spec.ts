/*
 * Unit tests of the Settings page against a mocked server: server values saved,
 * reset and refused, lists and checkboxes, the rules editor, agents' own
 * values, and the values resolved for one agent (agent IDs link to their rows
 * on the Agents page).
 */

import type {
  HttpTestingController,
  TestRequest,
} from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
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
import type { SettingsView, SettingValue } from '../api';
import { SettingsPage } from './settings-page';

function view(change: Partial<SettingsView> = {}): SettingsView {
  return {
    defaults: {
      min_interval: '1m',
      question_mode: 'ask',
      history_days: 30,
      restart_opencode: true,
    },
    server: {},
    rules: [
      { match: 'kaggle:*', settings: { question_mode: 'auto' } },
      { match: 'a:*', settings: { min_interval: '5m' } },
    ],
    agents: { 'kaggle:lead': { min_interval: '2m' } },
    schema: {
      min_interval: {
        kind: 'duration',
        scope: 'agent',
        default: '1m',
        help: 'at most one injection per session this often',
      },
      question_mode: {
        kind: 'enum',
        scope: 'agent',
        default: 'ask',
        values: ['ask', 'auto'],
        help: 'questions go to the owner (ask) or are answered at once (auto)',
      },
      history_days: {
        kind: 'int',
        scope: 'server',
        default: 30,
        help: 'days of history kept',
      },
      restart_opencode: {
        kind: 'bool',
        scope: 'server',
        default: true,
        help: 'restart missing OpenCode servers on this machine',
      },
    },
    ...change,
  };
}

// The view once `server` was set server-wide.
function withServer(server: Record<string, SettingValue>): SettingsView {
  return view({ server, defaults: { ...view().defaults, ...server } });
}

describe('SettingsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<SettingsPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  async function open(start = view()): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(SettingsPage);
    http.expectOne('/v1/settings').flush(start);
    await settle(fixture);
    http
      .expectOne((r) => r.url === '/v1/agents')
      .flush({ agents: [{ id: 'kaggle:lead' }, { id: 'kaggle:worker' }] });
    await settle(fixture);
    return el(fixture);
  }

  function patch(): TestRequest {
    return http.expectOne({ method: 'PATCH', url: '/v1/settings' });
  }

  function row(page: HTMLElement, key: string): Element {
    return page.querySelector(`table.settings tr[data-key="${key}"]`)!;
  }

  // What a row's Value column shows: its edit control's value.
  function shown(page: HTMLElement, key: string): string | boolean {
    const control = row(page, key).querySelector(
      'td.value input, td.value select',
    ) as HTMLInputElement | HTMLSelectElement;
    return control instanceof HTMLInputElement && control.type === 'checkbox'
      ? control.checked
      : control.value;
  }

  it('shows every setting: its server value in its edit control, where it comes from, its scope and help', async () => {
    const page = await open(withServer({ history_days: 7 }));
    expect(
      [...page.querySelectorAll('table.settings thead th')].map((th) =>
        text(th),
      ),
    ).toEqual(['Setting', 'Value', 'From', 'Scope', 'Description']);
    expect(page.querySelectorAll('table.settings tbody tr').length).toBe(4);
    const min = row(page, 'min_interval');
    expect(shown(page, 'min_interval')).toBe('1m');
    expect(button(min.querySelector('td.value')!, 'Save')).toBeTruthy();
    expect(button(min.querySelector('td.value')!, 'Reset')).toBeTruthy();
    expect(text(min.querySelector('td.from'))).toBe('built-in default');
    // A setting's key breaks only after "_" (the owner, 2026-11-03).
    expect(min.querySelector('td.key')!.classList).toContain('id-like');
    expect(parts(min.querySelector('td.key'))).toEqual(['min_', 'interval']);
    expect(min.querySelector('td.help')!.classList).not.toContain('id-like');
    expect(text(min.querySelector('td.scope'))).toBe('agent');
    expect(text(min.querySelector('td.help'))).toBe(
      'at most one injection per session this often',
    );
    const days = row(page, 'history_days');
    expect(shown(page, 'history_days')).toBe('7');
    expect(text(days.querySelector('td.from'))).toBe('set server-wide');
    expect(text(days.querySelector('td.scope'))).toBe('server');
    expect(shown(page, 'restart_opencode')).toBe(true);
  });

  it('admin sets a value as typed and sees the saved one', async () => {
    const page = await open();
    const min = row(page, 'min_interval');
    const save = button(min, 'Save')!;
    expect(save.disabled).toBe(true);
    type(min.querySelector('input[aria-label="Value of min_interval"]'), '2m');
    await settle(fixture);
    expect(save.disabled).toBe(false);
    save.click();
    const req = patch();
    expect(req.request.body).toEqual({ server: { min_interval: '2m' } });
    req.flush(withServer({ min_interval: '2m' }));
    await settle(fixture);
    expect(shown(page, 'min_interval')).toBe('2m');
    expect(save.disabled).toBe(true);
    expect(text(row(page, 'min_interval').querySelector('td.from'))).toBe(
      'set server-wide',
    );
    expect(text(page.querySelector('.notice'))).toBe('Saved min_interval.');
  });

  it('saving one server value keeps what the owner typed, but did not save yet, in another row', async () => {
    const page = await open();
    type(row(page, 'history_days').querySelector('input'), '7');
    type(row(page, 'min_interval').querySelector('input'), '2m');
    await settle(fixture);
    button(row(page, 'min_interval'), 'Save')!.click();
    patch().flush(withServer({ min_interval: '2m' }));
    await settle(fixture);
    const days = row(page, 'history_days');
    expect((days.querySelector('input') as HTMLInputElement).value).toBe('7');
    expect(button(days, 'Save')!.disabled).toBe(false);
    expect(
      (row(page, 'min_interval').querySelector('input') as HTMLInputElement)
        .value,
    ).toBe('2m');
  });

  it("a rule's second setting cannot be one the rule already has, so no value is ever dropped", async () => {
    const page = await open(view({ rules: [] }));
    button(page, 'Add a Rule')!.click();
    await settle(fixture);
    const editor = page.querySelector('.editor')!;
    type(editor.querySelector('#rule-match'), 'b:*');
    const first = (
      editor.querySelector(
        'select[aria-label="Setting 1"]',
      ) as HTMLSelectElement
    ).value;
    expect(first).toBe('min_interval');
    type(editor.querySelector('input[aria-label="Value 1"]'), '3m');
    button(editor, 'Add a Setting')!.click();
    await settle(fixture);
    const second = editor.querySelector(
      'select[aria-label="Setting 2"]',
    ) as HTMLSelectElement;
    expect([...second.options].map((o) => o.value)).not.toContain(first);
    // every agent setting is in the rule now: there is nothing left to add
    button(editor, 'Add a Setting')!.click();
    await settle(fixture);
    expect(editor.querySelector('select[aria-label="Setting 3"]')).toBeNull();
    button(editor, 'Save Rule')!.click();
    const req = patch();
    expect(Object.keys(req.request.body.rules[0].settings).sort()).toEqual([
      'min_interval',
      'question_mode',
    ]);
    req.flush(view({ rules: req.request.body.rules }));
    await settle(fixture);
  });

  it('admin resets a value to its built-in default (sends null)', async () => {
    const page = await open(withServer({ min_interval: '5m' }));
    expect(button(row(page, 'question_mode'), 'Reset')!.disabled).toBe(true);
    button(row(page, 'min_interval'), 'Reset')!.click();
    const req = patch();
    expect(req.request.body).toEqual({ server: { min_interval: null } });
    req.flush(view());
    await settle(fixture);
    expect(text(row(page, 'min_interval').querySelector('td.from'))).toBe(
      'built-in default',
    );
  });

  it('choices are a list and switches a checkbox', async () => {
    const page = await open();
    const mode = row(page, 'question_mode').querySelector('select')!;
    expect([...mode.options].map((o) => o.value)).toEqual(['ask', 'auto']);
    expect(mode.value).toBe('ask');
    choose(mode, 'auto');
    await settle(fixture);
    button(row(page, 'question_mode'), 'Save')!.click();
    const first = patch();
    expect(first.request.body).toEqual({ server: { question_mode: 'auto' } });
    first.flush(withServer({ question_mode: 'auto' }));
    await settle(fixture);

    const box = row(page, 'restart_opencode').querySelector(
      'input[type=checkbox]',
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await settle(fixture);
    button(row(page, 'restart_opencode'), 'Save')!.click();
    expect(patch().request.body).toEqual({
      server: { restart_opencode: false },
    });
  });

  it("shows the server's message, naming the key, when it refuses a change", async () => {
    const page = await open();
    const min = row(page, 'min_interval');
    type(min.querySelector('input'), 'soon');
    await settle(fixture);
    button(min, 'Save')!.click();
    apiError(
      patch(),
      400,
      'bad_setting',
      'min_interval: expected a duration like 90s, 5m or 1h30m (got "soon")',
    );
    await settle(fixture);
    expect(text(page.querySelector('.errmsg'))).toContain(
      'min_interval: expected a duration',
    );
    // What was typed stays, unsaved, for the owner to fix.
    expect(shown(page, 'min_interval')).toBe('soon');
    expect(button(row(page, 'min_interval'), 'Save')!.disabled).toBe(false);
    expect(text(row(page, 'min_interval').querySelector('td.from'))).toBe(
      'built-in default',
    );
  });

  it('rules: admin adds a rule; the whole list is sent', async () => {
    const page = await open();
    const rules = () =>
      [...page.querySelectorAll('table.rules tbody tr[data-rule]')].map((r) =>
        text(r.querySelector('td.match')),
      );
    expect(rules()).toEqual(['kaggle:*', 'a:*']);
    button(page, 'Add a Rule')!.click();
    await settle(fixture);
    const editor = page.querySelector('.editor')!;
    type(editor.querySelector('#rule-match'), 'b:*');
    const key = editor.querySelector(
      'select[aria-label="Setting 1"]',
    ) as HTMLSelectElement;
    expect(key.value).toBe('min_interval');
    expect([...key.options].map((o) => o.value)).toEqual([
      'min_interval',
      'question_mode',
    ]);
    type(editor.querySelector('input[aria-label="Value 1"]'), '3m');
    button(editor, 'Add a Setting')!.click();
    await settle(fixture);
    choose(editor.querySelector('select[aria-label="Value 2"]'), 'auto');
    await settle(fixture);
    button(editor, 'Save Rule')!.click();
    const req = patch();
    expect(req.request.body).toEqual({
      rules: [
        { match: 'kaggle:*', settings: { question_mode: 'auto' } },
        { match: 'a:*', settings: { min_interval: '5m' } },
        {
          match: 'b:*',
          settings: { min_interval: '3m', question_mode: 'auto' },
        },
      ],
    });
    req.flush(view({ rules: req.request.body.rules }));
    await settle(fixture);
    expect(rules()).toEqual(['kaggle:*', 'a:*', 'b:*']);
    expect(page.querySelector('.editor')).toBeNull();
  });

  it('rules: admin edits, moves and removes rules', async () => {
    const page = await open();
    button(page.querySelector('tr[data-rule="1"]')!, 'Edit')!.click();
    await settle(fixture);
    const editor = page.querySelector('.editor')!;
    expect(
      (editor.querySelector('#rule-match') as HTMLInputElement).value,
    ).toBe('kaggle:*');
    type(editor.querySelector('#rule-match'), 'kaggle:*,casmi:*');
    await settle(fixture);
    button(editor, 'Save Rule')!.click();
    const edited = patch();
    expect(edited.request.body.rules[0]).toEqual({
      match: 'kaggle:*,casmi:*',
      settings: { question_mode: 'auto' },
    });
    apiError(
      edited,
      400,
      'bad_pattern',
      'a pattern is one or more IDs with * wildcards',
    );
    await settle(fixture);
    expect(text(page.querySelector('.errmsg'))).toContain(
      'a pattern is one or more IDs',
    );
    expect(page.querySelector('.editor')).not.toBeNull();
    button(page.querySelector('.editor')!, 'Cancel')!.click();
    await settle(fixture);

    button(page, 'Move rule 1 down')!.click();
    const moved = patch();
    expect(
      moved.request.body.rules.map((r: { match: string }) => r.match),
    ).toEqual(['a:*', 'kaggle:*']);
    moved.flush(view({ rules: moved.request.body.rules }));
    await settle(fixture);
    expect(button(page, 'Move rule 1 up')!.disabled).toBe(true);
    expect(button(page, 'Move rule 2 down')!.disabled).toBe(true);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    button(page.querySelector('tr[data-rule="2"]')!, 'Remove')!.click();
    expect(confirm).toHaveBeenCalledWith('Remove rule 2 (kaggle:*)?');
    expect(patch().request.body).toEqual({
      rules: [{ match: 'a:*', settings: { min_interval: '5m' } }],
    });
    confirm.mockRestore();
  });

  it("agents' own values: admin adds, changes and removes one", async () => {
    const page = await open();
    const own = page.querySelector(
      'table.agent-values ' +
        'tr[data-agent="kaggle:lead"][data-key="min_interval"]',
    )!;
    expect(text(own.querySelector('td.value'))).toBe('2m');
    expect(own.querySelector('td.id a.id-link')!.getAttribute('href')).toBe(
      '/agents?agent=kaggle:lead',
    );
    for (const c of ['id', 'key'])
      expect(own.querySelector(`td.${c}`)!.classList, c).toContain('id-like');
    // A rule's pattern too.
    const match = page.querySelector('table.rules tr[data-rule="1"] td.match')!;
    expect(match.classList).toContain('id-like');
    expect(parts(match)).toEqual(['kaggle:', '*']);
    expect(parts(own.querySelector('td.key'))).toEqual(['min_', 'interval']);
    expect(text(own.querySelector('td.id code'))).toBe('kaggle:lead');
    expect(
      [...page.querySelectorAll('#known-agents option')].map((o) =>
        o.getAttribute('value'),
      ),
    ).toEqual(['kaggle:lead', 'kaggle:worker']);

    type(page.querySelector('#agent-value-id'), 'kaggle:worker');
    choose(page.querySelector('#agent-value-key'), 'question_mode');
    await settle(fixture);
    choose(
      page.querySelector('select[aria-label="Value for the agent"]'),
      'auto',
    );
    await settle(fixture);
    button(page.querySelector('.add-row')!, 'Add')!.click();
    const added = patch();
    expect(added.request.body).toEqual({
      agents: { 'kaggle:worker': { question_mode: 'auto' } },
    });
    const both = {
      'kaggle:lead': { min_interval: '2m' },
      'kaggle:worker': { question_mode: 'auto' },
    };
    added.flush(view({ agents: both }));
    await settle(fixture);
    expect(
      page.querySelectorAll('table.agent-values tbody tr[data-agent]').length,
    ).toBe(2);
    expect(
      (page.querySelector('#agent-value-key') as HTMLSelectElement).value,
    ).toBe('question_mode');
    expect(
      (page.querySelector('#agent-value-id') as HTMLInputElement).value,
    ).toBe('');

    const lead = () =>
      page.querySelector('table.agent-values tr[data-agent="kaggle:lead"]')!;
    button(lead(), 'Change')!.click();
    await settle(fixture);
    type(lead().querySelector('input[type=text]'), '4m');
    await settle(fixture);
    button(lead(), 'Save')!.click();
    const changed = patch();
    expect(changed.request.body).toEqual({
      agents: { 'kaggle:lead': { min_interval: '4m' } },
    });
    changed.flush(view({ agents: { 'kaggle:lead': { min_interval: '4m' } } }));
    await settle(fixture);
    expect(text(lead().querySelector('td.value'))).toBe('4m');

    button(lead(), 'Remove')!.click();
    expect(patch().request.body).toEqual({
      agents: { 'kaggle:lead': { min_interval: null } },
    });
  });

  it('shows the values resolved for one agent and where they come from', async () => {
    const page = await open();
    type(page.querySelector('#resolve-agent'), 'kaggle:lead');
    button(page, 'Show')!.click();
    const req = http.expectOne(
      (r) =>
        r.url === '/v1/settings' && r.params.get('agent') === 'kaggle:lead',
    );
    req.flush({
      agent: 'kaggle:lead',
      values: { min_interval: '2m', question_mode: 'auto', history_days: 30 },
      sources: {
        min_interval: 'agent',
        question_mode: 'rule 1 (kaggle:*)',
        history_days: 'default',
      },
    });
    await settle(fixture);
    const result = page.querySelector('table.resolved')!;
    const heading = result.querySelector('thead a.id-link')!;
    // The agent in the heading and the keys stay on one line.
    expect(heading.closest('app-agent-link')!.classList).toContain('id-like');
    const key = result.querySelector('tr[data-key="min_interval"] td.key')!;
    expect(key.classList).toContain('id-like');
    expect(parts(key)).toEqual(['min_', 'interval']);
    expect(parts(heading)).toEqual(['kaggle:', 'lead']);
    expect(heading.getAttribute('href')).toBe('/agents?agent=kaggle:lead');
    expect(text(heading.closest('th'))).toBe('Value for kaggle:lead');
    expect(
      text(result.querySelector('tr[data-key="min_interval"] td.from')),
    ).toBe("the agent's own value");
    expect(
      text(result.querySelector('tr[data-key="question_mode"] td.from')),
    ).toBe('rule 1 (kaggle:*)');
    expect(
      text(result.querySelector('tr[data-key="history_days"] td.from')),
    ).toBe('built-in default');
    expect(
      text(result.querySelector('tr[data-key="question_mode"] td.value')),
    ).toBe('auto');
  });
});
