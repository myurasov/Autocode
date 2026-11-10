/*
 * Unit tests of a grouped table's folding (the owner, 2026-11-09: "make groups
 * collapsible on group row click and remember the collapse state for each
 * group"): fold and open by a click, kept per table in localStorage, a link
 * into a folded group opens it; and the heading row that does it.
 */

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { el, settle, setup, text } from '../testing/helpers';
import { FoldRow, Folds } from './fold';

beforeEach(() => localStorage.clear());

describe('Folds', () => {
  it('folds and opens a group, kept per table across pages', () => {
    const agents = new Folds('agents');
    expect(agents.folded('laptop')).toBe(false);
    agents.toggle('laptop');
    expect(agents.folded('laptop')).toBe(true);
    // a new page of the same table remembers; another table does not share it
    expect(new Folds('agents').folded('laptop')).toBe(true);
    expect(new Folds('hosts').folded('laptop')).toBe(false);
    expect(JSON.parse(localStorage.getItem('autocode.fold.agents')!)).toEqual([
      'laptop',
    ]);
    agents.toggle('laptop');
    expect(new Folds('agents').folded('laptop')).toBe(false);
  });

  it('a link into a folded group opens it', () => {
    const f = new Folds('wakes');
    f.toggle('team:a');
    f.open('team:a');
    expect(f.folded('team:a')).toBe(false);
    expect(new Folds('wakes').folded('team:a')).toBe(false);
  });

  it('a stored value that is not a list counts as nothing folded', () => {
    localStorage.setItem('autocode.fold.agents', '{bad');
    expect(new Folds('agents').folded('x')).toBe(false);
  });
});

@Component({
  imports: [FoldRow],
  template: `<table>
    <tbody>
      <tr
        app-fold
        [columns]="12"
        [folded]="folded()"
        [count]="3"
        (toggle)="folded.set(!folded())"
      >
        <span class="name">laptop</span>
      </tr>
    </tbody>
  </table>`,
})
class Host {
  readonly folded = signal(false);
}

describe('FoldRow', () => {
  it('is the group heading: a click or Enter folds or opens it, and says so', async () => {
    setup();
    const fixture = TestBed.createComponent(Host);
    await settle(fixture);
    const row = el(fixture).querySelector('tr.group')!;
    const th = row.querySelector('th')!;
    expect(th.getAttribute('colspan')).toBe('12');
    expect(th.getAttribute('scope')).toBe('rowgroup');
    expect(th.getAttribute('role')).toBe('button');
    expect(th.getAttribute('tabindex')).toBe('0');
    expect(th.getAttribute('aria-expanded')).toBe('true');
    expect(text(th.querySelector('.name'))).toBe('laptop');
    expect(row.querySelector('.fold-count')).toBeNull();
    th.click();
    await settle(fixture);
    expect(th.getAttribute('aria-expanded')).toBe('false');
    expect(row.classList).toContain('folded');
    // folded: how many rows it hides
    expect(text(row.querySelector('.fold-count'))).toBe('3');
    th.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    expect(th.getAttribute('aria-expanded')).toBe('true');
  });

  it('a click on a link in the heading does not fold it', async () => {
    setup();
    @Component({
      imports: [FoldRow],
      template: `<table><tbody>
        <tr app-fold [columns]="2" [folded]="f()" [count]="1" (toggle)="f.set(!f())">
          <a href="#x" class="link">x</a>
        </tr></tbody></table>`,
    })
    class WithLink {
      readonly f = signal(false);
    }
    const fixture = TestBed.createComponent(WithLink);
    await settle(fixture);
    (el(fixture).querySelector('a.link') as HTMLElement).click();
    await settle(fixture);
    expect(fixture.componentInstance.f()).toBe(false);
  });
});
