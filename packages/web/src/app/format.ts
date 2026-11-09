/*
 * How the pages show times, setting values, versions, long texts and an
 * agent's status: times in the viewer's own time zone, in AISee's format with
 * the zone's short name; on/off for switches; versions with a v; a long text
 * folded to its first 200 characters; a status's dot.
 */

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
