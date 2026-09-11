import { ReactNode } from "react";
import styles from "../../page.module.css";

type StepScreenProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
};

export function StepScreen({ eyebrow, title, description, children }: StepScreenProps) {
  return <section className={styles.stepScreen} aria-labelledby="step-title">
    <header className={styles.stepScreenHeader}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id="step-title">{title}</h2>
      <p>{description}</p>
    </header>
    {children}
  </section>;
}
