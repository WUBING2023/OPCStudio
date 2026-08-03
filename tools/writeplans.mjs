import fs from "node:fs";
const out = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const plans = (out.result && out.result.plans) || out.plans || [];
fs.mkdirSync("M:/OPC/projects/OPCstudio/docs", { recursive: true });
const index = ["# OPC Studio 实施方案索引\n", "由 ROADMAP.md 展开的 5 阶段详细可执行方案（每份含接口/改动文件/有序任务清单/验证命令）。\n"];
for (const p of plans.sort((a, b) => a.n - b.n)) {
  let md = p.md || "";
  const i = md.indexOf("# ");
  if (i > 0 && i < 300) md = md.slice(i); // strip any short preamble before the first h1
  const file = `M:/OPC/projects/OPCstudio/docs/phase${p.n}-plan.md`;
  fs.writeFileSync(file, md, "utf8");
  index.push(`- [Phase ${p.n}](./phase${p.n}-plan.md) — ${p.name}（${md.length} 字）`);
  console.log(`wrote phase${p.n}-plan.md  ${md.length} chars  ${p.name}`);
}
fs.writeFileSync("M:/OPC/projects/OPCstudio/docs/README.md", index.join("\n") + "\n", "utf8");
console.log("wrote docs/README.md index");
