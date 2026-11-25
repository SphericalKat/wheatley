import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeCommandRunner } from "./command-runner.fake.js";
import {
  createServiceManager,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServiceSpec,
} from "./service.js";
import type { ServiceSpec } from "./service.js";

const spec: ServiceSpec = {
  command: ["/opt/node 26/bin/node", "/opt/wheatley/bin/wheatley.js", "daemon"],
  environment: { PATH: "/opt/node/bin:/usr/bin", WHEATLEY_HOME: "/srv/50%" },
  logDir: "/home/kat/.wheatley/logs",
  workingDirectory: "/home/kat/.wheatley",
};

let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "wheatley-service-"));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

describe("systemd unit", () => {
  it("stops with SIGTERM to the daemon and a 45-second grace period", () => {
    const unit = renderSystemdUnit(spec);

    expect(unit).toContain("KillSignal=SIGTERM\n");
    expect(unit).toContain("KillMode=mixed\n");
    expect(unit).toContain("TimeoutStopSec=45\n");
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("WantedBy=default.target\n");
  });

  it("quotes paths with spaces and escapes systemd specifiers", () => {
    const unit = renderSystemdUnit(spec);

    expect(unit).toContain(
      'ExecStart="/opt/node 26/bin/node" /opt/wheatley/bin/wheatley.js daemon\n'
    );
    expect(unit).toContain('Environment="WHEATLEY_HOME=/srv/50%%"\n');
    expect(unit).toContain('WorkingDirectory="/home/kat/.wheatley"\n');
  });

  it("extends the grace period so that a longer drain is never killed", () => {
    const unit = renderSystemdUnit({ ...spec, drainTimeoutMs: 40_000 });

    expect(unit).toContain("TimeoutStopSec=55\n");
  });

  it("rejects values with line breaks, which would inject unit directives", () => {
    expect(() =>
      renderSystemdUnit({ ...spec, workingDirectory: "/x\nExecStartPre=/evil" })
    ).toThrow("line breaks");
  });
});

describe("launchd plist", () => {
  it("sets a 45-second exit timeout and restarts only after a crash", () => {
    const plist = renderLaunchdPlist(spec);

    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>45<\/integer>/u);
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u
    );
    expect(plist).toMatch(
      /<key>Label<\/key>\s*<string>wheatley\.daemon<\/string>/u
    );
  });

  it("lists the program arguments and escapes XML", () => {
    const plist = renderLaunchdPlist({
      ...spec,
      command: ["/opt/node/bin/node", "/a&b/<wheatley>.js", "daemon"],
    });

    expect(plist).toMatch(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/a&amp;b\/&lt;wheatley&gt;\.js<\/string>\s*<string>daemon<\/string>\s*<\/array>/u
    );
    expect(plist).toContain(
      "<string>/home/kat/.wheatley/logs/daemon.err.log</string>"
    );
  });
});

describe("service spec", () => {
  it("starts the wheatley executable on PATH with the daemon subcommand", async () => {
    const bin = path.join(home, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "wheatley"), "#!/bin/sh\n");
    await chmod(path.join(bin, "wheatley"), 0o755);

    const result = await resolveServiceSpec({
      binScript: "/checkout/bin/wheatley.js",
      env: { PATH: bin },
      execPath: process.execPath,
      homeDir: "/home/kat/.wheatley",
    });

    expect(result.command).toStrictEqual([
      path.join(bin, "wheatley"),
      "daemon",
    ]);
    expect(result.environment.PATH?.split(path.delimiter)).toContain(bin);
    expect(result.environment.WHEATLEY_HOME).toBeUndefined();
  });

  it("runs the bin script with Node.js if PATH has no wheatley executable", async () => {
    const result = await resolveServiceSpec({
      binScript: "/checkout/bin/wheatley.js",
      env: { PATH: home, WHEATLEY_HOME: "/srv/wheatley" },
      execPath: process.execPath,
      homeDir: "/srv/wheatley",
    });

    expect(result.command.slice(1)).toStrictEqual([
      "/checkout/bin/wheatley.js",
      "daemon",
    ]);
    expect(result.environment.WHEATLEY_HOME).toBe("/srv/wheatley");
    expect(result.workingDirectory).toBe("/srv/wheatley");
  });
});

