/*
 * Unit tests of sorting a table by its column headings (the owner,
 * 2026-11-17: "where applicable table headers should upon click sort tables.
 * by default tabs should be roted by date, from recent to oldest"): the
 * default column and direction, a click on another column (times and numbers
 * start largest first, text A to Z), a click on the sorted one reverses it,
 * the choice kept per table in localStorage, empty values last either way;
 * and the heading that does it (a button, its arrow, aria-sort).
 */

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { el, settle, setup, text } from '../testing/helpers';
import { SortHead, Sorting } from './sort';

beforeEach(() => localStorage.clear());

interface Row {
  id: string;
  at: string | null;
  usd: number | null;
}

const ROWS: Row[] = [
  { id: 'b', at: '2026-11-02T00:00:00.000Z', usd: 2 },
  { id: 'C', at: null, usd: 10 },
  { id: 'a', at: '2026-11-03T00:00:00.000Z', usd: null },
  { id: 'd', at: '2026-11-01T00:00:00.000Z', usd: 1 },
];

function sorting(table = 'test') {
  return new Sorting<Row>(table, {
    columns: {
      id: { text: (r) => r.id },
      at: { time: (r) => r.at },
      usd: { number: (r) => r.usd },
    },
    by: 'at',
  });
}

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('Sorting', () => {
  it('sorts by its default column, newest first; empty values last', () => {
    const s = sorting();
    expect(s.key()).toBe('at');
    expect(s.dir()).toBe('desc');
    expect(ids(s.sort(ROWS))).toEqual(['a', 'b', 'd', 'C']);
    // the rows given are not changed
    expect(ids(ROWS)).toEqual(['b', 'C', 'a', 'd']);
  });

  it('a click on the sorted column reverses it; empty values stay last', () => {
    const s = sorting();
    s.click('at');
    expect(s.dir()).toBe('asc');
    expect(ids(s.sort(ROWS))).toEqual(['d', 'b', 'a', 'C']);
  });

  it('another column starts at its natural direction: numbers largest first, text A to Z', () => {
    const s = sorting();
    s.click('usd');
    expect([s.key(), s.dir()]).toEqual(['usd', 'desc']);
    expect(ids(s.sort(ROWS))).toEqual(['C', 'b', 'd', 'a']);
    s.click('id');
    expect([s.key(), s.dir()]).toEqual(['id', 'asc']);
    // case and numbers as people read them
    expect(ids(s.sort(ROWS))).toEqual(['a', 'b', 'C', 'd']);
    s.click('id');
    expect(ids(s.sort(ROWS))).toEqual(['d', 'C', 'b', 'a']);
  });

  it('a column may start the other way (a time to come: soonest first)', () => {
    const s = new Sorting<Row>('next', {
      columns: {
        at: { time: (r) => r.at },
        due: { time: (r) => r.at, first: 'asc' },
      },
      by: 'at',
    });
    s.click('due');
    expect(s.dir()).toBe('asc');
    expect(ids(s.sort(ROWS))).toEqual(['d', 'b', 'a', 'C']);
  });

  it('text sorts numbers in it by value', () => {
    const s = new Sorting<{ n: string }>('n', {
      columns: { n: { text: (r) => r.n } },
      by: 'n',
    });
    expect(
      s.sort([{ n: 'w10' }, { n: 'w2' }, { n: 'w1' }]).map((r) => r.n),
    ).toEqual(['w1', 'w2', 'w10']);
  });

  it('keeps the choice per table across pages; another table does not share it', () => {
    const s = sorting('agents');
    s.click('usd');
    expect(new Sorting<Row>('agents', sorting().spec).key()).toBe('usd');
    expect(sorting('hosts').key()).toBe('at');
    expect(JSON.parse(localStorage.getItem('autocode.sort.agents')!)).toEqual({
      key: 'usd',
      dir: 'desc',
    });
  });

  it('a stored choice of a column that is gone, or not JSON, is the default', () => {
    localStorage.setItem('autocode.sort.test', '{bad');
    expect(sorting().key()).toBe('at');
    localStorage.setItem(
      'autocode.sort.test',
      JSON.stringify({ key: 'gone', dir: 'asc' }),
    );
    expect([sorting().key(), sorting().dir()]).toEqual(['at', 'desc']);
    localStorage.setItem(
      'autocode.sort.test',
      JSON.stringify({ key: 'id', dir: 'sideways' }),
    );
    expect([sorting().key(), sorting().dir()]).toEqual(['at', 'desc']);
  });

  // The review before 1.0.0: "toString" passed as a column, and sort threw.
  it('a stored choice that names an Object member is the default; a click on one does nothing', () => {
    for (const key of ['toString', 'constructor', '__proto__']) {
      localStorage.setItem(
        'autocode.sort.test',
        JSON.stringify({ key, dir: 'asc' }),
      );
      const s = sorting();
      expect(s.key()).toBe('at');
      s.click(key);
      expect(s.key()).toBe('at');
      expect(() => s.sort(ROWS)).not.toThrow();
    }
  });

  it('ties keep their order', () => {
    const s = new Sorting<{ id: string; g: string }>('ties', {
      columns: { g: { text: (r) => r.g } },
      by: 'g',
    });
    const rows = [
      { id: '1', g: 'x' },
      { id: '2', g: 'a' },
      { id: '3', g: 'x' },
      { id: '4', g: 'a' },
    ];
    expect(s.sort(rows).map((r) => r.id)).toEqual(['2', '4', '1', '3']);
  });
});

