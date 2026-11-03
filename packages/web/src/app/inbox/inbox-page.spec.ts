/*
 * Unit tests of the Inbox page against a mocked server: the open items with
 * their kind, agent, title, body and time, answering a message and closing an
 * item (the list refreshes after each) with the result in the toolbar, Show
 * Closed with the answers given, the empty inbox, a failed answer, "Updated" in
 * the footer, and the 10 s refresh (one at a time).
 */

import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  apiError,
  button,
  el,
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
    ).toEqual(['Time', 'Kind', 'Agent', 'Item', '']);
    const rows = [...page.querySelectorAll('table.inbox tr[data-item]')];
    expect(rows.map((r) => r.getAttribute('data-item'))).toEqual([
      'ib_1',
      'ib_2',
    ]);
    const message = row(page, 'ib_1');
    const time = message.querySelector('td.time')!;
    expect(time.getAttribute('title')).toBe('2026-10-28T10:00:00.000Z');
    expect(text(time)).toBe(localTime('2026-10-28T10:00:00.000Z'));
    expect(text(message.querySelector('td.kind'))).toBe('message');
    expect(message.querySelector('td.agent code')!.innerHTML).toBe(
      'kaggle:<wbr>lead',
    );
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
    expect(text(alert.querySelector('td.kind'))).toBe('alert');
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

  it('Show Closed lists closed items too, with the answer given', async () => {
    const page = await open([ITEMS[1]!]);
    const toggle = page.querySelector('#show-closed') as HTMLInputElement;
    expect(text(page.querySelector('label[for="show-closed"]'))).toBe(
      'Show Closed',
    );
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
});
