import { AlertCircle, CheckCircle2, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { ReactNode } from "react";
import styles from "../page.module.css";

type StatusVariant = "success" | "error" | "warning" | "info" | "loading";

type StatusNoticeProps = {
  variant: StatusVariant;
  title?: string;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
};

const variantIcons = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
  loading: LoaderCircle,
};

const variantRoles: Record<StatusVariant, "alert" | "status"> = {
  success: "status",
  error: "alert",
  warning: "status",
  info: "status",
  loading: "status",
};

const variantClasses: Record<StatusVariant, string> = {
  success: styles.statusNoticeSuccess,
  error: styles.statusNoticeError,
  warning: styles.statusNoticeWarning,
  info: styles.statusNoticeInfo,
  loading: styles.statusNoticeLoading,
};

export function StatusNotice({ variant, title, children, action }: StatusNoticeProps) {
  const StatusIcon = variantIcons[variant];
  const statusRole = variantRoles[variant];

  return <div aria-live={statusRole === "alert" ? "assertive" : "polite"} className={`${styles.statusNotice} ${variantClasses[variant]}`} role={statusRole}>
    <StatusIcon aria-hidden="true" className={variant === "loading" ? styles.statusNoticeSpinner : styles.statusNoticeIcon} size={18} strokeWidth={1.8} />
    <div className={styles.statusNoticeContent}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
    {action ? <button className={styles.statusNoticeAction} onClick={action.onClick} type="button">{action.label}</button> : null}
  </div>;
}
