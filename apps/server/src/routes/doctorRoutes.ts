import type { Express } from "express";
import { runGlobalDoctor, readLatestDoctorReport, type DoctorLevel } from "../runtime/globalDoctor.js";
import { providerToolCanaryReal } from "../runtime/providerToolCanaryReal.js";

// 审计 P1-4:生产 Doctor 注入真实 provider 文件工具 canary(deep 层 + OPC_DOCTOR_PROVIDER_CANARY=1 时真跑;否则 not_tested)。
const DOCTOR_DEPS = { providerToolCanary: providerToolCanaryReal };

// Track E · E2/E5 Global Doctor 路由:
// - GET  /api/doctor        读最近一次体检报告(latest.json);没有就现跑一次 basic(快、不打外网)。
// - POST /api/doctor/run    {level:"basic"|"capability"|"deep"} 主动重跑;capability/deep 层会打外网
//   (provider 连通/MCP 探测/社区 registry 可达),慢;deep 层再叠加 E5 新探针(端口占用/工具链/文件锁等)。
// 报告落盘由 runGlobalDoctor 自己负责(.opc/doctor-reports/<ts>.json + latest.json),路由不重复写。

export function register(app: Express, projectRoot: string) {
  app.get("/api/doctor", async (_req, res) => {
    try {
      const latest = readLatestDoctorReport(projectRoot);
      if (latest) { res.json(latest); return; }
      const report = await runGlobalDoctor(projectRoot, { level: "basic" }, DOCTOR_DEPS);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "doctor failed" });
    }
  });

  app.post("/api/doctor/run", async (req, res) => {
    const level = req.body?.level ?? "basic";
    if (level !== "basic" && level !== "capability" && level !== "deep") {
      res.status(400).json({ error: 'level must be "basic", "capability" or "deep"' });
      return;
    }
    try {
      const report = await runGlobalDoctor(projectRoot, { level: level as DoctorLevel }, DOCTOR_DEPS);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "doctor run failed" });
    }
  });
}
