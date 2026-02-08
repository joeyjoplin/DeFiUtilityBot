import styles from "./event-timeline.module.css";
import { TimelineEvent } from "../simulation/types";
import { formatTime } from "../simulation/engine";

export function EventItem({ event }: { event: TimelineEvent }) {
    const statusClass =
        event.status === "success" ? styles.success :
            event.status === "warning" ? styles.warning :
                event.status === "error" ? styles.error : styles.info;
    return (
        <div className={styles.item}>
            <div className={`${styles.dot} ${statusClass}`} />
            <div className={styles.content}>
                <div className={styles.line1}>
                    <div className={styles.title}>{event.title}</div>
                    <div className={styles.time}>{formatTime(event.timestamp)}</div>
                </div>
                <div className={styles.desc}>{event.description}</div>
                {event.meta && (
                    <div className={styles.meta}>
                        {Object.entries(event.meta).map(([key, value]) => (
                            <span key={key} className={styles.metaItem}>
                                {key}: {value}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}