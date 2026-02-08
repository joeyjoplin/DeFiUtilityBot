import styles from "./event-timeline.module.css";
import { useSimulation } from "../simulation/simulation-context";
import { EventItem } from "./event-item";

export function EventTimeline() {
  const { state } = useSimulation();
  const timeline = state.timeline;

  return (
    <section className={styles.card}>
      <div className={styles.cardTitle}>Event Timeline</div>

      {timeline.length === 0 ? (
        <div className={styles.empty}>Waiting for events…</div>
      ) : (
        <div className={styles.timeline}>
          {timeline.map((event) => (
            <EventItem key={event.id} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}