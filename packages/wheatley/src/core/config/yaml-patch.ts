import { isJsonValue } from "@wheatley-ai/protocol";
import type { JsonObject, JsonValue } from "@wheatley-ai/protocol";
import { isMap, isNode, isScalar, isSeq } from "yaml";
import type { Document, Node, Scalar } from "yaml";

/** The most alias expansions that `config.yaml` may hold, so a crafted file cannot expand into a huge value. */
const MAX_ALIAS_COUNT = 100;

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

/** Returns the plain JSON value of a YAML document, or `undefined` if it holds values that JSON cannot represent. */
export const documentJson = (doc: Document): JsonValue | undefined => {
  const value: unknown = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });

  return isJsonValue(value) ? value : undefined;
};

/** True if a map key is a string or a scalar node that holds a string. */
const isStringKey = (key: unknown): key is string | Scalar<string> =>
  typeof key === "string" || (isScalar(key) && typeof key.value === "string");

const keyText = (key: string | Scalar<string>): string =>
  isScalar(key) ? key.value : key;

/** Replaces `node` with a new node for `value` and keeps the comments of `node`. */
const replaceNode = (doc: Document, node: Node, value: JsonValue): Node => {
  const created = doc.createNode(value);

  created.commentBefore = node.commentBefore;
  created.comment = node.comment;
  created.spaceBefore = node.spaceBefore;

  return created;
};

/**
 * Changes `node` in place so that its value equals `value`, and returns the node to store in the parent. Unchanged
 * scalars, map keys, and sequence items keep their nodes, so comments and key order stay. New map keys go to the end.
 */
const patchNode = (
  doc: Document,
  node: Node | undefined,
  value: JsonValue
): Node => {
  if (isMap(node) && isJsonObject(value)) {
    const stale = node.items.filter(
      (pair) =>
        !isStringKey(pair.key) || !Object.hasOwn(value, keyText(pair.key))
    );

    for (const pair of stale) {
      node.delete(pair.key);
    }

    for (const [key, child] of Object.entries(value)) {
      const existing: unknown = node.get(key, true);

      node.set(
        key,
        patchNode(doc, isNode(existing) ? existing : undefined, child)
      );
    }

    return node;
  }

  if (isSeq(node) && isJsonArray(value)) {
    node.items.splice(value.length);

    for (const [index, child] of value.entries()) {
      const existing: unknown = node.items[index];

      node.items[index] = patchNode(
        doc,
        isNode(existing) ? existing : undefined,
        child
      );
    }

    return node;
  }

  if (isScalar(node) && node.value === value) {
    return node;
  }

  return node === undefined
    ? doc.createNode(value)
    : replaceNode(doc, node, value);
};

/** Changes the YAML document `doc` so that it holds `value`, and keeps comments and key order where values stay. */
export const patchDocument = (doc: Document, value: JsonValue): void => {
  doc.contents = patchNode(doc, doc.contents ?? undefined, value);
};
