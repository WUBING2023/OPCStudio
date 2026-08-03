import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import {
  parseArtifactRef,
  parseRunEvents,
  type ArtifactRef,
  type RunEvent,
} from "@opc/shared";
import { OpcClient, type OpcClientOptions } from "./client.js";
import {
  writePluginDistribution,
  writePluginDistributions,
  type PluginPlatform,
} from "../plugins/distribution.js";
import {
  asCliError,
  cliErrorEnvelope,
  CliError,
  CLI_EXIT,
  localValidationError,
  type CliExitCode,
} from "./errors.js";

type JsonRecord = Record<string, unknown>;

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliDependencies {
  clientFactory?: (options: OpcClientOptions) => OpcClient;
  io?: CliIo;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

interface CliState {
  exitCode: CliExitCode;
}

interface OutputOptions {
  json?: boolean;
  jsonl?: boolean;
  server?: string;
  nonInteractive?: boolean;
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function commandOptions(command: Command): OutputOptions {
  return command.optsWithGlobals() as OutputOptions;
}

function isMachineOutput(options: OutputOptions): boolean {
  return options.json === true || options.jsonl === true;
}

function writeDocument(io: CliIo, options: OutputOptions, data: unknown, human?: string): void {
  if (isMachineOutput(options)) {
    io.stdout(JSON.stringify({ ok: true, data }));
    return;
  }
  io.stdout(human ?? JSON.stringify(data, null, 2));
}

function writeJsonLine(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value));
}

function writeError(io: CliIo, options: OutputOptions, error: CliError): void {
  const envelope = cliErrorEnvelope(error);
  if (isMachineOutput(options)) io.stdout(JSON.stringify(envelope));
  else {
    io.stderr(`${error.code}: ${error.message}`);
    if (Object.keys(error.details).length > 0) io.stderr(JSON.stringify(error.details, null, 2));
  }
}

function addJsonOption(command: Command): Command {
  return command.option("--json", "Output one JSON document and no human-readable logs");
}

function addConnectionOptions(command: Command): Command {
  return command
    .option("--server <url>", "OPC Server URL (or OPC_SERVER_URL)")
    .option("--non-interactive", "Never prompt for input", true);
}

function addMachineOptions(command: Command): Command {
  return addConnectionOptions(addJsonOption(command));
}

function clientFor(command: Command, dependencies: Required<Pick<CliDependencies, "clientFactory">>): OpcClient {
  const options = commandOptions(command);
  return dependencies.clientFactory({ baseUrl: options.server });
}

function parseInteger(name: string, raw: string, minimum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw localValidationError(`${name} must be an integer >= ${minimum}`, { value: raw });
  }
  return value;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function requireIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw localValidationError(`${name} contains unsupported characters`, { [name]: value });
  }
  return value;
}

function readTask(options: { task?: string; taskFile?: string }): string {
  if (options.task && options.taskFile) {
    throw localValidationError("Use either --task or --task-file, not both");
  }
  let file: string | undefined = options.taskFile;
  if (!file && options.task?.startsWith("@")) file = options.task.slice(1);
  if (!file && options.task && fs.existsSync(path.resolve(options.task))) {
    const stat = fs.statSync(path.resolve(options.task));
    if (stat.isFile()) file = options.task;
  }
  if (file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw localValidationError("Task file does not exist", { path: resolved });
    }
    const size = fs.statSync(resolved).size;
    if (size > 1024 * 1024) throw localValidationError("Task file exceeds 1 MiB", { path: resolved, size });
    const task = fs.readFileSync(resolved, "utf-8").trim();
    if (!task) throw localValidationError("Task file is empty", { path: resolved });
    return task;
  }
  const task = options.task?.trim();
  if (!task) throw localValidationError("--task or --task-file is required");
  return task;
}

function isTerminalRun(run: JsonRecord): boolean {
  const status = typeof run.status === "string" ? run.status : "";
  return ["done", "failed", "cancelled", "stopped"].includes(status);
}

