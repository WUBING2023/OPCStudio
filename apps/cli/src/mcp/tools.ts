import { createHash, randomUUID } from "node:crypto";
import { bundleToTemplateShape, parseArtifactRef, parseCompanyBundle, parseRunEvents } from "@opc/shared";
import { CliError } from "../headless/errors.js";
import type { McpAuditRecord, McpAuditWriter } from "./audit.js";

type JsonRecord = Record<string, unknown>;

export interface OpcMcpGateway {
  get(apiPath: string): Promise<unknown>;
  post(apiPath: string, body: unknown, idempotencyKey: string): Promise<unknown>;
}

export interface McpToolRuntime {
  callTool(name: string, argumentsValue: unknown): Promise<unknown>;
}

export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonRecord = {},
    readonly retryable = false,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const objectSchema = (properties: JsonRecord, required: string[] = []): JsonRecord => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const stringId = { type: "string", minLength: 1, maxLength: 128 };
const confirm = { type: "boolean", const: true, description: "Explicit user confirmation" };
const idempotencyKey = { type: "string", minLength: 1, maxLength: 128 };
const memoryScope = { type: "string", enum: ["user", "company", "project", "team", "agent"] };
const memoryObjectType = { type: "string", enum: ["user_preference", "fact", "success_experience", "failure_lesson", "resource_pointer"] };

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  { name: "list_companies", description: "List OPC Studio companies available to the current workspace.", inputSchema: objectSchema({}), annotations: { title: "List companies", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "inspect_company", description: "Inspect one company, its workers, and its current capability report.", inputSchema: objectSchema({ companyId: stringId }, ["companyId"]), annotations: { title: "Inspect company", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "inspect_capabilities", description: "Check whether a company can execute a requested run shape with configured providers.", inputSchema: objectSchema({ companyId: stringId, runType: { type: "string", enum: ["quick", "team"] }, teamMode: { type: "string", enum: ["economy", "balanced", "maxQuality"] } }, ["companyId"]), annotations: { title: "Inspect capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "plan_run", description: "Preview a task plan and effective company capabilities without creating a run.", inputSchema: objectSchema({ companyId: stringId, task: { type: "string", minLength: 1, maxLength: 4000 }, runType: { type: "string", enum: ["quick", "team"] }, teamMode: { type: "string", enum: ["economy", "balanced", "maxQuality"] } }, ["companyId", "task"]), annotations: { title: "Plan run", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "start_run", description: "Start a durable OPC run after explicit confirmation. Requires an authenticated OPC session and an idempotency key.", inputSchema: objectSchema({ companyId: stringId, task: { type: "string", minLength: 1, maxLength: 65536 }, runType: { type: "string", enum: ["quick", "team"] }, teamMode: { type: "string", enum: ["economy", "balanced", "maxQuality"] }, confirm, idempotencyKey }, ["companyId", "task", "confirm"]), annotations: { title: "Start run", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: "get_run_status", description: "Read the authoritative state of a durable OPC run.", inputSchema: objectSchema({ runId: stringId }, ["runId"]), annotations: { title: "Get run status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "cancel_run", description: "Request cancellation of an active OPC run after explicit confirmation. Requires an authenticated OPC session and an idempotency key.", inputSchema: objectSchema({ runId: stringId, reason: { type: "string", maxLength: 1000 }, confirm, idempotencyKey }, ["runId", "confirm"]), annotations: { title: "Cancel run", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "get_run_trace", description: "Read canonical, versioned events for one OPC run.", inputSchema: objectSchema({ runId: stringId }, ["runId"]), annotations: { title: "Get run trace", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "list_artifacts", description: "List canonical artifact references and verification state for one OPC run.", inputSchema: objectSchema({ runId: stringId }, ["runId"]), annotations: { title: "List artifacts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_artifact", description: "Read the server-limited preview for one recorded artifact. Arbitrary filesystem paths are not accepted.", inputSchema: objectSchema({ runId: stringId, artifactId: { type: "string", minLength: 1, maxLength: 512 } }, ["runId", "artifactId"]), annotations: { title: "Get artifact preview", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_evidence", description: "Read the committed evidence manifest for one run, optionally asking the server to verify hashes.", inputSchema: objectSchema({ runId: stringId, verify: { type: "boolean" } }, ["runId"]), annotations: { title: "Get run evidence", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "review_run", description: "Approve or reject a governance-gated run after explicit user confirmation. Requires an authenticated OPC session and an explicit idempotency key.", inputSchema: objectSchema({ runId: stringId, decision: { type: "string", enum: ["approve", "reject"] }, confirm, idempotencyKey }, ["runId", "decision", "confirm", "idempotencyKey"]), annotations: { title: "Review governed run", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "list_company_plans", description: "List persisted, bound company architecture proposals. Defaults to pending proposals.", inputSchema: objectSchema({ companyId: stringId, status: { type: "string", enum: ["all", "pending", "applying", "applied", "failed", "rolled_back"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["companyId"]), annotations: { title: "List company plans", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "get_company_plan", description: "Read one persisted company plan and its authoritative proposal, company-surface, action, and expiry bindings.", inputSchema: objectSchema({ companyId: stringId, proposalId: stringId }, ["companyId", "proposalId"]), annotations: { title: "Get company plan", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "apply_company_plan", description: "Apply a persisted company plan after explicit confirmation. The server revalidates proposalId, companyId, beforeHash, actionsHash, expiry, and high-risk confirmation.", inputSchema: objectSchema({ companyId: stringId, proposalId: stringId, beforeHash: { type: "string", minLength: 64, maxLength: 64 }, actionsHash: { type: "string", minLength: 64, maxLength: 64 }, expiresAt: { type: "string", minLength: 20, maxLength: 64 }, confirmationReceipt: { type: "string", minLength: 1, maxLength: 256 }, confirm, idempotencyKey }, ["companyId", "proposalId", "beforeHash", "actionsHash", "expiresAt", "confirm", "idempotencyKey"]), annotations: { title: "Apply company plan", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "propose_memory", description: "Create a governed memory proposal for later review. This never directly approves memory and requires confirmation, an authenticated session, and an explicit idempotency key.", inputSchema: objectSchema({ text: { type: "string", minLength: 1, maxLength: 65536 }, title: { type: "string", minLength: 1, maxLength: 200 }, summary: { type: "string", minLength: 1, maxLength: 1000 }, objectType: memoryObjectType, scope: memoryScope, scopeId: stringId, sourceRunId: stringId, rootCauseConfirmed: { type: "boolean" }, evidenceIds: { type: "array", maxItems: 20, items: stringId }, counterexamples: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 1000 } }, confirm, idempotencyKey }, ["text", "confirm", "idempotencyKey"]), annotations: { title: "Propose memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "validate_company_bundle", description: "Validate an inline Company Bundle through the shared schema plus OPC's Template Doctor and import capability-check paths. No company or run is created and filesystem paths are not accepted.", inputSchema: objectSchema({ bundle: { type: "object", description: "Inline Company Bundle JSON; pass content, never a local file path" } }, ["bundle"]), annotations: { title: "Validate company bundle", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

const SENSITIVE_KEYS = new Set(["apikey", "token", "sessiontoken", "accesstoken", "refreshtoken", "secret", "password", "authorization", "cookie", "headers", "env", "credentials", "privatekey"]);
const SECRET_VALUE = /(?:authorization\s*:\s*bearer\s+\S+|bearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S{8,})/i;
const ABSOLUTE_LOCAL_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/(?:home|Users|root|etc)\/)/;
const LOCAL_PATH_KEYS = new Set(["configdir", "workingdirectory", "workroot", "cwd", "folder"]);
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new McpToolError("invalid_arguments", "Tool arguments must be an object");
  return value as JsonRecord;
}
function optionalRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function requiredString(record: JsonRecord, key: string, maximum = 128): string {
  const value = typeof record[key] === "string" ? record[key].trim() : "";
  if (!value || value.length > maximum || CONTROL_CHARACTERS.test(value)) throw new McpToolError("invalid_arguments", key + " is required and must be at most " + maximum + " characters");
  return value;
}
function optionalString(record: JsonRecord, key: string, maximum: number): string | undefined {
  if (record[key] === undefined) return undefined;
  return requiredString(record, key, maximum);
}
function requiredInlineObject(record: JsonRecord, key: string, maximumBytes = 768 * 1024): JsonRecord {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpToolError("invalid_arguments", key + " must be an inline JSON object");
  }
  let byteLength: number;
  try { byteLength = Buffer.byteLength(JSON.stringify(value), "utf-8"); }
  catch { throw new McpToolError("invalid_arguments", key + " must be serializable JSON"); }
  if (byteLength > maximumBytes) {
    throw new McpToolError("input_too_large", key + " exceeds the MCP inline payload limit", { byteLength, maximumBytes });
  }
  return value as JsonRecord;
}
function optionalStringArray(record: JsonRecord, key: string, maximumItems: number, maximumLength: number): string[] | undefined {
  if (record[key] === undefined) return undefined;
  if (!Array.isArray(record[key]) || record[key].length > maximumItems) {
    throw new McpToolError("invalid_arguments", key + " must be an array with at most " + maximumItems + " items");
  }
  return record[key].map((value, index) => {
    if (typeof value !== "string") throw new McpToolError("invalid_arguments", key + "[" + index + "] must be a string");
    const normalized = value.trim();
    if (!normalized || normalized.length > maximumLength || CONTROL_CHARACTERS.test(normalized)) {
      throw new McpToolError("invalid_arguments", key + "[" + index + "] must be non-empty and at most " + maximumLength + " characters");
    }
    return normalized;
  });
}
function safeId(record: JsonRecord, key: string): string {
  const value = requiredString(record, key);
  if (!SAFE_ID.test(value)) throw new McpToolError("unsafe_identifier", key + " contains unsupported characters");
  return value;
}
function requiredSha256(record: JsonRecord, key: string): string {
  const value = requiredString(record, key, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new McpToolError("invalid_arguments", key + " must be a 64-character SHA-256 hex digest");
  return value;
}
function safeArtifactId(record: JsonRecord): string {
  const value = requiredString(record, "artifactId", 512);
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || /(^|\/)\.\.(\/|$)/.test(value) || /%2e|%2f|%5c/i.test(value) || !/^[A-Za-z0-9_.:/-]+$/.test(value)) {
    throw new McpToolError("unsafe_identifier", "artifactId is not a recorded safe artifact identifier");
  }
  return value;
}
function enumValue(record: JsonRecord, key: string, values: readonly string[], fallback: string): string {
  const raw = record[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !values.includes(raw)) throw new McpToolError("invalid_arguments", key + " must be one of: " + values.join(", "));
  return raw;
}
function optionalEnumValue(record: JsonRecord, key: string, values: readonly string[]): string | undefined {
  if (record[key] === undefined) return undefined;
  return enumValue(record, key, values, values[0]);
}
function requireConfirmation(record: JsonRecord): void {
  if (record.confirm !== true) throw new McpToolError("confirmation_required", "This write requires confirm=true");
}
function validateIdempotencyKey(record: JsonRecord, createId: () => string): string {
  const value = record.idempotencyKey === undefined ? createId() : requiredString(record, "idempotencyKey", 128);
  if (!SAFE_IDEMPOTENCY_KEY.test(value)) throw new McpToolError("invalid_idempotency_key", "idempotencyKey contains unsupported characters");
  return value;
}
function requireIdempotencyKey(record: JsonRecord): string {
  if (record.idempotencyKey === undefined) throw new McpToolError("idempotency_key_required", "An explicit idempotencyKey is required");
  return validateIdempotencyKey(record, () => "");
}
function valuesFrom(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = optionalRecord(raw);
  return Array.isArray(record[key]) ? record[key] : [];
}
function hashTask(task: string): string {
  return "sha256:" + createHash("sha256").update(task, "utf-8").digest("hex");
}
function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf-8").digest("hex");
}
function generatedReadKey(prefix: string, value: unknown): string {
  return "mcp-" + prefix + "-" + hashPayload(value).slice(0, 48);
}
function normalizeError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  const rawMessage = error instanceof Error ? error.message : "OPC request failed";
  const sanitizedMessage = sanitizeMcpValue(rawMessage);
  const message = typeof sanitizedMessage === "string" ? sanitizedMessage : "OPC request failed";
  if (error instanceof CliError) return new McpToolError(error.code, message, sanitizeMcpValue(error.details) as JsonRecord, error.retryable);
  return new McpToolError("upstream_error", message);
}

export function sanitizeMcpValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return SECRET_VALUE.test(value) || ABSOLUTE_LOCAL_PATH.test(value) ? "[REDACTED]" : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeMcpValue(entry, seen));
  const output: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const pathIsSensitive = LOCAL_PATH_KEYS.has(normalizedKey)
      || (normalizedKey === "path" && typeof entry === "string" && (ABSOLUTE_LOCAL_PATH.test(entry) || entry.includes("..")));
    const sensitiveKey = SENSITIVE_KEYS.has(normalizedKey)
      || ["token", "secret", "password", "credentials", "privatekey"].some((candidate) => normalizedKey.endsWith(candidate));
    output[key] = sensitiveKey || pathIsSensitive ? "[REDACTED]" : sanitizeMcpValue(entry, seen);
  }
  return output;
}
function limitResult(value: unknown, maximumBytes: number): unknown {
  const sanitized = sanitizeMcpValue(value);
  const json = JSON.stringify(sanitized);
  const byteLength = Buffer.byteLength(json, "utf-8");
  if (byteLength <= maximumBytes) return sanitized;
  return { truncated: true, byteLength, maximumBytes, message: "Result exceeded the MCP response limit. Narrow the query or use OPC Studio." };
}
async function writeAudit(audit: McpAuditWriter | undefined, record: McpAuditRecord): Promise<void> {
  if (!audit) throw new McpToolError("audit_unavailable", "Write audit is not configured");
  try { await audit(record); } catch { throw new McpToolError("audit_unavailable", "Write audit could not be persisted"); }
}

export function createMcpToolRuntime(options: {
  gateway: OpcMcpGateway;
  authenticated: boolean;
  audit?: McpAuditWriter;
  createId?: () => string;
  maximumResultBytes?: number;
}): McpToolRuntime {
  const createId = options.createId ?? randomUUID;
  const maximumResultBytes = options.maximumResultBytes ?? 64 * 1024;
  const idempotentWrites = new Map<string, { requestHash: string; result: Promise<unknown> }>();
  const read = async (apiPath: string): Promise<unknown> => limitResult(await options.gateway.get(apiPath), maximumResultBytes);
  const allowedArguments: Record<string, Set<string>> = {
    list_companies: new Set(),
    inspect_company: new Set(["companyId"]),
    inspect_capabilities: new Set(["companyId", "runType", "teamMode"]),
    plan_run: new Set(["companyId", "task", "runType", "teamMode"]),
    start_run: new Set(["companyId", "task", "runType", "teamMode", "confirm", "idempotencyKey"]),
    get_run_status: new Set(["runId"]),
    cancel_run: new Set(["runId", "reason", "confirm", "idempotencyKey"]),
    get_run_trace: new Set(["runId"]),
    list_artifacts: new Set(["runId"]),
    get_artifact: new Set(["runId", "artifactId"]),
    get_evidence: new Set(["runId", "verify"]),
    review_run: new Set(["runId", "decision", "confirm", "idempotencyKey"]),
    list_company_plans: new Set(["companyId", "status", "limit"]),
    get_company_plan: new Set(["companyId", "proposalId"]),
    apply_company_plan: new Set(["companyId", "proposalId", "beforeHash", "actionsHash", "expiresAt", "confirmationReceipt", "confirm", "idempotencyKey"]),
    propose_memory: new Set(["text", "title", "summary", "objectType", "scope", "scopeId", "sourceRunId", "rootCauseConfirmed", "evidenceIds", "counterexamples", "confirm", "idempotencyKey"]),
    validate_company_bundle: new Set(["bundle"]),
  };
  const authenticatedWrite = async (
    tool: "start_run" | "cancel_run" | "propose_memory" | "review_run" | "apply_company_plan",
    record: JsonRecord,
    target: { companyId?: string; runId?: string; taskHash?: string; contentHash?: string },
    invoke: (key: string) => Promise<unknown>,
    explicitIdempotencyKey = false,
    requestIdentity: unknown = target,
  ): Promise<unknown> => {
    requireConfirmation(record);
    if (!options.authenticated) throw new McpToolError("mcp_auth_required", "An authenticated OPC session is required for write tools");
    const key = explicitIdempotencyKey ? requireIdempotencyKey(record) : validateIdempotencyKey(record, createId);
    const cacheKey = tool + ":" + key;
    const requestHash = hashPayload(requestIdentity);
    const existing = idempotentWrites.get(cacheKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        await writeAudit(options.audit, { tool, idempotencyKey: key, outcome: "failed", ...target, errorCode: "idempotency_conflict" });
        throw new McpToolError("idempotency_conflict", "idempotencyKey was already used for a different request");
      }
      return existing.result;
    }
    const operation = (async () => {
      await writeAudit(options.audit, { tool, idempotencyKey: key, outcome: "intent", ...target });
      try {
        const result = await invoke(key);
        await writeAudit(options.audit, { tool, idempotencyKey: key, outcome: "accepted", ...target });
        return limitResult(result, maximumResultBytes);
      } catch (error) {
        const normalized = normalizeError(error);
        try { await writeAudit(options.audit, { tool, idempotencyKey: key, outcome: "failed", ...target, errorCode: normalized.code }); }
        catch { throw new McpToolError("audit_unavailable", "Write failure could not be persisted to the audit log"); }
        throw normalized;
      }
    })();
    idempotentWrites.set(cacheKey, { requestHash, result: operation });
    return operation;
  };

  return {
    async callTool(name, argumentsValue) {
      if (!MCP_TOOL_DEFINITIONS.some((tool) => tool.name === name)) throw new McpToolError("unknown_tool", "Unknown OPC MCP tool: " + name);
      const args = asRecord(argumentsValue ?? {});
      try {
        const unexpected = Object.keys(args).filter((key) => !allowedArguments[name].has(key));
        if (unexpected.length > 0) throw new McpToolError("invalid_arguments", "Unexpected tool arguments", { fields: unexpected });
        switch (name) {
          case "list_companies": return read("/api/companies");
          case "inspect_company": {
            const companyId = safeId(args, "companyId");
            const encoded = encodeURIComponent(companyId);
            const [companiesRaw, agentsRaw, capabilities] = await Promise.all([
              options.gateway.get("/api/companies"),
              options.gateway.get("/api/agents"),
              options.gateway.get("/api/companies/" + encoded + "/capability-report"),
            ]);
            const company = valuesFrom(companiesRaw, "companies").find((value) => optionalRecord(value).id === companyId);
            if (!company) throw new McpToolError("company_not_found", "Company not found");
            const agents = valuesFrom(agentsRaw, "agents").filter((value) => optionalRecord(value).companyId === companyId);
            return limitResult({ company, agents, capabilities }, maximumResultBytes);
          }
          case "inspect_capabilities": {
            const companyId = safeId(args, "companyId");
            const runType = enumValue(args, "runType", ["quick", "team"], "team");
            const teamMode = enumValue(args, "teamMode", ["economy", "balanced", "maxQuality"], "balanced");
            return read("/api/companies/" + encodeURIComponent(companyId) + "/capability-report?runType=" + encodeURIComponent(runType) + "&teamMode=" + encodeURIComponent(teamMode));
          }
          case "plan_run": {
            const companyId = safeId(args, "companyId");
            const task = requiredString(args, "task", 4000);
            if (SECRET_VALUE.test(task)) throw new McpToolError("sensitive_input_rejected", "Task appears to contain credentials or secret material");
            const runType = enumValue(args, "runType", ["quick", "team"], "team");
            const teamMode = enumValue(args, "teamMode", ["economy", "balanced", "maxQuality"], "balanced");
            const encoded = encodeURIComponent(companyId);
            const request = { companyId, task, runType, teamMode };
            const [capabilities, rawPlan] = await Promise.all([
              options.gateway.get("/api/companies/" + encoded + "/capability-report?runType=" + encodeURIComponent(runType) + "&teamMode=" + encodeURIComponent(teamMode)),
              options.gateway.post("/api/companies/" + encoded + "/task-decompose", { message: task, history: [] }, generatedReadKey("plan", request)),
            ]);
            const plan = optionalRecord(rawPlan);
            return limitResult({
              preview: true,
              createsRun: false,
              companyId,
              requested: { runType, teamMode, taskHash: hashTask(task) },
              capabilities,
              plan: {
                summary: plan.summary,
                needsChoice: plan.needsChoice,
                questions: plan.questions,
                finalTask: plan.finalTask,
                decomposer: plan.decomposer,
              },
            }, maximumResultBytes);
          }
          case "start_run": {
            const companyId = safeId(args, "companyId");
            const task = requiredString(args, "task", 65536);
            if (SECRET_VALUE.test(task)) throw new McpToolError("sensitive_input_rejected", "Task appears to contain credentials or secret material");
            const runType = enumValue(args, "runType", ["quick", "team"], "team");
            const teamMode = enumValue(args, "teamMode", ["economy", "balanced", "maxQuality"], "balanced");
            const body = { companyId, message: task, runType, teamMode };
            return authenticatedWrite("start_run", args, { companyId, taskHash: hashTask(task) }, (key) => options.gateway.post("/api/chat/task", body, key), false, body);
          }
          case "get_run_status": {
            const runId = safeId(args, "runId");
            return read("/api/runs/" + encodeURIComponent(runId));
          }
          case "cancel_run": {
            const runId = safeId(args, "runId");
            const reason = args.reason === undefined ? undefined : requiredString(args, "reason", 1000);
            const body = reason ? { reason } : {};
            return authenticatedWrite("cancel_run", args, { runId }, (key) => options.gateway.post("/api/runs/" + encodeURIComponent(runId) + "/stop", body, key), false, { runId, ...body });
          }
          case "get_run_trace": {
            const runId = safeId(args, "runId");
            const raw = await options.gateway.get("/api/runs/" + encodeURIComponent(runId) + "/events");
            const record = optionalRecord(raw);
            const events = valuesFrom(raw, "events").map((value) => {
              const event = optionalRecord(value);
              return event.runId ? event : { ...event, runId: record.runId ?? runId };
            });
            return limitResult({ runId, events: parseRunEvents(events) }, maximumResultBytes);
          }
          case "list_artifacts": {
            const runId = safeId(args, "runId");
            const raw = await options.gateway.get("/api/runs/" + encodeURIComponent(runId) + "/artifacts");
            return limitResult({ runId, artifacts: valuesFrom(raw, "artifacts").map((value) => parseArtifactRef(value, runId)) }, maximumResultBytes);
          }
          case "get_artifact": {
            const runId = safeId(args, "runId");
            const artifactId = safeArtifactId(args);
            return read("/api/runs/" + encodeURIComponent(runId) + "/artifacts/preview?artifactId=" + encodeURIComponent(artifactId));
          }
          case "get_evidence": {
            const runId = safeId(args, "runId");
            if (args.verify !== undefined && typeof args.verify !== "boolean") throw new McpToolError("invalid_arguments", "verify must be a boolean");
            return read("/api/runs/" + encodeURIComponent(runId) + "/evidence" + (args.verify === true ? "?verify=1" : ""));
          }
          case "review_run": {
            const runId = safeId(args, "runId");
            const decision = enumValue(args, "decision", ["approve", "reject"], "reject");
            const body = { decidedBy: "mcp" };
            return authenticatedWrite("review_run", args, { runId, contentHash: "sha256:" + hashPayload({ decision }) }, (key) => (
              options.gateway.post("/api/governance/runs/" + encodeURIComponent(runId) + "/" + decision, body, key)
            ), true, { runId, decision });
          }
          case "list_company_plans": {
            const companyId = safeId(args, "companyId");
            const status = enumValue(args, "status", ["all", "pending", "applying", "applied", "failed", "rolled_back"], "pending");
            const limit = args.limit === undefined ? 20 : Number(args.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new McpToolError("invalid_arguments", "limit must be an integer from 1 to 100");
            return read("/api/companies/" + encodeURIComponent(companyId) + "/architect-proposals?status=" + encodeURIComponent(status) + "&limit=" + limit);
          }
          case "get_company_plan": {
            const companyId = safeId(args, "companyId");
            const proposalId = safeId(args, "proposalId");
            return read("/api/companies/" + encodeURIComponent(companyId) + "/architect-proposals/" + encodeURIComponent(proposalId));
          }
          case "apply_company_plan": {
            const companyId = safeId(args, "companyId");
            const proposalId = safeId(args, "proposalId");
            const beforeHash = requiredSha256(args, "beforeHash");
            const actionsHash = requiredSha256(args, "actionsHash");
            const expiresAt = requiredString(args, "expiresAt", 64);
            const expiryMs = Date.parse(expiresAt);
            if (!Number.isFinite(expiryMs)) throw new McpToolError("invalid_arguments", "expiresAt must be an ISO timestamp");
            if (expiryMs <= Date.now()) throw new McpToolError("proposal_expired", "Company plan proposal has expired");
            const confirmationReceipt = optionalString(args, "confirmationReceipt", 256);
            const current = optionalRecord(await options.gateway.get("/api/companies/" + encodeURIComponent(companyId) + "/architect-proposals/" + encodeURIComponent(proposalId)));
            if (current.companyId !== companyId || current.proposalId !== proposalId) throw new McpToolError("proposal_binding_mismatch", "Company plan identity no longer matches");
            if (current.status !== "pending") throw new McpToolError("proposal_not_pending", "Company plan is no longer pending", { status: current.status });
            if (current.beforeHash !== beforeHash || current.actionsHash !== actionsHash || current.expiresAt !== expiresAt) {
              throw new McpToolError("proposal_binding_mismatch", "Company plan bindings changed; fetch and review the current proposal again");
            }
            const body = { proposalId, ...(confirmationReceipt ? { confirmationToken: confirmationReceipt } : {}) };
            return authenticatedWrite("apply_company_plan", args, { companyId, contentHash: "sha256:" + actionsHash }, async (key) => {
              try {
                return await options.gateway.post("/api/companies/" + encodeURIComponent(companyId) + "/architect-apply", body, key);
              } catch (error) {
                if (error instanceof CliError && Number(error.details.status) === 428) {
                  const responseBody = optionalRecord(error.details.body);
                  const receipt = typeof responseBody.confirmationToken === "string" ? responseBody.confirmationToken : "";
                  if (receipt) {
                    throw new McpToolError("confirmation_required", "This company plan contains high-risk changes. Review the risk list, then call apply_company_plan again with confirmationReceipt and a new idempotencyKey.", {
                      confirmationReceipt: receipt,
                      receiptExpiresAt: responseBody.tokenExpiresAt,
                      highRisk: sanitizeMcpValue(responseBody.highRisk),
                      reason: responseBody.reason,
                    });
                  }
                }
                throw error;
              }
            }, true, { companyId, proposalId, beforeHash, actionsHash, expiresAt, confirmationReceipt: confirmationReceipt ?? null });
          }
          case "propose_memory": {
            const text = requiredString(args, "text", 65536);
            if (SECRET_VALUE.test(text)) throw new McpToolError("sensitive_input_rejected", "Memory appears to contain credentials or secret material");
            const objectType = optionalEnumValue(args, "objectType", ["user_preference", "fact", "success_experience", "failure_lesson", "resource_pointer"]);
            const scope = optionalEnumValue(args, "scope", ["user", "company", "project", "team", "agent"]);
            const scopeId = optionalString(args, "scopeId", 128);
            if (scopeId !== undefined && !SAFE_ID.test(scopeId)) throw new McpToolError("unsafe_identifier", "scopeId contains unsupported characters");
            const sourceRunId = args.sourceRunId === undefined ? undefined : safeId(args, "sourceRunId");
            if (args.rootCauseConfirmed !== undefined && typeof args.rootCauseConfirmed !== "boolean") {
              throw new McpToolError("invalid_arguments", "rootCauseConfirmed must be a boolean");
            }
            const body = {
              text,
              title: optionalString(args, "title", 200),
              summary: optionalString(args, "summary", 1000),
              objectType,
              scope,
              scopeId,
              sourceRunId,
              rootCauseConfirmed: args.rootCauseConfirmed === true,
              evidenceIds: optionalStringArray(args, "evidenceIds", 20, 128),
              counterexamples: optionalStringArray(args, "counterexamples", 10, 1000),
              autoApprove: false,
            };
            return authenticatedWrite("propose_memory", args, { runId: sourceRunId, contentHash: "sha256:" + hashPayload({ text, objectType, scope, scopeId }) }, async (key) => {
              const result = await options.gateway.post("/api/memory/remember", body, key);
              const proposal = optionalRecord(result);
              if (proposal.status === "approved" || typeof proposal.memoryId === "string") {
                throw new McpToolError("memory_contract_violation", "The memory endpoint returned an approved memory for a proposal-only request");
              }
              return result;
            }, true, body);
          }
          case "validate_company_bundle": {
            const bundle = requiredInlineObject(args, "bundle");
            const parsed = parseCompanyBundle(bundle);
            const template = parsed.ok && parsed.bundle ? bundleToTemplateShape(parsed.bundle) : bundle;
            const doctorRaw = optionalRecord(await options.gateway.post(
              "/api/community/templates/doctor",
              template,
              generatedReadKey("bundle-doctor", bundle),
            ));
            const requirements = parsed.ok
              ? await options.gateway.post(
                "/api/companies/import-check",
                template,
                generatedReadKey("bundle-capabilities", bundle),
              )
              : undefined;
            return limitResult({
              bundleSchema: { ok: parsed.ok, errors: parsed.errors ?? [] },
              doctor: doctorRaw.doctor ?? doctorRaw,
              dangerFlags: doctorRaw.dangerFlags ?? [],
              ...(requirements === undefined ? {} : { requirements }),
              validationOnly: true,
              createsCompany: false,
            }, maximumResultBytes);
          }
          default: throw new McpToolError("unknown_tool", "Unknown OPC MCP tool: " + name);
        }
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}