@Component({
  imports: [SortHead],
  template: `<table>
    <thead>
      <tr>
        <th appSort="id" [sorting]="s">ID</th>
        <th appSort="at" [sorting]="s">Time</th>
        <th>Plain</th>
      </tr>
    </thead>
  </table>`,
})
class Head {
  readonly s = sorting();
}

describe('SortHead', () => {
  it('is a button in the heading with its arrow and aria-sort; a click sorts', async () => {
    setup();
    const fixture = TestBed.createComponent(Head);
    await settle(fixture);
    const [id, at, plain] = [...el(fixture).querySelectorAll('th')];
    const button = (th: Element) => th.querySelector('button.sort')!;
    expect(text(button(id!))).toBe('ID');
    expect(button(id!).getAttribute('type')).toBe('button');
    expect(id!.getAttribute('aria-sort')).toBe('none');
    expect(at!.getAttribute('aria-sort')).toBe('descending');
    expect(at!.classList).toContain('sorted');
    expect(button(at!).querySelector('.arrow')).not.toBeNull();
    expect(button(id!).getAttribute('title')).toBe('Sort by ID');
    expect(plain!.querySelector('button')).toBeNull();
    (button(id!) as HTMLButtonElement).click();
    await settle(fixture);
    expect(id!.getAttribute('aria-sort')).toBe('ascending');
    expect(at!.getAttribute('aria-sort')).toBe('none');
    expect(fixture.componentInstance.s.key()).toBe('id');
    (button(id!) as HTMLButtonElement).click();
    await settle(fixture);
    expect(id!.getAttribute('aria-sort')).toBe('descending');
  });

  // The owner, 2026-11-17: "make table header cell hilight entirely when
  // hover (showing it can sort)": the cell is what sorts, so a click
  // anywhere in it does, and one on its button counts once.
  it('the whole cell sorts: a click on the cell itself, once for one on its button', async () => {
    setup();
    const fixture = TestBed.createComponent(Head);
    await settle(fixture);
    const [id, at, plain] = [...el(fixture).querySelectorAll('th')];
    const s = fixture.componentInstance.s;
    (id as HTMLElement).click();
    await settle(fixture);
    expect([s.key(), s.dir()]).toEqual(['id', 'asc']);
    (id as HTMLElement).click();
    await settle(fixture);
    expect([s.key(), s.dir()]).toEqual(['id', 'desc']);
    // the button's click reaches the cell: one step, not two
    (at!.querySelector('button.sort') as HTMLButtonElement).click();
    await settle(fixture);
    expect([s.key(), s.dir()]).toEqual(['at', 'desc']);
    // a plain heading does nothing
    (plain as HTMLElement).click();
    await settle(fixture);
    expect([s.key(), s.dir()]).toEqual(['at', 'desc']);
  });
});
