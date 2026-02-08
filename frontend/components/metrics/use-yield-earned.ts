"use client";

import { useEffect, useState } from "react";
import { readContract } from "@wagmi/core";
import { formatUnits } from "viem";
import { wagmiConfig } from "../../wallet/wagmi";

const STRATEGY_ABI = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const VAULT_ABI = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const USDC_DECIMALS = 6;

export function useYieldEarnedOnChain(
  enabled: boolean,
  opts: {
    vaultAddress: `0x${string}`;
    strategyAddress: `0x${string}`;
    pollMs?: number;
  }
) {
  const pollMs = opts.pollMs ?? 3000;
  const [yieldUsdc, setYieldUsdc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: any;

    async function load() {
      setError(null);
      try {
        const [strategyAssets, vaultAssets] = await Promise.all([
          readContract(wagmiConfig, {
            address: opts.strategyAddress,
            abi: STRATEGY_ABI,
            functionName: "totalAssets",
          }) as Promise<bigint>,
          readContract(wagmiConfig, {
            address: opts.vaultAddress,
            abi: VAULT_ABI,
            functionName: "totalAssets",
          }) as Promise<bigint>,
        ]);

        const diff = strategyAssets > vaultAssets ? strategyAssets - vaultAssets : BigInt(0);

        if (!cancelled) {
          setYieldUsdc(formatUnits(diff, USDC_DECIMALS));
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to read yield");
      }
    }

    load();
    timer = setInterval(load, pollMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, opts.vaultAddress, opts.strategyAddress, pollMs]);

  return { yieldUsdc, error };
}
