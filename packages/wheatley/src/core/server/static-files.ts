import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** The dashboard entry file. Paths without a file extension fall back to it, so the SPA can route itself. */
const INDEX_FILE = "index.html";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const contentTypeOf = (file: string): string =>
  CONTENT_TYPES.get(path.extname(file).toLowerCase()) ??
  "application/octet-stream";

const isFile = async (file: string): Promise<boolean> => {
  try {
    const info = await stat(file);

    return info.isFile();
  } catch {
    return false;
  }
};

/**
 * Resolves the file for a URL path inside `root`, or `undefined`. A path that leaves `root` resolves `undefined`. A
 * path without a file extension resolves the SPA entry.
 */
const resolveFile = async (
  root: string,
  urlPath: string
): Promise<string | undefined> => {
  let decoded: string;

  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }

  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const inside = target === root || target.startsWith(`${root}${path.sep}`);

  if (!inside) {
    return undefined;
  }

  if (await isFile(target)) {
    return target;
  }

  const entry = path.join(root, INDEX_FILE);
  const isRoute = path.extname(target) === "";

  return isRoute && (await isFile(entry)) ? entry : undefined;
};

/**
 * Serves `GET` and `HEAD` requests from the bundled dashboard folder. Resolves `false` if no file matches, so the
 * caller can answer with its own response.
 *
 * The dashboard is static and holds no data. It reads everything over `/ws`, where the Control Server checks the
 * browser `Origin`.
 */
export const serveStaticFile = async (
  root: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<boolean> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  const file = await resolveFile(path.resolve(root), pathname);

  if (file === undefined) {
    return false;
  }

  const body = await readFile(file);

  response.writeHead(200, {
    "cache-control":
      path.basename(file) === INDEX_FILE ? "no-cache" : "max-age=3600",
    "content-length": body.byteLength,
    "content-type": contentTypeOf(file),
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);

  return true;
};
