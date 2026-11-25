/*
 * The page's icon, lit while something waits for the owner in the Inbox (the
 * owner, 2026-11-24: "i want triangle to befilled with gradiend to a lighter
 * color like it is lit"; not for reports, which the count leaves out): the
 * logo's triangle with its pink-red outline, its inside filled with a
 * gradient from that colour at the edge to a lighter one at its middle. With
 * nothing waiting the page shows its own icon again (index.html: the plain
 * outline). A browser tab in the background shows the one or the other.
 */

import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

// The lit triangle: the path and the outline of index.html's icon.
export const FAVICON_LIT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" ' +
  'fill="url(#lit)" stroke="#e8436e" stroke-width="2" ' +
  'stroke-linejoin="round" stroke-linecap="round">' +
  '<defs><radialGradient id="lit" gradientUnits="userSpaceOnUse" ' +
  'cx="8" cy="10.2" r="6.5">' +
  '<stop offset="0" stop-color="#fff3f6"/>' +
  '<stop offset=".5" stop-color="#ffb1c5"/>' +
  '<stop offset="1" stop-color="#e8436e"/>' +
  '</radialGradient></defs>' +
  '<path d="M8 2 14.5 13.5 1.5 13.5Z"/></svg>';

export const litHref = `data:image/svg+xml,${encodeURIComponent(FAVICON_LIT)}`;

@Injectable({ providedIn: 'root' })
export class Favicon {
  private readonly document = inject(DOCUMENT);
  // the page's own icon, as it was before the first change
  private plain: string | null = null;

  // Lit, or the page's own icon again.
  show(lit: boolean): void {
    const icon = this.document.querySelector('link[rel="icon"]');
    if (!icon) return;
    const now = icon.getAttribute('href');
    if (now !== litHref) this.plain = now;
    const href = lit ? litHref : this.plain;
    if (href !== null && href !== now) icon.setAttribute('href', href);
  }
}
