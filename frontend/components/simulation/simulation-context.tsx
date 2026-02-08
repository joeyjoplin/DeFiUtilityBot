"use client";

import React, { createContext, useContext, useCallback, useMemo, useState, useEffect, useRef } from "react";
import type { SimulationMode, SimulationState, TimelineEvent, BusinessCase } from "./types";

const MOCK_VAULT_BALANCE_USDC = 125.4;
const MOCK_YIELD_EARNED_USDC = 0.38;

const initialState: SimulationState = {
  mode: "local",
  isRunning: false,
  flowState: "NEED_ACCESS",
  flowStartedAt: undefined,
  timeline: [],
  dashboardStats: {
    expenseVaultBalanceUsdc: MOCK_VAULT_BALANCE_USDC,
    yieldEarnedUsdc: MOCK_YIELD_EARNED_USDC,
    paymentGateStatus: "None",
    lastPaymentTimestamp: undefined,
    lastPaymentAmountUsdc: undefined,
    lastPaymentTxHash: undefined,
  },
  selectedBusinessCase: "vending_machine",
};

function safeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
}

function addEvent(prev: TimelineEvent[], ev: Omit<TimelineEvent, "id" | "timestamp">): TimelineEvent[] {
  return [...prev, { id: safeId(), timestamp: Date.now(), ...ev }];
}

function randomInRange(min: number, max: number) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function getMockPaymentForBusinessCase(bc: BusinessCase | null) {
  switch (bc) {
    case "vending_machine":
      return randomInRange(10, 20);
    case "laundry":
      return randomInRange(10, 20);
    case "gas_station":
      return randomInRange(10, 20);
    default:
      return randomInRange(10, 20);
  }
}

type SimulationContextValue = {
  state: SimulationState;
  setMode: (mode: SimulationMode) => void;
  setBusinessCase: (businessCase: BusinessCase | null) => void;
  start: () => Promise<void>;
  abort: (reason?: string) => void;
  reset: () => void;
  sessionDurationSec: number;
};

const SimulationContext = createContext<SimulationContextValue | null>(null);

