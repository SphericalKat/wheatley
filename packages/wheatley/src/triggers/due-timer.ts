/** A timer never sleeps longer than this, so that a scheduler notices a changed system clock within a minute. */
const MAX_TIMER_MS = 60_000;

/**
 * Arms an unref'd timer that calls `onDue` at `due` (epoch milliseconds), or after `MAX_TIMER_MS` if `due` is later.
 * A `due` in the past calls `onDue` on the next timer turn. Returns `undefined` and arms nothing if `due` is `null`.
 */
export const armDueTimer = (
  due: number | null,
  now: number,
  onDue: () => void
): NodeJS.Timeout | undefined => {
  if (due === null) {
    return undefined;
  }

  const timer = setTimeout(
    onDue,
    Math.min(Math.max(due - now, 0), MAX_TIMER_MS)
  );

  timer.unref();

  return timer;
};
