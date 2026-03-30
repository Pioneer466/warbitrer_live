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

    const load = async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
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
        if (mountedRef.current) {
          timeoutId = setTimeout(load, intervalMs);
        }
      }
    };

    void load();

    return () => {
      mountedRef.current = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [intervalMs, url]);

  return state;
}
