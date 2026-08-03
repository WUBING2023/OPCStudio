import type { NativeHost, NativeNegotiation, NativeOperation } from "./types.js";

export interface NativeRouteRequest {
  operation: NativeOperation;
  host: NativeHost;
  featureGateEnabled: boolean;
  fallbackAvailable: boolean;
  negotiation?: NativeNegotiation;
}

export interface NativeRouteDecision {
  route: "native" | "fallback" | "blocked";
  degraded: boolean;
  reason:
    | "native_selected"
    | "feature_gate_disabled"
    | "negotiation_missing"
    | "host_version_unverified"
    | "host_version_incompatible"
    | "contract_version_incompatible"
    | "capability_unavailable"
    | "fallback_unavailable";
}

function fallbackOrBlocked(request: NativeRouteRequest, reason: NativeRouteDecision["reason"]): NativeRouteDecision {
  return request.fallbackAvailable
    ? { route: "fallback", degraded: true, reason }
    : { route: "blocked", degraded: true, reason: "fallback_unavailable" };
}

export function decideNativeRoute(request: NativeRouteRequest): NativeRouteDecision {
  if (!request.featureGateEnabled) return fallbackOrBlocked(request, "feature_gate_disabled");
  if (!request.negotiation) return fallbackOrBlocked(request, "negotiation_missing");
  if (!request.negotiation.compatible) {
    return fallbackOrBlocked(request, request.negotiation.degradationReason ?? "host_version_incompatible");
  }
  if (!request.negotiation.capabilities[request.operation]) {
    return fallbackOrBlocked(request, "capability_unavailable");
  }
  return { route: "native", degraded: false, reason: "native_selected" };
}
