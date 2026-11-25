/** The maximum length of a formatted Tool input preview, after secret redaction. */
export const TOOL_INPUT_PREVIEW_MAX_LENGTH = 500;

/** The maximum length of a formatted Tool output preview. */
export const TOOL_OUTPUT_PREVIEW_MAX_LENGTH = 500;

/** The maximum length of the message preview of a failed delivery. */
export const DELIVERY_PREVIEW_MAX_LENGTH = 500;

/** The maximum length of the reason on an Approval decision. */
export const APPROVAL_REASON_MAX_LENGTH = 2000;

/** The maximum length of a person's display name, for example a message sender or an Approval resolver. */
export const DISPLAY_NAME_MAX_LENGTH = 200;

/** The maximum length of a Trigger name. */
export const TRIGGER_NAME_MAX_LENGTH = 200;

/** The minimum length of a 5-field cron expression: five 1-character fields and four separators. */
export const CRON_EXPRESSION_MIN_LENGTH = 9;

/** The highest TCP port number. */
export const MAX_TCP_PORT = 65_535;
