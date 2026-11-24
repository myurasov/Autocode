/*
 * The Messages page: every message, newest first, with its ID, sender and
 * recipient (an agent's a link to the Agents page), subject, text (every
 * message is text), size and state (read, with how and when in the tooltip:
 * the owner, 2026-11-09; processed ones only with the Processed box, off by
 * default: the server leaves them out, so a message that waits shows however
 * many came after it), refreshed every 10 s (one refresh at a time; an older
 * answer never takes a newer one's place); a long text shows its first 200
 * characters until a click anywhere in
 * its cell (or Enter) opens it, read whole once, and the next folds it; and a
 * form, collapsed until opened, to send a text as the owner, to an agent ID,
 * a pattern or a list. The From and To fields filter by the sender and the
 * recipient (the owner, 2026-11-17), kept in the address, a second after the
 * last key; what is typed matches anywhere.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FILTER_DELAY_MS, REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Message } from '../api';
import { AgentId, IdParts, TimeText } from '../breaks';
import { FOLD_CHARS, localTime } from '../format';
import { AgentLink } from '../links';
import { Markdown } from '../markdown';
import { contains } from '../filter';
import { Latest } from '../latest';
import { MoreRow, Paged, paged } from '../more';
import { SortHead, Sorting } from '../sort';
import { Updated } from '../updated';

// How a copy was read, for its state's tooltip.
const VIA: Record<string, string> = {
  prompt: 'in a prompt',
  steer: 'during a turn of its recipient',
  read: "with its recipient's read",
  wait: "with its recipient's wait",
  inbox: 'in your Inbox',
};

// A message's state as shown: processed with how ("processed (inbox)").
export function stateText(m: Message): string {
  return m.state === 'processed' && m.processed_via
    ? `processed (${m.processed_via})`
    : m.state;
}

// Its tooltip: when and how it was processed, or what it waits for.
export function stateTitle(m: Message): string {
  if (m.state === 'queued') return 'Waiting for its recipient';
  if (m.state === 'dropped') return 'Dropped: its agent unregistered first';
  const how = m.processed_via
    ? `, ${VIA[m.processed_via] ?? m.processed_via}`
    : '';
  return m.processed_at
    ? `Processed ${localTime(m.processed_at)}${how}`
    : `Processed${how}`;
}

// An opened long text: the whole text, why it could not be read, or nothing
// yet.
export interface Opened {
  text?: string;
  error?: string;
}

// The To field as the API takes it: one ID or pattern, or a list when it has
// commas.
export function recipients(to: string): string | string[] {
  if (!to.includes(',')) return to.trim();
  return to
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

@Component({
  selector: 'app-messages-page',
  imports: [
    AgentId,
    AgentLink,
    IdParts,
    Markdown,
    MoreRow,
    SortHead,
    TimeText,
    Updated,
  ],
  templateUrl: './messages-page.html',
})
export class MessagesPage {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  // The From and To filters in the address, and as typed.
  protected readonly from = signal('');
  protected readonly toMatch = signal('');
  protected readonly fromTyped = signal('');
  protected readonly toTyped = signal('');
  private typing?: ReturnType<typeof setTimeout>;
  protected readonly stateText = stateText;
  protected readonly stateTitle = stateTitle;

  protected readonly messages = signal<Message[]>([]);
  // Processed messages too (the owner, 2026-11-09: off by default;
  // 2026-11-10: processed, not read).
  protected readonly showProcessed = signal(false);
  protected readonly shownMessages = computed(() =>
    this.showProcessed()
      ? this.messages()
      : this.messages().filter((m) => m.state !== 'processed'),
  );
  // by a heading, newest first by default (the owner, 2026-11-17)
  protected readonly sorting = new Sorting<Message>('messages', {
    columns: {
      id: { text: (m) => m.id },
      time: { time: (m) => m.created_at },
      from: { text: (m) => m.from },
      to: { text: (m) => m.to },
      subject: { text: (m) => m.subject },
      size: { number: (m) => m.size },
      state: { text: (m) => stateText(m) },
    },
    by: 'time',
  });
  // at most 25 rows, then "..." (the owner, 2026-11-09)
  protected readonly paging = new Paged();
  protected readonly page = computed(() =>
    paged(
      this.sorting.sort(this.shownMessages()),
      this.paging.count('messages'),
    ),
  );
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  private inFlight = 0;
  private readonly latest = new Latest();

  // What the table says when it has no row: nothing waits, or (with the
  // Processed box, every message) there is none.
  protected emptyText(): string {
    const filtered = !!(this.from() || this.toMatch());
    if (this.showProcessed())
      return filtered
        ? 'No message matches the From and To filters.'
        : 'No messages yet.';
    return (
      (filtered
        ? 'No message that waits matches the From and To filters '
        : 'No message waits ') + '(the Processed box shows the processed ones).'
    );
  }

  // The Processed box: the list is read again, with or without them.
  protected setShowProcessed(on: boolean): void {
    if (on === this.showProcessed()) return;
    this.showProcessed.set(on);
    void this.refresh();
  }

  // The long texts opened, and what each shows.
  protected readonly opened = signal<ReadonlySet<string>>(new Set());
  protected readonly bodies = signal<Record<string, Opened>>({});

  // The form, and how its last send went.
  protected readonly to = signal('');
  protected readonly subject = signal('');
  protected readonly text = signal('');
  protected readonly sending = signal(false);
  protected readonly sent = signal('');
  protected readonly sendError = signal('');

  constructor() {
    // The address sets the filters (a link, Back, or the toolbar's own).
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const from = params.get('from') ?? '';
      const to = params.get('to') ?? '';
      this.fromTyped.set(from);
      this.toTyped.set(to);
      if (this.loaded() && from === this.from() && to === this.toMatch())
        return;
      this.from.set(from);
      this.toMatch.set(to);
      void this.refresh();
    });
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.typing);
    });
  }

  protected async refresh(): Promise<void> {
    const from = this.from();
    const to = this.toMatch();
    const processed = this.showProcessed();
    // the filters' own answer, and not one older than the list on show
    const sent = this.latest.next();
    const current = () =>
      from === this.from() &&
      to === this.toMatch() &&
      processed === this.showProcessed() &&
      this.latest.take(sent);
    this.inFlight++;
    try {
      // what was typed matches anywhere (the owner, 2026-11-17); with the
      // Processed box off the server leaves the processed ones out, so a
      // message that waits shows however many came after it
      const list = await this.api.messages(
        contains(from),
        contains(to),
        processed,
      );
      if (!current()) return;
      this.messages.set(list);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (current()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }

  // A filter as typed applies a second after the last key.
  protected typed(field: 'from' | 'to', value: string): void {
    (field === 'from' ? this.fromTyped : this.toTyped).set(value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.applyFilters(), FILTER_DELAY_MS);
  }

  // The filters go into the address, which sets them (and keeps them for
  // Back); the same ones again reload the list.
  protected applyFilters(): void {
    clearTimeout(this.typing);
    const from = this.fromTyped().trim();
    const to = this.toTyped().trim();
    if (from === this.from() && to === this.toMatch()) {
      void this.refresh();
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { from: from || null, to: to || null },
      queryParamsHandling: 'merge',
    });
  }

  protected isOpen(id: string): boolean {
    return this.opened().has(id);
  }

  protected bodyOf(id: string): Opened | undefined {
    return this.bodies()[id];
  }

  // A message too long to show whole in the list.
  protected isLong(message: Message): boolean {
    return message.size > FOLD_CHARS;
  }

  // A long text's cell: the whole text once opened and read, else the list's
  // first 200 characters and "…".
  // An opened text, read whole: its text (to show as markdown); else null.
  protected wholeText(message: Message): string | null {
    if (!this.isOpen(message.id)) return null;
    return this.bodyOf(message.id)?.text ?? null;
  }

  protected shown(message: Message): string {
    const read = this.bodyOf(message.id)?.text;
    if (this.isOpen(message.id) && read !== undefined) return read;
    return `${(message.preview ?? '').trimEnd()}…`;
  }

  // Opens a long text, reading the message the first time (again after a
  // failed read), or folds it.
  protected async toggle(message: Message): Promise<void> {
    const opened = new Set(this.opened());
    if (opened.delete(message.id)) {
      this.opened.set(opened);
      return;
    }
    this.opened.set(opened.add(message.id));
    const known = this.bodyOf(message.id);
    if (known && !known.error) return;
    let body: Opened;
    try {
      body = { text: (await this.api.message(message.id)).text ?? '' };
    } catch (err) {
      body = { error: errorText(err) };
    }
    this.bodies.update((all) => ({ ...all, [message.id]: body }));
  }

  // A click anywhere in a long text's cell, but not one that ends a selection.
  protected cellClick(message: Message): void {
    if (!this.isLong(message)) return;
    if (window.getSelection()?.toString()) return;
    void this.toggle(message);
  }

  protected sizeText(message: Message): string {
    return message.size.toLocaleString('en-US');
  }

  protected canSend(): boolean {
    return !this.sending() && !!this.to().trim() && !!this.text().trim();
  }

  protected async send(): Promise<void> {
    if (!this.canSend()) return;
    const subject = this.subject().trim();
    this.sending.set(true);
    this.sent.set('');
    this.sendError.set('');
    try {
      const done = await this.api.send({
        to: recipients(this.to()),
        ...(subject ? { subject } : {}),
        text: this.text(),
      });
      this.sent.set(`Sent to ${done.recipients.join(', ')}.`);
      this.subject.set('');
      this.text.set('');
    } catch (err) {
      this.sendError.set(errorText(err));
      return;
    } finally {
      this.sending.set(false);
    }
    await this.refresh();
  }
}
