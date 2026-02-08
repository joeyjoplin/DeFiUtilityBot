"use client";

import styles from "./header.module.css";
import { ControlsBar } from "../controls/controls-bar";

export function Header() {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>DeFi Utility Bots</h1>
      <ControlsBar />
    </header>
  );
}
