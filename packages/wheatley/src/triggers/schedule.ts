import type { TriggerSchedule } from "@wheatley/protocol";
import { Cron } from "croner";

import { SeamError } from "../contracts/errors.js";
import { errorText } from "./errors.js";

const isTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);

    return true;
  } catch {
    return false;
  }
};

/**
 * Parses a 5-field cron expression in an IANA time zone. Throws `SeamError("invalid_name")` for an invalid expression,
 * an unknown time zone, or an expression that never matches, for example `0 0 30 2 *`.
 */
export const parseCron = (expression: string, timezone: string): Cron => {
  if (!isTimeZone(timezone)) {
    throw new SeamError("invalid_name", `Invalid time zone: ${timezone}`);
  }

  let cron: Cron;

  try {
    cron = new Cron(expression.trim(), { mode: "5-part", timezone });
  } catch (error) {
    throw new SeamError(
      "invalid_name",
      `Invalid cron expression: ${expression} (${errorText(error)})`
    );
  }

  if (cron.nextRun() === null) {
    throw new SeamError(
      "invalid_name",
      `Cron expression never matches: ${expression}`
    );
  }

  return cron;
};

/** Throws `SeamError("invalid_name")` if `schedule` is a `cron` schedule with an invalid expression or time zone. */
export const assertValidSchedule = (schedule: TriggerSchedule): void => {
  if (schedule.kind === "cron") {
    parseCron(schedule.schedule, schedule.timezone);
  }
};

/** The first `cron` tick strictly after `after` (epoch milliseconds), or `null` if no tick follows. */
export const nextCronTick = (
  schedule: Extract<TriggerSchedule, { kind: "cron" }>,
  after: number
): number | null =>
  parseCron(schedule.schedule, schedule.timezone)
    .nextRun(new Date(after))
    ?.getTime() ?? null;

/**
 * The first fire time of a new or rescheduled Trigger: the next future tick for `cron`, the `at` time for `once` (also
 * if it is in the past, so that an overdue `once` catches up one time), and `null` for `webhook`.
 */
export const initialFireAt = (
  schedule: TriggerSchedule,
  now: number
): number | null => {
  if (schedule.kind === "cron") {
    return nextCronTick(schedule, now);
  }

  return schedule.kind === "once" ? Date.parse(schedule.at) : null;
};
