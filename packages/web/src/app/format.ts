/*
 * How the pages show times, setting values, versions, long texts, an agent's
 * status, spend and context: times in the viewer's own time zone, in AISee's
 * format with the zone's short name; on/off for switches; versions with a v;
 * a long text folded to its first 200 characters; a status's dot; spend today
 * and in total; the context's share of its compaction threshold.
 */

import type { CostNumbers } from './api';

const tokens = (n: number) => n.toLocaleString('en-US');

// Spend today and in total (the owner, 2026-11-08): "$1.50 today / $12.35
// total".
export function spendText(k: CostNumbers): string {
  return spendParts(k).join(' ');
}

// Its two halves, which a narrow cell keeps whole: "$1.50 today /", "$12.35
// total".
export function spendParts(k: CostNumbers): [string, string] {
  return [
    `$${k.today_usd.toFixed(2)} today /`,
    `$${k.total_usd.toFixed(2)} total`,
  ];
}

/*
 * The context as its share of the compaction threshold (the owner,
 * 2026-11-08): "80.0% of 100,000", with " (max 200,000)" for the model's
 * window when asked; the tokens alone without a threshold; "—" before the
 * first step.
 */
export function contextText(k: CostNumbers, withWindow = false): string {
  if (k.context === null) return '—';
  if (k.compact_at === null || k.context_share === null)
    return `${tokens(k.context)} tokens`;
  const max =
    withWindow && k.context_limit ? ` (max ${tokens(k.context_limit)})` : '';
  return `${k.context_share.toFixed(1)}% of ${tokens(k.compact_at)}${max}`;
}

// Its two halves, which a narrow cell keeps whole: "80.0% of", "100,000"
// (one half alone when there is no threshold).
export function contextParts(k: CostNumbers): [string, string] {
  const all = contextText(k);
  const at = all.indexOf(' of ');
  return at < 0 ? [all, ''] : [all.slice(0, at + 3), all.slice(at + 4)];
}

/*
 * A model ID as the provider's path and the model's name: "nvidia-ih/aws/
 * anthropic/", "bedrock-claude-opus-5-5" (the name alone without a path).
 */
export function modelParts(model: string): [string, string] {
  const at = model.lastIndexOf('/');
  return at < 0 ? ['', model] : [model.slice(0, at + 1), model.slice(at + 1)];
}

// The context's tooltip: the tokens and the threshold.
export function contextTitle(k: CostNumbers): string {
  if (k.context === null) return 'No model step yet';
  const used = `${tokens(k.context)} tokens`;
  if (k.compact_at === null)
    return `${used}; no compaction threshold (compact_at off)`;
  return `${used}; compacted past ${tokens(k.compact_at)} (compact_at)`;
}

/*
 * The color of an agent's status dot, the same on every tab: idle and working
 * green (ok), paused amber (warn), offline red (off), error pink-red (err);
 * any other status (waiting) the plain dot's amber.
 */
export function dotClass(status: string): string {
  if (status === 'idle' || status === 'working') return 'ok';
  if (status === 'paused') return 'warn';
  if (status === 'offline') return 'off';
  if (status === 'error') return 'err';
  return '';
}

// An ISO time in the viewer's time zone (or the one given), like AISee plus
// the zone: 28-Oct-26 03:00:00 PT.
export function localTime(
  iso: string | undefined | null,
  timeZone?: string,
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: '2-digit',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortGeneric',
  }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return (
    `${part('day')}-${part('month')}-${part('year')} ` +
    `${part('hour')}:${part('minute')}:${part('second')} ` +
    part('timeZoneName')
  );
}

/*
 * A time in a zone (the owner, 2026-11-08: when the Costs tab's data was
 * read): "Nov 8, 2026 17:02:03 PT", the zone's generic short name (PT, not
 * PST or PDT), as the other pages' times.
 */
export function clockText(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortGeneric',
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return (
    `${part('month')} ${part('day')}, ${part('year')} ` +
    `${part('hour')}:${part('minute')}:${part('second')} ` +
    part('timeZoneName')
  );
}

// A setting's value as text: on/off for switches.
export function valueText(value: unknown): string {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value === undefined || value === null) return '';
  return String(value);
}

// A version as people see it, "v2.2.0"; one that does not start with a digit
// (nothing, or a name such as "local") stays as it is.
export function versionText(version: string | null | undefined): string {
  if (!version) return '';
  return /^\d/.test(version) ? `v${version}` : version;
}

// How much of a long text (a wake's, a message's) shows until it is opened.
export const FOLD_CHARS = 200;

// A text as it shows folded: whole up to 200 characters, else its first 200
// and "…".
export function folded(text: string): string {
  if (text.length <= FOLD_CHARS) return text;
  return `${text.slice(0, FOLD_CHARS).trimEnd()}…`;
}
