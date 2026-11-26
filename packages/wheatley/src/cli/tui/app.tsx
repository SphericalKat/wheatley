import type { ApprovalDecision, PendingApproval } from "@wheatley-ai/protocol";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { Activity, ChatController, ChatView } from "./controller.js";
import { formatCost, formatCount, formatSeconds } from "./format.js";
import { wrapLines } from "./markdown.js";
import { Prompt } from "./prompt.js";
import { EntryView, LOGO_WIDTH } from "./transcript.js";

/** The frames of the spinning logo. */
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const FRAME_MS = 120;

/** How long the spinner shows one thinking line. */
const LINE_MS = 3500;
const MS_PER_SECOND = 1000;
const APPROVAL_PREVIEW_LINES = 12;

/**
 * Output stays out of the last terminal column. A line that fills it makes some terminals wrap early, which splits
 * the last word of the line.
 */
const RIGHT_MARGIN = 1;
const MIN_WIDTH = 20;

/** Re-renders every `intervalMs` while `active`, and returns the current time. */
const useTicker = (active: boolean, intervalMs: number): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = active
      ? setInterval(() => {
          setNow(Date.now());
        }, intervalMs)
      : undefined;

    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  return now;
};

const activityLabel = (
  activity: Activity,
  thinkingLines: readonly string[],
  elapsed: number
) => {
  if (activity.kind === "tool") {
    return (
      <Text>
        <Text>Running </Text>
        <Text bold>{activity.name}</Text>
        <Text dimColor> {activity.input.split("\n")[0]}</Text>
      </Text>
    );
  }

  if (activity.kind === "shell") {
    return (
      <Text>
        <Text bold>$ </Text>
        <Text>{activity.command}</Text>
      </Text>
    );
  }

  const line =
    thinkingLines[Math.floor(elapsed / LINE_MS) % thinkingLines.length] ?? "";

  return <Text italic>{line}</Text>;
};

interface ActivityLineProps {
  readonly activity: Activity;
  readonly thinkingLines: readonly string[];
}

/** The spinning logo with what the Agent does now and the elapsed time. */
const ActivityLine = ({ activity, thinkingLines }: ActivityLineProps) => {
  const now = useTicker(true, FRAME_MS);
  const elapsed = Math.max(0, now - activity.startedAt);

  const frame =
    SPINNER_FRAMES[Math.floor(now / FRAME_MS) % SPINNER_FRAMES.length];

  return (
    <Box marginTop={1}>
      <Box width={2}>
        <Text color="cyan">{frame}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {activityLabel(activity, thinkingLines, elapsed)}
        </Text>
      </Box>
      <Text dimColor>
        {" "}
        ({formatSeconds(elapsed / MS_PER_SECOND)} · esc to interrupt)
      </Text>
    </Box>
  );
};

const CHOICES = [
  { decision: "allow_once", hotkey: "o", label: "Yes, once" },
  {
    decision: "allow_conversation",
    hotkey: "c",
    label: "Yes, for this conversation",
  },
  { decision: "allow_always", hotkey: "a", label: "Always allow this Tool" },
  { decision: "deny", hotkey: "d", label: "No, and tell Wheatley why" },
] as const satisfies readonly {
  readonly decision: ApprovalDecision;
  readonly hotkey: string;
  readonly label: string;
}[];

interface ApprovalPanelProps {
  readonly approval: PendingApproval;
  readonly onDecide: (decision: ApprovalDecision, reason?: string) => void;
}

