"use client";

import styles from "./page.module.css";
import { Header } from "../components/header/header";
import { MetricsRow } from "@/components/metrics/metrics-row";
import { ActionBar } from "@/components/controls/action-bar";
import { EventTimeline } from "@/components/timeline/event-timeline";

export default function Page() {
  return (
    <main className={styles.page}>
      <Header />
      <ActionBar />
      <MetricsRow />
      <section className={styles.gridMain}>
        <EventTimeline />
      </section>
    </main>
  );
}
