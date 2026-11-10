/*
 * Links from an agent or host ID to its page, which highlights its row (the
 * owner, 2026-11-03): the ID as it shows elsewhere, code that breaks only
 * after a ":" or "_" (or plain text in a group's heading row), underlined on
 * hover. And, for those pages, the ID to highlight from their
 * address, and its row scrolled into view.
 */

import {
  afterNextRender,
  Component,
  ElementRef,
  effect,
  Injector,
  inject,
  input,
  type Signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { IdParts } from './breaks';

@Component({
  selector: 'app-agent-link',
  imports: [IdParts, RouterLink],
  template: `<a
    class="id-link"
    routerLink="/agents"
    [queryParams]="gone() ? { agent: id(), unregistered: 1 } : { agent: id() }"
    title="Show on the Agents page"
    >@if (plain()) {<span [appId]="id()"></span>} @else {<code
        [appId]="id()"
      ></code>}</a
  >`,
})
export class AgentLink {
  readonly id = input.required<string>();
  // Plain text, not code: in a group's heading row.
  readonly plain = input(false);
  // An unregistered agent: the Agents page shows the gone ones to show it.
  readonly gone = input(false);
}

@Component({
  selector: 'app-host-link',
  imports: [IdParts, RouterLink],
  template: `<a
    class="id-link"
    routerLink="/hosts"
    [queryParams]="{ host: id() }"
    title="Show on the Hosts page"
    ><code [appId]="id()"></code
  ></a>`,
})
export class HostLink {
  readonly id = input.required<string>();
}

// The ID a page highlights: the one in its address (?agent=, ?host=).
export function highlightParam(name: string): Signal<string | null> {
  return toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((p) => p.get(name))),
    { initialValue: null },
  );
}

/*
 * Scrolls a page's highlighted row (the tr whose attr is the ID) into view,
 * centred: once for each ID that arrives, when the page's list first has it.
 */
export function scrollToHighlight(
  id: Signal<string | null>,
  has: (id: string) => boolean,
  attr: string,
): void {
  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const injector = inject(Injector);
  let done: string | null = null;
  effect(() => {
    const target = id();
    if (!target) done = null;
    if (!target || target === done || !has(target)) return;
    done = target;
    afterNextRender(
      () => {
        const row = [...host.querySelectorAll(`tr[${attr}]`)].find(
          (r) => r.getAttribute(attr) === target,
        );
        row?.scrollIntoView?.({ block: 'center' });
      },
      { injector },
    );
  });
}
