/*
 * Unit tests of how an ID may break (the owner, 2026-11-03): only right after
 * a ":" or "_", never inside a part; its parts as shown, each kept whole, with
 * a break between them and nothing added to the text.
 * Breaks (folders, model names, error types): only after its characters.
 * A time: its date, clock and zone, each kept whole.
 */

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { el, parts, settle, setup } from '../testing/helpers';
import { localTime } from './format';
import { Breaks, IdParts, idParts, TimeText } from './breaks';

@Component({
  imports: [IdParts],
  template: `
    <code class="agent" appId="live:laptop:glm-5.3:20261028T1314"></code>
    <code class="session" appId="ses_e7d5a9981ffeMI0at2ZTpikxTp"></code>
    <code class="name" appId="layout-check-of-a-long-wake-name"></code>
    <code class="none" [appId]="null"></code>
  `,
})
class Ids {}

describe('idParts', () => {
  it('splits right after each ":" and "_", never at "-" or "."', () => {
    expect(idParts('a:b_c-d.e')).toEqual(['a:', 'b_', 'c-d.e']);
    expect(idParts('live:laptop:glm-5.3:20261028T1314')).toEqual([
      'live:',
      'laptop:',
      'glm-5.3:',
      '20261028T1314',
    ]);
    expect(idParts('ses_e7d5a9981ffeMI0at2ZTpikxTp')).toEqual([
      'ses_',
      'e7d5a9981ffeMI0at2ZTpikxTp',
    ]);
    expect(idParts('layout-check-of-a-long-wake-name')).toEqual([
      'layout-check-of-a-long-wake-name',
    ]);
  });

  it('keeps a leading, trailing or double separator with the part before it', () => {
    expect(idParts(':a')).toEqual([':', 'a']);
    expect(idParts('a:')).toEqual(['a:']);
    expect(idParts('a::b')).toEqual(['a:', ':', 'b']);
    expect(idParts('_a__b_')).toEqual(['_', 'a_', '_', 'b_']);
    expect(idParts('')).toEqual([]);
  });
});

describe('IdParts', () => {
  beforeEach(() => {
    setup();
  });

  it('shows each part whole, with a break only between parts; the text stays the same', async () => {
    const fixture = TestBed.createComponent(Ids);
    await settle(fixture);
    const page = el(fixture);
    const agent = page.querySelector('code.agent')!;
    expect(parts(agent)).toEqual([
      'live:',
      'laptop:',
      'glm-5.3:',
      '20261028T1314',
    ]);
    expect(agent.textContent).toBe('live:laptop:glm-5.3:20261028T1314');
    expect(agent.innerHTML).toBe(
      '<span class="id-part">live:</span><wbr>' +
        '<span class="id-part">laptop:</span><wbr>' +
        '<span class="id-part">glm-5.3:</span><wbr>' +
        '<span class="id-part">20261028T1314</span>',
    );
    expect(parts(page.querySelector('code.session'))).toEqual([
      'ses_',
      'e7d5a9981ffeMI0at2ZTpikxTp',
    ]);
    const name = page.querySelector('code.name')!;
    expect(parts(name)).toEqual(['layout-check-of-a-long-wake-name']);
    expect(name.querySelector('wbr')).toBeNull();
    expect(page.querySelector('code.none')!.innerHTML).toBe('');
  });
});

// Tier 0g: a model's name breaks after "-", an error's type after "."; a
// folder still after ":", "/" and "_".
@Component({
  imports: [Breaks],
  template: `
    <code
      class="model"
      appBreaks="bedrock-claude-opus-5-5"
      breakAfter="-"
    ></code>
    <code class="error" appBreaks="provider.internal" breakAfter="."></code>
    <code class="folder" appBreaks="/home/someone/my_work"></code>
  `,
})
class Breaking {}

describe('Breaks', () => {
  it('breaks only after the characters it is given; a folder after ":", "/" and "_"', async () => {
    const fixture = TestBed.createComponent(Breaking);
    await settle(fixture);
    const page = el(fixture);
    const pieces = (selector: string) =>
      page.querySelector(selector)!.innerHTML.split('<wbr>');
    expect(pieces('code.model')).toEqual([
      'bedrock-',
      'claude-',
      'opus-',
      '5-',
      '5',
    ]);
    expect(pieces('code.error')).toEqual(['provider.', 'internal']);
    expect(pieces('code.folder')).toEqual([
      '/',
      'home/',
      'someone/',
      'my_',
      'work',
    ]);
    expect(page.querySelector('code.model')!.textContent).toBe(
      'bedrock-claude-opus-5-5',
    );
  });
});

// The owner, 2026-11-09: a time is its date, clock and zone, each kept
// whole; a narrow column breaks between them.
@Component({
  imports: [TimeText],
  template: `<span class="t" appTime="2026-10-28T10:00:00.000Z"></span>`,
})
class Times {}

describe('TimeText', () => {
  it('shows the date, the clock and the zone as three parts; the text stays the same', async () => {
    setup();
    const fixture = TestBed.createComponent(Times);
    await settle(fixture);
    const t = el(fixture).querySelector('.t')!;
    const spans = [...t.querySelectorAll('span')].map((s) => s.textContent);
    expect(spans.length).toBe(3);
    expect(spans.join(' ')).toBe(localTime('2026-10-28T10:00:00.000Z'));
    expect(t.textContent).toBe(localTime('2026-10-28T10:00:00.000Z'));
  });
});
