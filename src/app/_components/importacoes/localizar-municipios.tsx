import { useEffect, useMemo, useState } from "react";
import styles from "../../page.module.css";
import { SourceProfile } from "@/lib/types/importacao";
import { importErrorMessage } from "@/lib/import-error-message";
import { blankNameRows, confirmedMatches, currentChoice, GroupFilter, groupMatches, matchesFilter, MunicipalityDecision, MunicipalityMatch, needsDecision, normalizedSearchText } from "@/lib/municipality-decisions";
import { StatusNotice } from "../status-notice";
import { MunicipalityPicker } from "./seletor-municipio";

type MunicipalityLookupProps = {
  importId: string;
  sheetName: string | null | undefined;
  columns: SourceProfile["columns"];
  initialField: string;
  onPrepared: (municipalityField: string) => void;
};

const GROUPS_PER_PAGE = 25;

const filterLabels: Record<GroupFilter, string> = {
  pending: "Precisam de decisão",
  all: "Todos os nomes",
  exact: "Correspondências exatas",
  changed: "Alterados por você",
};

function situationLabel(status: MunicipalityMatch["status"], candidateCount: number, decision: MunicipalityDecision | undefined) {
  if (decision) return decision.ibge_code ? "Definido por você" : "Sem código (decidido)";
  if (status === "matched") return "Correspondência exata";
  if (status === "ambiguous") return candidateCount > 1 ? "Mais de uma opção" : "Confirme a UF";
  return "Sem correspondência";
}

function Pager({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return <div className={styles.pagination}>
    <span>Página {page + 1} de {pageCount}</span>
    <div>
      <button disabled={page === 0} onClick={() => onChange(page - 1)} type="button">Anterior</button>
      <button disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)} type="button">Próxima</button>
    </div>
  </div>;
}

