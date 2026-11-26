const THOUSAND = 1000;
const MILLION = 1_000_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SHORT_SECONDS = 10;
const CENT = 0.01;

/** A token count for the status bar, for example `842`, `12.3k`, or `1.2M`. */
export const formatCount = (count: number): string => {
  if (count >= MILLION) {
    return `${(count / MILLION).toFixed(1)}M`;
  }

  return count >= THOUSAND ? `${(count / THOUSAND).toFixed(1)}k` : `${count}`;
};

/** A cost in US dollars, with more digits below one cent. */
export const formatCost = (usd: number): string =>
  usd > 0 && usd < CENT ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** A duration, for example `0.4s`, `12s`, `3m 05s`, or `1h 02m`. */
export const formatSeconds = (seconds: number): string => {
  if (seconds < SHORT_SECONDS) {
    return `${seconds.toFixed(1)}s`;
  }

  const whole = Math.round(seconds);

  if (whole < SECONDS_PER_MINUTE) {
    return `${whole}s`;
  }

  if (whole < SECONDS_PER_HOUR) {
    const minutes = Math.floor(whole / SECONDS_PER_MINUTE);

    return `${minutes}m ${String(whole % SECONDS_PER_MINUTE).padStart(2, "0")}s`;
  }

  const hours = Math.floor(whole / SECONDS_PER_HOUR);
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);

  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
};
