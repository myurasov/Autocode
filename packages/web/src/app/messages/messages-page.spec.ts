/*
 * Unit tests of the Messages page against a mocked server: every message,
 * newest first, with its ID, time, sender, recipient, subject, kind, size and
 * state, and its text in a row below it on a click; the Send a Message form,
 * collapsed until opened, that sends as the owner to one ID, a pattern or a
 * list (the recipients on success, the server's message on failure);
 * "Updated" in the footer; and the 10 s refresh (one at a time).
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
import type { Message } from '../api';
import { localTime } from '../format';
import { MessagesPage, recipients } from './messages-page';

const MESSAGES: Message[] = [
  {
    id: 'msg_2',
    send_id: 'snd_2',
    from: 'owner',
    to: 'kaggle:lead',
    subject: '',
    reply_to: 'msg_1',
    kind: 'text',
    mime: null,
    size: 12,
    state: 'queued',
    created_at: '2026-10-28T11:00:00.000Z',
    delivered_at: null,
    read_at: null,
  },
  {
    id: 'msg_1',
    send_id: 'snd_1',
    from: 'kaggle:lead',
    to: 'owner',
    subject: 'Plan',
    reply_to: null,
    kind: 'binary',
    mime: 'image/png',
    size: 20480,
    state: 'read',
    created_at: '2026-10-28T10:00:00.000Z',
    delivered_at: '2026-10-28T10:00:01.000Z',
    read_at: '2026-10-28T10:05:00.000Z',
  },
];

// What a field of the page holds.
const value = (page: HTMLElement, selector: string) =>
  (page.querySelector(selector) as HTMLInputElement).value;

describe('MessagesPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<MessagesPage>;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => http.verify());

  function load(messages = MESSAGES): void {
    const req = http.expectOne((r) => r.url === '/v1/messages');
    expect(req.request.method).toBe('GET');
    req.flush({ messages });
  }

  async function open(messages = MESSAGES): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(MessagesPage);
    load(messages);
    await settle(fixture);
    return el(fixture);
  }

  it('lists every message, newest first, with ID, time, from, to, subject, kind, size and state', async () => {
    const page = await open();
    // When the list last loaded: in the footer, the page's last item.
    expect(page.querySelector('.toolbar app-updated')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.messages thead th')].map((th) =>
        text(th),
      ),
    ).toEqual(['ID', 'Time', 'From', 'To', 'Subject', 'Kind', 'Size', 'State']);
    const rows = [...page.querySelectorAll('table.messages tr[data-message]')];
    expect(rows.map((r) => r.getAttribute('data-message'))).toEqual([
      'msg_2',
      'msg_1',
    ]);
    const cells = (r: Element) =>
      [...r.querySelectorAll('td')].map((td) => text(td));
    expect(cells(rows[0]!)).toEqual([
      'msg_2',
      localTime('2026-10-28T11:00:00.000Z'),
      'owner',
      'kaggle:lead',
      '',
      'text',
      '12',
      'queued',
    ]);
    expect(cells(rows[1]!)).toEqual([
      'msg_1',
      localTime('2026-10-28T10:00:00.000Z'),
      'kaggle:lead',
      'owner',
      'Plan',
      'image/png',
      '20,480',
      'read',
    ]);
    // Agent IDs are data (code that wraps after ":"); the owner is a word.
    expect(rows[0]!.querySelector('td.sender code')).toBeNull();
    expect(rows[0]!.querySelector('td.recipient code')!.innerHTML).toBe(
      'kaggle:<wbr>lead',
    );
    expect(rows[0]!.querySelector('td.time')!.getAttribute('title')).toBe(
      '2026-10-28T11:00:00.000Z',
    );
  });

  // The owner's read of a message: the whole message, its state unchanged.
  function read(id: string, body: Record<string, unknown>): void {
    const req = http.expectOne(`/v1/messages/${id}`);
    expect(req.request.method).toBe('GET');
    const listed = MESSAGES.find((m) => m.id === id)!;
    req.flush({ message: { ...listed, ...body } });
  }
  const row = (page: HTMLElement, id: string) =>
    page.querySelector(
      `table.messages tr[data-message="${id}"]`,
    ) as HTMLElement;
  const detail = (page: HTMLElement, id: string) =>
    page.querySelector(`table.messages tr.detail[data-detail="${id}"]`);
  const shown = (page: HTMLElement, id: string) =>
    detail(page, id)?.querySelector('.body')?.textContent;

  it('opens a message in a row below it on a click, with its lines, and closes it on the next', async () => {
    const page = await open();
    expect(detail(page, 'msg_2')).toBeNull();
    expect(row(page, 'msg_2').getAttribute('aria-expanded')).toBe('false');
    row(page, 'msg_2').click();
    await settle(fixture);
    read('msg_2', { text: 'Line one.\nLine two.' });
    await settle(fixture);
    const below = detail(page, 'msg_2')!;
    expect(below.previousElementSibling).toBe(row(page, 'msg_2'));
    expect(below.querySelector('td')!.getAttribute('colspan')).toBe('8');
    expect(shown(page, 'msg_2')).toBe('Line one.\nLine two.');
    expect(row(page, 'msg_2').getAttribute('aria-expanded')).toBe('true');
    row(page, 'msg_2').click();
    await settle(fixture);
    expect(detail(page, 'msg_2')).toBeNull();
    // Opened again (here with Enter): from what was read, without asking.
    row(page, 'msg_2').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    await settle(fixture);
    http.expectNone('/v1/messages/msg_2');
    expect(shown(page, 'msg_2')).toBe('Line one.\nLine two.');
    expect(row(page, 'msg_2').getAttribute('tabindex')).toBe('0');
  });

  it('a file says what it is; a read that fails says why', async () => {
    const page = await open();
    row(page, 'msg_1').click();
    await settle(fixture);
    read('msg_1', { data: 'iVBORw0KGgo=' });
    await settle(fixture);
    expect(shown(page, 'msg_1')).toBe(
      'A file (image/png, 20,480 characters of base64).',
    );
    row(page, 'msg_2').click();
    await settle(fixture);
    apiError(
      http.expectOne('/v1/messages/msg_2'),
      404,
      'no_message',
      'no message msg_2',
    );
    await settle(fixture);
    expect(text(detail(page, 'msg_2')!.querySelector('.errmsg'))).toBe(
      'no message msg_2',
    );
  });

  it('an open message stays open when the list refreshes', async () => {
    const page = await open();
    row(page, 'msg_2').click();
    await settle(fixture);
    read('msg_2', { text: 'Still here.' });
    await settle(fixture);
    button(page, 'Refresh')!.click();
    load();
    await settle(fixture);
    expect(shown(page, 'msg_2')).toBe('Still here.');
  });

  it('says when there are no messages yet', async () => {
    const page = await open([]);
    expect(text(page.querySelector('table.messages tbody'))).toBe(
      'No messages yet.',
    );
  });

  it('reads the To field as one ID or pattern, or a list when it has commas', () => {
    expect(recipients(' kaggle:lead ')).toBe('kaggle:lead');
    expect(recipients('team:*')).toBe('team:*');
    expect(recipients('a:b, c:*,,')).toEqual(['a:b', 'c:*']);
  });

  it('admin sends a message to a pattern and sees its recipients; the list refreshes', async () => {
    const page = await open();
    // The form starts collapsed, its title a line that opens it.
    const form = page.querySelector('details.panel') as HTMLDetailsElement;
    expect(form.open).toBe(false);
    const title = form.querySelector('summary') as HTMLElement;
    expect(form.firstElementChild).toBe(title);
    expect(text(title)).toBe('Send a Message');
    expect(form.querySelector('h3')).toBeNull();
    title.click();
    await settle(fixture);
    expect(form.open).toBe(true);
    const send = () => button(form, 'Send')!;
    expect(send().disabled).toBe(true);
    type(page.querySelector('#send-to'), 'team:*');
    type(page.querySelector('#send-text'), 'Status?');
    await settle(fixture);
    expect(send().disabled).toBe(false);
    send().click();
    const req = http.expectOne('/v1/messages');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ to: 'team:*', text: 'Status?' });
    req.flush(
      {
        send_id: 'snd_3',
        recipients: ['team:a', 'team:b'],
        messages: [
          { id: 'msg_3', to: 'team:a' },
          { id: 'msg_4', to: 'team:b' },
        ],
      },
      { status: 201, statusText: 'Created' },
    );
    await settle(fixture);
    load();
    await settle(fixture);
    // The result shows right after the Send button (the owner, 2026-11-02),
    // in the form, which stays open; no note about the sender.
    const result = form.querySelector('.buttons button + .notice');
    expect(text(result)).toBe('Sent to team:a, team:b.');
    expect(form.querySelectorAll('.notice').length).toBe(1);
    expect(form.textContent).not.toContain('Sent as the owner.');
    expect(form.open).toBe(true);
    expect(page.querySelector('.toolbar .notice')).toBeNull();
    // The text goes; the recipients stay for the next message.
    expect(value(page, '#send-text')).toBe('');
    expect(value(page, '#send-to')).toBe('team:*');
  });

  it('sends to a list with a subject', async () => {
    const page = await open();
    type(page.querySelector('#send-to'), 'a:b, c:d');
    type(page.querySelector('#send-subject'), 'Plan');
    type(page.querySelector('#send-text'), 'Read it.');
    await settle(fixture);
    button(page, 'Send')!.click();
    const req = http.expectOne('/v1/messages');
    expect(req.request.body).toEqual({
      to: ['a:b', 'c:d'],
      subject: 'Plan',
      text: 'Read it.',
    });
    req.flush({ send_id: 'snd_4', recipients: ['a:b', 'c:d'], messages: [] });
    await settle(fixture);
    load();
    await settle(fixture);
    expect(
      text(page.querySelector('details.panel .buttons button + .notice')),
    ).toBe('Sent to a:b, c:d.');
    expect(value(page, '#send-subject')).toBe('');
  });

  it('shows why a message was not sent, and keeps what was typed', async () => {
    const page = await open();
    type(page.querySelector('#send-to'), 'x:y');
    type(page.querySelector('#send-text'), 'Hello.');
    await settle(fixture);
    button(page, 'Send')!.click();
    apiError(
      http.expectOne('/v1/messages'),
      404,
      'no_recipient',
      'no agent x:y is registered',
    );
    await settle(fixture);
    expect(
      text(page.querySelector('details.panel .buttons button + .errmsg')),
    ).toBe('no agent x:y is registered');
    expect(page.querySelector('details.panel .notice')).toBeNull();
    expect(value(page, '#send-text')).toBe('Hello.');
  });

  it('shows why the messages did not load', async () => {
    signedIn();
    fixture = TestBed.createComponent(MessagesPage);
    apiError(
      http.expectOne((r) => r.url === '/v1/messages'),
      500,
      'internal',
      'database locked',
    );
    await settle(fixture);
    expect(text(el(fixture).querySelector('.errmsg'))).toBe('database locked');
  });

  it('refreshes every 10 seconds, one refresh at a time', async () => {
    vi.useFakeTimers();
    try {
      signedIn();
      fixture = TestBed.createComponent(MessagesPage);
      load();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      http.expectNone((r) => r.url === '/v1/messages');
      await vi.advanceTimersByTimeAsync(1);
      const req = http.expectOne((r) => r.url === '/v1/messages');
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      http.expectNone((r) => r.url === '/v1/messages');
      req.flush({ messages: MESSAGES });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      load();
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
