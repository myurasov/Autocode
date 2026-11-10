/*
 * Unit tests of "Updated Xs ago.": nothing before the first load, then the
 * seconds since the last one, counting up every second.
 */

import { TestBed } from '@angular/core/testing';
import { el, setup, text } from '../testing/helpers';
import { Updated } from './updated';

describe('Updated', () => {
  beforeEach(() => {
    setup();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('shows nothing before the first load, then the seconds since the last one', async () => {
    const fixture = TestBed.createComponent(Updated);
    try {
      fixture.detectChanges();
      expect(text(el(fixture))).toBe('');
      fixture.componentRef.setInput('at', Date.now());
      fixture.detectChanges();
      expect(text(el(fixture))).toBe('Updated 0s ago.');
      await vi.advanceTimersByTimeAsync(3000);
      fixture.detectChanges();
      expect(text(el(fixture))).toBe('Updated 3s ago.');
      fixture.componentRef.setInput('at', Date.now());
      fixture.detectChanges();
      expect(text(el(fixture))).toBe('Updated 0s ago.');
    } finally {
      fixture.destroy();
    }
  });
});
