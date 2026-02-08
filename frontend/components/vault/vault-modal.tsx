"use client";

import React, { useEffect, useMemo, useState } from "react";
import styles from "./vault-modal.module.css";
import { Button } from "@/components/controls/button";

type Props = {
    open: boolean;
    title: string;
    modeLabel: "Fund" | "Withdraw";
    onClose: () => void;
    onConfirm?: (amountUsdc: string) => Promise<void>;
};

function isValidAmount(v: string) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
}

export function VaultModal({ open, title, modeLabel, onClose, onConfirm }: Props) {
    const [amount, setAmount] = useState("");
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const canConfirm = useMemo(() => isValidAmount(amount) && !isBusy, [amount, isBusy]);

    useEffect(() => {
        if (!open) return;
        setAmount("");
        setIsBusy(false);
        setError(null);
        setSuccess(null);
    }, [open]);

    if (!open) return null;

    async function handleConfirm() {
        setError(null);
        setSuccess(null);

        if (!isValidAmount(amount)) {
            setError("Enter a valid amount.");
            return;
        }

        setIsBusy(true);
        try {
            if (onConfirm) {
                await onConfirm(amount);
                setSuccess(`${modeLabel} request sent.`);
            } else {
                await new Promise((r) => setTimeout(r, 900));
                setSuccess("Integration pending (UI-only).");
            }
        } catch (e: any) {
            setError(e?.message ?? "Something went wrong.");
        } finally {
            setIsBusy(false);
        }
    }

    return (
        <div className={styles.backdrop} onMouseDown={onClose}>
            <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
                <div className={styles.header}>
                    <div className={styles.title}>{title}</div>
                    <button className={styles.close} onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>

                <div className={styles.note}>
                    This action requires an on-chain transaction. Contract/MCP integration will be plugged in by the backend owner.
                </div>

                <div className={styles.formRow}>
                    <div className={styles.label}>Amount</div>
                    <div className={styles.inputWrap}>
                        <input
                            className={styles.input}
                            inputMode="decimal"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            disabled={isBusy}
                        />
                        <span className={styles.suffix}>USDC</span>
                    </div>
                </div>

                <div className={styles.footer}>
                    <Button variant="secondary" onClick={onClose} disabled={isBusy}>
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm} disabled={!canConfirm}>
                        {isBusy ? "Processing…" : modeLabel}
                    </Button>
                </div>

                {error && <div className={styles.error}>{error}</div>}
                {success && <div className={styles.success}>{success}</div>}
            </div>
        </div>
    );
}