"use client";

import styles from "./action-bar.module.css";
import { Button } from "./button";
import { useSimulation } from "../simulation/simulation-context";
import { VaultModal } from "@/components/vault/vault-modal";
import { useMemo, useState } from "react";
import { createWagmiVaultAdapter } from "@/components/vault/vault-adapter-wagmi";
import { useAccount } from "wagmi";
import { useVaultBalance } from "@/components/metrics/use-vault-balance";

export function ActionBar() {
  const { start, reset, state } = useSimulation();
  const { address } = useAccount();

  const isLocal = state.mode === "local";
  const isTestnet = state.mode === "testnet";

  const noBusinessCase = !state.selectedBusinessCase;

  const [fundOpen, setFundOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const { data: vaultBalance } = useVaultBalance(isTestnet);
  const vaultAddress = vaultBalance?.vault_address as `0x${string}` | undefined;
  const tokenAddress = vaultBalance?.token_contract as `0x${string}` | undefined;

  async function handleStartSession() {
    start();
    
    if (isLocal) return;

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001";
    try {
      await fetch(`${serverUrl}/ui/timeline/clear`, { method: "POST" });
      const resp = await fetch(`${serverUrl}/agents/m2m/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_case: state.selectedBusinessCase }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error("Start Session failed:", resp.status, text);
      }
    } catch (err) {
      console.error("Start Session error:", err);
    }
  }

  const vaultAdapter = useMemo(() => {
    if (!isTestnet || !vaultAddress || !tokenAddress) return null;
    return createWagmiVaultAdapter({
      ownerAddress: address as `0x${string}` | undefined,
      vaultAddress,
      tokenAddress,
    });
  }, [isTestnet, address, vaultAddress, tokenAddress]);

  return (
    <section className={styles.actionBar}>
      <div className={styles.left}>
        <Button onClick={handleStartSession} disabled={state.isRunning || (!state.selectedBusinessCase && state.mode === "testnet")}>
          Start Session
        </Button>
        {isLocal && (
          <Button variant="secondary" onClick={reset}>Reset</Button>
        )}
      </div>

      <div className={styles.right}>
        <Button variant="secondary" disabled={isLocal || !vaultAdapter} onClick={() => setFundOpen(true)}>
          Fund Vault
        </Button>
        <Button variant="secondary" disabled={isLocal || !vaultAdapter} onClick={() => setWithdrawOpen(true)}>
          Withdraw Vault
        </Button>
      </div>

      <VaultModal
        open={fundOpen}
        title="Fund Expense Vault"
        modeLabel="Fund"
        onClose={() => setFundOpen(false)}
        onConfirm={vaultAdapter ? vaultAdapter.fund : undefined}
      />

      <VaultModal
        open={withdrawOpen}
        title="Withdraw from Expense Vault"
        modeLabel="Withdraw"
        onClose={() => setWithdrawOpen(false)}
        onConfirm={vaultAdapter ? vaultAdapter.withdraw : undefined}
      />
    </section>
  );
}
