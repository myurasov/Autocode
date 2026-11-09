/*
 * Unit tests of the Inbox page against a mocked server: the open items with
 * their kind, agent (a link to its row on the Agents page), who they were sent
 * to, title, body and time; answering a message and closing an item (the list
 * refreshes after each) with the result in the toolbar; asks (tier 0d): a
 * question answered by an option, its own words or a form of several
 * questions, a permission allowed once, always (after a confirmation) or
 * rejected with a reason, an approval approved or rejected with an option and
 * a note, their notes and expiry, the server's error when someone answered
 * first; Closed with the answers given; the empty inbox; a failed
 * answer; "Updated" in the footer; and the 10 s refresh (one at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  apiError,
  button,
  el,
  parts,
  settle,
  setup,
  signedIn,
  text,
  type,
} from '../../testing/helpers';
import { REFRESH_MS } from '../agents/agents-page';
import type { InboxItem } from '../api';
import { localTime } from '../format';
import { InboxPage } from './inbox-page';

const ITEMS: InboxItem[] = [
  {
    id: 'ib_1',
    kind: 'message',
    agent: 'kaggle:lead',
    message_id: 'msg_1',
    title: 'Message from kaggle:lead: "Plan"',
    body: 'Line one.\nLine two.',
    created_at: '2026-10-28T10:00:00.000Z',
    closed_at: null,
    answer: null,
  },
  {
    id: 'ib_2',
    kind: 'alert',
    agent: 'kaggle:worker',
    message_id: null,
    title: 'The check of wake standup failed three times',
    body: 'exit 2',
    created_at: '2026-10-28T11:00:00.000Z',
    closed_at: null,
    answer: null,
  },
];

const ANSWERED: InboxItem = {
  ...ITEMS[0]!,
  closed_at: '2026-10-28T12:00:00.000Z',
  answer: 'Yes, go on.',
};

describe('InboxPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<InboxPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(items = ITEMS, all = false): void {
    const req = http.expectOne((r) => r.url === '/v1/inbox');
    expect(req.request.params.get('all')).toBe(all ? '1' : null);
    req.flush({ items });
  }

  async function open(items = ITEMS): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(InboxPage);
    load(items);
    await settle(fixture);
    return el(fixture);
  }

  const row = (page: HTMLElement, id: string) =>
    page.querySelector(`table.inbox tr[data-item="${id}"]`)!;

  it('lists the open items with kind, agent, title, body and local time (ISO in the tooltip)', async () => {
    const page = await open();
    expect(page.querySelector('h2')).toBeNull();
    // When the list last loaded: in the footer, the page's last item.
    expect(page.querySelector('.toolbar app-updated')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.inbox thead th')].map((th) => text(th)),
    ).toEqual(['Time', 'Kind', 'Agent', 'Sent To', 'Item', '']);
    const rows = [...page.querySelectorAll('table.inbox tr[data-item]')];
    expect(rows.map((r) => r.getAttribute('data-item'))).toEqual([
      'ib_1',
      'ib_2',
    ]);
    const message = row(page, 'ib_1');
    const time = message.querySelector('td.time')!;
    expect(time.getAttribute('title')).toBe('2026-10-28T10:00:00.000Z');
    expect(text(time)).toBe(localTime('2026-10-28T10:00:00.000Z'));
    expect(text(message.querySelector('td.kind'))).toBe('Message');
    expect(text(message.querySelector('td.sent-to'))).toBe('owner');
    expect(parts(message.querySelector('td.agent code'))).toEqual([
      'kaggle:',
      'lead',
    ]);
    // An agent ID breaks only after ":" (the owner, 2026-11-03).
    expect(message.querySelector('td.agent')!.classList).toContain('id-like');
    expect(message.querySelector('td.item')!.classList).not.toContain(
      'id-like',
    );
    expect(
      message.querySelector('td.agent a.id-link')!.getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    expect(text(message.querySelector('.title'))).toBe(
      'Message from kaggle:lead: "Plan"',
    );
    // The body keeps its lines.
    expect(message.querySelector('.body')!.textContent).toBe(
      'Line one.\nLine two.',
    );
    expect(
      message.querySelector('textarea[aria-label="Answer"]'),
    ).not.toBeNull();
    expect(button(message, 'Answer')!.disabled).toBe(true);
    expect(button(message, 'Close')!.disabled).toBe(false);
    // An alert is closed, not answered.
    const alert = row(page, 'ib_2');
    expect(text(alert.querySelector('td.kind'))).toBe('Alert');
    expect(alert.querySelector('textarea')).toBeNull();
    expect(button(alert, 'Answer')).toBeUndefined();
    expect(button(alert, 'Close')).toBeDefined();
  });

  it('admin answers a message: the answer goes out and the list refreshes without it', async () => {
    const page = await open();
    const message = row(page, 'ib_1');
    type(message.querySelector('textarea'), 'Yes, go on.');
    await settle(fixture);
    expect(button(message, 'Answer')!.disabled).toBe(false);
    button(message, 'Answer')!.click();
    const req = http.expectOne('/v1/inbox/ib_1/answer');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ text: 'Yes, go on.' });
    req.flush({ item: ANSWERED });
    await settle(fixture);
    load([ITEMS[1]!]);
    await settle(fixture);
    expect(page.querySelector('tr[data-item="ib_1"]')).toBeNull();
    // The result shows in the toolbar, right after Refresh.
    const toolbar = page.querySelector('.toolbar')!;
    const notice = toolbar.querySelector('.notice')!;
    expect(text(notice)).toBe('Sent the answer to kaggle:lead.');
    expect(
      button(toolbar, 'Refresh')!.nextElementSibling!.contains(notice),
    ).toBe(true);
    expect(page.querySelector('p.notice')).toBeNull();
  });

  it('admin closes an item, and the list refreshes without it', async () => {
    const page = await open();
    button(row(page, 'ib_2'), 'Close')!.click();
    const req = http.expectOne('/v1/inbox/ib_2/close');
    expect(req.request.method).toBe('POST');
    req.flush({
      item: { ...ITEMS[1]!, closed_at: '2026-10-28T12:00:00.000Z' },
    });
    await settle(fixture);
    load([ITEMS[0]!]);
    await settle(fixture);
    expect(page.querySelector('tr[data-item="ib_2"]')).toBeNull();
    expect(text(page.querySelector('.toolbar .notice'))).toBe(
      'Closed the alert about kaggle:worker.',
    );
  });

  // The box is "Closed" (the owner, 2026-11-09).
  it('Closed lists closed items too, with the answer given', async () => {
    const page = await open([ITEMS[1]!]);
    const toggle = page.querySelector('#show-closed') as HTMLInputElement;
    expect(text(page.querySelector('label[for="show-closed"]'))).toBe('Closed');
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    load([ANSWERED, ITEMS[1]!], true);
    await settle(fixture);
    const closed = row(page, 'ib_1');
    expect(closed.classList).toContain('closed');
    expect(text(closed.querySelector('.answer'))).toBe('Answer: Yes, go on.');
    expect(closed.querySelector('textarea')).toBeNull();
    expect(closed.querySelectorAll('button').length).toBe(0);
    const state = closed.querySelector('td.actions .muted')!;
    expect(text(state)).toBe('closed');
    expect(state.getAttribute('title')).toBe(
      localTime('2026-10-28T12:00:00.000Z'),
    );
    expect(row(page, 'ib_2').classList).not.toContain('closed');

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    load([ITEMS[1]!]);
    await settle(fixture);
    expect(page.querySelector('tr[data-item="ib_1"]')).toBeNull();
  });

  it('says when the inbox is empty', async () => {
    const page = await open([]);
    expect(text(page.querySelector('table.inbox tbody'))).toBe(
      'Nothing in the inbox.',
    );
  });

  it('shows why an answer failed and keeps the text', async () => {
    const page = await open();
    const message = row(page, 'ib_1');
    type(message.querySelector('textarea'), 'Yes.');
    await settle(fixture);
    button(message, 'Answer')!.click();
    apiError(
      http.expectOne('/v1/inbox/ib_1/answer'),
      409,
      'closed',
      'inbox item ib_1 is closed',
    );
    await settle(fixture);
    expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
      'inbox item ib_1 is closed',
    );
    expect(page.querySelector('p.errmsg')).toBeNull();
    expect(
      (message.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('Yes.');
  });

  it('refreshes every 10 seconds, one refresh at a time, keeping a typed answer', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(InboxPage);
      load();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      const field = () =>
        el(fixture).querySelector(
          'tr[data-item="ib_1"] textarea',
        ) as HTMLTextAreaElement;
      type(field(), 'Half an ans');
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone((r) => r.url === '/v1/inbox');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne((r) => r.url === '/v1/inbox');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone((r) => r.url === '/v1/inbox');
      req.flush({ items: ITEMS });
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
      expect(field().value).toBe('Half an ans');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  describe('asks: questions, permissions and approvals', () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const BASE = {
      agent: 'team:worker',
      routed: 'owner',
      notes: [] as string[],
      state: 'open',
      created_at: '2026-10-28T12:00:00.000Z',
      expires: null,
    };
    // One question with options; two questions (one of several choices, one
    // free) sent to another agent, which could not answer; a permission; an
    // approval with options that expires.
    function asks(): InboxItem[] {
      return [
        {
          ...BASE,
          id: 'ask_q1',
          kind: 'question',
          title: 'Question from team:worker: Which fold?',
          questions: [
            {
              question: 'Which fold split should I use?',
              options: ['v3', 'v2'],
              multiple: false,
            },
          ],
        },
        {
          ...BASE,
          id: 'ask_q2',
          kind: 'question',
          title: 'Question from team:worker: Data',
          routed: 'agent:team:lead',
          notes: ['team:lead cannot answer: not my area'],
          questions: [
            {
              question: 'Which data sets?',
              options: ['train', 'test', 'extra'],
              multiple: true,
            },
            { question: 'How many epochs?', options: [], multiple: false },
          ],
        },
        {
          ...BASE,
          id: 'ask_p1',
          kind: 'permission',
          title: 'Permission for team:worker: shell rm -rf build, rm -rf dist',
          action: 'shell',
          resources: ['rm -rf build', 'rm -rf dist'],
          message: 'Clean the build folders.',
          decisions: ['once', 'always', 'reject'],
        },
        {
          ...BASE,
          id: 'ask_a1',
          kind: 'approval',
          agent: 'team:lead',
          title: 'Approval for team:lead: Deploy the new model.',
          expires: at(570_000),
          text: 'Deploy the new model.\nIt replaces v2.',
          options: ['now', 'tonight'],
        },
      ];
    }

    // The ask's answer call: its body; the server answers with the ask, then
    // the list reloads.
    async function answered(id: string, list = asks()): Promise<unknown> {
      const req = http.expectOne(`/v1/asks/${id}/answer`);
      expect(req.request.method).toBe('POST');
      const body = req.request.body;
      req.flush({ ask: { id, state: 'answered' } });
      await settle(fixture);
      load(list.filter((a) => a.id !== id));
      await settle(fixture);
      return body;
    }

    // The list again, the asks open as before.
    async function again(page: HTMLElement, list = asks()): Promise<void> {
      button(page, 'Refresh')!.click();
      load(list);
      await settle(fixture);
    }

    const notice = (page: HTMLElement) =>
      text(page.querySelector('.toolbar .notice'));

    it('lists asks beside messages and alerts: kind, agent, Sent To, title, notes and expiry', async () => {
      const list = asks();
      const page = await open([...ITEMS, ...list]);
      expect(
        [...page.querySelectorAll('table.inbox tr[data-item]')].map((r) =>
          text(r.querySelector('td.kind')),
        ),
      ).toEqual([
        'Message',
        'Alert',
        'Question',
        'Question',
        'Permission',
        'Approval',
      ]);
      const q1 = row(page, 'ask_q1');
      expect(text(q1.querySelector('.title'))).toBe(
        'Question from team:worker: Which fold?',
      );
      expect(q1.querySelector('td.agent a.id-link')!.getAttribute('href')).toBe(
        '/agents?agent=team:worker',
      );
      expect(text(q1.querySelector('td.sent-to'))).toBe('owner');
      expect(q1.querySelector('td.sent-to')!.classList).toContain('id-like');
      // Sent to another agent: a link to it; its note under the title.
      const q2 = row(page, 'ask_q2');
      expect(
        q2.querySelector('td.sent-to a.id-link')!.getAttribute('href'),
      ).toBe('/agents?agent=team:lead');
      expect([...q2.querySelectorAll('.note')].map((n) => text(n))).toEqual([
        'Note: team:lead cannot answer: not my area',
      ]);
      expect(q2.querySelector('.title + .note')).not.toBeNull();
      // An approval's expiry: when, and how long from now.
      const approval = row(page, 'ask_a1');
      const expires = approval.querySelector('.expires')!;
      expect(text(expires)).toBe(
        `expires ${localTime(list[3]!.expires)} (in 9m)`,
      );
      expect(expires.getAttribute('title')).toBe(list[3]!.expires);
      expect(q1.querySelector('.expires')).toBeNull();
      // Asks are answered, not closed.
      for (const id of ['ask_q1', 'ask_q2', 'ask_p1', 'ask_a1'])
        expect(button(row(page, id), 'Close'), id).toBeUndefined();
    });

    it('a question with options: a click on an option answers it at once; its own words go with Answer', async () => {
      const page = await open(asks());
      const confirm = vi.spyOn(window, 'confirm');
      try {
        const q1 = row(page, 'ask_q1');
        expect(text(q1.querySelector('.question .ask-text'))).toBe(
          'Which fold split should I use?',
        );
        const options = [...q1.querySelectorAll('button.option')];
        expect(options.map((b) => text(b))).toEqual(['v3', 'v2']);
        (options[0] as HTMLButtonElement).click();
        expect(await answered('ask_q1')).toEqual({ text: 'v3' });
        expect(confirm).not.toHaveBeenCalled();
        expect(notice(page)).toBe('Answered question from team:worker.');
        expect(page.querySelector('tr[data-item="ask_q1"]')).toBeNull();
      } finally {
        confirm.mockRestore();
      }

      // Its own words, for the same question asked again.
      await again(page);
      const q1 = row(page, 'ask_q1');
      const answer = button(q1, 'Answer')!;
      expect(answer.disabled).toBe(true);
      type(q1.querySelector('input[aria-label="Your answer"]'), ' v4 ');
      await settle(fixture);
      expect(answer.disabled).toBe(false);
      answer.click();
      expect(await answered('ask_q1')).toEqual({ text: 'v4' });
    });

    it('several questions, or several choices: a form, one answer per question', async () => {
      const page = await open(asks());
      const q2 = row(page, 'ask_q2');
      expect(
        [...q2.querySelectorAll('.question .ask-text')].map((q) => text(q)),
      ).toEqual(['Which data sets? (one or more)', 'How many epochs?']);
      // No buttons that answer at once here: the choices are checkboxes.
      expect(q2.querySelector('button.option')).toBeNull();
      const boxes = [
        ...q2.querySelectorAll('input[type="checkbox"]'),
      ] as HTMLInputElement[];
      expect(boxes.map((b) => b.closest('label')!.textContent!.trim())).toEqual(
        ['train', 'test', 'extra'],
      );
      const answer = button(q2, 'Answer')!;
      for (const box of [boxes[0]!, boxes[2]!]) {
        box.checked = true;
        box.dispatchEvent(new Event('change'));
      }
      await settle(fixture);
      // Every question needs an answer.
      expect(answer.disabled).toBe(true);
      type(q2.querySelector('input[aria-label="Answer to question 2"]'), '12');
      await settle(fixture);
      expect(answer.disabled).toBe(false);
      answer.click();
      expect(await answered('ask_q2')).toEqual({
        answers: ['train, extra', '12'],
      });
    });

    it('a single choice of several questions is a radio button; typed words win over it', async () => {
      const two: InboxItem = {
        ...asks()[1]!,
        questions: [
          { question: 'Which fold?', options: ['v3', 'v2'], multiple: false },
          { question: 'Why?', options: [], multiple: false },
        ],
      };
      const page = await open([two]);
      const item = row(page, 'ask_q2');
      const radios = [
        ...item.querySelectorAll('input[type="radio"]'),
      ] as HTMLInputElement[];
      expect(radios.map((r) => r.name)).toEqual(['ask_q2-q0', 'ask_q2-q0']);
      radios[1]!.checked = true;
      radios[1]!.dispatchEvent(new Event('change'));
      type(
        item.querySelector('input[aria-label="Answer to question 1"]'),
        'v5',
      );
      type(
        item.querySelector('input[aria-label="Answer to question 2"]'),
        'newer',
      );
      await settle(fixture);
      button(item, 'Answer')!.click();
      expect(await answered('ask_q2', [two])).toEqual({
        answers: ['v5', 'newer'],
      });
    });

    it('a permission: its action and resources; Allow Once, Allow Always after a confirmation, Reject with an optional reason', async () => {
      const page = await open(asks());
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      try {
        const p1 = () => row(page, 'ask_p1');
        expect(text(p1().querySelector('.action'))).toBe('Action: shell');
        expect(
          [...p1().querySelectorAll('.resources code')].map((c) => text(c)),
        ).toEqual(['rm -rf build', 'rm -rf dist']);
        expect(text(p1().querySelector('.ask-text'))).toBe(
          'Clean the build folders.',
        );
        button(p1(), 'Allow Once')!.click();
        expect(await answered('ask_p1', asks())).toEqual({ decision: 'once' });
        expect(notice(page)).toBe('Answered permission from team:worker.');
        await again(page);

        // Always: OpenCode saves the rule, so it asks first.
        button(p1(), 'Allow Always')!.click();
        expect(confirm).toHaveBeenCalledWith(
          'Allow always?\n\nOpenCode saves the rule for the project.',
        );
        http.expectNone('/v1/asks/ask_p1/answer');
        confirm.mockReturnValue(true);
        button(p1(), 'Allow Always')!.click();
        expect(await answered('ask_p1', asks())).toEqual({
          decision: 'always',
        });
        await again(page);

        // Reject, with the reason typed beside it.
        const reason = p1().querySelector(
          'input[aria-label="Reason to reject"]',
        ) as HTMLInputElement;
        expect(reason.nextElementSibling).toBe(button(p1(), 'Reject'));
        type(reason, ' not the build folder ');
        await settle(fixture);
        button(p1(), 'Reject')!.click();
        expect(await answered('ask_p1', asks())).toEqual({
          decision: 'reject',
          text: 'not the build folder',
        });
        await again(page);
        button(p1(), 'Reject')!.click();
        expect(await answered('ask_p1')).toEqual({ decision: 'reject' });
      } finally {
        confirm.mockRestore();
      }
    });

    it('an approval: its text, its options as radio buttons, a note, Approve or Reject', async () => {
      const page = await open(asks());
      const a1 = () => row(page, 'ask_a1');
      expect(a1().querySelector('.ask-text')!.textContent).toBe(
        'Deploy the new model.\nIt replaces v2.',
      );
      // its text once: the title names the agent only (the owner, 2026-11-07)
      expect(text(a1().querySelector('.title'))).toBe('Approval for team:lead');
      expect(a1().textContent!.split('Deploy the new model.').length).toBe(2);
      const radios = [
        ...a1().querySelectorAll('input[type="radio"]'),
      ] as HTMLInputElement[];
      expect(
        radios.map((r) => r.closest('label')!.textContent!.trim()),
      ).toEqual(['now', 'tonight']);
      radios[1]!.checked = true;
      radios[1]!.dispatchEvent(new Event('change'));
      type(a1().querySelector('input[aria-label="Note"]'), 'after 22:00');
      await settle(fixture);
      button(a1(), 'Approve')!.click();
      expect(await answered('ask_a1', asks())).toEqual({
        decision: 'approve',
        option: 'tonight',
        text: 'after 22:00',
      });
      expect(notice(page)).toBe('Answered approval from team:lead.');
      await again(page);
      button(a1(), 'Reject')!.click();
      expect(await answered('ask_a1')).toEqual({ decision: 'reject' });
    });

    it("shows the server's message when someone answered first, and reloads", async () => {
      const page = await open(asks());
      (
        row(page, 'ask_q1').querySelector('button.option') as HTMLElement
      ).click();
      apiError(
        http.expectOne('/v1/asks/ask_q1/answer'),
        409,
        'ask_closed',
        'ask ask_q1 is already answered by team:lead',
      );
      await settle(fixture);
      load(asks().slice(1));
      await settle(fixture);
      expect(text(page.querySelector('.toolbar .errmsg'))).toBe(
        'ask ask_q1 is already answered by team:lead',
      );
      expect(page.querySelector('tr[data-item="ask_q1"]')).toBeNull();
    });

    it('Closed: a closed ask shows its answer, who gave it, and its state, without buttons', async () => {
      const closed = (item: InboxItem, change: Partial<InboxItem>) => ({
        ...item,
        state: 'answered',
        closed_at: '2026-10-28T13:00:00.000Z',
        ...change,
      });
      const [q1, q2, p1, a1] = asks();
      const page = await open([
        closed(q1!, { answer: { answer: { q0: 'v3' } }, by: 'owner' }),
        closed(q2!, {
          answer: { answer: { q0: ['train', 'extra'], q1: '12' } },
          by: 'team:lead',
        }),
        closed(p1!, {
          answer: { decision: 'reject', text: 'not here' },
          by: 'owner',
        }),
        closed(a1!, {
          answer: { decision: 'approve', option: 'tonight', text: 'late' },
          by: 'owner',
        }),
        closed(q1!, {
          id: 'ask_q3',
          routed: 'auto',
          answer: { cancel: 'Use your judgement.' },
          by: 'auto',
        }),
        closed(a1!, { id: 'ask_a2', state: 'expired', answer: null, by: null }),
      ]);
      const answer = (id: string) =>
        text(row(page, id).querySelector('.answer'));
      expect(answer('ask_q1')).toBe('Answer: v3 (by the owner)');
      expect(answer('ask_q2')).toBe('Answer: train, extra; 12 (by team:lead)');
      expect(answer('ask_p1')).toBe('Answer: reject: not here (by the owner)');
      expect(answer('ask_a1')).toBe(
        'Answer: approve tonight: late (by the owner)',
      );
      // a closed approval still says what was asked, once
      expect(text(row(page, 'ask_a1').querySelector('.title'))).toBe(
        'Approval for team:lead',
      );
      expect(row(page, 'ask_a1').querySelector('.ask-text')!.textContent).toBe(
        'Deploy the new model.\nIt replaces v2.',
      );
      expect(answer('ask_q3')).toBe(
        'Answer: dismissed: Use your judgement. (at once)',
      );
      expect(text(row(page, 'ask_q3').querySelector('td.sent-to'))).toBe(
        'answered at once',
      );
      expect(
        row(page, 'ask_q3').querySelector('td.sent-to')!.classList,
      ).not.toContain('id-like');
      expect(row(page, 'ask_a2').querySelector('.answer')).toBeNull();
      for (const id of ['ask_q1', 'ask_q2', 'ask_p1', 'ask_a1', 'ask_q3'])
        expect(text(row(page, id).querySelector('td.actions')), id).toBe(
          'answered',
        );
      expect(text(row(page, 'ask_a2').querySelector('td.actions'))).toBe(
        'expired',
      );
      expect(page.querySelectorAll('table.inbox button').length).toBe(0);
      expect(page.querySelectorAll('table.inbox input').length).toBe(0);
    });
  });
});
