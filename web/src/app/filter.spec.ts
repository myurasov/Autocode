/*
 * Unit tests of the filter fields' matching (the owner, 2026-11-17: "treat
 * filters as if * is added before and after what is typed"): each
 * comma-separated part matches anywhere in an ID.
 */

import { contains } from './filter';

describe('contains', () => {
  it('puts * before and after each part, once', () => {
    expect(contains('lead')).toBe('*lead*');
    expect(contains('kaggle:*')).toBe('*kaggle:*');
    expect(contains('*:reviewer')).toBe('*:reviewer*');
    expect(contains('*')).toBe('*');
    expect(contains(' lead , worker ')).toBe('*lead*,*worker*');
    expect(contains('a,,b')).toBe('*a*,*b*');
  });

  it('nothing typed is no filter', () => {
    expect(contains('')).toBe('');
    expect(contains('  ')).toBe('');
    expect(contains(' , ')).toBe('');
  });
});
