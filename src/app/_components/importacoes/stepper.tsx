import { Check } from "lucide-react";
import styles from "../../page.module.css";

export type ImportStep = { id: number; title: string; description: string };

type StepperProps = {
  steps: ImportStep[];
  currentStep: number;
  maxReachedStep: number;
  onSelectStep: (stepId: number) => void;
};

export function Stepper({ steps, currentStep, maxReachedStep, onSelectStep }: StepperProps) {
  return <ol className={styles.stepper} aria-label="Etapas da importação">
    {steps.map((step, index) => {
      const status = step.id < currentStep ? "completed" : step.id === currentStep ? "current" : "pending";
      const isReachable = step.id <= maxReachedStep && step.id !== currentStep;
      return <li key={step.id} className={styles.stepperItem} data-status={status}>
        {isReachable
          ? <button className={styles.stepperMarker} onClick={() => onSelectStep(step.id)} type="button" aria-current={status === "current" ? "step" : undefined}>
              {status === "completed" ? <Check size={14} strokeWidth={2} /> : step.id}
            </button>
          : <span className={styles.stepperMarker} aria-current={status === "current" ? "step" : undefined}>
              {status === "completed" ? <Check size={14} strokeWidth={2} /> : step.id}
            </span>}
        <div className={styles.stepperLabel}>
          <strong>{step.title}</strong>
          <p>{step.description}</p>
        </div>
        {index < steps.length - 1 ? <span aria-hidden="true" className={styles.stepperConnector} /> : null}
      </li>;
    })}
  </ol>;
}
