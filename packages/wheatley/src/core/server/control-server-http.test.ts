import { mkdir, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { startDaemon } from "../daemon.js";
import type { Daemon } from "../daemon.js";
import { builtinCatalog, temporaryDir } from "../test-support.js";

const INDEX_HTML = "<!doctype html><title>dashboard</title>\n";
const APP_JS = "console.info('app');\n";
const OWNER_ONLY = 0o600;

/** The permission bits of a file mode. The higher bits hold the file type. */
const PERMISSION_RANGE = 0o1000;

let home: Awaited<ReturnType<typeof temporaryDir>>;
let daemon: Daemon | undefined;

const start = async (
  options: { readonly staticDir?: string; readonly socketPath?: string } = {}
): Promise<Daemon> => {
  const started = await startDaemon({
    env: {},
    extensions: builtinCatalog(),
    homeDir: home.dir,
    port: 0,
    socketPath: options.socketPath ?? null,
    staticDir: options.staticDir,
    version: "test",
  });

  daemon = started;

  return started;
};

const httpUrl = (started: Daemon): string =>
  started.server.url.replace(/^ws:/u, "http:").replace(/\/ws$/u, "");

const writeDashboard = async (): Promise<string> => {
  const dir = path.join(home.dir, "dashboard");

  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), INDEX_HTML);
  await writeFile(path.join(dir, "assets", "app.js"), APP_JS);
  await writeFile(path.join(home.dir, "secret.txt"), "secret");

  return dir;
};

interface SocketResponse {
  readonly status: number;
  readonly body: string;
}

/** Sends a `GET` over the Unix socket. */
const getOverSocket = async (
  socketPath: string,
  urlPath: string
): Promise<SocketResponse> => {
  const { promise, reject, resolve } = Promise.withResolvers<SocketResponse>();

  const sent = request({ path: urlPath, socketPath }, (response) => {
    const chunks: Buffer[] = [];

    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.on("end", () => {
      resolve({
        body: Buffer.concat(chunks).toString("utf-8"),
        status: response.statusCode ?? 0,
      });
    });
  });

  sent.on("error", reject);
  sent.end();

  return await promise;
};

beforeEach(async () => {
  home = await temporaryDir();
  await writeFile(
    path.join(home.dir, "config.yaml"),
    "version: 1\nagents: {}\n"
  );
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await home.remove();
});

it("serves dashboard files with their content type, nosniff, and cache headers", async () => {
  const started = await start({ staticDir: await writeDashboard() });

  const page = await fetch(`${httpUrl(started)}/`);
  const script = await fetch(`${httpUrl(started)}/assets/app.js`);

  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  await expect(page.text()).resolves.toBe(INDEX_HTML);

  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe(
    "text/javascript; charset=utf-8"
  );
  expect(script.headers.get("cache-control")).toBe("max-age=3600");
  expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  await expect(script.text()).resolves.toBe(APP_JS);
});

it("answers HEAD without a body", async () => {
  const started = await start({ staticDir: await writeDashboard() });

  const head = await fetch(`${httpUrl(started)}/assets/app.js`, {
    method: "HEAD",
  });

  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe(
    "text/javascript; charset=utf-8"
  );
  await expect(head.text()).resolves.toBe("");
});

it("serves index.html for browser-history routes and 404 for a missing file", async () => {
  const started = await start({ staticDir: await writeDashboard() });

  const route = await fetch(`${httpUrl(started)}/agents/foo/chat`);
  const missing = await fetch(`${httpUrl(started)}/assets/missing.js`);

  const post = await fetch(`${httpUrl(started)}/agents/foo/chat`, {
    method: "POST",
  });

  expect(route.status).toBe(200);
  expect(route.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(route.headers.get("cache-control")).toBe("no-cache");
  await expect(route.text()).resolves.toBe(INDEX_HTML);
  expect(missing.status).toBe(404);
  expect(post.status).toBe(404);
});

it("does not serve files outside the dashboard folder", async () => {
  const started = await start({ staticDir: await writeDashboard() });

  const escaped = await fetch(`${httpUrl(started)}/%2e%2e/secret.txt`);

  expect(escaped.status).toBe(404);
  await expect(escaped.text()).resolves.not.toBe("secret");
});

it("answers / with a plain text note without a dashboard folder", async () => {
  const started = await start();

  const root = await fetch(`${httpUrl(started)}/`);
  const other = await fetch(`${httpUrl(started)}/overview`);

  expect(root.status).toBe(200);
  expect(root.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  await expect(root.text()).resolves.toBe(
    "Wheatley daemon. Connect with JSON-RPC over WebSocket at /ws.\n"
  );
  expect(other.status).toBe(404);
});

it("listens on an owner-only Unix socket that serves the dashboard too", async () => {
  const socketPath = path.join(home.dir, "wheatley.sock");

  await start({ socketPath, staticDir: await writeDashboard() });

  const info = await stat(socketPath);
  const page = await getOverSocket(socketPath, "/agents/foo/chat");

  expect(info.mode % PERMISSION_RANGE).toBe(OWNER_ONLY);
  expect(page).toStrictEqual({ body: INDEX_HTML, status: 200 });
});
