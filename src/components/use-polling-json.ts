"use client";

import { startTransition, useCallback, useEffect, useState } from "react";

export type PollingState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

export type PollingJsonOptions = {
  parseJsonOnNonOk?: boolean;
  clearDataOnError?: boolean;
};

export function usePollingJson<T>(url: string, intervalMs: number, options: PollingJsonOptions = {}) {
  const parseJsonOnNonOk = options.parseJsonOnNonOk === true;
  const clearDataOnError = options.clearDataOnError === true;
  const [state, setState] = useState<PollingState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const [refreshSequence, setRefreshSequence] = useState(0);
  const refresh = useCallback(() => setRefreshSequence((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let requestInFlight = false;

    const scheduleNextLoad = () => {
      if (!active || document.visibilityState === "hidden") {
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
        const result = await parsePollingJsonResponse<T>(response, { parseJsonOnNonOk });
        if (!active) {
          return;
        }
        startTransition(() => {
          setState({
            data: result.data,
            error: result.error,
            loading: false,
          });
        });
      } catch (error) {
        if (!active) {
          return;
        }
        startTransition(() => {
          setState((current) => buildPollingErrorState(current, error, clearDataOnError));
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
      active = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [clearDataOnError, intervalMs, parseJsonOnNonOk, refreshSequence, url]);

  return { ...state, refresh };
}

export async function parsePollingJsonResponse<T>(
  response: Response,
  options: Pick<PollingJsonOptions, "parseJsonOnNonOk"> = {},
) {
  const raw = await response.text();
  let payload: unknown;

  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    const message = raw.trim() || `HTTP ${response.status}`;
    throw new Error(response.ok ? `Réponse JSON invalide: ${message}` : message);
  }

  const responseError = readPayloadError(payload) ?? `HTTP ${response.status}`;
  if (!response.ok && options.parseJsonOnNonOk !== true) {
    throw new Error(responseError);
  }

  return {
    data: payload as T,
    error: response.ok ? null : responseError,
  };
}

export function buildPollingErrorState<T>(
  current: PollingState<T>,
  error: unknown,
  clearDataOnError: boolean,
): PollingState<T> {
  return {
    data: clearDataOnError ? null : current.data,
    error: error instanceof Error ? error.message : "Erreur de chargement",
    loading: false,
  };
}

function readPayloadError(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.length > 0) {
    return record.error;
  }
  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message;
  }
  return null;
}
