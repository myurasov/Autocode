/*
 * Unit tests of a message's text as markdown (the owner, 2026-11-09: "Let
 * them use normal font, but render markdown"): what markdown makes, line
 * breaks kept, and nothing that could run (scripts, handlers, javascript:
 * links) left in it; links open in a new tab.
 */

import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { el, settle, setup } from '../testing/helpers';
import { Markdown, markdownHtml } from './markdown';

@Component({
  imports: [Markdown],
  template: `<app-markdown class="m" [text]="text()" />`,
})
class Host {
  readonly text = input('');
}

async function render(text: string): Promise<HTMLElement> {
  setup();
  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('text', text);
  await settle(fixture);
  return el(fixture).querySelector('.m') as HTMLElement;
}

describe('markdownHtml', () => {
  it('makes headings, emphasis, code, lists, quotes and links', () => {
    const html = markdownHtml(
      '# Plan\n\n**Bold**, _it_, `code`.\n\n- one\n- two\n\n> quoted\n\n' +
        '[docs](https://example.com)\n\n```\nblock\n```',
    );
    for (const part of [
      '<h1>Plan</h1>',
      '<strong>Bold</strong>',
      '<em>it</em>',
      '<code>code</code>',
      '<li>one</li>',
      '<blockquote>',
      '<pre><code>block\n</code></pre>',
    ])
      expect(html).toContain(part);
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('keeps single line breaks, as a message is written', () => {
    expect(markdownHtml('Line one.\nLine two.')).toContain(
      'Line one.<br>Line two.',
    );
  });

  it('a table renders', () => {
    expect(markdownHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toContain(
      '<table>',
    );
  });
});

describe('Markdown', () => {
  it('shows the markdown, and nothing in it runs', async () => {
    const m = await render(
      '**hi** <script>window.x = 1</script>\n\n' +
        '<img src=x onerror="window.x = 2">\n\n[bad](javascript:alert(1))',
    );
    expect(m.querySelector('strong')!.textContent).toBe('hi');
    expect(m.querySelector('script')).toBeNull();
    expect(m.querySelector('[onerror]')).toBeNull();
    for (const a of m.querySelectorAll('a'))
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    expect((window as any).x).toBeUndefined();
  });

  it('nothing for no text', async () => {
    const m = await render('');
    expect(m.textContent).toBe('');
  });
});
