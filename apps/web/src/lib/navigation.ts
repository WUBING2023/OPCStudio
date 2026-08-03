export type AppPage =
  | "org"
  | "cockpit"
  | "results"
  | "memory"
  | "subscription"
  | "api"
  | "mcp"
  | "skills"
  | "cost"
  | "community"
  | "settings";

export interface AppRoute {
  page: AppPage;
  companyId?: string;
  runId?: string;
  memoryId?: string;
  agentId?: string;
}

export interface MemoryNavigationTarget {
  memoryId: string;
  kind: string;
  content?: string;
  companyId?: string;
  sourceRunId?: string;
  whySelected?: string;
}

const APP_ROUTE_EVENT = "opc-route-changed";

function cleanSegment(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? encodeURIComponent(cleaned) : undefined;
}

function decodeSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { return value; }
}

function queryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function formatAppRoute(route: AppRoute): string {
  const company = cleanSegment(route.companyId);
  const run = cleanSegment(route.runId);
  const memory = cleanSegment(route.memoryId);
  const agent = route.agentId?.trim();
  switch (route.page) {
    case "org": return `#/companies${company ? `/${company}` : ""}`;
    case "cockpit":
      return `#/workbench${company ? `/${company}` : ""}${run ? `/runs/${run}` : ""}${queryString({ agent })}`;
    case "results": return run ? `#/runs/${run}${queryString({ company: route.companyId })}` : `#/results${queryString({ company: route.companyId })}`;
    case "memory": return `#/assets/memory${memory ? `/${memory}` : ""}${queryString({ company: route.companyId })}`;
    case "skills": return "#/assets/skills";
    case "community": return "#/assets/community";
    case "subscription": return "#/integrations/subscriptions";
    case "api": return "#/integrations/api";
    case "mcp": return "#/integrations/mcp";
    case "cost": return `#/usage/tokens${queryString({ company: route.companyId })}`;
    case "settings": return "#/settings";
  }
}

export function parseAppRoute(rawHash: string): AppRoute {
  const raw = (rawHash || "").replace(/^#/, "") || "/companies";
  const [pathnameRaw, queryRaw = ""] = raw.split("?", 2);
  const pathname = pathnameRaw.startsWith("/") ? pathnameRaw : `/${pathnameRaw}`;
  const parts = pathname.split("/").filter(Boolean).map(decodeSegment) as string[];
  const query = new URLSearchParams(queryRaw);

  if (parts[0] === "companies") return { page: "org", companyId: parts[1] };
  if (parts[0] === "workbench") {
    return {
      page: "cockpit",
      companyId: parts[1],
      runId: parts[2] === "runs" ? parts[3] : undefined,
      agentId: query.get("agent") || undefined,
    };
  }
  if (parts[0] === "runs") return { page: "results", runId: parts[1], companyId: query.get("company") || undefined };
  if (parts[0] === "results") return { page: "results", companyId: query.get("company") || undefined };
  if (parts[0] === "assets") {
    if (parts[1] === "memory") return { page: "memory", memoryId: parts[2], companyId: query.get("company") || undefined };
    if (parts[1] === "skills") return { page: "skills" };
    if (parts[1] === "community") return { page: "community" };
  }
  if (parts[0] === "integrations") {
    if (parts[1] === "api") return { page: "api" };
    if (parts[1] === "mcp") return { page: "mcp" };
    return { page: "subscription" };
  }
  if (parts[0] === "usage") return { page: "cost", companyId: query.get("company") || undefined };
  if (parts[0] === "settings") return { page: "settings" };

  // One-cycle compatibility for links emitted before Phase 1 routing.
  const legacy: Partial<Record<string, AppPage>> = {
    org: "org", company: "org", cockpit: "cockpit", projects: "results", project: "results",
    results: "results", trace: "results", memory: "memory", experience: "memory",
    subscription: "subscription", api: "api", mcp: "mcp", skills: "skills", cost: "cost", community: "community",
  };
  return { page: legacy[parts[0] ?? ""] ?? "org" };
}

export function currentAppRoute(): AppRoute {
  if (typeof window === "undefined") return { page: "org" };
  return parseAppRoute(window.location.hash);
}

export function navigateApp(route: AppRoute, options?: { replace?: boolean }): void {
  if (typeof window === "undefined") return;
  const next = formatAppRoute(route);
  if (`#${window.location.hash.replace(/^#/, "")}` === next) {
    window.dispatchEvent(new CustomEvent(APP_ROUTE_EVENT, { detail: route }));
    return;
  }
  if (options?.replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  window.dispatchEvent(new CustomEvent(APP_ROUTE_EVENT, { detail: route }));
}

export function subscribeAppRoute(listener: (route: AppRoute) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const notify = () => listener(currentAppRoute());
  const onInternal = (event: Event) => listener((event as CustomEvent<AppRoute>).detail ?? currentAppRoute());
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  window.addEventListener(APP_ROUTE_EVENT, onInternal);
  return () => {
    window.removeEventListener("hashchange", notify);
    window.removeEventListener("popstate", notify);
    window.removeEventListener(APP_ROUTE_EVENT, onInternal);
  };
}

export function openRun(runId: string, companyId?: string): void {
  if (!runId) return;
  navigateApp({ page: "results", runId, companyId });
}

export function openMemoryItem(target: MemoryNavigationTarget): void {
  if (!target.memoryId) return;
  try { sessionStorage.setItem("opc-open-memory", JSON.stringify(target)); } catch { /* compatibility cache only */ }
  navigateApp({ page: "memory", memoryId: target.memoryId, companyId: target.companyId });
}
