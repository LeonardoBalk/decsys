import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";

type SourcePreviewTableProps = { sourceProfile: SourceProfile };

export function SourcePreviewTable({ sourceProfile }: SourcePreviewTableProps) {
  const sourceFields = sourceProfile.sample[0] ? Object.keys(sourceProfile.sample[0]) : [];
  return <section className={styles.tableWorkspace} id="dados-revisados">
    <div className={styles.tableHeading}><div><p className={styles.eyebrow}>PRÉVIA DO ARQUIVO</p><h2>Dados como planilha</h2></div><span>{sourceProfile.rows.toLocaleString("pt-BR")} registros na origem</span></div>
    <div className={styles.tableWrap}><table><thead><tr>{sourceFields.map((fieldName) => <th key={fieldName}>{fieldName}</th>)}</tr></thead><tbody>{sourceProfile.sample.map((sourceRecord, rowIndex) => <tr key={rowIndex}>{sourceFields.map((fieldName) => <td key={`${rowIndex}-${fieldName}`}>{sourceRecord[fieldName] ?? ""}</td>)}</tr>)}</tbody></table></div>
  </section>;
}
