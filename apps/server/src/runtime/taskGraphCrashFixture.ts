import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskGraph } from "@opc/shared";
import { getTaskGraph, loadTaskGraphs, upsertTaskGraph } from "../storage/taskGraphStore.js";
import { reconcileRunningTaskGraphsOnStartup } from "./startupReconcile.js";
import { executeGraph, type ExecuteGraphDeps } from "./taskGraphScheduler.js";

type CrashScenario =
  | "before_dispatch"
  | "after_spawn"
  | "after_artifact_commit"
  | "after_test"
  | "after_node_persist"
  | "after_run_finished";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function blockUntilKilled(): never {
  for (;;) Atomics.wait(sleepCell, 0, 0, 60_000);
}

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeResult(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function createGraph(scenario: CrashScenario): TaskGraph {
  const now = new Date().toISOString();
  return {
    id: `crash-${scenario}`,
    missionId: `mission-${scenario}`,
    companyId: "release-gate-company",
    goal: `Exercise ${scenario}`,
    schemaVersion: "2",
    revision: 0,
    status: "committed",
    createdAt: now,
    updatedAt: now,
    nodes: [{
      schemaVersion: "2",
      id: "producer",
      title: "Crash fixture producer",
      goal: `Produce an artifact for ${scenario}`,
      assignedAgentId: "fixture-worker",
      assignedRole: "dev",
      dependsOn: [],
      expectedArtifacts: ["workspace/artifact.txt"],
      status: "planned",
      statusHistory: [{ status: "planned", at: now, by: "fixture" }],
      attempt: 0,
      visit: 0,
      artifactRefs: [],
      evidenceRefs: [],
      uncertain: false,
    }],
  };
}

function artifactSnapshot(root: string): Record<string, string> {
  const workspace = path.join(root, "workspace");
  if (!fs.existsSync(workspace)) return {};
  return Object.fromEntries(
    fs.readdirSync(workspace, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => [entry.name, hashFile(path.join(workspace, entry.name))]),
  );
}

function signalCrashPoint(root: string, scenario: CrashScenario, graph: TaskGraph): never {
  writeResult(path.join(root, "crash-ready.json"), {
    schemaVersion: 1,
    scenario,
    pid: process.pid,
    graphId: graph.id,
    graphStatus: graph.status,
    nodeStatus: graph.nodes[0]?.status,
    attempt: graph.nodes[0]?.attempt,
    startedReceipt: !!graph.nodes[0]?.startedReceipt,
    completionReceipt: !!graph.nodes[0]?.completionReceipt,
    artifactHashes: artifactSnapshot(root),
    reachedAt: new Date().toISOString(),
  });
  blockUntilKilled();
}

async function crash(root: string, scenario: CrashScenario): Promise<void> {
  fs.mkdirSync(root, { recursive: true });
  const graph = createGraph(scenario);

  if (scenario === "before_dispatch") {
    graph.status = "running";
    graph.updatedAt = new Date().toISOString();
    upsertTaskGraph(root, graph);
    signalCrashPoint(root, scenario, graph);
  }

  const useCustomPersist = scenario === "after_node_persist" || scenario === "after_run_finished";
  if (!useCustomPersist) upsertTaskGraph(root, graph);

  const dispatch: ExecuteGraphDeps["dispatch"] = async () => {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    if (scenario === "after_spawn") {
      fs.writeFileSync(path.join(workspace, "spawned.txt"), "worker process started\n", "utf-8");
      signalCrashPoint(root, scenario, getTaskGraph(root, graph.id) ?? graph);
    }

    const artifact = path.join(workspace, "artifact.txt");
    fs.writeFileSync(artifact, `durable artifact for ${scenario}\n`, "utf-8");

    if (scenario === "after_artifact_commit") {
      signalCrashPoint(root, scenario, getTaskGraph(root, graph.id) ?? graph);
    }

    if (scenario === "after_test") {
      fs.writeFileSync(
        path.join(workspace, "test-evidence.json"),
        `${JSON.stringify({ passed: true, testedHash: hashFile(artifact) })}\n`,
        "utf-8",
      );
      signalCrashPoint(root, scenario, getTaskGraph(root, graph.id) ?? graph);
    }

    return {
      ok: true,
      runId: `run-${scenario}`,
      summary: "fixture completed",
      artifactRefs: ["file:workspace/artifact.txt"],
      evidenceRefs: ["file:workspace/test-evidence.json"],
    };
  };

  const deps: ExecuteGraphDeps = { dispatch, leaseMs: 60_000 };
  if (useCustomPersist) {
    deps.persist = (projectRoot, current) => {
      upsertTaskGraph(projectRoot, current);
      const nodePersisted = current.status === "running" && !!current.nodes[0]?.completionReceipt;
      const runFinishedPersisted = current.status === "completed";
      if (
        (scenario === "after_node_persist" && nodePersisted)
        || (scenario === "after_run_finished" && runFinishedPersisted)
      ) {
        signalCrashPoint(projectRoot, scenario, current);
      }
    };
  }

  await executeGraph(root, graph, deps);
  throw new Error(`Crash scenario ${scenario} reached normal process exit`);
}

function reconcile(root: string, resultFile: string): void {
  const result = reconcileRunningTaskGraphsOnStartup(root);
  const graph = loadTaskGraphs(root)[0];
  writeResult(resultFile, {
    ...result,
    graphStatus: graph?.status,
    graphRevision: graph?.revision,
    nodeStatus: graph?.nodes[0]?.status,
    uncertain: graph?.nodes[0]?.uncertain,
    attempt: graph?.nodes[0]?.attempt,
    startedReceipt: !!graph?.nodes[0]?.startedReceipt,
    completionReceipt: !!graph?.nodes[0]?.completionReceipt,
    artifactHashes: artifactSnapshot(root),
  });
}

async function resume(root: string, resultFile: string): Promise<void> {
  const graphId = loadTaskGraphs(root)[0]?.id;
  if (!graphId) throw new Error("Missing persisted task graph");
  const graph = getTaskGraph(root, graphId);
  if (!graph) throw new Error(`Missing graph ${graphId}`);
  let dispatchCount = 0;
  const result = await executeGraph(root, graph, {
    dispatch: async () => {
      dispatchCount++;
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "artifact.txt"), `duplicate dispatch ${dispatchCount}\n`, "utf-8");
      return {
        ok: true,
        runId: `resume-${dispatchCount}`,
        summary: "resumed",
        artifactRefs: ["file:workspace/artifact.txt"],
      };
    },
  });
  writeResult(resultFile, {
    dispatchCount,
    graphStatus: result.status,
    nodeStatus: result.nodes[0]?.status,
    uncertain: result.nodes[0]?.uncertain,
    attempt: result.nodes[0]?.attempt,
    completionReceipt: !!result.nodes[0]?.completionReceipt,
    artifactHashes: artifactSnapshot(root),
  });
}

async function main(): Promise<void> {
  process.env.OPC_STORAGE_BACKEND = "json";
  const [command, root, argument] = process.argv.slice(2);
  if (!command || !root || !argument) throw new Error("Usage: taskGraphCrashFixture <crash|reconcile|resume> <root> <scenario|resultFile>");
  if (command === "crash") return crash(root, argument as CrashScenario);
  if (command === "reconcile") return reconcile(root, argument);
  if (command === "resume") return resume(root, argument);
  throw new Error(`Unknown fixture command: ${command}`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
