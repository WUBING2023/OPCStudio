import type { EmbeddedEcosystemRoute } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function safeParam(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return SAFE_ID.test(trimmed) ? trimmed : undefined;
}

export function parseEmbeddedEcosystemRoute(rawHash: string): EmbeddedEcosystemRoute | null {
  const raw = (rawHash || "").replace(/^#/, "");
  const [path, query = ""] = raw.split("?", 2);
  if (path !== "/ecosystem" && path !== "ecosystem") return null;
  const params = new URLSearchParams(query);
  return {
    runId: safeParam(params.get("run")),
    companyId: safeParam(params.get("company")),
    proposalId: safeParam(params.get("proposal")),
  };
}

export function formatEmbeddedEcosystemRoute(route: EmbeddedEcosystemRoute): string {
  const params = new URLSearchParams();
  if (route.runId && SAFE_ID.test(route.runId)) params.set("run", route.runId);
  if (route.companyId && SAFE_ID.test(route.companyId)) params.set("company", route.companyId);
  if (route.proposalId && SAFE_ID.test(route.proposalId)) params.set("proposal", route.proposalId);
  const query = params.toString();
  return `#/ecosystem${query ? `?${query}` : ""}`;
}

export function subscribeEmbeddedEcosystemRoute(
  listener: (route: EmbeddedEcosystemRoute | null) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const notify = () => listener(parseEmbeddedEcosystemRoute(window.location.hash));
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
    window.removeEventListener("popstate", notify);
  };
}