export function SimulationProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SimulationState>(initialState);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (state.mode === "local") {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001";

    async function fetchTimeline() {
      const resp = await fetch(`${serverUrl}/ui/timeline?limit=100`);
      if (!resp.ok) throw new Error(`timeline fetch failed: ${resp.status}`);
      const data = await resp.json();
      return Array.isArray(data.items) ? data.items : [];
    }

    async function pollBackendTimeline() {
      try {
        const timeline = await fetchTimeline();

        setState((s) => {
          const lastPaymentEvent = timeline.find((e: TimelineEvent) =>
            e.type === "PAYMENT_VERIFIED" || e.type === "PAYMENT_SUBMITTED" || e.type === "ACCESS_GRANTED"
          );
          const lastTxHash =
            (lastPaymentEvent?.meta as any)?.tx_hash ||
            (lastPaymentEvent?.meta as any)?.txHash ||
            (timeline.find((e: TimelineEvent) => (e.meta as any)?.tx_hash)?.meta as any)?.tx_hash;

          const latest = timeline[timeline.length - 1];
          const flowState =
            latest?.type === "PAYMENT_REQUIRED_402"
              ? "AWAITING_AUTHORIZATION"
              : latest?.type === "PAYMENT_VERIFIED" || latest?.type === "ACCESS_GRANTED"
                ? "AUTHORIZATION_CONFIRMED"
                : latest?.type === "SERVICE_FULFILLED"
                  ? "COMPLETED"
                  : latest?.type === "FLOW_ABORTED" || latest?.type === "ERROR"
                    ? "ABORTED"
                    : latest?.type === "QUOTE_REQUESTED"
                      ? "NEED_ACCESS"
                      : s.flowState;

          const paymentGateStatus =
            timeline.some((e: TimelineEvent) => e.type === "PAYMENT_VERIFIED" || e.type === "ACCESS_GRANTED")
              ? "Verified"
              : timeline.some((e: TimelineEvent) => e.type === "PAYMENT_REQUIRED_402")
                ? "Pending"
                : "None";

          const shouldStop =
            timeline.some((e: TimelineEvent) =>
              ["ACCESS_GRANTED", "SERVICE_FULFILLED", "FLOW_ABORTED", "ERROR"].includes(e.type)
            );

          return {
            ...s,
            isRunning: shouldStop ? false : s.isRunning,
            flowState,
            timeline,
            dashboardStats: {
              ...s.dashboardStats,
              paymentGateStatus,
              lastPaymentTimestamp: lastPaymentEvent?.timestamp,
              lastPaymentAmountUsdc: (lastPaymentEvent?.meta as any)?.total_usd ?? s.dashboardStats.lastPaymentAmountUsdc,
              lastPaymentTxHash: lastTxHash ?? s.dashboardStats.lastPaymentTxHash,
            },
          };
        });
      } catch (err) {
        console.error("poll error:", err);
      }
    }

    pollBackendTimeline();
    pollTimerRef.current = window.setInterval(pollBackendTimeline, 3000);

    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [state.mode]);

  useEffect(() => {
  if (state.mode !== "local") return;

  const id = window.setInterval(() => {
    setState((s) => {
      const bump = Math.random() * 0.18 + 0.07;
      return {
        ...s,
        dashboardStats: {
          ...s.dashboardStats,
          yieldEarnedUsdc: +(s.dashboardStats.yieldEarnedUsdc + bump).toFixed(2),
        },
      };
    });
  }, 12000);

  return () => window.clearInterval(id);
}, [state.mode]);

  const setMode = useCallback((mode: SimulationMode) => {
    setState((s) => ({ ...s, mode }));
  }, []);

  const setBusinessCase = useCallback((businessCase: BusinessCase | null) => {
    setState((s) => ({ ...s, selectedBusinessCase: businessCase }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => {
      if (s.mode !== "local") return s;

      return {
        ...s,
        isRunning: false,
        flowStartedAt: undefined,
        flowState: "NEED_ACCESS",
        timeline: [],
        dashboardStats: {
          ...s.dashboardStats,
          expenseVaultBalanceUsdc: MOCK_VAULT_BALANCE_USDC,
          yieldEarnedUsdc: MOCK_YIELD_EARNED_USDC,
          paymentGateStatus: "None",
          lastPaymentTimestamp: undefined,
          lastPaymentAmountUsdc: undefined,
          lastPaymentTxHash: undefined,
        },
      };
    });
  }, []);

  const abort = useCallback((reason?: string) => {
    setState((s) => ({
      ...s,
      flowState: "ABORTED",
      isRunning: false,
      timeline: addEvent(s.timeline, {
        type: "FLOW_ABORTED",
        title: "Flow Aborted",
        description: reason ?? "Simulation aborted manually",
        status: "error",
      }),
    }));
  }, []);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const start = useCallback(async () => {
    setState((s) => ({
      ...s,
      isRunning: true,
      flowStartedAt: Date.now(),
      flowState: "NEED_ACCESS",
      timeline: [],
      dashboardStats: { ...s.dashboardStats, paymentGateStatus: "None" },
    }));

    if (state.mode === "local") {
      setState((s) => ({
        ...s,
        timeline: addEvent(s.timeline, {
          type: "QUOTE_REQUESTED",
          title: "Quote Requested",
          description: `Requested a quote for ${s.selectedBusinessCase ?? "vending_machine"}`,
          status: "info",
        }),
      }));

      await wait(500);

      setState((s) => ({
        ...s,
        flowState: "AWAITING_AUTHORIZATION",
        timeline: addEvent(s.timeline, {
          type: "PAYMENT_REQUIRED_402",
          title: "402 Payment Required",
          description: "Payment gate enforced (mock)",
          status: "warning",
          meta: { Gate: "0x402" },
        }),
      }));

      await wait(700);

      setState((s) => ({
        ...s,
        flowState: "AUTHORIZATION_CONFIRMED",
        dashboardStats: { ...s.dashboardStats, paymentGateStatus: "Verified" },
        timeline: addEvent(s.timeline, {
          type: "PAYMENT_VERIFIED",
          title: "Payment Verified",
          description: "Payment confirmed (mock)",
          status: "success",
        }),
      }));

      await wait(600);

      setState((s) => ({
        ...s,
        flowState: "ACCESSING_RESOURCE",
        timeline: addEvent(s.timeline, {
          type: "RESOURCE_ACCESS_STARTED",
          title: "Service Started",
          description: "Service is being fulfilled (mock)",
          status: "info",
        }),
      }));

      await wait(900);

      const mockPayment = getMockPaymentForBusinessCase(state.selectedBusinessCase);

      setState((s) => ({
        ...s,
        flowState: "COMPLETED",
        isRunning: false,
        dashboardStats: {
          ...s.dashboardStats,
          lastPaymentAmountUsdc: mockPayment,
          lastPaymentTimestamp: Date.now(),
          lastPaymentTxHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
          expenseVaultBalanceUsdc: +(s.dashboardStats.expenseVaultBalanceUsdc - mockPayment).toFixed(2),
        },
        timeline: addEvent(s.timeline, {
          type: "SERVICE_FULFILLED",
          title: "Service Fulfilled",
          description: "Flow completed successfully (mock)",
          status: "success",
        }),
      }));

      return;
    }

  }, [state.mode]);

  const sessionDurationSec = state.flowStartedAt ? Math.floor((Date.now() - state.flowStartedAt) / 1000) : 0;

  const value = useMemo(
    () => ({ state, setMode, setBusinessCase, start, abort, reset, sessionDurationSec }),
    [state, setMode, setBusinessCase, start, abort, reset, sessionDurationSec]
  );

  return <SimulationContext.Provider value={value}>{children}</SimulationContext.Provider>;
}

export function useSimulation() {
  const ctx = useContext(SimulationContext);
  if (!ctx) throw new Error("useSimulation must be used inside <SimulationProvider />");
  return ctx;
}
