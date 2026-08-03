import type { Express } from "express";

export function register(app: Express) {
  app.get("/api/hello", (_req, res) => {
    res.type("text/plain").send("hello");
  });
}
