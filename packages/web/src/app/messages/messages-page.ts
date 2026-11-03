/*
 * The Messages page: every message, newest first, with its ID, sender,
 * recipient, subject, kind, size and state, refreshed every 10 s (one refresh
 * at a time); a click on a message (or Enter) opens its text in a row below it
 * and the next closes it; and a form, collapsed until opened, to send a
 * message as the owner, to an agent ID, a pattern or a list.
 */

import { Component, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type Message } from '../api';
import { Breaks, TimeText } from '../breaks';
import { Updated } from '../updated';

// What an opened message's row shows: its text (or what a file is), why it
// could not be read, or nothing yet.
export interface Opened {
  text?: string;
  file?: boolean;
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
  imports: [Breaks, TimeText, Updated],
  templateUrl: './messages-page.html',
})
export class MessagesPage {
  private readonly api = inject(Api);

  protected readonly messages = signal<Message[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  private inFlight = 0;

  // The messages opened below their rows, and what each shows.
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

  // Opens a message below its row, reading it the first time (again after a
  // failed read), or closes it.
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
      const full = await this.api.message(message.id);
      body =
        full.text !== undefined
          ? { text: full.text }
          : {
              text:
                `A file (${full.mime ?? 'binary'}, ${this.sizeText(full)} ` +
                'characters of base64).',
              file: true,
            };
    } catch (err) {
      body = { error: errorText(err) };
    }
    this.bodies.update((all) => ({ ...all, [message.id]: body }));
  }

  // What the Kind column shows: text, or a file's mime type.
  protected kindText(message: Message): string {
    return message.kind === 'text' ? 'text' : (message.mime ?? 'binary');
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