describe("systemd manager", () => {
  it("installs and enables the user unit", async () => {
    const runner = new FakeCommandRunner();

    const manager = createServiceManager({
      env: {},
      platform: "linux",
      runner,
      uid: 1000,
      userHome: home,
    });

    const result = await manager.install(spec);

    expect(result.unitPath).toBe(
      path.join(home, ".config", "systemd", "user", "wheatley.service")
    );
    await expect(readFile(result.unitPath, "utf-8")).resolves.toBe(
      renderSystemdUnit(spec)
    );
    expect(runner.lines).toStrictEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable wheatley.service",
    ]);
  });

  it("starts, stops, and restarts through systemctl", async () => {
    const runner = new FakeCommandRunner();

    const manager = createServiceManager({
      env: {},
      platform: "linux",
      runner,
      uid: 1000,
      userHome: home,
    });

    await manager.install(spec);

    await manager.start();
    await manager.stop();
    await manager.restart();

    expect(runner.lines.slice(2)).toStrictEqual([
      "systemctl --user start wheatley.service",
      "systemctl --user stop wheatley.service",
      "systemctl --user restart wheatley.service",
    ]);
  });

  it("reports the state and PID of the running unit", async () => {
    const runner = new FakeCommandRunner((_command, args) =>
      args.includes("show")
        ? { stdout: "ActiveState=active\nMainPID=4242\n" }
        : undefined
    );

    const manager = createServiceManager({
      env: {},
      platform: "linux",
      runner,
      uid: 1000,
      userHome: home,
    });

    await manager.install(spec);

    await expect(manager.status()).resolves.toMatchObject({
      manager: "systemd",
      pid: 4242,
      state: "running",
    });
  });

  it("reports not_installed and refuses to start without a unit", async () => {
    const runner = new FakeCommandRunner();

    const manager = createServiceManager({
      env: {},
      platform: "linux",
      runner,
      uid: 1000,
      userHome: home,
    });

    await expect(manager.status()).resolves.toMatchObject({
      pid: null,
      state: "not_installed",
    });
    await expect(manager.start()).rejects.toThrow("wheatley service install");
    expect(runner.commands).toHaveLength(0);
  });

  it("reports a failed systemctl command with its output", async () => {
    const runner = new FakeCommandRunner((_command, args) =>
      args.includes("enable")
        ? { exitCode: 1, stderr: "Failed to connect to bus" }
        : undefined
    );

    const manager = createServiceManager({
      env: {},
      platform: "linux",
      runner,
      uid: 1000,
      userHome: home,
    });

    await expect(manager.install(spec)).rejects.toThrow(
      "systemctl --user enable wheatley.service exited with code 1: Failed to connect to bus"
    );
  });
});

/** Answers `launchctl print` as a loaded and running agent, or as an unknown service (exit code 113). */
const loadedRunner = (loaded: boolean): FakeCommandRunner =>
  new FakeCommandRunner((_command, args) => {
    const printed = loaded
      ? { stdout: "\tstate = running\n\tpid = 99\n" }
      : { exitCode: 113 };

    return args[0] === "print" ? printed : undefined;
  });

describe("launchd manager", () => {
  it("installs the plist into LaunchAgents and lints it", async () => {
    const runner = loadedRunner(false);

    const manager = createServiceManager({
      env: {},
      platform: "darwin",
      runner,
      uid: 501,
      userHome: home,
    });

    const result = await manager.install({
      ...spec,
      logDir: path.join(home, "logs"),
    });

    expect(result.unitPath).toBe(
      path.join(home, "Library", "LaunchAgents", "wheatley.daemon.plist")
    );
    await expect(readFile(result.unitPath, "utf-8")).resolves.toContain(
      "<integer>45</integer>"
    );
    expect(runner.lines).toStrictEqual([`plutil -lint ${result.unitPath}`]);
  });

  it("bootstraps an unloaded agent on start and boots it out on stop", async () => {
    const unloaded = loadedRunner(false);

    const manager = createServiceManager({
      env: {},
      platform: "darwin",
      runner: unloaded,
      uid: 501,
      userHome: home,
    });

    const { unitPath } = await manager.install({
      ...spec,
      logDir: path.join(home, "logs"),
    });

    await manager.start();
    await manager.stop();

    expect(unloaded.lines.slice(1)).toStrictEqual([
      "launchctl print gui/501/wheatley.daemon",
      `launchctl bootstrap gui/501 ${unitPath}`,
      "launchctl print gui/501/wheatley.daemon",
    ]);

    const loaded = loadedRunner(true);

    const running = createServiceManager({
      env: {},
      platform: "darwin",
      runner: loaded,
      uid: 501,
      userHome: home,
    });

    await running.restart();

    expect(loaded.lines).toStrictEqual([
      "launchctl print gui/501/wheatley.daemon",
      "launchctl bootout gui/501/wheatley.daemon",
      "launchctl print gui/501/wheatley.daemon",
      "launchctl kickstart gui/501/wheatley.daemon",
    ]);
  });

  it("reports the state and PID from launchctl print", async () => {
    const manager = createServiceManager({
      env: {},
      platform: "darwin",
      runner: loadedRunner(true),
      uid: 501,
      userHome: home,
    });

    await manager.install({ ...spec, logDir: path.join(home, "logs") });

    await expect(manager.status()).resolves.toMatchObject({
      manager: "launchd",
      pid: 99,
      state: "running",
    });
  });
});

describe("service manager selection", () => {
  it("rejects Docker and unsupported platforms", () => {
    const runner = new FakeCommandRunner();

    expect(() =>
      createServiceManager({
        env: { WHEATLEY_DOCKER: "1" },
        platform: "linux",
        runner,
        uid: 0,
        userHome: home,
      })
    ).toThrow("Docker Compose");
    expect(() =>
      createServiceManager({
        env: {},
        platform: "win32",
        runner,
        uid: 0,
        userHome: home,
      })
    ).toThrow("not win32");
  });
});
