import { TimelineEvent, TimelineEventType } from "../simulation/types";

export function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour12: false });
}

function safeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now());
}

export function createTimelineEvent(
  type: TimelineEventType,
  title: string,
  description: string,
  opts?: Partial<TimelineEvent>
): TimelineEvent {
  return {
    id: safeId(),
    type,
    title,
    description,
    timestamp: Date.now(),
    status: "info",
    ...opts,
  };
}