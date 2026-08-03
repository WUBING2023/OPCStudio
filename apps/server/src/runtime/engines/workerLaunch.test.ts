import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliWorkerEnv, buildCliWorkerLaunch, resolveCliWorkerEntry } from "./workerLaunch.js";

const originalEntry = process.env.OPC_CLI_WORKER_ENTRY;

afterEach(() => {
  if (originalEntry === undefined) delete process.env.OPC_CLI_WORKER_ENTRY;
  else process.env.OPC_CLI_WORKER_ENTRY = originalEntry;
});

describe("packaged CLI worker launch", () => {
  it("launches a configured compiled worker outside the monorepo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-packaged-worker-"));
    const entry = path.join(root, "worker.js");
    fs.writeFileSync(entry, "process.exit(0);\n", "utf8");
    process.env.OPC_CLI_WORKER_ENTRY = entry;

    expect(resolveCliWorkerEntry(import.meta.url)).toBe(entry);
    expect(buildCliWorkerLaunch(import.meta.url, ["run", "--task", "task.json"])).toEqual({
      file: process.execPath,
      args: ["--conditions=production", entry, "run", "--task", "task.json"],
      entry,
    });
  });

  it("forces an Electron executable into Node mode without mutating the caller env", () => {
    const baseEnv: NodeJS.ProcessEnv = { PATH: "test-path" };
    const env = buildCliWorkerEnv(baseEnv, path.join("C:\\", "OPC Studio.exe"));

    expect(env).toMatchObject({
      PATH: "test-path",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(baseEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();

    const nodeEnv = buildCliWorkerEnv(
      { ELECTRON_RUN_AS_NODE: "1" },
      path.join("C:\\", "Program Files", "nodejs", "node.exe"),
    );
    expect(nodeEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("fails closed when the configured worker does not exist", () => {
    process.env.OPC_CLI_WORKER_ENTRY = path.join(os.tmpdir(), "opc-missing-worker.js");
    expect(() => resolveCliWorkerEntry(import.meta.url)).toThrow(/existing absolute path/);
  });
});
