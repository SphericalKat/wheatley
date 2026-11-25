const DURATION = /^(?<amount>\d+)(?<unit>ms|s|m|h|d)$/u;

const UNIT_MS = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  ms: 1,
  s: 1000,
} as const;

const isUnit = (unit: string): unit is keyof typeof UNIT_MS =>
  Object.hasOwn(UNIT_MS, unit);

/**
 * Converts a config duration such as `15m` or `30s` to milliseconds.
 *
 * Throws a `RangeError` for text that does not match the `Duration` schema or exceeds `Number.MAX_SAFE_INTEGER`
 * milliseconds.
 */
export const parseDuration = (text: string): number => {
  const groups = DURATION.exec(text)?.groups;
  const unit = groups?.unit ?? "";

  if (groups?.amount === undefined || !isUnit(unit)) {
    throw new RangeError(`Invalid duration: ${text}`);
  }

  const milliseconds = Number(groups.amount) * UNIT_MS[unit];

  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`Duration is too long: ${text}`);
  }

  return milliseconds;
};
