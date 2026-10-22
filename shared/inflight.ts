/**
 * One request at a time for one action: while a call is running, every further call gets the same
 * promise instead of starting another. A button pressed twice, an effect that ran again or a
 * handler fired from two places creates one month, not five.
 */
export function inFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let pending: Promise<T> | null = null;
  return (...args: A) => {
    if (pending) return pending;
    pending = fn(...args).finally(() => {
      pending = null;
    });
    return pending;
  };
}