function runSummary(run: JsonRecord): string {
  const id = String(run.id ?? run.runId ?? "unknown");
  const status = String(run.status ?? "unknown");
  const finalState = typeof run.finalState === "string" ? ` / ${run.finalState}` : "";
  return `${id}: ${status}${finalState}`;
}

function artifactName(artifact: ArtifactRef): string {
  return artifact.name || artifact.artifactId;
}

function safeOutputName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return base && base !== "." ? base : "artifact.bin";
}

async function waitForRun(
  client: OpcClient,
  runId: string,
  options: { intervalMs: number; timeoutMs: number; jsonl: boolean },
  io: CliIo,
  dependencies: {
    sleep: NonNullable<CliDependencies["sleep"]>;
    now: NonNullable<CliDependencies["now"]>;
    signal?: AbortSignal;
  },
): Promise<JsonRecord> {
  const started = dependencies.now();
  let lastSignature = "";
  let consecutiveFailures = 0;
  while (true) {
    if (dependencies.signal?.aborted) {
      throw new CliError("interrupted", "Operation interrupted", { runId }, false, CLI_EXIT.interrupted);
    }
    if (options.timeoutMs > 0 && dependencies.now() - started >= options.timeoutMs) {
      throw new CliError("watch_timeout", "Timed out while watching run", { runId }, true, CLI_EXIT.unavailable);
    }
    try {
      const run = asRecord(await client.get(`/api/runs/${encodeSegment(runId)}`, dependencies.signal));
      consecutiveFailures = 0;
      const signature = `${String(run.status)}:${String(run.finalState)}`;
      if (signature !== lastSignature) {
        if (options.jsonl) writeJsonLine(io, {
          schemaVersion: "1", type: "run.status", runId,
          status: run.status ?? "unknown", finalState: run.finalState ?? null,
          timestamp: new Date().toISOString(),
        });
        else io.stderr(runSummary(run));
        lastSignature = signature;
      }
      if (isTerminalRun(run)) return run;
    } catch (error) {
      const cliError = asCliError(error);
      if (!cliError.retryable || ++consecutiveFailures > 20) throw cliError;
      if (!options.jsonl) io.stderr(`reconnecting (${consecutiveFailures}/20): ${cliError.message}`);
    }
    await dependencies.sleep(options.intervalMs);
  }
}

function canonicalEvents(raw: unknown, fallbackRunId: string): RunEvent[] {
  const record = asRecord(raw);
  const values = Array.isArray(record.events) ? record.events : Array.isArray(raw) ? raw : [];
  return parseRunEvents(values.map((value) => {
    const event = asRecord(value);
    return event.runId ? event : { ...event, runId: record.runId ?? fallbackRunId };
  }));
}

function canonicalArtifacts(raw: unknown, runId: string): ArtifactRef[] {
  const record = asRecord(raw);
  const values = Array.isArray(record.artifacts) ? record.artifacts : Array.isArray(raw) ? raw : [];
  return values.map((value) => parseArtifactRef(value, runId));
}

