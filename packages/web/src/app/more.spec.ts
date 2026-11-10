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

  it('keeps a count per list (a group of a grouped table)', () => {
    const p = new Paged();
    p.more('a');
    expect(p.count('a')).toBe(50);
    expect(p.count('b')).toBe(25);
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
  it('is one cell across the table, says how many are left, and asks for 25 more', async () => {
    setup();
    const fixture = TestBed.createComponent(Host);
    await settle(fixture);
    const row = el(fixture).querySelector('tr.more-rows')!;
    const cells = row.querySelectorAll('td');
    expect(cells.length).toBe(1);
    expect(cells[0]!.getAttribute('colspan')).toBe('7');
    const button = row.querySelector('button') as HTMLButtonElement;
    expect(text(button)).toBe('...');
    expect(button.getAttribute('title')).toBe('Show 25 more (35 left)');
    expect(text(row)).toBe('... 35 more');
    button.click();
    await settle(fixture);
    expect(fixture.componentInstance.clicks()).toBe(1);
    fixture.componentInstance.left.set(10);
    await settle(fixture);
    expect(button.getAttribute('title')).toBe('Show 10 more');
    expect(text(row)).toBe('... 10 more');
  });
});
