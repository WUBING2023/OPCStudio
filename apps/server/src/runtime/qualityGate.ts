import type { QualityGateResult } from "@opc/shared";
import { checkTypeErrorsResult, runTestsResult, countTsErrors } from "./tools.js";

// Project state captured at run start, before any worker touches files. Diff-relative gating
// compares against this so a worker is judged on the errors IT introduced — not pre-existing
// ones it never caused.
export interface GateBaseline {
  typeErrors: number;
  testsRan: boolean;
  testsPassed: boolean;
}

export function captureBaseline(workdir: string): GateBaseline {
  const tc = checkTypeErrorsResult(workdir);
  const t = runTestsResult(workdir);
  return {
    typeErrors: tc.ran ? countTsErrors(tc.output) : 0,
    testsRan: t.ran,
    testsPassed: t.passed,
  };
}

// Real quality gate. A worker's diff is accepted iff it does not INCREASE type errors past the
// baseline AND does not break tests that were green at run start. Absent tooling counts as pass
// (nothing to fail). No keyword scanning, no soft pass. With no baseline it degrades to an
// absolute gate (must be fully clean). Failure → orchestrator discards the diff and defers.
export function runQualityGate(workdir: string, baseline?: GateBaseline): QualityGateResult {
  const typeCheck = checkTypeErrorsResult(workdir);
  const tests = runTestsResult(workdir);

  const afterErrors = typeCheck.ran ? countTsErrors(typeCheck.output) : 0;
  const typeOk =
    !typeCheck.ran ||
    typeCheck.passed ||
    (baseline !== undefined && afterErrors <= baseline.typeErrors);

  // Tests must not regress: if they were passing at baseline they must still pass; if they were
  // already failing (or absent) at baseline, broken tests don't block this worker.
  const testsOk =
    !tests.ran ||
    tests.passed ||
    (baseline !== undefined && !(baseline.testsRan && baseline.testsPassed));

  return { passed: typeOk && testsOk, typeCheck, tests };
}
