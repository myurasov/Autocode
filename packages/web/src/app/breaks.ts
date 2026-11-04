/*
 * Where a narrow table cell may break its text, so that a table fits its frame:
 * a folder or a check after each ":", "/" and "_" (a <wbr>); an ID or id-like
 * name only right after a ":" or "_", never inside a part (the owner,
 * 2026-11-03); and a time only between its date and its clock with its zone.
 * The text stays the same, and a copy of it has no extra characters.
 */

import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { localTime } from './format';

@Directive({ selector: '[appBreaks]' })
export class Breaks {
  readonly appBreaks = input<string | null | undefined>('');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      const parts = (this.appBreaks() ?? '').split(/(?<=[:/_])/);
      host.replaceChildren();
      parts.forEach((part, i) => {
        if (i > 0) host.append(host.ownerDocument.createElement('wbr'));
        host.append(part);
      });
    });
  }
}

// A time in the viewer's zone (see localTime) as a date and a clock with its
// zone, each on one line.
@Directive({ selector: '[appTime]' })
export class TimeText {
  readonly appTime = input<string | null | undefined>('');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      const [date, ...rest] = localTime(this.appTime()).split(' ');
      const parts = [date, rest.join(' ')].filter(Boolean);
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

/*
 * An ID as its parts, each kept whole (a span.id-part, white-space: pre), with
 * a break (a <wbr>) only between them: it breaks only right after a ":" or
 * "_", and one without either never breaks.
 */
@Directive({ selector: '[appId]' })
export class IdParts {
  readonly appId = input<string | null | undefined>('');

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      const document = host.ownerDocument;
      host.replaceChildren();
      idParts(this.appId() ?? '').forEach((part, i) => {
        if (i > 0) host.append(document.createElement('wbr'));
        const span = document.createElement('span');
        span.className = 'id-part';
        span.textContent = part;
        host.append(span);
      });
    });
  }
}
