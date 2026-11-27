import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, it } from "vitest";

import { MAX_FETCH_BYTES, MAX_REDIRECTS } from "./fetch.js";
import { pluginTool, resultText, toolContext } from "./test-support.js";

const PAGE = `<!doctype html>
<html>
  <head><title>Page title</title><style>body { color: red; }</style></head>
  <body>
    <h1>Heading</h1>
    <p>Some <strong>bold</strong> text and a <a href="https://example.com/">link</a>.</p>
    <script>alert("hidden");</script>
    <ul><li>One</li><li>Two</li></ul>
  </body>
</html>`;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const send =
  (contentType: string, body: string | Buffer): Handler =>
  (_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  };

const redirect =
  (location: string, code = 302): Handler =>
  (_request, response) => {
    response.writeHead(code, { location });
    response.end();
  };

/** Streams more than `MAX_FETCH_BYTES` bytes without a `Content-Length` header. */
const oversized: Handler = (_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });

  const chunk = "a".repeat(1024 * 1024);

  for (
    let sentBytes = 0;
    sentBytes <= MAX_FETCH_BYTES;
    sentBytes += chunk.length
  ) {
    response.write(chunk);
  }

  response.end();
};

/** A redirect loop: `/loop/<n>` redirects to `/loop/<n + 1>`. */
const loop: Handler = (request, response) => {
  const step = Number(request.url?.split("/").at(-1) ?? "0");

  redirect(`/loop/${step + 1}`)(request, response);
};

const HANDLERS = new Map<string, Handler>(
  Object.entries({
    "/binary": send("application/octet-stream", Buffer.from([0, 1, 2])),
    "/headers": (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accept: request.headers.accept }));
    },
    "/image": send("image/png", Buffer.from([137, 80, 78, 71])),
    "/missing": (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("nope");
    },
    "/oversized": oversized,
    "/page": send("text/html; charset=utf-8", PAGE),
    "/redirect-ftp": redirect("ftp://example.com/file"),
    "/redirect-twice": redirect("/redirect-once", 301),
    "/redirect-once": redirect("/page", 307),
    "/slow": (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    },
    "/svg": send("image/svg+xml", "<svg></svg>"),
  })
);

const isAddressInfo = (
  address: ReturnType<Server["address"]>
): address is AddressInfo => address !== null && typeof address !== "string";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    const route = path.startsWith("/loop/") ? loop : HANDLERS.get(path);

    if (route === undefined) {
      response.writeHead(500);
      response.end();

      return;
    }

    route(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!isAddressInfo(address)) {
    throw new Error("The test server has no TCP address");
  }

  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

const fetchUrl = async (input: {
  readonly url: string;
  readonly format?: string;
  readonly timeout?: number;
}) => {
  const tool = await pluginTool("fetch");

  return await tool.execute(input, toolContext());
};

it("converts HTML to Markdown by default and drops the head, scripts, and styles", async () => {
  const result = await fetchUrl({ url: `${base}/page` });

  expect(result.isError).toBeUndefined();
  expect(resultText(result)).toBe(
    "# Heading\n\nSome **bold** text and a [link](https://example.com/).\n\n-   One\n-   Two"
  );
});

it("returns plain text or the raw HTML on request", async () => {
  const text = resultText(
    await fetchUrl({ format: "text", url: `${base}/page` })
  );

  const html = resultText(
    await fetchUrl({ format: "html", url: `${base}/page` })
  );

  expect(text).not.toMatch(/alert|color: red|</u);
  expect(text).toMatch(/Heading\s+Some bold text and a link\.\s+OneTwo/u);
  expect(html).toBe(PAGE);
});

it("sends an Accept header that prefers the requested format", async () => {
  const result = await fetchUrl({ format: "html", url: `${base}/headers` });

  expect(JSON.parse(resultText(result))).toStrictEqual({
    accept:
      "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
  });
});

it("follows redirects and checks each new URL", async () => {
  const followed = await fetchUrl({
    format: "html",
    url: `${base}/redirect-twice`,
  });

  const ftp = await fetchUrl({ url: `${base}/redirect-ftp` });

  expect(resultText(followed)).toBe(PAGE);
  expect(ftp).toStrictEqual({
    content: [
      {
        text: `Unable to fetch ${base}/redirect-ftp: URL must use http:// or https://`,
        type: "text",
      },
    ],
    isError: true,
  });
});

it(`fails after more than ${MAX_REDIRECTS} redirects`, async () => {
  const result = await fetchUrl({ url: `${base}/loop/0` });

  expect(result.isError).toBe(true);
  expect(resultText(result)).toBe(
    `Unable to fetch ${base}/loop/0: Too many redirects (more than ${MAX_REDIRECTS})`
  );
});

it("rejects URLs with credentials or another scheme before it connects", async () => {
  const withCredentials = await fetchUrl({
    url: "http://user:secret@127.0.0.1:1/",
  });

  const file = await fetchUrl({ url: "file:///etc/passwd" });
  const invalid = await fetchUrl({ url: "not a url" });

  expect([withCredentials, file, invalid].map(resultText)).toStrictEqual([
    "Unable to fetch http://user:secret@127.0.0.1:1/: URL must not include credentials",
    "Unable to fetch file:///etc/passwd: URL must use http:// or https://",
    "Unable to fetch not a url: Invalid URL: not a url",
  ]);
});

it("rejects images and binary files but returns textual image types", async () => {
  const image = await fetchUrl({ url: `${base}/image` });
  const binary = await fetchUrl({ url: `${base}/binary` });
  const svg = await fetchUrl({ url: `${base}/svg` });

  expect(resultText(image)).toBe(
    `Unable to fetch ${base}/image: Unsupported fetched image content type: image/png`
  );
  expect(resultText(binary)).toBe(
    `Unable to fetch ${base}/binary: Unsupported fetched file content type: application/octet-stream`
  );
  expect(svg).toStrictEqual({
    content: [{ text: "<svg></svg>", type: "text" }],
  });
});

it("stops reading a body larger than the size limit", async () => {
  const result = await fetchUrl({ url: `${base}/oversized` });

  expect(resultText(result)).toBe(
    `Unable to fetch ${base}/oversized: Response too large (exceeds ${MAX_FETCH_BYTES} byte limit)`
  );
});

it("reports HTTP errors and time-outs", async () => {
  const missing = await fetchUrl({ url: `${base}/missing` });
  const slow = await fetchUrl({ timeout: 0.2, url: `${base}/slow` });

  expect(resultText(missing)).toBe(
    `Unable to fetch ${base}/missing: Request failed with HTTP 404`
  );
  expect(resultText(slow)).toBe(
    `Unable to fetch ${base}/slow: Request timed out`
  );
});

it("stops when the Tool call aborts", async () => {
  const tool = await pluginTool("fetch");
  const controller = new AbortController();

  const pending = tool.execute(
    { url: `${base}/slow` },
    toolContext(controller.signal)
  );

  controller.abort(new Error("Run stopped"));

  await expect(pending).rejects.toThrow("Run stopped");
});
