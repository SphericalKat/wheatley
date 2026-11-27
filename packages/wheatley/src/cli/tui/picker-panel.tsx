import { Box, Text, useInput } from "ink";

import { pickerMatches, pickerRows, pickerWindow } from "./model-picker.js";
import type { ModelPicker, PickerAction, PickerRow } from "./model-picker.js";

/** The lines of the panel and the chat around it that are not list rows: borders, title, query, footer, status bar. */
const RESERVED_LINES = 8;
const MIN_LIST_ROWS = 3;

interface PickerPanelProps {
  readonly picker: ModelPicker;
  readonly columns: number;
  readonly rows: number;
  readonly onEdit: (action: PickerAction) => void;
  readonly onChoose: () => void;
  readonly onCancel: () => void;
}

const RowView = ({ row }: { readonly row: PickerRow }) => {
  if (row.kind === "provider") {
    return (
      <Text bold dimColor wrap="truncate-end">
        {row.provider}
      </Text>
    );
  }

  const { model, selected, current } = row;

  return (
    <Text wrap="truncate-end">
      <Text color="cyan">{selected ? "› " : "  "}</Text>
      <Text bold={selected} color={selected ? "cyan" : undefined}>
        {model.id}
      </Text>
      {model.name === model.id ? undefined : (
        <Text dimColor> {model.name}</Text>
      )}
      {current ? <Text color="green"> (current)</Text> : undefined}
    </Text>
  );
};

/** The `/model` picker. Typing filters, arrows move, Enter chooses, Esc cancels. */
export const PickerPanel = ({
  picker,
  columns,
  rows,
  onEdit,
  onChoose,
  onCancel,
}: PickerPanelProps) => {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
    } else if (key.return) {
      onChoose();
    } else if (key.upArrow || key.downArrow) {
      onEdit({ kind: "move", step: key.upArrow ? -1 : 1 });
    } else if (key.backspace || key.delete) {
      onEdit({ kind: "erase" });
    } else if (!key.ctrl && !key.meta && input !== "") {
      onEdit({ kind: "type", text: input });
    }
  });

  const matches = pickerMatches(picker);

  const view = pickerWindow(
    pickerRows(picker),
    Math.max(MIN_LIST_ROWS, rows - RESERVED_LINES)
  );

  const position =
    picker.selected === undefined ? 0 : matches.indexOf(picker.selected) + 1;

  return (
    <Box
      borderColor="cyan"
      borderStyle="round"
      flexDirection="column"
      paddingX={1}
      width={columns}
    >
      <Text>
        <Text bold>Choose a model </Text>
        <Text>{picker.query}</Text>
        <Text inverse> </Text>
      </Text>
      {view.above > 0 ? <Text dimColor>↑ {view.above} more</Text> : undefined}
      {matches.length === 0 ? (
        <Text dimColor>No model matches “{picker.query}”.</Text>
      ) : (
        view.rows.map((row) => (
          <RowView
            key={
              row.kind === "provider"
                ? `provider:${row.provider}`
                : `model:${row.model.provider}/${row.model.id}`
            }
            row={row}
          />
        ))
      )}
      {view.below > 0 ? <Text dimColor>↓ {view.below} more</Text> : undefined}
      <Text dimColor>
        {position}/{matches.length} · type to filter · ↑↓ move · Enter selects ·
        Esc cancels
      </Text>
    </Box>
  );
};
