/*
 * Unit tests of how the pages show times: in the viewer's time zone, with the
 * zone's short name (PT for Pacific time); and versions, with a v.
 */

import { localTime, versionText } from './format';

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
