/*
 * The web UI's routes: /hosts, /agents and /settings; any other path goes to
 * /agents. The page title stays "Autocode" (index.html) on every page.
 */

import type { Routes } from '@angular/router';
import { AgentsPage } from './agents/agents-page';
import { HostsPage } from './hosts/hosts-page';
import { SettingsPage } from './settings/settings-page';

export const routes: Routes = [
  { path: 'hosts', component: HostsPage },
  { path: 'agents', component: AgentsPage },
  { path: 'settings', component: SettingsPage },
  { path: '', pathMatch: 'full', redirectTo: 'agents' },
  { path: '**', redirectTo: 'agents' },
];
