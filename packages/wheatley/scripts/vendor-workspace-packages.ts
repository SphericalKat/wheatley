// Copies the compiled workspace packages that the daemon imports at runtime into `dist/node_modules/`. Node.js finds
// them there from every file in `dist/`, so the npm tarball installs without the private `@wheatley/protocol` on a
// registry and without the `workspace:` protocol in its manifest (ADR 0008).
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** The workspace packages that `dist/` imports at runtime. */
const VENDORED = ["@wheatley/protocol", "@wheatley/sdk"] as const;

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const isManifest = (value: unknown): value is Manifest =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "version" in value &&
  typeof value.version === "string";

const readManifest = async (dir: string): Promise<Manifest> => {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(dir, "package.json"), "utf-8")
  );

  if (!isManifest(parsed)) {
    throw new Error(`${dir}/package.json has no name or version`);
  }

  return parsed;
};

const packageRoot = path.resolve(import.meta.dirname, "..");
const ownManifest = await readManifest(packageRoot);
const target = path.join(packageRoot, "dist", "node_modules");

/** Copies the compiled `dist/` and a minimal manifest of the workspace package `name` into `target`. */
const vendor = async (name: string): Promise<void> => {
  const source = await realpath(path.join(packageRoot, "node_modules", name));
  const manifest = await readManifest(source);
  const dir = path.join(target, name);

  // The vendored copy uses the runtime dependencies of the `wheatley` package, so they must be listed there too.
  for (const [dependency, range] of Object.entries(
    manifest.dependencies ?? {}
  )) {
    if (ownManifest.dependencies?.[dependency] !== range) {
      throw new Error(
        `${name} needs ${dependency}@${range}: add the same version to the dependencies of wheatley`
      );
    }
  }

  await mkdir(dir, { recursive: true });
  await cp(path.join(source, "dist"), path.join(dir, "dist"), {
    filter: (file) => !file.endsWith(".map"),
    recursive: true,
  });
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        dependencies: manifest.dependencies,
        exports: {
          ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
        },
        name,
        type: "module",
        version: manifest.version,
      },
      null,
      2
    )}\n`
  );
};

await rm(target, { force: true, recursive: true });

await Promise.all(VENDORED.map(vendor));

process.stdout.write(`Vendored ${VENDORED.join(" and ")} into ${target}\n`);
