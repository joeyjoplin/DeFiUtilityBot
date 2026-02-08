"use client";

import styles from "./metrics-row.module.css";
import { MetricsCard } from "./metrics-card";
import { useSimulation } from "../simulation/simulation-context";
import { useUiSummary } from "./use-summary";
import { useVaultBalance } from "./use-vault-balance";

function fmtUsdc(n?: number) {
  if (typeof n !== "number") return "—";
  return `${n.toFixed(2)} USDC`;
}

function shortHash(hash?: string) {
  if (!hash) return "—";
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function timeAgo(ts?: number) {
  if (!ts) return "—";
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function MetricsRow() {
  const { state } = useSimulation();
  const isTestnet = state.mode === "testnet";
  const { data: summary, error: summaryError, loading: summaryLoading } = useUiSummary(isTestnet);
  const { data: vaultBalance } = useVaultBalance(isTestnet);
  const vaultAddress = vaultBalance?.vault_address as `0x${string}` | undefined;
  const statsLocal = state.dashboardStats;

  const getFirstNumericField = (
    source: Record<string, unknown> | null | undefined,
    candidateKeys: string[]
  ): number | undefined => {
    for (const key of candidateKeys) {
      const value = source?.[key];
      if (typeof value === "number") return value;
    }
    return undefined;
  };

  const getFirstTimestampField = (
    source: Record<string, unknown> | null | undefined,
    candidateKeys: string[]
  ): number | undefined => {
    for (const key of candidateKeys) {
      const value = source?.[key];
      if (typeof value === "number") return value;
    }
    return undefined;
  };

  const statsFinal = isTestnet && summary
  ? {
      expenseVaultBalanceUsdc: vaultBalance?.amount_usdc ?? getFirstNumericField(summary, ["expenseVaultBalanceUsdc", "vaultBalanceUsdc", "vaultBalance"]),
      yieldEarnedUsdc: vaultBalance?.yield_usdc ?? undefined,
      lastPaymentAmountUsdc: getFirstNumericField(summary, ["lastPaymentAmountUsdc", "lastPaymentUsdc", "lastPaymentAmount"]),
      lastPaymentTimestamp: getFirstTimestampField(summary, ["lastPaymentTimestamp", "lastPaymentTs", "lastPaymentTime"])
        ?? statsLocal.lastPaymentTimestamp,
      lastPaymentTxHash: statsLocal.lastPaymentTxHash,
    }
  : statsLocal;


  return (
    <section className={styles.row}>
      <MetricsCard
        title="Expense Vault Balance"
        value={fmtUsdc(statsFinal.expenseVaultBalanceUsdc)}
        icon={<span>💳</span>}
      />

      <MetricsCard
        title="Yield Earned"
        value={fmtUsdc(statsFinal.yieldEarnedUsdc)}
        sub="fees generated while idle"
        icon={<span>📈</span>}
      />

      <MetricsCard
        title="Last Payment"
        value={statsFinal.lastPaymentTxHash ? `tx: ${shortHash(statsFinal.lastPaymentTxHash)}` : "—"}
        sub={statsFinal.lastPaymentTimestamp ? timeAgo(statsFinal.lastPaymentTimestamp) : "—"}
        icon={<span>🧾</span>}
      />
    </section>
  );
}
