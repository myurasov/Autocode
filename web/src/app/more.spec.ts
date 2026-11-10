/*
 * Unit tests of the 25-row limit (the owner, 2026-11-09: "in each table after
 * max 25 rows there should be "..." indicator at the bottom that loads 25
 * rows more"): the shown count per list, 25 more a click, a row a link points
 * at always shown; and the "..." row: one cell across the table, what it
 * says, and its click.
 */

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { el, settle, setup, text } from '../testing/helpers';
import { MoreRow, Paged, PAGE_ROWS, paged } from './more';

describe('paged', () => {
  const rows = Array.from({ length: 60 }, (_, i) => `r${i}`);

  it('shows the first 25, then 25 more each time; says how many are left', () => {
    const p = new Paged();
    let v = paged(rows, p.count('t'));
    expect(PAGE_ROWS).toBe(25);
    expect(v.rows).toEqual(rows.slice(0, 25));
    expect(v.left).toBe(35);
    p.more('t');
    v = paged(rows, p.count('t'));
    expect(v.rows.length).toBe(50);
    expect(v.left).toBe(10);
    p.more('t');
    v = paged(rows, p.count('t'));
    expect(v.rows).toEqual(rows);
    expect(v.left).toBe(0);
  });

  it('keeps a count per list (a group of a grouped table); a new list starts at 25', () => {
    const p = new Paged();
    p.more('a');
    expect(p.count('a')).toBe(50);
    expect(p.count('b')).toBe(25);
    p.reset('a');
    expect(p.count('a')).toBe(25);
  });

  it('a row a link points at is shown, past the 25 too', () => {
    const v = paged(rows, 25, (r) => r === 'r40');
    expect(v.rows).toEqual([...rows.slice(0, 25), 'r40']);
    expect(v.left).toBe(34);
    // within the 25: nothing added
    expect(paged(rows, 25, (r) => r === 'r3').rows.length).toBe(25);
  });

  it('a short list shows whole, with nothing left', () => {
    expect(paged(['a', 'b'], 25)).toEqual({ rows: ['a', 'b'], left: 0 });
  });
});

@Component({
  imports: [MoreRow],
  template: `<table>
    <tbody>
      <tr app-more [columns]="7" [left]="left()" (more)="clicks.set(clicks() + 1)"></tr>
    </tbody>
  </table>`,
})
class Host {
  readonly left = signal(35);
  readonly clicks = signal(0);
}

describe('MoreRow', () => {
  // The owner, 2026-11-09: only "...", no count (History's was wrong: it
  // cannot know what is not loaded yet), and not a button: the row itself,
  // its dots bigger, centered.
  it('is one cell across the table, only "...", and a click or Enter asks for more', async () => {
    setup();
    const fixture = TestBed.createComponent(Host);
    await settle(fixture);
    const row = el(fixture).querySelector('tr.more-rows')!;
    const cells = row.querySelectorAll('td');
    expect(cells.length).toBe(1);
    const td = cells[0]!;
    expect(td.getAttribute('colspan')).toBe('7');
    expect(row.querySelector('button')).toBeNull();
    expect(text(row)).toBe('...');
    expect(td.getAttribute('role')).toBe('button');
    expect(td.getAttribute('tabindex')).toBe('0');
    expect(td.getAttribute('aria-label')).toBe('Show more');
    expect(td.getAttribute('title')).toBe('Show more');
    (td as HTMLElement).click();
    await settle(fixture);
    expect(fixture.componentInstance.clicks()).toBe(1);
    td.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    expect(fixture.componentInstance.clicks()).toBe(2);
    // the count is gone whatever is left
    fixture.componentInstance.left.set(10);
    await settle(fixture);
    expect(text(row)).toBe('...');
  });
});
