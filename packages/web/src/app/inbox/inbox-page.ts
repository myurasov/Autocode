/*
 * The Inbox page: the owner's open items (messages to the owner, alerts and
 * asks: questions, permission prompts and approvals that an agent's turn
 * waits for), or with the Closed box every item, refreshed every 10 s (one
 * refresh at a time); an item's agent, and the agent an ask was sent to, link
 * to the Agents page. The owner answers a message (the answer goes back to
 * its agent as a message) or closes an item, and answers an ask: a question by
 * an option or in its own words, a permission once, always (after a
 * confirmation) or not, an approval with an option and a note. The result
 * shows in the toolbar, and the list refreshes after each.
 */

import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { REFRESH_MS } from '../agents/agents-page';
import { type AskAnswer, Api, errorText, type InboxItem } from '../api';
import { IdParts, TimeText } from '../breaks';
import { localTime } from '../format';
import { AgentLink } from '../links';
import { leftText } from '../locks/locks-page';
import { Markdown } from '../markdown';
import { MoreRow, Paged, paged } from '../more';
import { Updated } from '../updated';

// What each kind of item is called on the page.
const KINDS: Record<string, string> = {
  message: 'Message',
  alert: 'Alert',
  question: 'Question',
  permission: 'Permission',
  approval: 'Approval',
};

// What Close says it closed: "the message from a:b", "the alert about a:b".
function itemText(item: InboxItem): string {
  if (!item.agent) return `the ${item.kind}`;
  const about = item.kind === 'message' ? 'from' : 'about';
  return `the ${item.kind} ${about} ${item.agent}`;
}

// Whether an item is an ask: what an agent's turn waits for.
export function isAsk(item: InboxItem): boolean {
  return ['question', 'permission', 'approval'].includes(item.kind);
}

/*
 * A closed ask's answer in a line: a question's answers (or the text it was
 * dismissed with), a permission's or an approval's decision with its option
 * and note; then who gave it.
 */
export function askAnswerText(item: InboxItem): string {
  const answer = item.answer as Record<string, unknown> | null | undefined;
  if (!answer) return '';
  let what: string;
  if (item.kind === 'question') {
    if (typeof answer['cancel'] === 'string')
      what = `dismissed: ${answer['cancel']}`;
    else
      what = Object.values((answer['answer'] ?? {}) as Record<string, unknown>)
        .map((value) => (Array.isArray(value) ? value.join(', ') : value))
        .join('; ');
  } else {
    const head = [answer['decision'], answer['option']]
      .filter(Boolean)
      .join(' ');
    what = answer['text'] ? `${head}: ${answer['text']}` : head;
  }
  if (item.by === 'auto') return `${what} (at once)`;
  if (item.by === 'owner') return `${what} (by the owner)`;
  return item.by ? `${what} (by ${item.by})` : what;
}

