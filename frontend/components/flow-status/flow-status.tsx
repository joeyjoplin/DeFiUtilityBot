"use client";

import styles from "./flow-status.module.css";
import { FlowItem } from "./flow-item";
import { useSimulation } from "../simulation/simulation-context";
import type { FlowState } from "../simulation/types";


const steps: FlowState[] = [
  "NEED_ACCESS",
  "AWAITING_AUTHORIZATION",
  "AUTHORIZATION_CONFIRMED",
  "ACCESSING_RESOURCE",
  "COMPLETED",
];


const stepLabel: Record<FlowState, string> = {
  NEED_ACCESS: "Access requested",
  AWAITING_AUTHORIZATION: "Authorization required",
  AUTHORIZATION_CONFIRMED: "Authorization confirmed",
  ACCESSING_RESOURCE: "Accessing service",
  COMPLETED: "Completed",
  ABORTED: "Aborted",
};


function stepIndex(step: FlowState) {
  const idx = steps.indexOf(step);
  return idx === -1 ? 0 : idx;
}

export function FlowStatus() {
  const { state } = useSimulation();

  const currentIdx = stepIndex(state.flowState);
  const isAborted = state.flowState === "ABORTED";

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>Current Flow</h2>
        <span className={styles.sub}>{state.isRunning ? "Running" : "Ready"}</span>
      </div>

      <div className={styles.list}>
        {steps.map((s, idx) => (
          <FlowItem
            key={s}
            label={stepLabel[s]}
            status={idx < currentIdx ? "done" : idx === currentIdx ? "active" : "todo"}
          />
        ))}
      </div>

      {isAborted ? (
        <div className={styles.abortBadge}>
          Flow aborted!
        </div>
      ) : null}
    </div>
  );
}