export function MunicipalityLookup({ importId, sheetName, columns, initialField, onPrepared }: MunicipalityLookupProps) {
  const [sourceField, setSourceField] = useState(initialField);
  const [matches, setMatches] = useState<MunicipalityMatch[]>([]);
  const [decisions, setDecisions] = useState<Record<string, MunicipalityDecision>>({});
  const [searchText, setSearchText] = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("pending");
  const [page, setPage] = useState(0);
  const [isFinding, setIsFinding] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"error" | "success">("error");

  function clearResults() {
    setMatches([]);
    setDecisions({});
    setSearchText("");
    setGroupFilter("pending");
    setPage(0);
    setMessage("");
  }

  useEffect(() => {
    setSourceField(initialField);
    clearResults();
  }, [importId, sheetName, initialField]);

  const groups = useMemo(() => groupMatches(matches), [matches]);
  const blankRows = useMemo(() => blankNameRows(matches), [matches]);
  const matchesToApply = useMemo(() => confirmedMatches(groups, decisions), [groups, decisions]);
  const exactGroupCount = groups.filter((group) => group.status === "matched").length;
  const undecidedGroupCount = groups.filter((group) => needsDecision(group, decisions)).length;
  const changedGroupCount = Object.keys(decisions).length;

  const visibleGroups = useMemo(() => {
    const normalizedSearch = normalizedSearchText(searchText);
    return groups.filter((group) => matchesFilter(group, decisions, groupFilter) && (!normalizedSearch || normalizedSearchText(group.originalName).includes(normalizedSearch)));
  }, [groups, decisions, groupFilter, searchText]);
  const pageCount = Math.ceil(visibleGroups.length / GROUPS_PER_PAGE);
  const currentPage = Math.min(page, Math.max(pageCount - 1, 0));
  const pageGroups = visibleGroups.slice(currentPage * GROUPS_PER_PAGE, (currentPage + 1) * GROUPS_PER_PAGE);

  function decide(originalName: string, decision: MunicipalityDecision | null) {
    setDecisions((currentDecisions) => {
      const nextDecisions = { ...currentDecisions };
      if (decision) nextDecisions[originalName] = decision;
      else delete nextDecisions[originalName];
      return nextDecisions;
    });
  }

  function changeFilter(nextFilter: GroupFilter) {
    setGroupFilter(nextFilter);
    setPage(0);
  }

  async function findMatches() {
    setIsFinding(true);
    clearResults();
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/municipality-matches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ municipality_field: sourceField, sheet_name: sheetName }), cache: "no-store" });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não conseguimos consultar os códigos oficiais do IBGE."));
      const payload = await response.json();
      const foundMatches: MunicipalityMatch[] = payload.matches;
      setMatches(foundMatches);
      if (!foundMatches.some((match) => match.status !== "matched")) setGroupFilter("all");
      if (!foundMatches.length) {
        setMessageKind("error");
        setMessage("Esta aba não tem linhas para comparar. Nenhum dado foi alterado.");
      }
    } catch (lookupError) {
      setMessageKind("error");
      setMessage(lookupError instanceof Error ? lookupError.message : "Não foi possível consultar o catálogo do IBGE.");
    } finally {
      setIsFinding(false);
    }
  }

  async function applyMatches() {
    if (!matchesToApply.length) return;
    setIsApplying(true);
    setMessage("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(importId)}/apply-municipality-matches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ municipality_field: sourceField, sheet_name: sheetName, matches: matchesToApply }) });
      if (!response.ok) throw new Error(await importErrorMessage(response, "Não conseguimos salvar os códigos confirmados."));
      const payload = await response.json();
      const remainingRows = matches.length - payload.applied_count;
      setMessageKind("success");
      setMessage(`${payload.applied_count.toLocaleString("pt-BR")} linhas receberam código IBGE. O texto original da planilha foi mantido.${remainingRows > 0 ? ` ${remainingRows.toLocaleString("pt-BR")} linhas ficaram sem código e não serão gravadas.` : ""} Se precisar corrigir algum código, altere na tabela e confirme de novo.`);
      onPrepared(payload.municipality_field);
    } catch (applyError) {
      setMessageKind("error");
      setMessage(applyError instanceof Error ? applyError.message : "Não foi possível preparar os códigos municipais.");
    } finally {
      setIsApplying(false);
    }
  }

  return <section className={styles.processHint}>
    <strong>Localizar códigos de município</strong>
    <p>O Decsys compara os nomes da planilha com o catálogo oficial do IBGE (nome e UF, como “Campinas (SP)”). Você pode corrigir qualquer resultado, inclusive as correspondências exatas, pesquisando pelo nome ou pelo código. Cada decisão vale para todas as linhas com o mesmo nome, e nada é alterado antes da sua confirmação.</p>
    <label>Coluna com o município<select onChange={(event) => { setSourceField(event.target.value); clearResults(); }} value={sourceField}><option value="">Selecione uma coluna</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
    <button disabled={isFinding || isApplying || !sourceField} onClick={() => void findMatches()} type="button">{isFinding ? "Consultando IBGE..." : matches.length ? "Buscar de novo no IBGE" : "Buscar correspondências no IBGE"}</button>
    {isFinding ? <StatusNotice variant="loading">Consultando a lista oficial de municípios do IBGE e comparando nome e UF.</StatusNotice> : null}
    {message ? <StatusNotice variant={messageKind}>{message}</StatusNotice> : null}
    {matches.length ? <>
      <p className={styles.fieldNote}>
        {groups.length.toLocaleString("pt-BR")} nomes diferentes: {exactGroupCount.toLocaleString("pt-BR")} com correspondência exata, {undecidedGroupCount.toLocaleString("pt-BR")} aguardando sua decisão{changedGroupCount ? `, ${changedGroupCount.toLocaleString("pt-BR")} alterados por você` : ""}.
        {blankRows ? ` ${blankRows.toLocaleString("pt-BR")} linhas estão sem nome de município e ficam sem código.` : ""}
        {" "}Não fazemos aproximação automática por nomes parecidos.
      </p>
      <div className={styles.filterRow}>
        <label>Mostrar<select className={styles.filterSelect} onChange={(event) => changeFilter(event.target.value as GroupFilter)} value={groupFilter}>{(Object.keys(filterLabels) as GroupFilter[]).map((filter) => <option key={filter} value={filter}>{filterLabels[filter]}</option>)}</select></label>
        <label>Procurar nome<input onChange={(event) => { setSearchText(event.target.value); setPage(0); }} placeholder="Ex.: Bom Jesus" type="search" value={searchText} /></label>
      </div>
      {pageGroups.length ? <div className={styles.tableWrap}><table><thead><tr><th>Nome na planilha</th><th>Linhas</th><th>Situação</th><th>Código IBGE</th></tr></thead><tbody>{pageGroups.map((group) => {
        const decision = decisions[group.originalName];
        return <tr key={group.originalName}>
          <td>{group.originalName}</td>
          <td title={group.rowNumbers.slice(0, 20).join(", ")}>{group.rowNumbers.length.toLocaleString("pt-BR")}</td>
          <td>{situationLabel(group.status, group.candidates.length, decision)}</td>
          <td><MunicipalityPicker canRestore={Boolean(decision)} candidates={group.candidates} current={currentChoice(group, decision)} onChoose={(nextDecision) => decide(group.originalName, nextDecision)} onRestore={() => decide(group.originalName, null)} originalName={group.originalName} /></td>
        </tr>;
      })}</tbody></table></div> : <p className={styles.fieldNote}>{groupFilter === "pending" && !searchText ? "Nenhum nome aguardando decisão." : "Nenhum nome corresponde ao filtro."}</p>}
      <Pager onChange={setPage} page={currentPage} pageCount={pageCount} />
      <button disabled={isApplying || isFinding || matchesToApply.length === 0} onClick={() => void applyMatches()} type="button">{isApplying ? "Preparando códigos..." : `Confirmar códigos para ${matchesToApply.length.toLocaleString("pt-BR")} linhas`}</button>
      {isApplying ? <StatusNotice variant="loading">Validando os códigos no IBGE e preparando as linhas selecionadas.</StatusNotice> : null}
    </> : null}
  </section>;
}
