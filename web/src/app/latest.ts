/*
 * Which answer of a list's requests may show: one that was sent after the
 * answer on show. A refresh sent before an action (Close, Pause, a saved
 * description) can answer after the refresh that followed the action; that
 * older list must not take the newer one's place (the review before 1.0.0).
 */

export class Latest {
  private sent = 0;
  private shown = 0;

  // A request goes out: its number.
  next(): number {
    return ++this.sent;
  }

  // Whether request n's answer may show: no later one's shows yet.
  take(n: number): boolean {
    if (n < this.shown) return false;
    this.shown = n;
    return true;
  }
}
