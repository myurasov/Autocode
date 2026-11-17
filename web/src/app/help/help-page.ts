/*
 * The Help page: how to use Autocode, for the owner, after nv-ov-aaa's method
 * page: numbered contents at the left that stay in view (a row above the text
 * in narrow windows), each entry a link to its section. The text is in the
 * template; the sections are data here, for the contents, the headings'
 * numbers and titles, and the links between sections. They are in the order
 * the owner needs them: what Autocode is, every day's work, working with
 * agents, the web UI tab by tab, the settings, troubleshooting, the CLI, and
 * installing last (needed once). It asks the server for nothing.
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
  { id: 'words', n: '1.1', label: 'Words Used Here', sub: true },
  { id: 'daily', n: '2', label: 'Every Day' },
  { id: 'statuses', n: '2.1', label: 'Statuses', sub: true },
  { id: 'pause', n: '2.2', label: 'Pause, Resume and Stop All', sub: true },
  { id: 'inbox', n: '2.3', label: 'The Inbox', sub: true },
  { id: 'spend', n: '2.4', label: 'Spend and the Daily Cap', sub: true },
  { id: 'compaction', n: '2.5', label: 'Context and Compaction', sub: true },
  { id: 'retries', n: '2.6', label: 'Failed Turns and Retries', sub: true },
  { id: 'opencode', n: '3', label: 'Working With Agents' },
  { id: 'register', n: '3.1', label: 'Asking an Agent to Register', sub: true },
  { id: 'wakes', n: '3.2', label: 'Wakes', sub: true },
  { id: 'messages', n: '3.3', label: 'Messages', sub: true },
  { id: 'locks', n: '3.4', label: 'Locks', sub: true },
  {
    id: 'asks',
    n: '3.5',
    label: 'Questions, Permissions and Approvals',
    sub: true,
  },
  { id: 'jobs', n: '3.6', label: 'Jobs', sub: true },
  { id: 'sees', n: '3.7', label: 'What an Agent Sees', sub: true },
  { id: 'learn', n: '3.8', label: 'How Agents Learn Autocode', sub: true },
  { id: 'web', n: '4', label: 'The Web UI' },
  { id: 'web-hosts', n: '4.1', label: 'Hosts Tab', sub: true },
  { id: 'web-agents', n: '4.2', label: 'Agents Tab', sub: true },
  { id: 'web-inbox', n: '4.3', label: 'Inbox Tab', sub: true },
  { id: 'web-messages', n: '4.4', label: 'Messages Tab', sub: true },
  { id: 'web-locks', n: '4.5', label: 'Locks Tab', sub: true },
  { id: 'web-wakes', n: '4.6', label: 'Wakes Tab', sub: true },
  { id: 'web-jobs', n: '4.7', label: 'Jobs Tab', sub: true },
  { id: 'web-costs', n: '4.8', label: 'Costs Tab', sub: true },
  { id: 'web-history', n: '4.9', label: 'History Tab', sub: true },
  { id: 'web-settings', n: '4.10', label: 'Settings Tab', sub: true },
  { id: 'settings', n: '5', label: 'Settings' },
  { id: 'trouble', n: '6', label: 'Troubleshooting' },
  { id: 'cli', n: '7', label: 'The CLI' },
  { id: 'commands', n: '7.1', label: 'Your Commands', sub: true },
  { id: 'scripts', n: '7.2', label: "In an Agent's Shell", sub: true },
  { id: 'start', n: '8', label: 'Install and Connect' },
  { id: 'install', n: '8.1', label: 'Install the Server', sub: true },
  { id: 'connect', n: '8.2', label: "Connect a Machine's OpenCode", sub: true },
  { id: 'sign-in', n: '8.3', label: 'Sign In', sub: true },
  { id: 'tokens', n: '8.4', label: 'Tokens', sub: true },
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
