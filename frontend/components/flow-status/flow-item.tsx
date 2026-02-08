import styles from "./flow-status.module.css";

export function FlowItem({
  label,
  status,
}: {
  label: string;
  status: "done" | "active" | "todo";
}) {
  const showInProgress = status === "active" && label !== "Need fuel" && label !== "Done";

  return (
    <div className={styles.item}>
      <span
        className={`${styles.dot} ${
          status === "done"
            ? styles.dotDone
            : status === "active"
            ? styles.dotActive
            : styles.dotTodo
        }`}
      />
      <span className={`${styles.label} ${status === "active" ? styles.labelActive : ""}`}>
        {label}
      </span>
      {status === "active" ? <span className={styles.badge}>In Progress</span> : null}
    </div>
  );
}
