/*
 * Unit tests of Latest: which answer of a list's requests may show (the
 * review before 1.0.0: a refresh sent before an action answered after the
 * refresh that followed it, and put the old list back).
 */

import { Latest } from './latest';

describe('Latest', () => {
  it('answers in the order sent all show', () => {
    const latest = new Latest();
    const one = latest.next();
    const two = latest.next();
    expect(latest.take(one)).toBe(true);
    expect(latest.take(two)).toBe(true);
  });

  it('an answer that comes after a newer one does not show', () => {
    const latest = new Latest();
    const one = latest.next();
    const two = latest.next();
    const three = latest.next();
    expect(latest.take(two)).toBe(true);
    expect(latest.take(one)).toBe(false);
    expect(latest.take(three)).toBe(true);
    expect(latest.take(two)).toBe(false);
  });
});
