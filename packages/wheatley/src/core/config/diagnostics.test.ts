import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";

import { renderConfigDiagnostics } from "./diagnostics.js";
import { parseConfigText } from "./validate.js";

const FILE = "/home/me/.wheatley/config.yaml";

const render = (source: string, color = false): string => {
  const parsed = parseConfigText(source);

  if (parsed.ok) {
    throw new Error("Expected an invalid config");
  }

  return renderConfigDiagnostics({
    color,
    file: FILE,
    issues: parsed.issues,
    source,
  });
};

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

it("points at the position of a YAML syntax error", () => {
  const source = lines("version: 1", "agents:", "  home:", "   x: 1", "  bad");

  expect(render(source)).toBe(
    lines(
      "error: invalid YAML syntax",
      "  --> /home/me/.wheatley/config.yaml:5:3",
      "  4 |    x: 1",
      "> 5 |   bad",
      "    |   ^^^ Implicit map keys need to be followed by map values"
    )
  );
});

it("underlines a value of the wrong type together with its key", () => {
  const source = lines(
    "version: 1",
    "agents:",
    "  home:",
    "    model: 5 # a number",
    "    instructions: hi"
  );

  expect(render(source)).toBe(
    lines(
      "error: invalid value at /agents/home/model",
      "  --> /home/me/.wheatley/config.yaml:4:5",
      "  3 |   home:",
      "> 4 |     model: 5 # a number",
      "    |     ^^^^^^^^ must be string",
      "  5 |     instructions: hi"
    )
  );
});

it("points at an unknown field and at the map that holds it", () => {
  const source = lines(
    "version: 1",
    "agents:",
    "  home:",
    "    model: a/b",
    "    bogus: 1"
  );

  expect(render(source)).toBe(
    lines(
      "error: invalid value at /agents/home/bogus",
      "  --> /home/me/.wheatley/config.yaml:5:5",
      "  4 |     model: a/b",
      "> 5 |     bogus: 1",
      "    |     ^^^^^^^^ schema is false",
      "",
      "error: invalid value at /agents/home",
      "  --> /home/me/.wheatley/config.yaml:3:3",
      "  2 | agents:",
      "> 3 |   home:",
      "    |   ^^^^ must not have additional properties",
      "  4 |     model: a/b"
    )
  );
});

it("points at the parent key of a missing required field", () => {
  const source = lines(
    "version: 1",
    "agents:",
    "  home:",
    "    instructions: hi"
  );

  expect(render(source)).toBe(
    lines(
      "error: invalid value at /agents/home",
      "  --> /home/me/.wheatley/config.yaml:3:3",
      "  2 | agents:",
      "> 3 |   home:",
      "    |   ^^^^ must have required properties model",
      "  4 |     instructions: hi"
    )
  );
});

it("points at a reserved and a duplicate Frontend Binding ID", () => {
  const source = lines(
    "version: 1",
    "agents:",
    "  home:",
    "    model: a/b",
    "    frontends:",
    "      - { id: cli, type: telegram, config: {} }",
    "      - { id: tg, type: telegram, config: {} }",
    "      - { id: tg, type: telegram, config: {} }"
  );

  expect(render(source)).toBe(
    lines(
      "error: invalid value at /agents/home/frontends/0/id",
      "  --> /home/me/.wheatley/config.yaml:6:11",
      "  5 |     frontends:",
      "> 6 |       - { id: cli, type: telegram, config: {} }",
      '    |           ^^^^^^^ The binding ID "cli" is reserved for the CLI Chat',
      "  7 |       - { id: tg, type: telegram, config: {} }",
      "",
      "error: invalid value at /agents/home/frontends/2/id",
      "  --> /home/me/.wheatley/config.yaml:8:11",
      "  7 |       - { id: tg, type: telegram, config: {} }",
      "> 8 |       - { id: tg, type: telegram, config: {} }",
      "    |           ^^^^^^ Duplicate binding ID: tg"
    )
  );
});

it("adds ANSI colors only when color is on", () => {
  const source = lines("version: 1", "agents:", "  home:", "    model: 5");
  const plain = render(source);
  const colored = render(source, true);

  expect(plain).toBe(stripVTControlCharacters(plain));
  expect(colored).not.toBe(plain);
  expect(stripVTControlCharacters(colored)).toBe(plain);
});
