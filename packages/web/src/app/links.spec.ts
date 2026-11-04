/*
 * Unit tests of the links from agent and host IDs to their pages: where they
 * lead (the page with the ID to highlight in its address), and that they show
 * the ID as before, breaking only after ":" or "_": code, or plain text.
 */

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { el, parts, settle, setup } from '../testing/helpers';
import { AgentLink, HostLink } from './links';

@Component({
  imports: [AgentLink, HostLink],
  template: `
    <p class="agent"><app-agent-link id="kaggle:lead" /></p>
    <p class="plain"><app-agent-link id="kaggle:lead" [plain]="true" /></p>
    <p class="host"><app-host-link id="myspark2:MY-Co-SA:ea8173fe" /></p>
  `,
})
class Links {}

describe('AgentLink and HostLink', () => {
  beforeEach(() => {
    setup();
  });

  async function open(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(Links);
    await settle(fixture);
    return el(fixture);
  }

  it('an agent ID leads to the Agents page with the agent to highlight', async () => {
    const page = await open();
    const link = page.querySelector('p.agent a')!;
    expect(link.classList).toContain('id-link');
    expect(link.getAttribute('href')).toBe('/agents?agent=kaggle:lead');
    // It may break only after ":" (the owner, 2026-11-03).
    expect(parts(link.querySelector('code'))).toEqual(['kaggle:', 'lead']);
    // In a group's heading row it stays plain text.
    const plain = page.querySelector('p.plain a')!;
    expect(plain.getAttribute('href')).toBe('/agents?agent=kaggle:lead');
    expect(plain.querySelector('code')).toBeNull();
    expect(plain.textContent).toBe('kaggle:lead');
    expect(parts(plain)).toEqual(['kaggle:', 'lead']);
  });

  it('a host ID leads to the Hosts page with the host to highlight', async () => {
    const page = await open();
    const link = page.querySelector('p.host a')!;
    expect(link.classList).toContain('id-link');
    expect(link.getAttribute('href')).toBe(
      '/hosts?host=myspark2:MY-Co-SA:ea8173fe',
    );
    expect(link.querySelector('code')!.textContent).toBe(
      'myspark2:MY-Co-SA:ea8173fe',
    );
    expect(parts(link.querySelector('code'))).toEqual([
      'myspark2:',
      'MY-Co-SA:',
      'ea8173fe',
    ]);
  });
});
