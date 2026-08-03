import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ExecutionPermissionPosture from "./ExecutionPermissionPosture.js";
import type { ExecutionPermissionPostureDto } from "./evidencePermissionTypes.js";

const risky: ExecutionPermissionPostureDto = {
  source: "committed-events", completeness: "complete", reasons: [], expectedAgentIds: ["dev-1"],
  receiptAgentIds: ["dev-1"], missingReceiptAgentIds: [], fullHostAccess: true, noOsSandbox: true,
  unsupportedConstraints: ["network allowlist was not enforced"], approvalModes: ["run-governance"],
  workers: [{
    agentId: "dev-1", taskId: "task-1", attempt: 1, engine: "codex", adapter: "acp", launchKind: "subprocess",
    sandboxBackend: "none", fullHostAccess: true, network: { requested: "limited", effective: "unrestricted" },
    shell: { requested: "allowlist", effective: "full-host" },
    file: { requestedWrite: true, effective: "full-host", rootCount: 1 },
    unsupportedConstraints: ["network allowlist was not enforced"], approvalMode: "run-governance", receiptCompleteness: "complete",
  }],
};

describe("ExecutionPermissionPosture", () => {
  it("shows host access, missing OS sandbox, unsupported constraints, approval and adapter explicitly", () => {
    const html = renderToStaticMarkup(createElement(ExecutionPermissionPosture, { posture: risky }));
    expect(html).toContain("完整宿主权限");
    expect(html).toContain("无 OS sandbox");
    expect(html).toContain("未执行的约束");
    expect(html).toContain("Run 治理审批");
    expect(html).toContain("codex / acp");
  });

  it("fails closed when permission evidence is unavailable", () => {
    const html = renderToStaticMarkup(createElement(ExecutionPermissionPosture, {}));
    expect(html).toContain("权限证据不完整");
    expect(html).toContain("不能宣称 Evidence 完整");
  });
});
