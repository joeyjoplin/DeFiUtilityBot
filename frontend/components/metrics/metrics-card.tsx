import styles from "./metrics-card.module.css"

export function MetricsCard({
    title,
    value,
    sub,
    icon,
    rightBadge
}: {
    title: string;
    value: string;
    sub?: string;
    icon?: React.ReactNode;
    rightBadge?: React.ReactNode;
}) {
    return (
        <div className={styles.card}>
            <div className={styles.top}>
                <div>
                    <div className={styles.title}>{title}</div>
                    <div className={styles.value}>{value}</div>
                    {sub && <div className={styles.sub}>{sub}</div>}
                    </div>
                    <div className={styles.icon}>{icon}</div>
            </div>
            {rightBadge && <div className={styles.rightBadge}>{rightBadge}</div>}
        </div>
    );
}