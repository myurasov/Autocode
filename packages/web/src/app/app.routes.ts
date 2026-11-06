/*
 * The web UI's routes: /hosts, /agents, /inbox, /messages, /locks, /wakes,
 * /history, /settings and /help; any other path goes to /agents. The page
 * title stays "Autocode" (index.html) on every page.
 */

import type { Routes } from '@angular/router';
import { AgentsPage } from './agents/agents-page';
import { HelpPage } from './help/help-page';
import { HistoryPage } from './history/history-page';
import { HostsPage } from './hosts/hosts-page';
import { InboxPage } from './inbox/inbox-page';
import { LocksPage } from './locks/locks-page';
import { MessagesPage } from './messages/messages-page';
import { SettingsPage } from './settings/settings-page';
import { WakesPage } from './wakes/wakes-page';

export const routes: Routes = [
  { path: 'hosts', component: HostsPage },
  { path: 'agents', component: AgentsPage },
  { path: 'inbox', component: InboxPage },
  { path: 'messages', component: MessagesPage },
  { path: 'locks', component: LocksPage },
  { path: 'wakes', component: WakesPage },
  { path: 'history', component: HistoryPage },
  { path: 'settings', component: SettingsPage },
  { path: 'help', component: HelpPage },
  { path: '', pathMatch: 'full', redirectTo: 'agents' },
  { path: '**', redirectTo: 'agents' },
];
