import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client.js";
import type { SubscriptionFramework } from "./framework.js";

export interface SetupInstallJob {
  engine: SubscriptionFramework;
  status: "running" | "done" | "error" | "timeout";
  log: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  error?: string;
}

/** The install process belongs to the server, so remounts must recover it. */
export function useSetupInstallJob(onSettled?: (job: SetupInstallJob) => void) {
  const [job, setJob] = useState<SetupInstallJob | null>(null);
  const [requestError, setRequestError] = useState("");
  const mounted = useRef(true);
  const handledTerminal = useRef("");
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ job: SetupInstallJob | null }>("/setup/install/status");
      if (!mounted.current) return;
      setJob(data.job);
      setRequestError("");
    } catch (error) {
      if (!mounted.current) return;
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (job?.status !== "running") return;
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [job?.status, job?.startedAt, refresh]);

  useEffect(() => {
    if (!job || job.status === "running") return;
    const key = `${job.engine}:${job.startedAt}:${job.status}`;
    if (handledTerminal.current === key) return;
    handledTerminal.current = key;
    onSettledRef.current?.(job);
  }, [job]);

  const start = useCallback(async (engine: SubscriptionFramework) => {
    setRequestError("");
    try {
      const data = await api.post<{ job: SetupInstallJob }>("/setup/install", { engine });
      if (mounted.current) setJob(data.job);
      return data.job;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current) setRequestError(message);
      throw error;
    }
  }, []);

  return {
    job,
    requestError,
    refresh,
    start,
    installing: job?.status === "running" ? job.engine : null,
  };
}