// MUP 波2 · 交付合同绑定共享 helper:Verifier Snapshot 运行器(apps/server tools.runVerifierTestsInSnapshot)
// 与 DeliveryAcceptance 验收门共用同一判据,消除两侧口径漂移(此前快照侧认"目标 stem∈合同"而验收门只认
// testedFile 严格∈合同)。路径一律归一为 POSIX + 去 ./ 前缀 + 小写(Windows 大小写不敏感,合同来自 git
// 也统一小写比对)。
//
// 目录敏感修复:stem 匹配按【带目录层】与【basename 层】都试——src/sum.js 的合同要能绑根级 sum.test.js,
// tests/ 下的测试也要能绑 src/ 下的同名源文件。注意这是文件名启发式(绑定候选面),verified 强判据另由
// Node 解析链证据(resolvedProducerFiles × ProducerArtifactManifest hash 交叉)把关,启发式放宽不单独产出 verified。

function normPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function stripExt(p: string): string {
  return p.replace(/\.[^./]+$/, "");
}

/**
 * 一个测试文件"测的是哪个源文件"的目标 stem 候选:foo.test.js / foo.spec.ts → foo;test_foo.py → foo;
 * foo_test.py → foo。返回 0-2 个候选(归一小写):带目录层(tests/sum)与 basename 层(sum);
 * 非测试命名的文件 → [](它不是测试,谈不上目标)。
 */
export function testTargetStems(testPathPosix: string): string[] {
  const rl = normPosix(testPathPosix);
  const slash = rl.lastIndexOf("/");
  const dir = slash >= 0 ? rl.slice(0, slash + 1) : "";
  const base = slash >= 0 ? rl.slice(slash + 1) : rl;
  let stem: string | null = null;
  const js = base.match(/^(.+)\.(?:test|spec)\.(?:m|c)?[jt]sx?$/);
  if (js) stem = js[1];
  else {
    const py = base.match(/^test_(.+)\.py$/) || base.match(/^(.+)_test\.py$/);
    if (py) stem = py[1];
  }
  if (!stem) return [];
  return dir ? [dir + stem, stem] : [stem];
}

/**
 * 合同绑定判据:一条测试文件是否属于本 run 交付合同。
 * ①测试文件本身 ∈ 合同(本 run 新增/改了它);或
 * ②它测的源文件(目标 stem)与合同文件 stem 相交——合同侧同时登记带目录层与 basename 层,
 *   目标侧(testTargetStems)亦两层都试,修掉目录敏感假阴性。
 * 二者皆非 → 拒(它是共享工作目录里历次遗留的无关测试,绝不能把它的通过当作本任务的验证)。
 */
export function contractBindsTest(testPathPosix: string, contractPaths: string[]): boolean {
  const rl = normPosix(testPathPosix);
  const contractSet = new Set(contractPaths.map(normPosix));
  if (contractSet.has(rl)) return true;
  const targets = testTargetStems(rl);
  if (!targets.length) return false;
  const stems = new Set<string>();
  for (const c of contractSet) {
    const full = stripExt(c);
    stems.add(full);
    const s = full.lastIndexOf("/");
    if (s >= 0) stems.add(full.slice(s + 1));
  }
  return targets.some((t) => stems.has(t));
}