/** Asks for an Approval. Arrows and Enter, a hotkey, or a number choose. Esc denies. */
const ApprovalPanel = ({ approval, onDecide }: ApprovalPanelProps) => {
  const [selected, setSelected] = useState(0);
  const [reason, setReason] = useState<string | undefined>();

  const choose = (index: number): void => {
    const choice = CHOICES[index];

    if (choice === undefined) {
      return;
    }

    if (choice.decision === "deny") {
      setReason("");

      return;
    }

    onDecide(choice.decision);
  };

  useInput((input, key) => {
    if (reason !== undefined) {
      if (key.return) {
        onDecide("deny", reason.trim() === "" ? undefined : reason.trim());
      } else if (key.escape) {
        onDecide("deny");
      } else if (key.backspace || key.delete) {
        setReason(reason.slice(0, -1));
      } else if (!key.ctrl && !key.meta && input !== "") {
        setReason(`${reason}${input}`);
      }

      return;
    }

    if (key.upArrow || key.downArrow) {
      setSelected(
        (selected + (key.upArrow ? -1 : 1) + CHOICES.length) % CHOICES.length
      );
    } else if (key.return) {
      choose(selected);
    } else if (key.escape) {
      onDecide("deny");
    } else {
      const byKey = CHOICES.findIndex(
        (choice, index) =>
          choice.hotkey === input.toLowerCase() || `${index + 1}` === input
      );

      if (byKey !== -1) {
        choose(byKey);
      }
    }
  });

  const lines = approval.inputPreview.split("\n");

  const preview =
    lines.length > APPROVAL_PREVIEW_LINES
      ? [
          ...lines.slice(0, APPROVAL_PREVIEW_LINES),
          `… ${lines.length - APPROVAL_PREVIEW_LINES} more lines`,
        ].join("\n")
      : approval.inputPreview;

  return (
    <Box
      borderColor="yellow"
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text>
        <Text color="yellow">⚠ </Text>
        <Text bold>{approval.toolName}</Text>
        <Text> needs your approval</Text>
      </Text>
      <Box marginY={1} marginLeft={2}>
        <Text dimColor>{preview}</Text>
      </Box>
      {reason === undefined ? (
        CHOICES.map((choice, index) => (
          <Text key={choice.decision}>
            <Text color="yellow">{index === selected ? "› " : "  "}</Text>
            <Text bold={index === selected}>
              {index + 1}. {choice.label}
            </Text>
            <Text dimColor> ({choice.hotkey})</Text>
          </Text>
        ))
      ) : (
        <Text>
          <Text color="yellow">Why? </Text>
          <Text>{reason}</Text>
          <Text inverse> </Text>
          <Text dimColor> Enter sends · Esc denies without a reason</Text>
        </Text>
      )}
    </Box>
  );
};

interface StatusBarProps {
  readonly view: ChatView;
  readonly busy: boolean;
  readonly columns: number;
}

const StatusBar = ({ view, busy, columns }: StatusBarProps) => {
  const { usage } = view;

  const left = [
    view.agent,
    view.model ?? "model unknown",
    `↑${formatCount(usage.inputTokens)} ↓${formatCount(usage.outputTokens)}`,
    formatCost(usage.costUsd),
  ].join(" · ");

  const right = busy
    ? "esc interrupt · enter sends next"
    : "/ commands · ! shell · \\⏎ newline";

  return (
    <Box justifyContent="space-between" paddingX={1} width={columns}>
      <Text dimColor wrap="truncate-end">
        {left}
      </Text>
      <Text dimColor wrap="truncate-start">
        {right}
      </Text>
    </Box>
  );
};

export interface ChatAppProps {
  readonly controller: ChatController;
  readonly version: string;
  readonly history: readonly string[];
  readonly onHistory: (history: readonly string[]) => void;
}

/** The interactive chat: the transcript, the live reply, the spinner, and the input box or the Approval panel. */
export const ChatApp = ({
  controller,
  version,
  history,
  onHistory,
}: ChatAppProps) => {
  const view = useSyncExternalStore(controller.subscribe, controller.view);
  const { exit } = useApp();
  const { columns: terminalColumns } = useWindowSize();
  const columns = Math.max(MIN_WIDTH, terminalColumns - RIGHT_MARGIN);
  const { busy } = controller;

  const onSubmit = (text: string): void => {
    controller
      .submit(text)
      .then((result) => {
        if (result === "exit") {
          exit();
        }

        return result;
      })
      .catch(() => {
        // `submit` reports its own errors as transcript entries.
      });
  };

  const onDecide = (decision: ApprovalDecision, reason?: string): void => {
    controller.decide(decision, reason).catch(() => {
      // `decide` reports its own errors as transcript entries.
    });
  };

  return (
    <>
      <Static items={[...view.entries]}>
        {(entry) => (
          <Box key={entry.id} width={columns}>
            <EntryView
              columns={columns}
              entry={entry}
              version={version}
              view={view}
            />
          </Box>
        )}
      </Static>
      {view.live.length === 0 ? undefined : (
        <Box marginLeft={LOGO_WIDTH} width={columns - LOGO_WIDTH}>
          <Text>{wrapLines(view.live, columns - LOGO_WIDTH)}</Text>
        </Box>
      )}
      {view.activity === undefined ||
      view.approval !== undefined ? undefined : (
        <ActivityLine
          activity={view.activity}
          thinkingLines={view.thinkingLines}
        />
      )}
      {view.approval === undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Prompt
            busy={busy}
            columns={columns}
            history={history}
            onExit={exit}
            onHistory={onHistory}
            onInterrupt={controller.interrupt}
            onSubmit={onSubmit}
          />
          <StatusBar busy={busy} columns={columns} view={view} />
        </Box>
      ) : (
        <ApprovalPanel
          approval={view.approval}
          key={view.approval.approvalId}
          onDecide={onDecide}
        />
      )}
    </>
  );
};
