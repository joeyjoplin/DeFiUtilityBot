export type SimulationMode = "local" | "testnet";
export type BusinessCase = "vending_machine" | "laundry" | "gas_station";

export type FlowState =
    | "NEED_ACCESS"
    | "AWAITING_AUTHORIZATION"
    | "AUTHORIZATION_CONFIRMED"
    | "ACCESSING_RESOURCE"
    | "COMPLETED"
    | "ABORTED";

export type TimelineEventType =
    | "QUOTE_REQUESTED"
    | "PAYMENT_REQUIRED_402"
    | "PAYMENT_SUBMITTED"
    | "PAYMENT_VERIFIED"
    | "ACCESS_GRANTED"
    | "RESOURCE_ACCESS_STARTED"
    | "SERVICE_FULFILLED"
    | "FLOW_ABORTED"
    | "ERROR";

export interface TimelineEvent {
    id: string;
    type: TimelineEventType;
    title: string;
    description: string;
    timestamp: number;
    meta?: Record<string, string | number | boolean>;
    status?: "success" | "warning" | "info" | "error";
}

export interface DashboardStats {
    expenseVaultBalanceUsdc: number;
    yieldEarnedUsdc: number;
    lastPaymentTimestamp?: number;
    lastPaymentAmountUsdc?: number;
    lastPaymentTxHash?: string;
    paymentGateStatus: "Verified" | "Pending" | "None";
}

export interface SimulationState {
    mode: SimulationMode;
    isRunning: boolean;
    flowState: FlowState;
    flowStartedAt?: number;
    timeline: TimelineEvent[];
    dashboardStats: DashboardStats;
    selectedBusinessCase: BusinessCase | null;
}
