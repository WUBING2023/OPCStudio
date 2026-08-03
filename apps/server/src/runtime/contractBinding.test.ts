import { describe, it, expect } from "vitest";
import { contractBindsTest, testTargetStems } from "@opc/shared";

// MUP 波2 · 合同绑定共享 helper(packages/shared/src/contractBinding.ts)。验收门与
// Verifier Snapshot 运行器共用同一判据;核心验收用例:目录敏感修复——src/sum.js 合同要能绑
// 根级 sum.test.js(stem 匹配按 basename 层与带目录层都试)。

describe("testTargetStems", () => {
  it("同层测试文件 → 单一 basename 层 stem", () => {
    expect(testTargetStems("sum.test.js")).toEqual(["sum"]);
    expect(testTargetStems("clamp.spec.ts")).toEqual(["clamp"]);
    expect(testTargetStems("util.spec.mjs")).toEqual(["util"]);
  });

  it("带目录的测试文件 → 带目录层 + basename 层两个候选", () => {
    expect(testTargetStems("tests/sum.test.js")).toEqual(["tests/sum", "sum"]);
    expect(testTargetStems("src/deep/calc.spec.tsx")).toEqual(["src/deep/calc", "calc"]);
  });

  it("python 两种命名:test_x.py / x_test.py", () => {
    expect(testTargetStems("test_calc.py")).toEqual(["calc"]);
    expect(testTargetStems("lib/calc_test.py")).toEqual(["lib/calc", "calc"]);
  });

  it("非测试命名 → [](不是测试,谈不上目标)", () => {
    expect(testTargetStems("readme.md")).toEqual([]);
    expect(testTargetStems("src/sum.js")).toEqual([]);
    expect(testTargetStems("notes.test.md")).toEqual([]);
  });

  it("归一:反斜杠 / ./ 前缀 / 大小写", () => {
    expect(testTargetStems(".\\Tests\\Sum.TEST.JS")).toEqual(["tests/sum", "sum"]);
  });
});

describe("contractBindsTest", () => {
  it("测试文件本身 ∈ 合同 → 绑定(含反斜杠/大小写归一)", () => {
    expect(contractBindsTest("feature.test.js", ["feature.test.js"])).toBe(true);
    expect(contractBindsTest("Tests\\Feature.Test.JS", ["tests/feature.test.js"])).toBe(true);
  });

  it("目录敏感修复(冻结规格验收用例):src/sum.js 合同绑根级 sum.test.js", () => {
    expect(contractBindsTest("sum.test.js", ["src/sum.js"])).toBe(true);
  });

  it("目录敏感修复:tests/ 下的测试绑 src/ 下的同名源文件", () => {
    expect(contractBindsTest("tests/sum.test.js", ["src/sum.js"])).toBe(true);
  });

  it("经典同目录目标匹配仍成立(不回归)", () => {
    expect(contractBindsTest("src/clamp.test.js", ["src/clamp.js"])).toBe(true);
    expect(contractBindsTest("clamp.test.js", ["clamp.js"])).toBe(true);
  });

  it("python:test_calc.py 绑 lib/calc.py;calc_test.py 同理", () => {
    expect(contractBindsTest("test_calc.py", ["lib/calc.py"])).toBe(true);
    expect(contractBindsTest("calc_test.py", ["lib/calc.py"])).toBe(true);
  });

  it("纯遗留测试(不在合同、目标 stem 也不相交)→ 拒", () => {
    expect(contractBindsTest("gcd.test.js", ["src/sum.js"])).toBe(false);
    expect(contractBindsTest("leftover.test.js", ["feature.test.js"])).toBe(false);
  });

  it("空合同 → 拒(本 run 零变更,任何测试都不属于它)", () => {
    expect(contractBindsTest("sum.test.js", [])).toBe(false);
  });

  it("非测试命名文件不经目标匹配放行(只能靠自身∈合同)", () => {
    expect(contractBindsTest("sum.js", ["src/sum.js"])).toBe(false);
    expect(contractBindsTest("src/sum.js", ["src/sum.js"])).toBe(true);
  });
});
