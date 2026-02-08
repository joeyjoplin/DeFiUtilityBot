"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL } from "../lib/api";

export type VaultBalance = {
  vault_address?: string;
  strategy_address?: string | null;
  token?: string;
  token_contract?: string;
  decimals?: number;
  amount_base_units?: string;
  amount_usdc?: number;
  total_assets_base_units?: string;
  total_assets_usdc?: number;
  total_supply_base_units?: string;
  total_supply_usdc?: number;
  share_price?: number;
  yield_usdc?: number;
};

export function useVaultBalance(enabled: boolean, pollMs = 3000) {
  const [data, setData] = useState<VaultBalance | null>(null);
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
        const res = await fetch(`${API_BASE_URL}/ui/vault`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`vault ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json?.balance ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load vault balance");
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
