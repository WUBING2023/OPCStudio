import { describe, it, expect, beforeEach } from "vitest";
import {
  issueInstallConfirmationToken,
  consumeInstallConfirmationToken,
  _resetInstallConfirmationTokens,
} from "./installTransactionStore.js";
import type { InstallDangerSurface } from "../runtime/install.js";

// 令四.1 · 一次性安装确认 token(后端签发,替代客户端布尔 unsafeAcknowledged)。
// 覆盖:正常两步、重放(一次性)、过期、模板 hash 不符(预览后被换)、危险面不符。

const surface = (over: Partial<InstallDangerSurface> = {}): InstallDangerSurface => ({
  templateHash: "hash-abc",
  trustLevel: "community",
  dangerFlags: ["file-write", "shell-access"],
  mcp: ["github"],
  cli: ["claude-code"],
  fileWrite: true,
  ...over,
});

describe("令四.1 · installConfirmationToken", () => {
  beforeEach(() => _resetInstallConfirmationTokens());

  it("正常两步:preview 签发 → 真装携带同一危险面 → 消费成功", () => {
    const issued = issueInstallConfirmationToken(surface(), { scope: "install/company" });
    expect(issued.installConfirmationToken).toBeTruthy();
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const consumed = consumeInstallConfirmationToken(issued.installConfirmationToken, surface(), { scope: "install/company" });
    expect(consumed.ok).toBe(true);
  });

  it("重放:同一 token 第二次消费 → 409(一次性)", () => {
    const issued = issueInstallConfirmationToken(surface());
    expect(consumeInstallConfirmationToken(issued.installConfirmationToken, surface()).ok).toBe(true);
    const replay = consumeInstallConfirmationToken(issued.installConfirmationToken, surface());
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe(409);
  });

  it("过期:超过 10 分钟 → 410(要求重新预览)", () => {
    const t0 = Date.now();
    const issued = issueInstallConfirmationToken(surface(), { now: t0 });
    const later = t0 + 10 * 60 * 1000 + 1;
    const consumed = consumeInstallConfirmationToken(issued.installConfirmationToken, surface(), { now: later });
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.status).toBe(410);
  });

  it("模板 hash 不符(预览后模板被换)→ 409,token 未被消费(可重新预览)", () => {
    const issued = issueInstallConfirmationToken(surface({ templateHash: "hash-original" }));
    const consumed = consumeInstallConfirmationToken(issued.installConfirmationToken, surface({ templateHash: "hash-swapped" }));
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.status).toBe(409);
    // 未消费:换回正确 hash 仍可用(证明失败不吞 token)
    const retry = consumeInstallConfirmationToken(issued.installConfirmationToken, surface({ templateHash: "hash-original" }));
    expect(retry.ok).toBe(true);
  });

  it("危险面不符(dangerFlags/mcp/cli/fileWrite/trustLevel 任一变)→ 409", () => {
    const issued = issueInstallConfirmationToken(surface());
    const mismatch = consumeInstallConfirmationToken(issued.installConfirmationToken, surface({ dangerFlags: ["file-write"] }));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.status).toBe(409);
  });

  it("token cannot be replayed through a different install endpoint scope", () => {
    const issued = issueInstallConfirmationToken(surface(), { scope: "install/company" });
    const wrongScope = consumeInstallConfirmationToken(
      issued.installConfirmationToken,
      surface(),
      { scope: "companies/import" },
    );
    expect(wrongScope.ok).toBe(false);
    if (!wrongScope.ok) expect(wrongScope.status).toBe(403);

    // Scope mismatch does not consume the token; the intended endpoint can still use it once.
    expect(consumeInstallConfirmationToken(
      issued.installConfirmationToken,
      surface(),
      { scope: "install/company" },
    ).ok).toBe(true);
  });

  it("未知 token → 401(需重新预览)", () => {
    const consumed = consumeInstallConfirmationToken("not-a-real-token", surface());
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.status).toBe(401);
  });
});
