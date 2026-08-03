import { describe, expect, it, vi } from "vitest";
import {
  MCP_TOOL_DEFINITIONS,
  McpToolError,
  createMcpToolRuntime,
  sanitizeMcpValue,
  type OpcMcpGateway,
} from "./tools.js";
import { CliError } from "../headless/errors.js";

function gateway(): OpcMcpGateway {
  return {
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({ runId: "run-12345678" })),
  };
}

describe("OPC MCP tool boundary", () => {
  it("exposes only high-level OPC tools", () => {
    const names = MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual([
      "list_companies", "inspect_company", "inspect_capabilities",
      "plan_run", "start_run", "get_run_status", "cancel_run", "get_run_trace",
      "list_artifacts", "get_artifact", "get_evidence", "review_run",
      "list_company_plans", "get_company_plan", "apply_company_plan", "propose_memory",
      "validate_company_bundle",
    ]);
    expect(names.join(" ")).not.toMatch(/shell|git|file_write|read_file|credential/i);
  });

  it("contains every Phase 4 formal tool and declares the new schemas and safety annotations", () => {
    const formalTools = [
      "list_companies", "inspect_company", "inspect_capabilities", "plan_run",
      "start_run", "get_run_status", "get_run_trace", "list_artifacts",
      "get_artifact", "propose_memory", "validate_company_bundle",
    ];
    const byName = new Map(MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(formalTools.filter((name) => !byName.has(name))).toEqual([]);

    const plan = byName.get("plan_run")!;
    expect(plan.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["companyId", "task"],
      properties: { task: { type: "string", maxLength: 4000 } },
    });
    expect(plan.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const memory = byName.get("propose_memory")!;
    expect(memory.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["text", "confirm", "idempotencyKey"],
      properties: {
        confirm: { const: true },
        idempotencyKey: { type: "string", maxLength: 128 },
        evidenceIds: { type: "array", maxItems: 20 },
      },
    });
    expect(memory.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });

    const bundle = byName.get("validate_company_bundle")!;
    expect(bundle.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["bundle"],
      properties: { bundle: { type: "object" } },
    });
    expect(bundle.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("allows read tools without write credentials", async () => {
    const api = gateway();
    vi.mocked(api.get).mockResolvedValue([{ id: "company-1", name: "Alpha" }]);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    await expect(runtime.callTool("list_companies", {})).resolves.toEqual([
      { id: "company-1", name: "Alpha" },
    ]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("fails closed when a write is unconfirmed or unauthenticated", async () => {
    const api = gateway();
    const unauthenticated = createMcpToolRuntime({ gateway: api, authenticated: false });
    await expect(unauthenticated.callTool("start_run", {
      companyId: "company-1", task: "Build a report", confirm: true,
    })).rejects.toMatchObject({ code: "mcp_auth_required" });

    const authenticated = createMcpToolRuntime({ gateway: api, authenticated: true });
    await expect(authenticated.callTool("cancel_run", {
      runId: "run-12345678", confirm: false,
    })).rejects.toMatchObject({ code: "confirmation_required" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("uses an idempotency key and writes an audit record for execution", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await runtime.callTool("start_run", {
      companyId: "company-1",
      task: "Build a report",
      confirm: true,
      idempotencyKey: "idem-1",
    });
    expect(api.post).toHaveBeenCalledWith("/api/chat/task", expect.objectContaining({
      companyId: "company-1", message: "Build a report",
    }), "idem-1");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "start_run", idempotencyKey: "idem-1", outcome: "accepted",
    }));
  });

  it("previews capabilities and a task plan without creating a run", async () => {
    const api = gateway();
    vi.mocked(api.get).mockResolvedValue({ executable: true, availableWorkers: ["lead-1", "dev-1"] });
    vi.mocked(api.post).mockResolvedValue({
      summary: "Use the coding team",
      needsChoice: false,
      questions: [],
      finalTask: "Implement and independently verify the parser",
      decomposer: { agentId: "lead-1", role: "lead" },
      runId: "must-not-leak",
    });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    const result = await runtime.callTool("plan_run", {
      companyId: "company-1",
      task: "Implement a parser",
      runType: "team",
      teamMode: "balanced",
    }) as Record<string, any>;

    expect(api.get).toHaveBeenCalledWith("/api/companies/company-1/capability-report?runType=team&teamMode=balanced");
    expect(api.post).toHaveBeenCalledWith(
      "/api/companies/company-1/task-decompose",
      { message: "Implement a parser", history: [] },
      expect.stringMatching(/^mcp-plan-[a-f0-9]{48}$/),
    );
    expect(result).toMatchObject({ preview: true, createsRun: false, companyId: "company-1" });
    expect(result.plan).not.toHaveProperty("runId");
    expect(vi.mocked(api.post).mock.calls.some(([path]) => path === "/api/chat/task")).toBe(false);
  });

  it("rejects unsafe plan input before capability lookup or model planning", async () => {
    const api = gateway();
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    await expect(runtime.callTool("plan_run", {
      companyId: "company-1",
      task: "Use token=abcdefghijklmnop to inspect the system",
    })).rejects.toMatchObject({ code: "sensitive_input_rejected" });
    await expect(runtime.callTool("plan_run", {
      companyId: "company-1",
      task: "Plan this",
      workingDirectory: "C:\\private",
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("caps a plan preview response instead of returning an unbounded model result", async () => {
    const api = gateway();
    vi.mocked(api.get).mockResolvedValue({ executable: true, details: "x".repeat(1000) });
    vi.mocked(api.post).mockResolvedValue({ summary: "y".repeat(1000), needsChoice: false, finalTask: "Task" });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false, maximumResultBytes: 200 });
    await expect(runtime.callTool("plan_run", { companyId: "company-1", task: "Plan this" }))
      .resolves.toMatchObject({ truncated: true, maximumBytes: 200 });
  });

  it("creates only a governed memory proposal through the confirmed authenticated boundary", async () => {
    const api = gateway();
    vi.mocked(api.post).mockResolvedValue({ proposalId: "memprop-1", status: "proposed" });
    const audit = vi.fn(async () => undefined);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await expect(runtime.callTool("propose_memory", {
      text: "Prefer concise release summaries with evidence first",
      objectType: "user_preference",
      scope: "user",
      confirm: true,
      idempotencyKey: "memory-1",
    })).resolves.toEqual({ proposalId: "memprop-1", status: "proposed" });

    expect(api.post).toHaveBeenCalledWith("/api/memory/remember", expect.objectContaining({
      text: "Prefer concise release summaries with evidence first",
      objectType: "user_preference",
      scope: "user",
      autoApprove: false,
    }), "memory-1");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "propose_memory",
      idempotencyKey: "memory-1",
      outcome: "accepted",
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }));
  });

  it("requires confirmation, a session, and an explicit idempotency key for memory proposals", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const authenticated = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await expect(authenticated.callTool("propose_memory", {
      text: "Remember this", confirm: false, idempotencyKey: "memory-1",
    })).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(authenticated.callTool("propose_memory", {
      text: "Remember this", confirm: true,
    })).rejects.toMatchObject({ code: "idempotency_key_required" });

    const unauthenticated = createMcpToolRuntime({ gateway: api, authenticated: false, audit });
    await expect(unauthenticated.callTool("propose_memory", {
      text: "Remember this", confirm: true, idempotencyKey: "memory-1",
    })).rejects.toMatchObject({ code: "mcp_auth_required" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not create a memory proposal when durable audit is unavailable", async () => {
    const api = gateway();
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true });
    await expect(runtime.callTool("propose_memory", {
      text: "Audited memory only", confirm: true, idempotencyKey: "memory-needs-audit",
    })).rejects.toMatchObject({ code: "audit_unavailable" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("bounds memory text and evidence collections before the governed proposal API", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await expect(runtime.callTool("propose_memory", {
      text: "x".repeat(65537), confirm: true, idempotencyKey: "memory-too-large",
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(runtime.callTool("propose_memory", {
      text: "Bounded evidence", evidenceIds: Array.from({ length: 21 }, (_, i) => "evidence-" + i),
      confirm: true, idempotencyKey: "memory-too-many-evidence",
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("replays the same idempotency key, rejects key reuse with different input, and rejects direct approval", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    vi.mocked(api.post).mockResolvedValue({ proposalId: "memprop-1", status: "proposed" });
    await runtime.callTool("propose_memory", {
      text: "A reusable fact", confirm: true, idempotencyKey: "same-memory-key",
    });
    await runtime.callTool("propose_memory", {
      text: "A reusable fact", confirm: true, idempotencyKey: "same-memory-key",
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenLastCalledWith("/api/memory/remember", expect.any(Object), "same-memory-key");
    await expect(runtime.callTool("propose_memory", {
      text: "A different fact", confirm: true, idempotencyKey: "same-memory-key",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(api.post).toHaveBeenCalledTimes(1);

    vi.mocked(api.post).mockResolvedValueOnce({ proposalId: "memprop-2", status: "approved", memoryId: "memory-2" });
    await expect(runtime.callTool("propose_memory", {
      text: "Never bypass review", confirm: true, idempotencyKey: "memory-contract",
    })).rejects.toMatchObject({ code: "memory_contract_violation" });
  });

  it("validates an inline company bundle without returning install authority or creating a company", async () => {
    const api = gateway();
    vi.mocked(api.post).mockImplementation(async (apiPath) => apiPath.endsWith("/doctor")
      ? { doctor: { status: "pass", install_allowed: true }, dangerFlags: [] }
      : { ok: true, ready: { engines: [], providers: [] }, missing: [] });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    const bundle = {
      schema_version: "0.3.0",
      bundle_type: "company",
      bundle_id: "bundle-1",
      title: "Validated company",
      description: "",
      agents: [],
      privacy: { redacted: true, redacted_fields: [], required_secrets: [] },
      compatibility: { migration_notes: [] },
    };
    const result = await runtime.callTool("validate_company_bundle", { bundle }) as Record<string, unknown>;

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/api/community/templates/doctor",
      expect.objectContaining({ title: "Validated company", agents: [] }),
      expect.stringMatching(/^mcp-bundle-doctor-[a-f0-9]{48}$/),
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/api/companies/import-check",
      expect.objectContaining({ title: "Validated company", agents: [] }),
      expect.stringMatching(/^mcp-bundle-capabilities-[a-f0-9]{48}$/),
    );
    expect(result).toMatchObject({
      validationOnly: true,
      createsCompany: false,
      bundleSchema: { ok: true, errors: [] },
      doctor: { status: "pass", install_allowed: true },
      requirements: { ok: true },
    });
    expect(result).not.toHaveProperty("installConfirmationToken");
    expect(result).not.toHaveProperty("installConfirmationExpiresAt");
  });

  it("rejects bundle paths, non-object payloads, oversized input, and extra arguments", async () => {
    const api = gateway();
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    await expect(runtime.callTool("validate_company_bundle", { bundle: "C:\\templates\\company.json" }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(runtime.callTool("validate_company_bundle", { bundle: { blob: "x".repeat(800 * 1024) } }))
      .rejects.toMatchObject({ code: "input_too_large" });
    await expect(runtime.callTool("validate_company_bundle", { bundle: {}, filePath: "C:\\templates\\company.json" }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("reports an invalid bundle schema and skips capability checking", async () => {
    const api = gateway();
    vi.mocked(api.post).mockResolvedValue({ doctor: { status: "error", install_allowed: false }, dangerFlags: [] });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    const result = await runtime.callTool("validate_company_bundle", {
      bundle: { schema_version: "unsupported", bundle_type: "company" },
    }) as Record<string, any>;
    expect(result.bundleSchema.ok).toBe(false);
    expect(result.bundleSchema.errors.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("requirements");
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(
      "/api/community/templates/doctor",
      expect.any(Object),
      expect.stringMatching(/^mcp-bundle-doctor-[a-f0-9]{48}$/),
    );
  });

  it("caps a large bundle validation report", async () => {
    const api = gateway();
    vi.mocked(api.post).mockResolvedValue({ preview: true, doctor: { checks: [{ message: "x".repeat(1000) }] } });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false, maximumResultBytes: 200 });
    await expect(runtime.callTool("validate_company_bundle", { bundle: { schema_version: "0.1" } }))
      .resolves.toMatchObject({ truncated: true, maximumBytes: 200 });
  });

  it("sends cancellation through the authenticated, idempotent write boundary", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await runtime.callTool("cancel_run", {
      runId: "run-12345678", reason: "User requested stop", confirm: true,
      idempotencyKey: "cancel-1",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/runs/run-12345678/stop",
      { reason: "User requested stop" },
      "cancel-1",
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "cancel_run", runId: "run-12345678", outcome: "accepted",
    }));
  });

  it("reviews a governed run through the confirmed, authenticated boundary", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await runtime.callTool("review_run", {
      runId: "run-12345678", decision: "approve", confirm: true, idempotencyKey: "review-1",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/governance/runs/run-12345678/approve",
      { decidedBy: "mcp" },
      "review-1",
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tool: "review_run", outcome: "accepted" }));
  });

  it("reads bound company plans without a write session", async () => {
    const api = gateway();
    vi.mocked(api.get).mockResolvedValue({ companyId: "company-1", proposals: [{ proposalId: "plan-1" }] });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false });
    await runtime.callTool("list_company_plans", { companyId: "company-1", status: "pending", limit: 5 });
    expect(api.get).toHaveBeenCalledWith("/api/companies/company-1/architect-proposals?status=pending&limit=5");
  });

  it("applies only the exact persisted company-plan bindings", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const beforeHash = "a".repeat(64);
    const actionsHash = "b".repeat(64);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(api.get).mockResolvedValue({
      companyId: "company-1", proposalId: "plan-1", status: "pending", beforeHash, actionsHash, expiresAt,
    });
    vi.mocked(api.post).mockResolvedValue({ proposalId: "plan-1", txId: "tx-1" });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await runtime.callTool("apply_company_plan", {
      companyId: "company-1", proposalId: "plan-1", beforeHash, actionsHash, expiresAt,
      confirm: true, idempotencyKey: "apply-plan-1",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/companies/company-1/architect-apply",
      { proposalId: "plan-1" },
      "apply-plan-1",
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tool: "apply_company_plan", outcome: "accepted" }));
  });

  it("turns the server high-risk token into an explicit one-time confirmation receipt", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const beforeHash = "a".repeat(64);
    const actionsHash = "b".repeat(64);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(api.get).mockResolvedValue({
      companyId: "company-1", proposalId: "plan-1", status: "pending", beforeHash, actionsHash, expiresAt,
    });
    vi.mocked(api.post).mockRejectedValue(new CliError("confirmation_required", "confirmation required", {
      status: 428,
      body: { confirmationToken: "receipt-123", tokenExpiresAt: expiresAt, highRisk: [{ kind: "remove_agent" }] },
    }));
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await expect(runtime.callTool("apply_company_plan", {
      companyId: "company-1", proposalId: "plan-1", beforeHash, actionsHash, expiresAt,
      confirm: true, idempotencyKey: "apply-plan-risk-1",
    })).rejects.toMatchObject({
      code: "confirmation_required",
      details: { confirmationReceipt: "receipt-123", highRisk: [{ kind: "remove_agent" }] },
    });
  });

  it("rejects stale or tampered company-plan bindings before apply", async () => {
    const api = gateway();
    const audit = vi.fn(async () => undefined);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(api.get).mockResolvedValue({
      companyId: "company-1", proposalId: "plan-1", status: "pending",
      beforeHash: "a".repeat(64), actionsHash: "b".repeat(64), expiresAt,
    });
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true, audit });
    await expect(runtime.callTool("apply_company_plan", {
      companyId: "company-1", proposalId: "plan-1", beforeHash: "c".repeat(64),
      actionsHash: "b".repeat(64), expiresAt, confirm: true, idempotencyKey: "apply-plan-stale",
    })).rejects.toMatchObject({ code: "proposal_binding_mismatch" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not execute a write when durable audit is unavailable", async () => {
    const api = gateway();
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true });
    await expect(runtime.callTool("start_run", {
      companyId: "company-1", task: "Build a report", confirm: true,
    })).rejects.toMatchObject({ code: "audit_unavailable" });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("rejects traversal-like identifiers and secrets before any API call", async () => {
    const api = gateway();
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: true });
    await expect(runtime.callTool("get_run_status", { runId: "../../secrets" }))
      .rejects.toBeInstanceOf(McpToolError);
    await expect(runtime.callTool("start_run", {
      companyId: "company-1",
      task: "use apiKey=sk-abcdefghijklmnopqrstuvwxyz123456",
      confirm: true,
    })).rejects.toMatchObject({ code: "sensitive_input_rejected" });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("recursively redacts sensitive response fields and token-shaped strings", () => {
    expect(sanitizeMcpValue({
      account: { apiKey: "secret", headers: { authorization: "Bearer abc" } },
      output: "Authorization: Bearer abcdefghijklmnop",
      safe: "visible",
    })).toEqual({
      account: { apiKey: "[REDACTED]", headers: "[REDACTED]" },
      output: "[REDACTED]",
      safe: "visible",
    });
  });

  it("redacts local absolute paths, rejects extra arguments, and caps large results", async () => {
    expect(sanitizeMcpValue({
      folder: "M:\\private\\workspace",
      source: { path: "C:\\Users\\User\\secret.txt" },
      relative: { path: "src/index.ts" },
    })).toEqual({
      folder: "[REDACTED]",
      source: { path: "[REDACTED]" },
      relative: { path: "src/index.ts" },
    });
    const api = gateway();
    vi.mocked(api.get).mockResolvedValue([{ id: "company-1", description: "x".repeat(1000) }]);
    const runtime = createMcpToolRuntime({ gateway: api, authenticated: false, maximumResultBytes: 100 });
    await expect(runtime.callTool("list_companies", { apiKey: "hidden" })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(runtime.callTool("list_companies", {})).resolves.toMatchObject({ truncated: true, maximumBytes: 100 });
  });
});
