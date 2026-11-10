/*
 * Unit tests of how the pages show times: in the viewer's time zone, with the
 * zone's short name (PT for Pacific time); versions, with a v; and long texts,
 * folded to their first 200 characters.
 */

import { dayText, folded, localTime, versionText } from './format';

describe('localTime', () => {
  it("shows a time in the viewer's zone, with the zone's name", () => {
    const la = 'America/Los_Angeles';
    expect(localTime('2026-10-28T10:00:00.000Z', la)).toBe(
      '28-Oct-26 03:00:00 PT',
    );
    expect(localTime('2026-12-01T20:05:09.000Z', la)).toBe(
      '01-Dec-26 12:05:09 PT',
    );
    expect(localTime('2026-10-28T10:00:00.000Z', 'America/New_York')).toBe(
      '28-Oct-26 06:00:00 ET',
    );
  });

  it("uses the browser's own zone by default", () => {
    expect(localTime('2026-10-28T10:00:00.000Z')).toMatch(
      /^\d\d-[A-Z][a-z]{2}-\d\d \d\d:\d\d:\d\d \S+$/,
    );
  });

  it('leaves nothing and a bad time as they are', () => {
    expect(localTime('')).toBe('');
    expect(localTime(undefined)).toBe('');
    expect(localTime('soon')).toBe('soon');
  });
});

// The owner, 2026-11-09: every date in the web UI as 05-Nov-26.
describe('dayText', () => {
  it('shows a day (YYYY-MM-DD) as 05-Nov-26, whatever the zone', () => {
    expect(dayText('2026-11-05')).toBe('05-Nov-26');
    expect(dayText('2026-12-31')).toBe('31-Dec-26');
    expect(dayText('2027-01-01')).toBe('01-Jan-27');
  });

  it('leaves nothing and a bad day as they are', () => {
    expect(dayText('')).toBe('');
    expect(dayText('soon')).toBe('soon');
  });
});

describe('versionText', () => {
  it('shows a version with a v; a name or nothing stays as it is', () => {
    expect(versionText('0.1.0-build12')).toBe('v0.1.0-build12');
    expect(versionText('2.2.0')).toBe('v2.2.0');
    expect(versionText('v2.2.0')).toBe('v2.2.0');
    expect(versionText('local')).toBe('local');
    expect(versionText('')).toBe('');
    expect(versionText(null)).toBe('');
  });
});

describe('folded', () => {
  it('keeps a text of up to 200 characters whole and folds a longer one', () => {
    const two = 'x'.repeat(200);
    expect(folded(two)).toBe(two);
    expect(folded(`${'y'.repeat(199)} more`)).toBe(`${'y'.repeat(199)}…`);
    expect(folded(`a\nb${'c'.repeat(220)}`)).toBe(`a\nb${'c'.repeat(197)}…`);
  });
});
