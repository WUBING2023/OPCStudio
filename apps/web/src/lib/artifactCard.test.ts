import { describe, it, expect } from "vitest";
import { isArtifactOpenable, hasDeliverables, isMarkdownPreview, type OpenableArtifact } from "./artifactCard.js";

function mk(over: Partial<OpenableArtifact>): OpenableArtifact {
  return { id: "x", kind: "file", title: "t", status: "added", inFinalDeliverable: true, ...over } as OpenableArtifact;
}

describe("成果卡打开能力判定(渲染三态)", () => {
  it("有文件:report(final)/file(added,modified)可打开", () => {
    expect(isArtifactOpenable(mk({ kind: "report", status: "final", reviewStatus: "accepted" }))).toBe(true);
    expect(isArtifactOpenable(mk({ kind: "file", status: "added", changeType: "added" }))).toBe(true);
    expect(isArtifactOpenable(mk({ kind: "file", status: "modified", changeType: "modified" }))).toBe(true);
  });

  it("纯文本:worker-output(accepted)仅当有归档实体(savedPath)才可打开,否则不给假按钮", () => {
    expect(isArtifactOpenable(mk({ kind: "worker-output", status: "accepted", reviewStatus: "accepted", savedPath: "artifacts/w.txt" }))).toBe(true);
    expect(isArtifactOpenable(mk({ kind: "worker-output", status: "accepted", reviewStatus: "accepted" }))).toBe(false);
  });

  it("不可打开:deleted/rejected 一律拒(即便带 savedPath)", () => {
    expect(isArtifactOpenable(mk({ kind: "file", status: "deleted", changeType: "deleted", savedPath: "artifacts/x" }))).toBe(false);
    expect(isArtifactOpenable(mk({ kind: "worker-output", status: "rejected", reviewStatus: "rejected", savedPath: "artifacts/x" }))).toBe(false);
    expect(isArtifactOpenable(mk({ kind: "report", status: "rejected", reviewStatus: "rejected" }))).toBe(false);
  });

  it("无交付:空清单 hasDeliverables=false,非空=true", () => {
    expect(hasDeliverables([])).toBe(false);
    expect(hasDeliverables([mk({})])).toBe(true);
  });

  it("预览渲染模式:.md/.markdown→markdown,其余/缺省→纯文本", () => {
    expect(isMarkdownPreview("report-abc.md")).toBe(true);
    expect(isMarkdownPreview("notes.MARKDOWN")).toBe(true);
    expect(isMarkdownPreview("art-inline.txt")).toBe(false);
    expect(isMarkdownPreview(undefined)).toBe(false);
  });
});
