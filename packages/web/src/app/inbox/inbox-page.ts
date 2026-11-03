/*
 * The Inbox page: the owner's open items (messages to the owner and alerts),
 * or with Show Closed every item, refreshed every 10 s (one refresh at a
 * time). The owner answers a message (the answer goes back to its agent as a
 * message) or closes an item; the result shows in the toolbar, and the list
 * refreshes after each.
 */

import { Component, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { Api, errorText, type InboxItem } from '../api';
import { Breaks, TimeText } from '../breaks';
import { localTime } from '../format';
import { Updated } from '../updated';

// What Close says it closed: "the message from a:b", "the alert about a:b".
function itemText(item: InboxItem): string {
  if (!item.agent) return `the ${item.kind}`;
  const about = item.kind === 'message' ? 'from' : 'about';
  return `the ${item.kind} ${about} ${item.agent}`;
}

@Component({
  selector: 'app-inbox-page',
  imports: [Breaks, TimeText, Updated],
  templateUrl: './inbox-page.html',
})
export class InboxPage {
  private readonly api = inject(Api);

  protected readonly items = signal<InboxItem[]>([]);
  protected readonly loaded = signal(false);
  // Why the list did not load.
  protected readonly error = signal('');
  // How the last action went, shown in the toolbar.
  protected readonly notice = signal('');
  protected readonly failed = signal('');
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly showClosed = signal(false);
  // The answers as typed, by item ID; they stay through refreshes.
  protected readonly drafts = signal<Record<string, string>>({});
  protected readonly localTime = localTime;
  private inFlight = 0;

  constructor() {
    void this.refresh();
    const timer = setInterval(() => {
      if (this.inFlight === 0) void this.refresh();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected async refresh(): Promise<void> {
    const all = this.showClosed();
    this.inFlight++;
    try {
      const items = await this.api.inbox(all);
      if (all !== this.showClosed()) return;
      this.items.set(items);
      this.error.set('');
      this.updatedAt.set(Date.now());
    } catch (err) {
      if (all === this.showClosed()) this.error.set(errorText(err));
    } finally {
      this.inFlight--;
      this.loaded.set(true);
    }
  }

  protected toggleClosed(on: boolean): void {
    this.showClosed.set(on);
    void this.refresh();
  }

  protected draft(item: InboxItem): string {
    return this.drafts()[item.id] ?? '';
  }

  protected setDraft(item: InboxItem, text: string): void {
    this.drafts.update((all) => ({ ...all, [item.id]: text }));
  }

  protected async answer(item: InboxItem): Promise<void> {
    const done = await this.act(async () => {
      await this.api.answer(item.id, this.draft(item));
      this.drafts.update((all) => {
        const rest = { ...all };
        delete rest[item.id];
        return rest;
      });
      return `Sent the answer to ${item.agent}.`;
    });
    if (done) await this.refresh();
  }

  protected async close(item: InboxItem): Promise<void> {
    const done = await this.act(async () => {
      await this.api.closeItem(item.id);
      return `Closed ${itemText(item)}.`;
    });
    if (done) await this.refresh();
  }

  // Runs an action and shows how it went; true when it worked.
  private async act(work: () => Promise<string>): Promise<boolean> {
    this.busy.set(true);
    this.notice.set('');
    this.failed.set('');
    try {
      this.notice.set(await work());
      return true;
    } catch (err) {
      this.failed.set(errorText(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
