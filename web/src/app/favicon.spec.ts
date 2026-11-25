/*
 * Unit tests of the page's icon (the owner, 2026-11-24): the lit triangle is
 * the plain one filled with a gradient from its pink-red to a lighter colour
 * at its middle; the page's icon link shows it while something waits, and the
 * page's own icon again when nothing does.
 */

import { TestBed } from '@angular/core/testing';
import { Favicon, FAVICON_LIT, litHref } from './favicon';

const PLAIN =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ' +
  'viewBox="0 0 16 16" fill="none" stroke="%23e8436e" stroke-width="2">' +
  '<path d="M8 2 14.5 13.5 1.5 13.5Z"/></svg>';

function link(): HTMLLinkElement {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.setAttribute('href', PLAIN);
  document.head.append(icon);
  return icon;
}

describe('the lit favicon', () => {
  it('is the same triangle and outline, filled with a gradient that gets lighter toward its middle', () => {
    const svg = new DOMParser().parseFromString(FAVICON_LIT, 'image/svg+xml');
    const root = svg.documentElement;
    expect(root.nodeName).toBe('svg');
    expect(root.getAttribute('viewBox')).toBe('0 0 16 16');
    // the outline as before: the logo's pink-red, 2 px, round corners
    expect(root.getAttribute('stroke')).toBe('#e8436e');
    expect(root.getAttribute('stroke-width')).toBe('2');
    expect(root.getAttribute('stroke-linejoin')).toBe('round');
    const paths = [...root.querySelectorAll('path')];
    expect(paths.map((p) => p.getAttribute('d'))).toEqual([
      'M8 2 14.5 13.5 1.5 13.5Z',
    ]);
    // filled with its gradient
    const gradient = root.querySelector('radialGradient')!;
    expect(root.getAttribute('fill')).toBe(`url(#${gradient.id})`);
    const stops = [...gradient.querySelectorAll('stop')].map((s) => ({
      at: Number(s.getAttribute('offset')),
      color: s.getAttribute('stop-color')!,
    }));
    // at its edge the outline's colour; lighter at each step to the middle
    expect(stops.at(-1)).toEqual({ at: 1, color: '#e8436e' });
    expect(stops[0]!.at).toBe(0);
    const light = (hex: string) =>
      [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
    const lights = stops.map((s) => light(s.color));
    expect(lights).toEqual([...lights].sort((a, b) => b - a));
    expect(new Set(lights).size).toBe(stops.length);
    expect(lights[0]).toBeGreaterThan(700);
    // its middle is inside the triangle, below its centre line
    expect(Number(gradient.getAttribute('cx'))).toBe(8);
    const cy = Number(gradient.getAttribute('cy'));
    expect(cy).toBeGreaterThan(8);
    expect(cy).toBeLessThan(12.5);
  });

  it('is a data URL of that SVG', () => {
    const prefix = 'data:image/svg+xml,';
    expect(litHref.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(litHref.slice(prefix.length))).toBe(FAVICON_LIT);
    // nothing a URL would cut: no raw "#"
    expect(litHref).not.toContain('#');
  });
});

describe('Favicon', () => {
  afterEach(() => {
    for (const icon of document.querySelectorAll('link[rel="icon"]'))
      icon.remove();
  });

  it("lights the page's icon and puts the page's own back", () => {
    const icon = link();
    const favicon = TestBed.inject(Favicon);
    favicon.show(true);
    expect(icon.getAttribute('href')).toBe(litHref);
    favicon.show(true);
    expect(icon.getAttribute('href')).toBe(litHref);
    favicon.show(false);
    expect(icon.getAttribute('href')).toBe(PLAIN);
    // one icon link, as before
    expect(document.querySelectorAll('link[rel="icon"]').length).toBe(1);
  });

  it('does nothing on a page without an icon', () => {
    const favicon = TestBed.inject(Favicon);
    expect(() => favicon.show(true)).not.toThrow();
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
  });
});
