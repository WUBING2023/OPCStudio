export interface SharedSkillDefinition {
  name: string;
  version: string;
  description: string;
  mcpTools: string[];
  body: string;
}

function skillBody(lines: string[]): string {
  return lines.join("\n") + "\n";
}

export const SHARED_SKILLS: SharedSkillDefinition[] = [
  {
    name: "opc-team-run",
    version: "0.1.0",
    description: "Use an OPC Studio company to plan, start, monitor, and collect a durable multi-agent run with explicit confirmation and evidence.",
    mcpTools: ["list_companies", "inspect_company", "inspect_capabilities", "start_run", "get_run_status", "get_run_trace", "list_artifacts", "get_artifact", "get_evidence"],
    body: skillBody([
      "# OPC Team Run", "",
      "Use this skill when the user wants an OPC Studio company to perform a durable task.", "",
      "## Procedure", "",
      "1. Call list_companies and select only a company the user identifies or approves.",
      "2. Call inspect_company and inspect_capabilities before proposing execution.",
      "3. Explain unavailable providers, verifiers, or permissions instead of silently substituting them.",
      "4. Ask for explicit user confirmation before start_run.",
      "5. Reuse one idempotencyKey if the same start request must be retried.",
      "6. Poll get_run_status. Use get_run_trace only when progress or failure detail is needed.",
      "7. On completion, inspect list_artifacts and get_evidence before claiming success.",
      "8. Treat failed, degraded, missing, or unverified evidence as non-success.", "",
      "## Safety", "",
      "- Never place credentials, session tokens, private keys, or secret-bearing text in a task.",
      "- Do not ask OPC Studio to bypass its verification or permission gates.",
      "- Do not infer file delivery from model text. Use artifact and evidence tools.",
    ]),
  },
  {
    name: "opc-run-review",
    version: "0.1.0",
    description: "Review an OPC Studio run from authoritative state, trace, artifact references, and committed evidence without trusting status text alone.",
    mcpTools: ["get_run_status", "get_run_trace", "list_artifacts", "get_artifact", "get_evidence"],
    body: skillBody([
      "# OPC Run Review", "",
      "Use this skill to audit a completed, failed, or degraded OPC Studio run.", "",
      "## Review order", "",
      "1. Read get_run_status and record status, final state, degradation, and acceptance.",
      "2. Read get_run_trace to reconstruct the producer, verifier, tool, and approval sequence.",
      "3. Read list_artifacts. Open only recorded artifact identifiers with get_artifact.",
      "4. Call get_evidence with verify enabled when a strong integrity claim is required.",
      "5. Report mismatches, missing artifacts, unbound tests, deferred work, and rejected evidence.", "",
      "## Claims", "",
      "- Verified means the committed evidence supports the claim, not merely that a worker said it passed.",
      "- Degraded and failed runs may still contain useful artifacts; label them accurately.",
      "- Never expose redacted or sensitive fields and never reconstruct hidden credentials.",
    ]),
  },
  {
    name: "opc-company-design",
    version: "0.1.0",
    description: "Inspect an OPC Studio company and draft a responsibility, capability, and verification design proposal without directly mutating the company.",
    mcpTools: ["list_companies", "inspect_company", "inspect_capabilities"],
    body: skillBody([
      "# OPC Company Design", "",
      "Use this skill to review a company and propose a safer, right-sized design.", "",
      "## Procedure", "",
      "1. Inspect the selected company, its workers, responsibilities, providers, and capability report.",
      "2. Separate long-lived organization policy from the mission task graph and disposable execution sessions.",
      "3. Prefer one capable producer plus independent verification for small tasks.",
      "4. Add managers or parallel workers only when dependency, risk, or review needs justify them.",
      "5. Define producer-to-verifier responsibility and acceptance evidence explicitly.",
      "6. Return a proposal with rationale, expected impact, risks, and rollback notes.", "",
      "## Boundary", "",
      "This exported skill is proposal-only. It does not expose company mutation tools.",
      "Do not embed company memory, user history, credentials, local paths, or runtime state in the proposal.",
    ]),
  },
];

export function renderSkillMarkdown(skill: SharedSkillDefinition): string {
  return [
    "---",
    "name: " + skill.name,
    "description: " + JSON.stringify(skill.description),
    "license: MIT",
    "compatibility: Requires an OPC Studio MCP server with the listed high-level tools.",
    "metadata:",
    "  author: OPC Studio",
    "  version: " + JSON.stringify(skill.version),
    "allowed-tools: " + JSON.stringify(skill.mcpTools.join(" ")),
    "---", "",
    skill.body.trimEnd(), "",
  ].join("\n");
}
