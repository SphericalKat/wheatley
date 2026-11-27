import { describe, expect, it } from "vitest";

import { fetchPublishedVersions } from "./registry.js";
import type { FetchFn } from "./registry.js";

interface RecordedRequest {
  readonly url: string;
  readonly accept: string | null;
  readonly hasSignal: boolean;
}

/** A registry response body. The tests also send bodies without `versions`, which the schema rejects. */
interface AbbreviatedVersion {
  readonly version?: string;
}

interface RegistryBody {
  readonly versions?: Readonly<Record<string, AbbreviatedVersion>>;
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly error?: string;
}

interface FakeRegistry {
  readonly fetch: FetchFn;
  readonly requests: RecordedRequest[];
}

const registry = (body: RegistryBody, status = 200): FakeRegistry => {
  const requests: RecordedRequest[] = [];

  return {
    fetch: async (url, init) => {
      requests.push({
        accept: new Headers(init.headers).get("accept"),
        hasSignal: init.signal instanceof AbortSignal,
        url,
      });

      return await Promise.resolve(Response.json(body, { status }));
    },
    requests,
  };
};

describe("published versions", () => {
  it("reads the version keys of the abbreviated packument from npmjs.org", async () => {
    const { fetch, requests } = registry({
      "dist-tags": { latest: "1.1.0" },
      versions: { "1.0.0": {}, "1.1.0": {} },
    });

    await expect(fetchPublishedVersions({ env: {}, fetch })).resolves.toEqual([
      "1.0.0",
      "1.1.0",
    ]);
    expect(requests).toStrictEqual([
      {
        accept: "application/vnd.npm.install-v1+json",
        hasSignal: true,
        url: "https://registry.npmjs.org/@wheatley-ai%2Fcli",
      },
    ]);
  });

  it("uses npm_config_registry when it is set", async () => {
    const { fetch, requests } = registry({ versions: {} });

    await fetchPublishedVersions({
      env: { npm_config_registry: "https://npm.example.test/mirror/" },
      fetch,
    });

    expect(requests[0]?.url).toBe(
      "https://npm.example.test/mirror/@wheatley-ai%2Fcli"
    );
  });

  it("reports an HTTP error status", async () => {
    const { fetch } = registry({ error: "Not found" }, 404);

    await expect(fetchPublishedVersions({ env: {}, fetch })).rejects.toThrow(
      "HTTP 404"
    );
  });

  it("rejects a response without a versions object", async () => {
    const { fetch } = registry({ name: "@wheatley-ai/cli" });

    await expect(fetchPublishedVersions({ env: {}, fetch })).rejects.toThrow(
      "unexpected"
    );
  });
});
