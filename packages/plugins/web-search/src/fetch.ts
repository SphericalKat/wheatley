import { defineTool } from "@wheatley-ai/sdk";
import type { Tool } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";

import { htmlToMarkdown, htmlToText } from "./html.js";
import { HttpStatusError, readTextWithin, USER_AGENT } from "./http.js";
import { errorResult, textResult } from "./results.js";
import { toJsonSchema } from "./schema.js";

/** The largest response body that the `fetch` Tool reads. */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;

/** The number of redirects that the `fetch` Tool follows before it fails. */
export const MAX_REDIRECTS = 10;

export const DEFAULT_TIMEOUT_SECONDS = 30;

export const MAX_TIMEOUT_SECONDS = 120;

const MS_PER_SECOND = 1000;

const HTTP_FORBIDDEN = 403;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** The `User-Agent` of the second attempt after a Cloudflare challenge rejects the browser-like one. */
const FALLBACK_USER_AGENT = "wheatley";

/** The image type that is text, so the Tool can return it. */
const SVG_TYPE = "image/svg+xml";

/** The media types that the Tool converts from HTML. */
const HTML_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
]);

const TEXTUAL_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
]);

const FORMATS = ["markdown", "text", "html"] as const;

type Format = (typeof FORMATS)[number];

const ACCEPT: Readonly<Record<Format, string>> = {
  html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
  markdown:
    "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
  text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
};

const FetchInputSchema = Type.Object(
  {
    format: Type.Optional(
      Type.Enum(FORMATS, {
        description:
          "The format of the returned content. Defaults to markdown.",
      })
    ),
    timeout: Type.Optional(
      Type.Number({
        description: `The time limit in seconds (maximum: ${MAX_TIMEOUT_SECONDS}). Defaults to ${DEFAULT_TIMEOUT_SECONDS}.`,
        exclusiveMinimum: 0,
        maximum: MAX_TIMEOUT_SECONDS,
      })
    ),
    url: Type.String({
      description: "The HTTP or HTTPS URL to fetch",
    }),
  },
  { additionalProperties: false }
);

type FetchInput = Static<typeof FetchInputSchema>;

/** Parses `value` as an `http:` or `https:` URL without credentials and without a fragment. */
const parseHttpUrl = (value: string, base?: string): URL => {
  let url: URL;

  try {
    url = new URL(value, base);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("URL must not include credentials");
  }

  url.hash = "";

  return url;
};

/** Returns the lowercase media type of a `Content-Type` header, without parameters. */
const mediaType = (contentType: string): string =>
  contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const isTextual = (mime: string): boolean =>
  mime === "" ||
  mime.startsWith("text/") ||
  TEXTUAL_APPLICATION_TYPES.has(mime) ||
  mime.endsWith("+json") ||
  mime.endsWith("+xml");

const isImage = (mime: string): boolean =>
  mime.startsWith("image/") && mime !== SVG_TYPE;

const isCloudflareChallenge = (response: Response): boolean =>
  response.status === HTTP_FORBIDDEN &&
  response.headers.get("cf-mitigated") === "challenge";

interface FetchRequest {
  readonly format: Format;
  readonly userAgent: string;
  readonly signal: AbortSignal;
}

/**
 * Sends GET requests and follows up to `MAX_REDIRECTS` redirects. It follows them itself, so that it validates each
 * new URL before it connects.
 */
const follow = async (url: URL, request: FetchRequest): Promise<Response> => {
  let target = url;

  for (let redirects = 0; ; redirects += 1) {
    // Each request depends on the `Location` of the previous response.
    // oxlint-disable-next-line no-await-in-loop
    const response = await fetch(target, {
      headers: {
        accept: ACCEPT[request.format],
        "accept-language": "en-US,en;q=0.9",
        "user-agent": request.userAgent,
      },
      redirect: "manual",
      signal: request.signal,
    });

    const location = response.headers.get("location");

    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return response;
    }

    // oxlint-disable-next-line no-await-in-loop
    await response.body?.cancel();

    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
    }

    target = parseHttpUrl(location, target.href);
  }
};

const convert = (body: string, mime: string, format: Format): string => {
  if (!HTML_TYPES.has(mime) || format === "html") {
    return body;
  }

  return format === "markdown" ? htmlToMarkdown(body) : htmlToText(body);
};

const download = async (
  url: URL,
  format: Format,
  signal: AbortSignal
): Promise<string> => {
  let response = await follow(url, {
    format,
    signal,
    userAgent: USER_AGENT,
  });

  if (isCloudflareChallenge(response)) {
    await response.body?.cancel();
    response = await follow(url, {
      format,
      signal,
      userAgent: FALLBACK_USER_AGENT,
    });
  }

  if (!response.ok) {
    await response.body?.cancel();

    throw new HttpStatusError("Request", response);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = mediaType(contentType);

  if (isImage(mime)) {
    await response.body?.cancel();

    throw new Error(`Unsupported fetched image content type: ${mime}`);
  }

  if (!isTextual(mime)) {
    await response.body?.cancel();

    throw new Error(`Unsupported fetched file content type: ${mime}`);
  }

  const body = await readTextWithin(
    response,
    MAX_FETCH_BYTES,
    () =>
      new Error(`Response too large (exceeds ${MAX_FETCH_BYTES} byte limit)`)
  );

  return convert(body, mime, format);
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught value has no type.
const fetchErrorText = (url: string, error: unknown): string => {
  const reason = error instanceof Error ? `: ${error.message}` : "";

  return `Unable to fetch ${url}${reason}`;
};

/** Creates the `fetch` Tool. It allows every host, including localhost and private addresses. */
export const createFetchTool = (): Tool<FetchInput> =>
  defineTool<FetchInput>({
    description:
      "Fetch content from an HTTP or HTTPS URL and return it as Markdown, plain text, or HTML. Markdown is the default. Use a more specific Tool when one is available. This Tool is read-only.",
    execute: async (input, ctx) => {
      const timeout = AbortSignal.timeout(
        (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * MS_PER_SECOND
      );

      try {
        const output = await download(
          parseHttpUrl(input.url),
          input.format ?? "markdown",
          AbortSignal.any([ctx.signal, timeout])
        );

        return textResult(output);
      } catch (error) {
        if (ctx.signal.aborted) {
          throw error;
        }

        return errorResult(
          fetchErrorText(
            input.url,
            timeout.aborted ? new Error("Request timed out") : error
          )
        );
      }
    },
    inputSchema: toJsonSchema(FetchInputSchema),
    name: "fetch",
  });