function createProgram(dependencies: CliDependencies, state: CliState): Command {
  const io = dependencies.io ?? defaultIo;
  const deps = {
    clientFactory: dependencies.clientFactory ?? ((options: OpcClientOptions) => new OpcClient(options)),
    sleep: dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: dependencies.now ?? (() => Date.now()),
    signal: dependencies.signal,
  };
  const program = new Command();
  program
    .name("opc")
    .description("OPC Studio headless client")
    .version("0.1.0")
    .option("--server <url>", "OPC Server URL (or OPC_SERVER_URL)")
    .option("--non-interactive", "Never prompt for input", true)
    .showHelpAfterError(false)
    .exitOverride();

  const guarded = async (command: Command, action: () => Promise<void> | void): Promise<void> => {
    try { await action(); }
    catch (error) {
      const cliError = asCliError(error);
      state.exitCode = cliError.exitCode;
      writeError(io, commandOptions(command), cliError);
    }
  };

  addJsonOption(program.command("init").description("Initialize the .opc project directory"))
    .action(async (_options, command) => guarded(command, () => {
      const dir = path.join(process.cwd(), ".opc");
      const existed = fs.existsSync(dir);
      fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
      fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
      fs.mkdirSync(path.join(dir, "traces"), { recursive: true });
      writeDocument(io, commandOptions(command), { path: dir, created: !existed },
        existed ? `.opc already exists at ${dir}` : `OPC initialized at ${dir}`);
    }));

  program.command("studio")
    .description("Launch OPC Studio (server + UI)")
    .option("-p, --project <path>", "Target project directory (default: cwd)")
    .action(async (options, command) => guarded(command, async () => {
      const targetRoot = options.project ? path.resolve(options.project) : process.cwd();
      if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
        throw localValidationError("Project path is not a directory", { path: targetRoot });
      }
      io.stdout(`Starting OPC Studio for project: ${targetRoot}`);
      const here = path.dirname(fileURLToPath(import.meta.url));
      const serverEntry = path.resolve(here, "../../../server/src/index.ts");
      const serverProcess = spawn("npx", ["tsx", serverEntry], {
        cwd: targetRoot,
        env: { ...process.env, PORT: "3100", OPC_PROJECT_ROOT: targetRoot },
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      const { default: open } = await import("open");
      const timer = setTimeout(() => { void open("http://localhost:3100"); }, 2_000);
      await new Promise<void>((resolve, reject) => {
        serverProcess.once("error", reject);
        serverProcess.once("close", () => resolve());
      });
      clearTimeout(timer);
    }));

  const doctor = addMachineOptions(program.command("doctor")
    .description("Run the global environment Doctor")
    .option("--level <level>", "basic, capability or deep", "basic"));
  doctor.action(async (options, command) => guarded(command, async () => {
    if (!["basic", "capability", "deep"].includes(options.level)) {
      throw localValidationError("--level must be basic, capability or deep", { level: options.level });
    }
    const data = await clientFor(command, deps).post(
      "/api/doctor/run", { level: options.level }, randomUUID(), deps.signal,
    );
    writeDocument(io, commandOptions(command), data);
  }));

  const company = program.command("company").description("Inspect executable companies");
  addMachineOptions(company.command("list").description("List companies"))
    .action(async (_options, command) => guarded(command, async () => {
      const data = await clientFor(command, deps).get<unknown>("/api/companies", deps.signal);
      const companies = Array.isArray(data) ? data : [];
      const human = companies.length === 0
        ? "No companies found"
        : companies.map((item) => {
          const companyRecord = asRecord(item);
          return `${String(companyRecord.id ?? "-")}\t${String(companyRecord.name ?? "-")}`;
        }).join("\n");
      writeDocument(io, commandOptions(command), companies, human);
    }));

  addMachineOptions(company.command("inspect <company-id>").description("Inspect a company and its capability report"))
    .action(async (companyId, _options, command) => guarded(command, async () => {
      requireIdentifier("companyId", companyId);
      const client = clientFor(command, deps);
      const [rawCompanies, rawAgents, capabilityReport] = await Promise.all([
        client.get<unknown>("/api/companies", deps.signal),
        client.get<unknown>("/api/agents", deps.signal),
        client.get<unknown>(`/api/companies/${encodeSegment(companyId)}/capability-report`, deps.signal),
      ]);
      const companies = Array.isArray(rawCompanies) ? rawCompanies : [];
      const found = companies.find((item) => asRecord(item).id === companyId);
      if (!found) throw new CliError("company_not_found", "Company not found", { companyId }, false, CLI_EXIT.notFound);
      const agents = (Array.isArray(rawAgents) ? rawAgents : []).filter(
        (item) => asRecord(item).companyId === companyId,
      );
      writeDocument(io, commandOptions(command), { company: found, agents, capabilityReport });
    }));

  addMachineOptions(company.command("doctor <company-id>").description("Read a company's executable capability report"))
    .action(async (companyId, _options, command) => guarded(command, async () => {
      requireIdentifier("companyId", companyId);
      const data = await clientFor(command, deps)
        .get(`/api/companies/${encodeSegment(companyId)}/capability-report`, deps.signal);
      writeDocument(io, commandOptions(command), data);
    }));

  const run = program.command("run").description("Start and inspect runs");
  const start = addMachineOptions(run.command("start")
    .alias("create")
    .description("Start a durable run")
    .requiredOption("--company <id>", "Company id")
    .option("--task <text-or-file>", "Task text, @file, or an existing file path")
    .option("--task-file <path>", "Read task text from a UTF-8 file")
    .option("--run-type <type>", "quick or team", "team")
    .option("--team-mode <mode>", "economy, balanced or maxQuality", "balanced")
    .option("--idempotency-key <key>", "Stable retry key; generated when omitted"));
  start.action(async (options, command) => guarded(command, async () => {
    requireIdentifier("companyId", options.company);
    if (!["quick", "team"].includes(options.runType)) {
      throw localValidationError("--run-type must be quick or team", { runType: options.runType });
    }
    if (!["economy", "balanced", "maxQuality"].includes(options.teamMode)) {
      throw localValidationError("--team-mode must be economy, balanced or maxQuality", { teamMode: options.teamMode });
    }
    const task = readTask(options);
    const data = asRecord(await clientFor(command, deps).post("/api/chat/task", {
      message: task,
      companyId: options.company,
      runType: options.runType,
      teamMode: options.teamMode,
    }, options.idempotencyKey || randomUUID(), deps.signal));
    const human = data.runId ? `Run accepted: ${String(data.runId)}` : JSON.stringify(data, null, 2);
    writeDocument(io, commandOptions(command), data, human);
  }));

  const status = addMachineOptions(run.command("status <run-id>")
    .description("Read or watch authoritative run state")
    .option("--watch", "Poll until the run reaches a terminal state")
    .option("--jsonl", "Emit status changes as JSON Lines")
    .option("--interval-ms <ms>", "Polling interval", "1000")
    .option("--timeout-ms <ms>", "Overall timeout; 0 means no timeout", "0"));
  status.action(async (runId, options, command) => guarded(command, async () => {
    requireIdentifier("runId", runId);
    const client = clientFor(command, deps);
    if (!options.watch) {
      const data = asRecord(await client.get(`/api/runs/${encodeSegment(runId)}`, deps.signal));
      if (options.jsonl) writeJsonLine(io, data);
      else writeDocument(io, commandOptions(command), data, runSummary(data));
      return;
    }
    const data = await waitForRun(client, runId, {
      intervalMs: parseInteger("--interval-ms", options.intervalMs, 50),
      timeoutMs: parseInteger("--timeout-ms", options.timeoutMs, 0),
      jsonl: options.jsonl === true,
    }, io, deps);
    if (!options.jsonl) writeDocument(io, commandOptions(command), data, runSummary(data));
  }));

  const events = addConnectionOptions(run.command("events <run-id>")
    .alias("trace")
    .description("Read canonical run events")
    .option("--json", "Output one JSON document")
    .option("--jsonl", "Output one canonical RunEvent per line")
    .option("--follow", "Poll for new events until the run is terminal")
    .option("--interval-ms <ms>", "Polling interval", "1000")
    .option("--timeout-ms <ms>", "Overall timeout; 0 means no timeout", "0"));
  events.action(async (runId, options, command) => guarded(command, async () => {
    requireIdentifier("runId", runId);
    if (options.json && options.jsonl) throw localValidationError("Use either --json or --jsonl, not both");
    const client = clientFor(command, deps);
    const intervalMs = parseInteger("--interval-ms", options.intervalMs, 50);
    const timeoutMs = parseInteger("--timeout-ms", options.timeoutMs, 0);
    const startedAt = deps.now();
    const seen = new Set<string>();
    const collected: RunEvent[] = [];
    while (true) {
      if (deps.signal?.aborted) {
        throw new CliError("interrupted", "Operation interrupted", { runId }, false, CLI_EXIT.interrupted);
      }
      if (timeoutMs > 0 && deps.now() - startedAt >= timeoutMs) {
        throw new CliError("watch_timeout", "Timed out while following events", { runId }, true, CLI_EXIT.unavailable);
      }
      const fetched = canonicalEvents(
        await client.get(`/api/runs/${encodeSegment(runId)}/events`, deps.signal),
        runId,
      );
      const fresh = fetched.filter((event) => !seen.has(event.eventId));
      for (const event of fresh) {
        seen.add(event.eventId);
        collected.push(event);
        if (options.jsonl) writeJsonLine(io, event);
        else if (!options.json) {
          io.stdout(`${event.sequence}\t${event.timestamp}\t${event.type}\t${event.actor?.id ?? "-"}`);
        }
      }
      if (!options.follow) break;
      const runState = asRecord(await client.get(`/api/runs/${encodeSegment(runId)}`, deps.signal));
      if (isTerminalRun(runState)) break;
      await deps.sleep(intervalMs);
    }
    if (!options.jsonl) {
      writeDocument(io, commandOptions(command), { runId, events: collected },
        collected.length === 0 ? "No events recorded" : `Events: ${collected.length}`);
    }
  }));

  addMachineOptions(run.command("cancel <run-id>").description("Request graceful cancellation"))
    .action(async (runId, _options, command) => guarded(command, async () => {
      requireIdentifier("runId", runId);
      const data = await clientFor(command, deps).post(
        `/api/runs/${encodeSegment(runId)}/stop`, {}, randomUUID(), deps.signal,
      );
      writeDocument(io, commandOptions(command), data, `Stop requested for ${runId}`);
    }));

  const renderArtifactList = async (runId: string, command: Command): Promise<void> => {
    requireIdentifier("runId", runId);
    const raw = await clientFor(command, deps).get(
      `/api/runs/${encodeSegment(runId)}/artifacts`, deps.signal,
    );
    const artifacts = canonicalArtifacts(raw, runId);
    const human = artifacts.length === 0 ? "No artifacts recorded" : artifacts.map((artifact) =>
      `${artifact.artifactId}\t${artifact.verification.status}\t${artifactName(artifact)}`,
    ).join("\n");
    writeDocument(io, commandOptions(command), { runId, artifacts }, human);
  };

  addMachineOptions(run.command("artifacts <run-id>").description("List canonical artifacts for a run"))
    .action(async (runId, _options, command) => guarded(command, () => renderArtifactList(runId, command)));

  const artifact = program.command("artifact").description("List and download artifacts");
  addMachineOptions(artifact.command("list <run-id>").description("List canonical artifacts for a run"))
    .action(async (runId, _options, command) => guarded(command, () => renderArtifactList(runId, command)));

  addMachineOptions(artifact.command("get <run-id> <artifact-id>")
    .description("Download an artifact without overwriting by default")
    .option("--output <path>", "Output file or directory")
    .option("--force", "Replace an existing output file"))
    .action(async (runId, artifactId, options, command) => guarded(command, async () => {
      requireIdentifier("runId", runId);
      if (!artifactId.trim()) throw localValidationError("artifact-id is required");
      const client = clientFor(command, deps);
      const downloaded = await client.download(
        `/api/runs/${encodeSegment(runId)}/artifacts/download?artifactId=${encodeURIComponent(artifactId)}`,
        deps.signal,
      );
      const fallbackName = safeOutputName(downloaded.filename ?? artifactId);
      const requested = options.output ? path.resolve(options.output) : path.resolve(fallbackName);
      const outputPath = fs.existsSync(requested) && fs.statSync(requested).isDirectory()
        ? path.join(requested, fallbackName)
        : requested;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      try {
        fs.writeFileSync(outputPath, downloaded.body, { flag: options.force ? "w" : "wx" });
      } catch (error) {
        const code = asRecord(error).code;
        if (code === "EEXIST") {
          throw new CliError("output_exists", "Output file already exists; pass --force to replace it",
            { output: outputPath }, false, CLI_EXIT.conflict);
        }
        throw error;
      }
      writeDocument(io, commandOptions(command), {
        runId, artifactId, output: outputPath, bytes: downloaded.body.byteLength,
        contentType: downloaded.contentType,
      }, `Saved ${downloaded.body.byteLength} bytes to ${outputPath}`);
    }));

  const evidence = program.command("evidence").description("Inspect immutable run evidence");
  addMachineOptions(evidence.command("verify <run-id>").description("Recalculate and verify run evidence"))
    .action(async (runId, _options, command) => guarded(command, async () => {
      requireIdentifier("runId", runId);
      const data = asRecord(await clientFor(command, deps).get(
        `/api/runs/${encodeSegment(runId)}/evidence?verify=1`, deps.signal,
      ));
      if (data.ok !== true) {
        throw new CliError("evidence_verification_failed", "Run evidence verification failed",
          { runId, evidence: data }, false, CLI_EXIT.acceptanceFailed);
      }
      writeDocument(io, commandOptions(command), data, `Evidence verified for ${runId}`);
    }));

  const acceptance = program.command("acceptance").description("Check authoritative delivery acceptance");
  addMachineOptions(acceptance.command("check <run-id>")
    .description("Check finalState, deliveryAcceptance and evidence integrity"))
    .action(async (runId, _options, command) => guarded(command, async () => {
      requireIdentifier("runId", runId);
      const client = clientFor(command, deps);
      const [rawRun, rawEvidence] = await Promise.all([
        client.get(`/api/runs/${encodeSegment(runId)}`, deps.signal),
        client.get(`/api/runs/${encodeSegment(runId)}/evidence?verify=1`, deps.signal),
      ]);
      const runState = asRecord(rawRun);
      const evidenceState = asRecord(rawEvidence);
      const finalState = typeof runState.finalState === "string" ? runState.finalState : null;
      const deliveryAcceptance = asRecord(runState.deliveryAcceptance);
      const accepted = (finalState === "verified" || finalState === "tests_passed")
        && evidenceState.ok === true;
      const result = {
        runId,
        accepted,
        status: runState.status ?? null,
        finalState,
        deliveryAcceptance,
        evidence: evidenceState,
      };
      if (!accepted) {
        throw new CliError("acceptance_failed", "Run did not satisfy authoritative acceptance",
          result, false, CLI_EXIT.acceptanceFailed);
      }
      writeDocument(io, commandOptions(command), result, `Acceptance passed for ${runId}`);
    }));

  const plugin = program.command("plugin").description("Export OPC Studio host adapters");
  addJsonOption(plugin.command("export")
    .description("Generate installable Codex and/or Claude Code plugin distributions")
    .option("--target <target>", "codex, claude or all", "all")
    .option("--output <path>", "Distribution root", "opc-integrations"))
    .action(async (options, command) => guarded(command, () => {
      const target = String(options.target ?? "all");
      if (!["codex", "claude", "all"].includes(target)) {
        throw localValidationError("--target must be codex, claude or all", { target });
      }
      const output = path.resolve(String(options.output ?? "opc-integrations"));
      if (target === "all") writePluginDistributions(output);
      else writePluginDistribution(output, target as PluginPlatform);
      const platforms = target === "all" ? ["codex", "claude"] : [target];
      writeDocument(io, commandOptions(command), { output, platforms },
        `Exported ${platforms.join(" and ")} plugin adapter${platforms.length > 1 ? "s" : ""} to ${output}`);
    }));

  program.configureOutput({
    writeOut: (message) => io.stdout(message.replace(/\n$/, "")),
    writeErr: () => undefined,
  });
  return program;
}

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  return createProgram(dependencies, { exitCode: CLI_EXIT.ok });
}

export async function executeCli(argv: string[], dependencies: CliDependencies = {}): Promise<CliExitCode> {
  const state: CliState = { exitCode: CLI_EXIT.ok };
  const io = dependencies.io ?? defaultIo;
  const program = createProgram(dependencies, state);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version"].includes(error.code)) {
      return CLI_EXIT.ok;
    }
    const details = error instanceof CommanderError ? { commanderCode: error.code } : {};
    const cliError = error instanceof CliError
      ? error
      : new CliError("invalid_arguments", error instanceof Error ? error.message : String(error),
        details, false, CLI_EXIT.usage);
    state.exitCode = cliError.exitCode;
    const machine = { json: argv.includes("--json"), jsonl: argv.includes("--jsonl") };
    writeError(io, machine, cliError);
  }
  return state.exitCode;
}
