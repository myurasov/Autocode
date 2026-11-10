/*
 * The Messages page: every message, newest first, with its ID, sender and
 * recipient (an agent's a link to the Agents page), subject, text (every
 * message is text), size and state (read, with how and when in the tooltip:
 * the owner, 2026-11-09; read ones only with the Read box, off by default),
 * refreshed every 10 s (one refresh at a
 * time); a long text shows its first 200 characters until a click anywhere in
 * its cell (or Enter) opens it, read whole once, and the next folds it; and a
 * form, collapsed until opened, to send a text as the owner, to an agent ID,
 * a pattern or a list.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Message } from '../api';
import { IdParts, TimeText } from '../breaks';
import { FOLD_CHARS, localTime } from '../format';
import { AgentLink } from '../links';
import { Markdown } from '../markdown';
import { Updated } from '../updated';

// How a copy was read, for its state's tooltip.
const VIA: Record<string, string> = {
  prompt: 'in a prompt',
  steer: 'during a turn of its recipient',
  read: "with its recipient's read",
  wait: "with its recipient's wait",
  inbox: 'in your Inbox',
};

// A message's state as shown: read with how ("read (inbox)").
export function stateText(m: Message): string {
  return m.state === 'read' && m.read_via ? `read (${m.read_via})` : m.state;
}

// Its tooltip: when and how it was read, or what it waits for.
export function stateTitle(m: Message): string {
  if (m.state === 'queued') return 'Waiting for its recipient';
  if (m.state === 'dropped') return 'Dropped: its agent unregistered first';
  const how = m.read_via ? `, ${VIA[m.read_via] ?? m.read_via}` : '';
  return m.read_at ? `Read ${localTime(m.read_at)}${how}` : `Read${how}`;
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
  imports: [AgentLink, IdParts, Markdown, TimeText, Updated],
  templateUrl: './messages-page.html',
})
export class MessagesPage {
  private readonly api = inject(Api);
  protected readonly stateText = stateText;
  protected readonly stateTitle = stateTitle;

  protected readonly messages = signal<Message[]>([]);
  // Read messages too (the owner, 2026-11-09: off by default).
  protected readonly showRead = signal(false);
  protected readonly shownMessages = computed(() =>
    this.showRead()
      ? this.messages()
      : this.messages().filter((m) => m.state !== 'read'),
  );
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  private inFlight = 0;

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
    void this.refresh();
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async refresh(): Promise<void> {
    this.inFlight++;
    try {
      this.messages.set(await this.api.messages());
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
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
