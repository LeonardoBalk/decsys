import styles from "../../page.module.css";

export type ValidationIssue = { severity: string; row_number: number | null; field: string | null; message: string };

const VISIBLE_ISSUES = 20;

type ValidationIssueListProps = { issues: ValidationIssue[]; fieldLabels?: Record<string, string> };

export function ValidationIssueList({ issues, fieldLabels = {} }: ValidationIssueListProps) {
  if (!issues.length) return null;
  return <>
    <h3 className={styles.issueHeading}>Linhas para revisar</h3>
    <ul className={styles.validationIssueList}>
      {issues.slice(0, VISIBLE_ISSUES).map((issue, issuePosition) => <li key={`${issue.row_number}-${issue.field}-${issuePosition}`}>
        <strong>{issue.row_number ? `Linha ${issue.row_number}` : "Arquivo"}{issue.field ? ` · ${fieldLabels[issue.field] ?? issue.field}` : ""}:</strong> {issue.message}
      </li>)}
    </ul>
    {issues.length > VISIBLE_ISSUES ? <p className={styles.fieldNote}>Exibindo {VISIBLE_ISSUES} de {issues.length.toLocaleString("pt-BR")} pendências. Baixe a base completa para revisar todas.</p> : null}
  </>;
}
