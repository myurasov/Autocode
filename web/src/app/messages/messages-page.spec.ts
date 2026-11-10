/*
 * Unit tests of the Messages page against a mocked server: every message,
 * newest first, with its ID, time, sender and recipient (an agent's a link
 * to its row on the Agents page; the owner and autocode are words), subject,
 * text (every message is text), size and state; a long text's first 200
 * characters, the whole text on a click anywhere in its cell (read once) and
 * back on the next; the Send a Message form, collapsed until opened, that
 * sends as the owner to one ID, a pattern or a list (the recipients on
 * success, the server's message on failure); "Updated" in the footer; and the
 * 10 s refresh (one at a time).
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
    size: 12,
    preview: 'Status, now?',
    state: 'queued',
    created_at: '2026-10-28T11:00:00.000Z',
    read_at: null,
    read_via: null,
  },
  {
    id: 'msg_1',
    send_id: 'snd_1',
    from: 'kaggle:lead',
    to: 'owner',
    subject: 'Plan',
    reply_to: null,
    size: 17,
    preview: 'Here is the plan.',
    state: 'read',
    created_at: '2026-10-28T10:00:00.000Z',
    read_at: '2026-10-28T10:00:01.000Z',
    read_via: 'inbox',
  },
];

// A long text message, of more than a thousand characters: the list has its
// first 200.
const LONG_TEXT =
  'Line one of a long report that goes on and on about the training run.\n' +
  'Line two: the loss went down, then up again, and the run stopped at ' +
  'epoch 12, after which the validation score fell by two points.\n' +
  'Line three: I restarted it from the checkpoint of epoch 10.\n' +
  `Line four: ${'what each epoch did, one by one. '.repeat(30).trim()}`;
const LONG: Message = {
  ...MESSAGES[0]!,
  id: 'msg_3',
  send_id: 'snd_3',
  from: 'kaggle:lead',
  to: 'owner',
  subject: 'Report',
  size: LONG_TEXT.length,
  preview: LONG_TEXT.slice(0, 200),
  state: 'read',
  read_via: 'steer',
};

// An opened text's lines as markdown shows them (one <br> a line break).
const wholeLines = (page: HTMLElement, id: string) => {
  const md = page.querySelector(
    `table.messages tr[data-message="${id}"] td.text app-markdown`,
  );
  return md ? (md.querySelector('p')!.innerHTML.split('<br>') as string[]) : [];
};

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

  // The page, with its Read box on (every message) unless told otherwise.
  async function open(messages = MESSAGES, read = true): Promise<HTMLElement> {
    signedIn();
    fixture = TestBed.createComponent(MessagesPage);
    load(messages);
    await settle(fixture);
    const box = el(fixture).querySelector('#show-read') as HTMLInputElement;
    if (read && box && !box.checked) {
      box.click();
      await settle(fixture);
    }
    return el(fixture);
  }

  it('lists every message, newest first, with ID, time, from, to, subject, text, size and state; no kind, as every message is text', async () => {
    const page = await open();
    // When the list last loaded: in the footer, the page's last item.
    expect(page.querySelector('.toolbar app-updated')).toBeNull();
    expect(page.lastElementChild!.tagName).toBe('FOOTER');
    expect(text(page.querySelector('footer'))).toBe('Updated 0s ago.');
    expect(
      [...page.querySelectorAll('table.messages thead th')].map((th) =>
        text(th),
      ),
    ).toEqual(['ID', 'Time', 'From', 'To', 'Subject', 'Text', 'Size', 'State']);
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
      'Status, now?',
      '12',
      'queued',
    ]);
    expect(cells(rows[1]!)).toEqual([
      'msg_1',
      localTime('2026-10-28T10:00:00.000Z'),
      'kaggle:lead',
      'owner',
      'Plan',
      'Here is the plan.',
      '17',
      'read (inbox)',
    ]);
    // when it was read, in the tooltip (the owner, 2026-11-09)
    expect(rows[1]!.querySelector('td.state')!.getAttribute('title')).toBe(
      `Read ${localTime('2026-10-28T10:00:01.000Z')}, in your Inbox`,
    );
    expect(rows[0]!.querySelector('td.state')!.getAttribute('title')).toBe(
      'Waiting for its recipient',
    );
    expect(page.querySelector('table.messages td.kind')).toBeNull();
    // Agent IDs are data (code that wraps after ":") that links to the
    // agent's row on the Agents page; the owner is a word.
    expect(rows[0]!.querySelector('td.sender code')).toBeNull();
    expect(rows[0]!.querySelector('td.sender a')).toBeNull();
    expect(parts(rows[0]!.querySelector('td.recipient code'))).toEqual([
      'kaggle:',
      'lead',
    ]);
    expect(parts(rows[0]!.querySelector('td.sender'))).toEqual(['owner']);
    expect(parts(rows[0]!.querySelector('td.id'))).toEqual(['msg_', '2']);
    // IDs break only after ":" or "_" (the owner, 2026-11-03); the rest
    // wraps.
    for (const c of ['id', 'sender', 'recipient'])
      expect(rows[0]!.querySelector(`td.${c}`)!.classList, c).toContain(
        'id-like',
      );
    for (const c of ['time', 'subject', 'text', 'state'])
      expect(rows[0]!.querySelector(`td.${c}`)!.classList, c).not.toContain(
        'id-like',
      );
    expect(
      rows[0]!.querySelector('td.recipient a.id-link')!.getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    expect(
      rows[1]!.querySelector('td.sender a.id-link')!.getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
    expect(rows[1]!.querySelector('td.recipient a')).toBeNull();
    expect(rows[0]!.querySelector('td.time')!.getAttribute('title')).toBe(
      '2026-10-28T11:00:00.000Z',
    );
  });

  // The owner's read of a message: the whole message, its state unchanged.
  function read(id: string, body: Record<string, unknown>): void {
    const req = http.expectOne(`/v1/messages/${id}`);
    expect(req.request.method).toBe('GET');
    req.flush({ message: { ...LONG, id, ...body } });
  }
  const cell = (page: HTMLElement, id: string) =>
    page.querySelector(
      `table.messages tr[data-message="${id}"] td.text`,
    ) as HTMLElement;
  // A long text's toggle: a button to the keyboard and to screen readers.
  const toggle = (page: HTMLElement, id: string) =>
    cell(page, id).querySelector('.more') as HTMLElement | null;

  it("shows Autocode's own notice (a lock granted) from autocode, a word and not a link", async () => {
    const notice: Message = {
      ...MESSAGES[0]!,
      id: 'msg_9',
      send_id: 'snd_9',
      from: 'autocode',
      to: 'kaggle:lead',
      subject: 'lock "gpu-0" granted',
      preview: 'You hold lock "gpu-0".',
      size: 22,
    };
    const page = await open([notice, ...MESSAGES]);
    const row = page.querySelector('tr[data-message="msg_9"]')!;
    expect(row.querySelector('td.sender a')).toBeNull();
    expect(parts(row.querySelector('td.sender'))).toEqual(['autocode']);
    expect(
      row.querySelector('td.recipient a.id-link')!.getAttribute('href'),
    ).toBe('/agents?agent=kaggle:lead');
  });

  it("shows a long text's first 200 characters; a click anywhere in its cell shows it whole (read once), the next folds it", async () => {
    expect(LONG_TEXT.length).toBeGreaterThan(200);
    const page = await open([LONG, ...MESSAGES]);
    const more = toggle(page, 'msg_3')!;
    expect(cell(page, 'msg_3').classList).toContain('folds');
    expect(more.getAttribute('role')).toBe('button');
    expect(more.getAttribute('tabindex')).toBe('0');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.textContent).toBe(`${LONG_TEXT.slice(0, 200).trimEnd()}…`);
    // The cell itself, its padding included, takes the click.
    cell(page, 'msg_3').click();
    await settle(fixture);
    read('msg_3', { text: LONG_TEXT });
    await settle(fixture);
    // The whole text, its lines kept.
    expect(wholeLines(page, 'msg_3')).toEqual(LONG_TEXT.split('\n'));
    expect(toggle(page, 'msg_3')!.getAttribute('aria-expanded')).toBe('true');
    // A click on the text itself folds it once, not twice.
    toggle(page, 'msg_3')!.click();
    await settle(fixture);
    expect(toggle(page, 'msg_3')!.textContent).toBe(
      `${LONG_TEXT.slice(0, 200).trimEnd()}…`,
    );
    // Open again, with Enter: from what was read, without asking again.
    toggle(page, 'msg_3')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    await settle(fixture);
    http.expectNone('/v1/messages/msg_3');
    expect(wholeLines(page, 'msg_3')).toEqual(LONG_TEXT.split('\n'));
  });

  // The owner, 2026-11-09: a Read box, off by default: off, only what is
  // not read (queued, dropped); on, every message.
  it('the Read box, off by default, hides read messages; on, shows them', async () => {
    const page = await open(MESSAGES, false);
    const box = page.querySelector('.toolbar #show-read') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(text(box.closest('label'))).toBe('Read');
    const ids = () =>
      [...page.querySelectorAll('table.messages tr[data-message]')].map((r) =>
        r.getAttribute('data-message'),
      );
    // msg_1 is read: hidden
    expect(ids()).toEqual(['msg_2']);
    box.click();
    await settle(fixture);
    expect(ids()).toEqual(['msg_2', 'msg_1']);
  });

  // The owner, 2026-11-09: a text as markdown, in the page's own font; a
  // folded one is its first 200 characters as they are written.
  it('shows a short text and a whole one as markdown; a folded one as written', async () => {
    const page = await open([
      { ...MESSAGES[0]!, preview: '**Status**, now?' },
      LONG,
      ...MESSAGES.slice(1),
    ]);
    const short = cell(page, 'msg_2').querySelector('app-markdown.whole')!;
    expect(short.querySelector('strong')!.textContent).toBe('Status');
    expect(toggle(page, 'msg_3')!.querySelector('app-markdown')).toBeNull();
    cell(page, 'msg_3').click();
    await settle(fixture);
    read('msg_3', { text: '# Report\n\nAll **good**.' });
    await settle(fixture);
    const whole = toggle(page, 'msg_3')!.querySelector('app-markdown')!;
    expect(whole.querySelector('h1')!.textContent).toBe('Report');
  });

  it('a short text shows whole and does not open, nor does the row', async () => {
    const page = await open([LONG, ...MESSAGES]);
    expect(toggle(page, 'msg_2')).toBeNull();
    expect(text(cell(page, 'msg_2'))).toBe('Status, now?');
    expect(cell(page, 'msg_2').classList).not.toContain('folds');
    expect(toggle(page, 'msg_1')).toBeNull();
    expect(text(cell(page, 'msg_1'))).toBe('Here is the plan.');
    expect(cell(page, 'msg_1').querySelector('.muted')).toBeNull();
    // A long one's size, as people write it.
    expect(
      text(
        page.querySelector('table.messages tr[data-message="msg_3"] td.size'),
      ),
    ).toBe(LONG_TEXT.length.toLocaleString('en-US'));
    expect(LONG_TEXT.length).toBeGreaterThan(1000);
    // The row itself opens nothing: no detail row, no focus, no state.
    const row = page.querySelector(
      'table.messages tr[data-message="msg_2"]',
    ) as HTMLElement;
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(row.getAttribute('aria-expanded')).toBeNull();
    row.click();
    cell(page, 'msg_1').click();
    await settle(fixture);
    expect(page.querySelector('tr.detail')).toBeNull();
    http.expectNone((r) => r.url.startsWith('/v1/messages/'));
  });

  it('a read that fails says why in the cell, and the next opening asks again', async () => {
    const page = await open([LONG, ...MESSAGES]);
    toggle(page, 'msg_3')!.click();
    await settle(fixture);
    apiError(
      http.expectOne('/v1/messages/msg_3'),
      404,
      'no_message',
      'no message msg_3',
    );
    await settle(fixture);
    expect(text(cell(page, 'msg_3').querySelector('.errmsg'))).toBe(
      'no message msg_3',
    );
    toggle(page, 'msg_3')!.click();
    await settle(fixture);
    expect(cell(page, 'msg_3').querySelector('.errmsg')).toBeNull();
    toggle(page, 'msg_3')!.click();
    await settle(fixture);
    read('msg_3', { text: LONG_TEXT });
    await settle(fixture);
    expect(wholeLines(page, 'msg_3')).toEqual(LONG_TEXT.split('\n'));
  });

  it('an open text stays open when the list refreshes', async () => {
    const page = await open([LONG, ...MESSAGES]);
    toggle(page, 'msg_3')!.click();
    await settle(fixture);
    read('msg_3', { text: LONG_TEXT });
    await settle(fixture);
    button(page, 'Refresh')!.click();
    load([LONG, ...MESSAGES]);
    await settle(fixture);
    expect(wholeLines(page, 'msg_3')).toEqual(LONG_TEXT.split('\n'));
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
    // Text only: no file to attach.
    expect(form.querySelector('input[type="file"]')).toBeNull();
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
