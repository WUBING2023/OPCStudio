import type { Express } from "express";
import { loadPricing } from "../storage/pricingStore.js";

export function register(app: Express, projectRoot: string) {
  app.get("/api/pricing", (_req, res) => {
    res.json(loadPricing(projectRoot));
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });
}
