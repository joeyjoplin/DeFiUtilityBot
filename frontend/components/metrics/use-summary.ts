"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "../lib/api";

export type UiSummary = {
  [k: string]: any;
};

export function useUiSummary(enabled: boolean, pollMs = 3000) {
  const [data, setData] = useState<UiSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: any;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE_URL}/ui/summary`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`summary ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load summary");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    timer = setInterval(load, pollMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, pollMs]);

  return { data, error, loading };
}
