import { DeploymentConfigSchema, decode } from "@wheatley/protocol";
import type { ConfigIssue, DeploymentConfig } from "@wheatley/protocol";
import { parseDocument } from "yaml";
import type { Document } from "yaml";

import { documentJson } from "./yaml-patch.js";

/** The binding ID that the Control Server reserves for the CLI and dashboard Chat. */
export const CLI_BINDING_ID = "cli";

/** The result of parsing `config.yaml` text. */
export type ParsedConfig =
  | {
      readonly ok: true;
      readonly doc: Document;
      readonly config: DeploymentConfig;
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Checks rules that the JSON schema cannot express: unique Frontend Binding IDs and the reserved `cli` ID. */
const semanticIssues = (config: DeploymentConfig): ConfigIssue[] =>
  Object.entries(config.agents).flatMap(([agent, agentConfig]) => {
    const seen = new Set<string>();

    return (agentConfig.frontends ?? []).flatMap(
      (binding, index): ConfigIssue[] => {
        const path = `/agents/${agent}/frontends/${index}/id`;

        if (binding.id === CLI_BINDING_ID) {
          return [
            {
              message: `The binding ID "${CLI_BINDING_ID}" is reserved for the CLI Chat`,
              path,
            },
          ];
        }

        if (seen.has(binding.id)) {
          return [{ message: `Duplicate binding ID: ${binding.id}`, path }];
        }

        seen.add(binding.id);

        return [];
      }
    );
  });

/** Parses and validates `config.yaml` text. YAML syntax errors, schema errors, and rule errors become issues. */
export const parseConfigText = (raw: string): ParsedConfig => {
  const doc = parseDocument(raw, { prettyErrors: false });

  if (doc.errors.length > 0) {
    return {
      issues: doc.errors.map((error) => ({
        message: error.message,
        path: "/",
      })),
      ok: false,
    };
  }

  const value = documentJson(doc);

  if (value === undefined) {
    return {
      issues: [
        { message: "The file holds values that are not JSON", path: "/" },
      ],
      ok: false,
    };
  }

  const decoded = decode(DeploymentConfigSchema, value);

  if (!decoded.ok) {
    return { issues: decoded.issues, ok: false };
  }

  const issues = semanticIssues(decoded.value);

  return issues.length > 0
    ? { issues, ok: false }
    : { config: decoded.value, doc, ok: true };
};
