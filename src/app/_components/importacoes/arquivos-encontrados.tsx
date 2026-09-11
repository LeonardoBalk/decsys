import { FileText } from "lucide-react";
import styles from "../../page.module.css";
import { DownloadCandidate } from "@/lib/types/importacao";

type FoundFilesProps = {
  candidates: DownloadCandidate[];
  onSelect: (sourceUrl: string) => void;
};

export function FoundFiles({ candidates, onSelect }: FoundFilesProps) {
  if (candidates.length === 0) return null;
  return <section className={styles.downloadCandidates}>
    <p className={styles.eyebrow}>ARQUIVOS ENCONTRADOS</p>
    <h2>Escolha o arquivo que será analisado</h2>
    {candidates.map((candidate) => <button key={candidate.url} onClick={() => onSelect(candidate.url)} type="button"><FileText size={16} strokeWidth={1.5} />{candidate.name}</button>)}
  </section>;
}
