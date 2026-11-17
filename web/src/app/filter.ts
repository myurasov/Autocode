/*
 * What a filter field matches (the owner, 2026-11-17: "treat filters as if *
 * is added before and after what is typed"): each comma-separated part of
 * what is typed, anywhere in an ID, so "lead" finds kaggle:lead. The pages
 * send the server this pattern; the address keeps what was typed. The API
 * and the CLI keep exact patterns.
 */

// The pattern for what was typed: each part with * before and after it.
export function contains(typed: string): string {
  return typed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(
      (part) =>
        `${part.startsWith('*') ? '' : '*'}${part}${part.endsWith('*') ? '' : '*'}`,
    )
    .join(',');
}
