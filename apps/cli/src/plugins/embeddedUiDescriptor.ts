export const EMBEDDED_UI_DESCRIPTOR_PATH = "plugins/opc-studio/ui/embedded-ui.json";

export const EMBEDDED_UI_DESCRIPTOR = {
  schemaVersion: 1,
  kind: "opc-embedded-ui",
  name: "opc-studio-run-review",
  version: "0.1.0",
  optional: true,
  featureFlag: "OPC_EMBEDDED_PLUGIN_UI",
  entrypoint: "#/ecosystem?run={runId}&company={companyId}",
  cards: [
    {
      id: "run-status",
      mode: "read-only",
      source: { http: "GET /api/runs/{runId}", mcpTools: ["get_run_status"] },
      canonicalState: "Run.status",
      refresh: { method: "GET", createsRun: false },
    },
    {
      id: "approval",
      mode: "explicit-confirmation",
      source: { http: "GET /api/governance/runs/{runId}", mcpTools: ["get_run_status"] },
      actions: [
        { id: "approve", http: "POST /api/governance/runs/{runId}/approve", mcpTool: "review_run", explicitConfirmation: true, createsRun: false },
        { id: "reject", http: "POST /api/governance/runs/{runId}/reject", mcpTool: "review_run", explicitConfirmation: true, createsRun: false },
      ],
      refresh: { method: "GET", createsRun: false },
      headlessFallback: "formal-opc-control-plane",
    },
    {
      id: "artifacts",
      mode: "read-only",
      source: {
        http: "GET /api/runs/{runId}/artifacts and server-limited preview by artifactId",
        mcpTools: ["list_artifacts", "get_artifact"],
      },
      refresh: { method: "GET", createsRun: false },
    },
    {
      id: "evidence",
      mode: "read-only",
      source: { http: "GET /api/runs/{runId}/evidence", mcpTools: ["get_evidence"] },
      refresh: { method: "GET", createsRun: false },
    },
    {
      id: "company-plan",
      mode: "explicit-confirmation",
      source: {
        kind: "server-persisted-bound-proposal",
        http: "GET /api/companies/{companyId}/architect-proposals/{proposalId}",
        requiredBindings: ["proposalId", "companyId", "beforeHash", "actionsHash", "expiresAt"],
        mcpTools: ["list_company_plans", "get_company_plan", "inspect_company", "inspect_capabilities"],
      },
      actions: [
        {
          id: "apply",
          http: "POST /api/companies/{companyId}/architect-apply",
          mcpTool: "apply_company_plan",
          explicitConfirmation: true,
          createsRun: false,
          serverRevalidatesBindings: true,
        },
      ],
      refresh: { method: "GET", createsRun: false },
      headlessFallback: "opc-company-design plus bound MCP proposal tools",
    },
  ],
  headless: {
    requiresEmbeddedUi: false,
    skills: ["opc-team-run", "opc-run-review", "opc-company-design"],
    mcpServer: "opc-studio",
    limitation: "High-risk Company Plan changes require a second apply call with the short-lived confirmation receipt returned by OPC Core.",
  },
  security: {
    transport: "existing OPC HTTP API or opc-mcp only",
    forbiddenSources: ["local-files", "credentials", "api-keys", "auth-files", "memory-store"],
    artifactAccess: "recorded artifactId through server-limited preview only",
    refreshPolicy: "GET-only; never call start_run or create a Run",
  },
} as const;

const REQUIRED_CARD_IDS = ["run-status", "approval", "artifacts", "evidence", "company-plan"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function validateEmbeddedUiDescriptor(value: unknown): string[] {
  const errors: string[] = [];
  const root = record(value);
  if (!root) return ["embedded UI descriptor must be an object"];
  if (root.schemaVersion !== 1) errors.push("embedded UI schema version mismatch");
  if (root.kind !== "opc-embedded-ui" || root.optional !== true) errors.push("embedded UI identity mismatch");
  const cards = Array.isArray(root.cards) ? root.cards.map(record) : [];
  if (cards.some((card) => card === null)) errors.push("embedded UI card must be an object");
  const ids = cards.flatMap((card) => typeof card?.id === "string" ? [card.id] : []);
  if (JSON.stringify(ids) !== JSON.stringify(REQUIRED_CARD_IDS)) errors.push("embedded UI card inventory mismatch");
  for (const card of cards) {
    if (!card) continue;
    const refresh = record(card.refresh);
    if (!refresh || refresh.createsRun !== false || !["GET", "none"].includes(String(refresh.method))) {
      errors.push("embedded UI refresh must be non-creating: " + String(card.id));
    }
    if (card.mode === "explicit-confirmation") {
      const actions = Array.isArray(card.actions) ? card.actions.map(record) : [];
      if (actions.length === 0 || actions.some((action) => !action || action.explicitConfirmation !== true || action.createsRun !== false)) {
        errors.push("embedded UI confirmation must be explicit and non-creating: " + String(card.id));
      }
    }
  }
  const headless = record(root.headless);
  if (!headless || headless.requiresEmbeddedUi !== false || !Array.isArray(headless.skills)) errors.push("headless fallback contract missing");
  const security = record(root.security);
  const forbidden = Array.isArray(security?.forbiddenSources) ? security.forbiddenSources : [];
  for (const expected of ["local-files", "credentials", "api-keys", "auth-files"]) {
    if (!forbidden.includes(expected)) errors.push("embedded UI forbidden source missing: " + expected);
  }
  const serialized = JSON.stringify(value);
  if (/file:\/\/|[A-Za-z]:\\|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}/i.test(serialized)) {
    errors.push("embedded UI descriptor contains local path or secret material");
  }
  const refreshPolicy = String(security?.refreshPolicy ?? "");
  if (/start_run|chat\/task|create[_ -]?run/i.test(refreshPolicy) && !/never call/i.test(refreshPolicy)) {
    errors.push("embedded UI refresh policy may create a Run");
  }
  return [...new Set(errors)];
}
