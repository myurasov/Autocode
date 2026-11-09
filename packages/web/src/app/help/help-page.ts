/*
 * The Help page: how to use Autocode, for the owner, after nv-ov-aaa's method
 * page: numbered contents at the left that stay in view (a row above the text
 * in narrow windows), each entry a link to its section. The text is in the
 * template; the sections are data here, for the contents and the headings'
 * numbers and titles. It asks the server for nothing.
 */

import { ViewportScroller } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

export interface Section {
  id: string;
  n: string;
  label: string;
  sub?: boolean;
}

const LIST = [
  { id: 'what', n: '1', label: 'What Autocode Is' },
  { id: 'start', n: '2', label: 'Getting Started' },
  { id: 'install', n: '2.1', label: 'Install the Server', sub: true },
  { id: 'connect', n: '2.2', label: "Connect a Machine's OpenCode", sub: true },
  { id: 'sign-in', n: '2.3', label: 'Sign In', sub: true },
  { id: 'tokens', n: '2.4', label: 'Tokens', sub: true },
  { id: 'opencode', n: '3', label: 'Using It From OpenCode' },
  { id: 'learn', n: '3.1', label: 'How Agents Learn Autocode', sub: true },
  { id: 'register', n: '3.2', label: 'Asking an Agent to Register', sub: true },
  { id: 'wakes', n: '3.3', label: 'Wakes', sub: true },
  { id: 'messages', n: '3.4', label: 'Messages', sub: true },
  { id: 'locks', n: '3.5', label: 'Locks', sub: true },
  {
    id: 'asks',
    n: '3.6',
    label: 'Questions, Permissions and Approvals',
    sub: true,
  },
  { id: 'jobs', n: '3.7', label: 'Jobs', sub: true },
  { id: 'sees', n: '3.8', label: 'What an Agent Sees', sub: true },
  { id: 'cli', n: '4', label: 'The CLI' },
  { id: 'commands', n: '4.1', label: 'Your Commands', sub: true },
  { id: 'scripts', n: '4.2', label: "In an Agent's Shell", sub: true },
  { id: 'web', n: '5', label: 'The Web UI' },
  { id: 'web-hosts', n: '5.1', label: 'Hosts', sub: true },
  { id: 'web-agents', n: '5.2', label: 'Agents', sub: true },
  { id: 'web-inbox', n: '5.3', label: 'Inbox', sub: true },
  { id: 'web-messages', n: '5.4', label: 'Messages', sub: true },
  { id: 'web-locks', n: '5.5', label: 'Locks', sub: true },
  { id: 'web-wakes', n: '5.6', label: 'Wakes', sub: true },
  { id: 'web-jobs', n: '5.7', label: 'Jobs', sub: true },
  { id: 'web-costs', n: '5.8', label: 'Costs', sub: true },
  { id: 'web-history', n: '5.9', label: 'History', sub: true },
  { id: 'web-settings', n: '5.10', label: 'Settings', sub: true },
  { id: 'web-help', n: '5.11', label: 'Help', sub: true },
  { id: 'settings', n: '6', label: 'Settings' },
  { id: 'trouble', n: '7', label: 'Troubleshooting' },
] as const;
type Id = (typeof LIST)[number]['id'];

export const SECTIONS: readonly Section[] = LIST;

// How far below the window's top a section's heading lands, in pixels.
const SCROLL_OFFSET = 16;

@Component({
  selector: 'app-help-page',
  imports: [RouterLink],
  templateUrl: './help-page.html',
  styleUrl: './help-page.css',
})
export class HelpPage {
  private readonly router = inject(Router);
  protected readonly sections = SECTIONS;
  protected readonly sec = Object.fromEntries(
    SECTIONS.map((s) => [s.id, s]),
  ) as Record<Id, Section>;

  constructor() {
    inject(ViewportScroller).setOffset([0, SCROLL_OFFSET]);
  }

  /*
   * A click on the section already in the address does not navigate, so the
   * router does not scroll to it: this does.
   */
  protected again(id: string): void {
    if (!this.router.url.endsWith(`#${id}`)) return;
    document.getElementById(id)?.scrollIntoView?.();
  }
}
