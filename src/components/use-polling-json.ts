"use client";

import { startTransition, useEffect, useRef, useState } from "react";

type PollingState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

export function usePollingJson<T>(url: string, intervalMs: number) {
  const [state, setState] = useState<PollingState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let requestInFlight = false;

    const scheduleNextLoad = () => {
      if (!mountedRef.current || document.visibilityState === "hidden") {
        return;
      }
      timeoutId = setTimeout(load, intervalMs);
    };

    const load = async () => {
      if (requestInFlight || document.visibilityState === "hidden") {
        return;
      }
      requestInFlight = true;
      try {
        const response = await fetch(url, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(await readResponseError(response));
        }
        const payload = (await response.json()) as T;
        if (!mountedRef.current) {
          return;
        }
        startTransition(() => {
          setState({
            data: payload,
            error: null,
            loading: false,
          });
        });
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        startTransition(() => {
          setState((current) => ({
            data: current.data,
            error: error instanceof Error ? error.message : "Erreur de chargement",
            loading: false,
          }));
        });
      } finally {
        requestInFlight = false;
        scheduleNextLoad();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        return;
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      void load();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void load();

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [intervalMs, url]);

  return state;
}

async function readResponseError(response: Response) {
  try {
    const payload = (await response.json()) as {
      error?: string;
      message?: string;
    };

    if (payload.error) {
      return payload.error;
    }

    if (payload.message) {
      return payload.message;
    }
  } catch {
    try {
      const text = await response.text();
      if (text) {
        return text;
      }
    } catch {}
  }

  return `HTTP ${response.status}`;
}
