/*
 * A message's text as markdown (the owner, 2026-11-09: "Let them use normal
 * font, but render markdown"), through marked: GitHub's flavor, a single line
 * break kept, links opening in a new tab. Its HTML goes in through Angular's
 * [innerHTML], whose sanitizer takes out anything that could run (scripts,
 * event handlers, javascript: links).
 */

import { Component, computed, input } from '@angular/core';
import { Marked, type Tokens } from 'marked';

const marked = new Marked({ gfm: true, breaks: true, async: false });
marked.use({
  renderer: {
    link(this: any, token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      const href = String(token.href ?? '').replace(/"/g, '&quot;');
      return (
        `<a href="${href}" target="_blank" rel="noopener noreferrer">` +
        `${text}</a>`
      );
    },
  },
});

// A text's markdown as HTML (not yet sanitized: [innerHTML] does that).
export function markdownHtml(text: string): string {
  return marked.parse(text ?? '') as string;
}

@Component({
  selector: 'app-markdown',
  template: `<div class="md" [innerHTML]="html()"></div>`,
})
export class Markdown {
  readonly text = input<string | null | undefined>('');
  protected readonly html = computed(() => markdownHtml(this.text() ?? ''));
}
