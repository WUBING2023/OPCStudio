import type { ChatTaskResponse } from "../api/client.js";

export const RUN_UI_STATE_EVENT = "opc-run-ui-state";

export interface RunUiStateDetail {
  runId: string;
  goal: string;
  companyId: string;
  status: "queued" | "preparing";
  queuePosition?: number;
  announcedAt: string;
}

// The durable run is created before chatTask returns. Announce that known state
// locally so the cockpit does not look idle while the first run_started event is
// still being prepared. Durable /runs data replaces this optimistic snapshot.
export function announceRunUiState(response: ChatTaskResponse, goal: string, companyId?: string): void {
  if (response.approvalRequired || typeof window === "undefined") return;
  const detail: RunUiStateDetail = {
    runId: response.runId,
    goal,
    companyId: companyId || "default",
    status: response.queued ? "queued" : "preparing",
    ...(response.queuePosition ? { queuePosition: response.queuePosition } : {}),
    announcedAt: new Date().toISOString(),
  };
  window.dispatchEvent(new CustomEvent(RUN_UI_STATE_EVENT, { detail }));
}
