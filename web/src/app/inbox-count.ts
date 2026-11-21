/*
 * How much waits for the owner in the Inbox (1.1.0-rc2; the owner,
 * 2026-11-20: "add red-pink hilight at the top of inbox tab when it has
 * messages for us"): open messages that are not reports, alerts, and asks
 * that are the owner's to answer. The server counts; the shell asks every
 * 10 seconds, and each load of the Inbox's list brings the number too, so
 * the tab follows an answer or a Close at once.
 */

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class InboxCount {
  readonly open = signal(0);
}