@Component({
  selector: 'app-inbox-page',
  imports: [AgentLink, IdParts, Markdown, MoreRow, TimeText, Updated],
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
  // at most 25 rows, then "..." (the owner, 2026-11-09)
  protected readonly paging = new Paged();
  protected readonly page = computed(() =>
    paged(this.items(), this.paging.count('inbox')),
  );
  // The answers as typed, by item ID; they stay through refreshes.
  protected readonly drafts = signal<Record<string, string>>({});
  // An ask's fields as typed or chosen (its own words for each question, a
  // reason to reject, a note, an approval's option), by item ID and field,
  // and a question's chosen options, by item ID and question.
  protected readonly fields = signal<Record<string, string>>({});
  protected readonly picks = signal<Record<string, string[]>>({});
  protected readonly localTime = localTime;
  protected readonly isAsk = isAsk;
  protected readonly askAnswerText = askAnswerText;
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

  protected kindText(item: InboxItem): string {
    return KINDS[item.kind] ?? item.kind;
  }

  // An item's title; an approval's names its agent only, as its text shows
  // whole under it (the owner, 2026-11-07: not twice).
  protected titleText(item: InboxItem): string {
    return item.kind === 'approval' && item.agent
      ? `Approval for ${item.agent}`
      : item.title;
  }

  // The agent an ask was sent to (agent:<id>), if one.
  protected sentAgent(item: InboxItem): string | null {
    const to = item.routed ?? '';
    return to.startsWith('agent:') ? to.slice('agent:'.length) : null;
  }

  // Whether an item is the owner's: messages, alerts and asks for the owner.
  protected sentOwner(item: InboxItem): boolean {
    return !isAsk(item) || item.routed === 'owner';
  }

  // Who else an ask went to: none (answered at once by a setting), or as the
  // server says.
  protected sentText(item: InboxItem): string {
    return item.routed === 'auto' || item.routed === 'approve'
      ? 'answered at once'
      : (item.routed ?? '');
  }

  // How long an approval may wait, as of the list's last load.
  protected left(item: InboxItem): string {
    const now = this.updatedAt() ?? Date.now();
    return leftText(Date.parse(item.expires ?? '') - now);
  }

  // A message's answer, once it has one.
  protected messageAnswer(item: InboxItem): string | null {
    return typeof item.answer === 'string' ? item.answer : null;
  }

  protected draft(item: InboxItem): string {
    return this.drafts()[item.id] ?? '';
  }

  protected setDraft(item: InboxItem, text: string): void {
    this.drafts.update((all) => ({ ...all, [item.id]: text }));
  }

  protected field(item: InboxItem, name: string): string {
    return this.fields()[`${item.id}/${name}`] ?? '';
  }

  protected setField(item: InboxItem, name: string, value: string): void {
    this.fields.update((all) => ({ ...all, [`${item.id}/${name}`]: value }));
  }

  protected picked(item: InboxItem, q: number, option: string): boolean {
    return (this.picks()[`${item.id}/${q}`] ?? []).includes(option);
  }

  // A choice of a question: one option (a radio button), or one more or one
  // less (a checkbox).
  protected pick(
    item: InboxItem,
    q: number,
    option: string,
    on: boolean,
    multiple: boolean,
  ): void {
    const key = `${item.id}/${q}`;
    this.picks.update((all) => {
      const now = all[key] ?? [];
      const next = multiple
        ? (item.questions?.[q]?.options ?? []).filter((o) =>
            o === option ? on : now.includes(o),
          )
        : on
          ? [option]
          : [];
      return { ...all, [key]: next };
    });
  }

  // One question of one choice with options: a click on one answers.
  protected oneClick(item: InboxItem): boolean {
    const questions = item.questions ?? [];
    const first = questions[0];
    return questions.length === 1 && !!first?.options.length && !first.multiple;
  }

  // A free text field's label: the answer, or which question's.
  protected freeLabel(item: InboxItem, q: number): string {
    return (item.questions?.length ?? 0) > 1
      ? `Answer to question ${q + 1}`
      : 'Your answer';
  }

  // A question's answer: its own words, else the options chosen.
  private questionAnswer(item: InboxItem, q: number): string {
    const own = this.field(item, `free${q}`).trim();
    return own || (this.picks()[`${item.id}/${q}`] ?? []).join(', ');
  }

  protected canAnswer(item: InboxItem): boolean {
    const questions = item.questions ?? [];
    return (
      questions.length > 0 &&
      questions.every((_, q) => !!this.questionAnswer(item, q))
    );
  }

  protected answerOption(item: InboxItem, option: string): void {
    void this.answerAsk(item, { text: option });
  }

  // A question's answers: one, or one per question.
  protected answerQuestion(item: InboxItem): void {
    if (!this.canAnswer(item)) return;
    const answers = (item.questions ?? []).map((_, q) =>
      this.questionAnswer(item, q),
    );
    void this.answerAsk(
      item,
      answers.length === 1 ? { text: answers[0]! } : { answers },
    );
  }

  // A permission once, or always: OpenCode saves that rule, so it asks first.
  protected allow(item: InboxItem, decision: 'once' | 'always'): void {
    if (
      decision === 'always' &&
      !confirm('Allow always?\n\nOpenCode saves the rule for the project.')
    )
      return;
    void this.answerAsk(item, { decision });
  }

  protected rejectPermission(item: InboxItem): void {
    const reason = this.field(item, 'reason').trim();
    void this.answerAsk(item, {
      decision: 'reject',
      ...(reason ? { text: reason } : {}),
    });
  }

  // An approval approved or rejected, with its option and note if any.
  protected decide(item: InboxItem, decision: 'approve' | 'reject'): void {
    const option = this.field(item, 'option');
    const note = this.field(item, 'note').trim();
    void this.answerAsk(item, {
      decision,
      ...(option ? { option } : {}),
      ...(note ? { text: note } : {}),
    });
  }

  /*
   * Sends an ask's answer; the result (or the server's message, as when
   * someone answered first) in the toolbar; the list reloads either way.
   */
  private async answerAsk(item: InboxItem, answer: AskAnswer): Promise<void> {
    await this.act(async () => {
      await this.api.answerAsk(item.id, answer);
      const mine = (key: string) => key.startsWith(`${item.id}/`);
      this.fields.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([k]) => !mine(k))),
      );
      this.picks.update((all) =>
        Object.fromEntries(Object.entries(all).filter(([k]) => !mine(k))),
      );
      return `Answered ${item.kind} from ${item.agent}.`;
    });
    await this.refresh();
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
