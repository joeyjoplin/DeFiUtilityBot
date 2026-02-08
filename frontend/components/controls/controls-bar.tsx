"use client";

import styles from "./controls-bar.module.css";
import { ToggleOption } from "./toggle-option";
import { useSimulation } from "../simulation/simulation-context";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function ControlsBar() {
    const { state, setMode, setBusinessCase } = useSimulation();
    const isLocal = state.mode === "local";

    return (
        <div className={styles.controls}>
            <div className={styles.mode}>
                <ToggleOption
                    label={`Local Simulation: ${isLocal ? "ON" : "OFF"}`}
                    active={isLocal}
                    onClick={() => setMode(isLocal ? "testnet" : "local")}
                />
                
                <div className={styles.selection}>
                    <span className={styles.selectionLabel}>Selection Mode:</span>
                    <select
                        className={styles.selectionSelect}
                        value={state.selectedBusinessCase ?? "vending_machine"}
                        onChange={(e) => setBusinessCase(e.target.value as any)}
                    >
                        <option value="vending_machine">Vending Machine</option>
                        <option value="laundry">Laundry</option>
                        <option value="gas_station">Gas Station</option>
                    </select>
                </div>
            </div>
            <ConnectButton />
        </div>
    )
}
