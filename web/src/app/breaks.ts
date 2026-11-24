/*
 * Where a narrow table cell may break its text, so that a table fits its frame:
 * a folder or a check after each ":", "/" and "_" (a <wbr>); an ID or id-like
 * name right after a ":" or "_" (the owner, 2026-11-03; the page's styles let
 * it break anywhere when a part does not fit); an agent's ID only right after
 * a punctuation character, never inside a word (the owner, 2026-11-23); and a
 * time only between its date and its clock with its zone.
 * The text stays the same, and a copy of it has no extra characters.
 */

import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { localTime } from './format';

@Directive({ selector: '[appBreaks]' })
export class Breaks {
  readonly appBreaks = input<string | null | undefined>('');
  // The characters a break may follow: a folder's by default; a model's
  // name breaks after "-", an error's type after "." (tier 0g).
  readonly breakAfter = input(':/_');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      const after = this.breakAfter().replace(/[\\\]^-]/g, '\\$&');
      const parts = (this.appBreaks() ?? '').split(
        new RegExp(`(?<=[${after}])`),
      );
      host.replaceChildren();
      parts.forEach((part, i) => {
        if (i > 0) host.append(host.ownerDocument.createElement('wbr'));
        host.append(part);
      });
    });
  }
}

// A time in the viewer's zone (see localTime) as a date, a clock and its
// zone, each kept whole: a narrow column breaks between them (the owner,
// 2026-11-09: the Agents table must fit a laptop in any zone, "GMT+0" too).
@Directive({ selector: '[appTime]' })
export class TimeText {
  readonly appTime = input<string | null | undefined>('');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      const [date, clock, ...zone] = localTime(this.appTime()).split(' ');
      const parts = [date, clock, zone.join(' ')].filter(Boolean);
      host.replaceChildren();
      parts.forEach((part, i) => {
        if (i > 0) host.append(' ');
        const span = host.ownerDocument.createElement('span');
        span.textContent = part;
        host.append(span);
      });
    });
  }
}

// An ID's parts: each ends right after a ":" or "_" (the last may not).
export function idParts(id: string): string[] {
  return id ? id.split(/(?<=[:_])/) : [];
}

// An agent's ID's parts: each ends right after a punctuation character, one
// that is not a letter or a digit (":", "-", "_", ".", and the "," and "*"
// of a list or a pattern).
export function agentIdParts(id: string): string[] {
  return id ? id.split(/(?<=[^\p{L}\p{N}])/u) : [];
}

// The parts as the host's content: a span.id-part each, a <wbr> between.
function showParts(host: HTMLElement, parts: string[]): void {
  const document = host.ownerDocument;
  host.replaceChildren();
  parts.forEach((part, i) => {
    if (i > 0) host.append(document.createElement('wbr'));
    const span = document.createElement('span');
    span.className = 'id-part';
    span.textContent = part;
    host.append(span);
  });
}

/*
 * An ID as its parts (a span.id-part each), with a break (a <wbr>) between
 * them: it breaks right after a ":" or "_" first, and, by the page's styles,
 * anywhere when a part does not fit (the owner, 2026-11-23).
 */
@Directive({ selector: '[appId]' })
export class IdParts {
  readonly appId = input<string | null | undefined>('');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => showParts(host, idParts(this.appId() ?? '')));
  }
}

/*
 * An agent's ID, wherever a table shows one, and the words that stand in its
 * place (owner, autocode, schedule): its parts kept whole (.agent-id, whose
 * parts the styles keep on one line), so it breaks only right after a
 * punctuation character (the owner, 2026-11-23: "make agent ids columns only
 * breaking at punctuation").
 */
@Directive({ selector: '[appAgentId]', host: { class: 'agent-id' } })
export class AgentId {
  readonly appAgentId = input<string | null | undefined>('');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => showParts(host, agentIdParts(this.appAgentId() ?? '')));
  }
}
