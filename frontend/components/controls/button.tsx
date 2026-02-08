"use client";

import React from "react";
import styles from "./button.module.css";

type ButtonVariant = "primary" | "secondary";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
};

export function Button({
    variant = "primary",
    className,
    ...props
}: ButtonProps) {
    return (
        <button {...props} className={[ styles.button, styles[variant], className ].filter(Boolean).join(" ")} />
    );
}