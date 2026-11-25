import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ui-sdk/react/alert-dialog";
import { Button } from "@ui-sdk/react/button";
import type { ReactNode } from "react";

import { errorMessage } from "../store.js";

/** The look of a button. */
export type Tone = "primary" | "neutral" | "danger";

const TONE_CLASSES: Record<Tone, string> = {
  danger: "bg-red-600 text-white hover:bg-red-500 data-[pending]:opacity-60",
  neutral:
    "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 data-[pending]:opacity-60",
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-500 data-[pending]:opacity-60",
};

/** Returns the classes of a button with `tone`. */
export const buttonClass = (tone: Tone = "neutral"): string =>
  `inline-flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${TONE_CLASSES[tone]}`;

/** Classes of a text input, select, or text area. */
export const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

export interface ActionButtonProps {
  readonly children: ReactNode;
  /** Runs on press. A returned Promise makes the button pending until it settles. */
  readonly onClick: () => Promise<void>;
  readonly tone?: Tone;
  readonly disabled?: boolean;
  readonly title?: string;
}

/** A button that shows a pending state while its async action runs. */
export const ActionButton = ({
  children,
  disabled = false,
  onClick,
  title,
  tone = "neutral",
}: ActionButtonProps) => (
  <Button
    className={buttonClass(tone)}
    disabled={disabled}
    onClick={onClick}
    title={title}
    type="button"
  >
    {children}
  </Button>
);

export interface ConfirmButtonProps {
  /** The text of the button that opens the dialog. */
  readonly label: ReactNode;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  /**
   * Runs after the Operator confirms. The dialog stays open while it runs. If it rejects, the dialog stays open and
   * shows the error.
   */
  readonly onConfirm: () => Promise<void>;
  readonly tone?: Tone;
  readonly disabled?: boolean;
  /** Extra inputs inside the dialog, for example a new name. */
  readonly children?: ReactNode;
}

/** A button that asks the Operator to confirm in an alert dialog before it runs an action. */
export const ConfirmButton = ({
  children,
  confirmLabel,
  description,
  disabled = false,
  label,
  onConfirm,
  title,
  tone = "danger",
}: ConfirmButtonProps) => (
  <AlertDialog>
    <AlertDialogTrigger
      className={buttonClass(tone === "danger" ? "neutral" : tone)}
      disabled={disabled}
    >
      {label}
    </AlertDialogTrigger>
    <AlertDialogBackdrop className="fixed inset-0 bg-black/50" />
    <AlertDialogContent className="fixed top-1/2 left-1/2 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-zinc-900">
      <AlertDialogTitle className="text-lg font-semibold">
        {title}
      </AlertDialogTitle>
      <AlertDialogDescription className="text-sm text-zinc-600 dark:text-zinc-400">
        {description}
      </AlertDialogDescription>
      {children}
      <AlertDialogClose
        action={onConfirm}
        className={buttonClass(tone)}
        render={(props, state) => (
          <div className="space-y-3">
            {state.error === undefined || state.error === null ? null : (
              <p className="text-sm text-red-600" role="alert">
                {errorMessage(state.error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <AlertDialogClose className={buttonClass("neutral")}>
                Cancel
              </AlertDialogClose>
              <button {...props}>{confirmLabel}</button>
            </div>
          </div>
        )}
        value="confirm"
      />
    </AlertDialogContent>
  </AlertDialog>
);

/** A titled section of a view. */
export const Panel = ({
  actions,
  children,
  title,
}: {
  readonly title: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {actions === undefined ? null : (
        <div className="flex flex-wrap gap-2">{actions}</div>
      )}
    </header>
    {children}
  </section>
);

/** A page heading with optional actions. */
export const PageHeader = ({
  actions,
  subtitle,
  title,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}) => (
  <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      {subtitle === undefined ? null : (
        <p className="text-sm text-zinc-500">{subtitle}</p>
      )}
    </div>
    {actions === undefined ? null : (
      <div className="flex flex-wrap gap-2">{actions}</div>
    )}
  </header>
);

/** An error message, or nothing for `null`. */
export const ErrorText = ({ error }: { readonly error: string | null }) =>
  error === null ? null : (
    <p
      className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
    >
      {error}
    </p>
  );

/** A message about a state that needs the Operator's attention. */
export const Notice = ({ children }: { readonly children: ReactNode }) => (
  <p
    className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    role="status"
  >
    {children}
  </p>
);

/** Text for a list without entries. */
export const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="py-4 text-center text-sm text-zinc-500">{children}</p>
);

/** The color of a state badge. */
export type BadgeColor = "green" | "amber" | "red" | "zinc" | "indigo";

const BADGE_CLASSES: Record<BadgeColor, string> = {
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100",
  green:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100",
  indigo:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-100",
  red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100",
  zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
};

/** A small colored label, for example an Agent state. */
export const Badge = ({
  children,
  color,
}: {
  readonly children: ReactNode;
  readonly color: BadgeColor;
}) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_CLASSES[color]}`}
  >
    {children}
  </span>
);

const STATE_COLORS = new Map<string, BadgeColor>([
  ["completed", "green"],
  ["degraded", "red"],
  ["disabled", "zinc"],
  ["failed", "red"],
  ["ready", "green"],
  ["running", "green"],
  ["starting", "amber"],
  ["stopped", "zinc"],
  ["waiting_approval", "amber"],
]);

/** A badge for an Agent, extension, or Run state. */
export const StateBadge = ({ state }: { readonly state: string }) => (
  <Badge color={STATE_COLORS.get(state) ?? "zinc"}>
    {state.replace("_", " ")}
  </Badge>
);

/** A label above a form control. */
export const Field = ({
  children,
  hint,
  label,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) => (
  <label className="block space-y-1 text-sm">
    <span className="font-medium text-zinc-700 dark:text-zinc-300">
      {label}
    </span>
    {children}
    {hint === undefined ? null : (
      <span className="block text-xs text-zinc-500">{hint}</span>
    )}
  </label>
);

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86_400;

/** Formats a duration in milliseconds, for example `3h 12m`. */
export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / SECOND_MS);

  if (seconds < MINUTE_S) {
    return `${seconds}s`;
  }

  if (seconds < HOUR_S) {
    return `${Math.floor(seconds / MINUTE_S)}m ${seconds % MINUTE_S}s`;
  }

  if (seconds < DAY_S) {
    return `${Math.floor(seconds / HOUR_S)}h ${Math.floor((seconds % HOUR_S) / MINUTE_S)}m`;
  }

  return `${Math.floor(seconds / DAY_S)}d ${Math.floor((seconds % DAY_S) / HOUR_S)}h`;
};

/** Formats an ISO timestamp in the browser's locale and time zone. */
export const formatTime = (timestamp: string | null): string =>
  timestamp === null ? "–" : new Date(timestamp).toLocaleString();
