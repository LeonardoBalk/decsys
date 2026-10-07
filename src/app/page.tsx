import type { Route } from "next";
import Link from "next/link";
import { ArrowRight, BadgeCheck, ClipboardCheck, Compass, FileSearch, FileUp, Gauge } from "lucide-react";
import styles from "./page.module.css";
import landing from "./landing.module.css";
import { collectionDimensions, collectionItems, countByAccess } from "@/lib/coleta-catalog";

const FLOW_STEPS = [
  { icon: Compass, title: "Encontre a fonte", text: "Em “Onde coletar”, veja de onde vem cada um dos indicadores da matriz e se dá para importar por link, se precisa baixar o arquivo ou se depende da prefeitura.", href: "/coleta" },
  { icon: FileUp, title: "Importe o arquivo", text: "Cole o link ou envie CSV, XLSX, XLS, JSON ou ZIP. O original fica guardado e nada é publicado nessa etapa.", href: "/importar" },
  { icon: FileSearch, title: "Confira a leitura", text: "Veja abas, colunas, tipos e avisos de qualidade antes de seguir. Se a leitura estiver errada, descarte e tente outra aba ou arquivo.", href: "/importar" },
  { icon: ClipboardCheck, title: "Mapeie e aprove", text: "Indique município, período, valor e indicador. Linhas inválidas viram pendências e ficam fora; só o que passou na validação é publicado.", href: "/importacoes" },
  { icon: Gauge, title: "Acompanhe o IIU", text: "Os valores aprovados alimentam o Índice de Inteligência Urbana. Pesos e faixas de referência podem mudar sem reimportar nada.", href: "/iiu" }
] as const;

const GOOD_TO_KNOW = [
  { title: "Aprovar não é o mesmo que publicar", text: "Só a aprovação municipal grava valores no painel. A aprovação genérica apenas registra a proposta de mapeamento." },
  { title: "Nada se perde", text: "A linha original de cada importação é preservada. Descartar uma importação não desfaz valores já publicados." },
  { title: "Limites de leitura", text: "Links precisam ser HTTPS e públicos. O limite padrão é de 200 MB por arquivo, também para o que está dentro de um ZIP." },
  { title: "Ausência não é zero", text: "Indicador sem valor ou sem faixa de referência fica sem pontuação, em vez de entrar no índice como zero." }
] as const;

export default function HomePage() {
  const totals = countByAccess();
  const dimensions = collectionDimensions().map((name) => {
    const items = collectionItems.filter((item) => item.dimension === name);
    return { name, total: items.length, ...countByAccess(items) };
  });

  return <main className={styles.workspaceShell}>
    <section className={landing.hero}>
      <p className={styles.eyebrow}>DECSYS</p>
      <h1>Do dado público ao índice de inteligência urbana</h1>
      <p className={landing.lead}>O DECSYS reúne planilhas e bases públicas sobre os municípios, mostra o que foi lido, deixa você conferir cada valor e só então publica o resultado no painel do IIU. Cada número mantém a origem.</p>
      <div className={landing.ctaRow}>
        <Link className={styles.primaryLink} href="/coleta">Ver onde coletar cada dado<ArrowRight size={16} /></Link>
        <Link className={styles.secondaryLink} href="/importar"><FileUp size={16} />Nova importação</Link>
      </div>
    </section>

    <section aria-label="Resumo da cobertura" className={landing.stats}>
      <div><strong>{collectionItems.length}</strong><span>indicadores na matriz</span></div>
      <div><strong>{dimensions.length}</strong><span>dimensões</span></div>
      <div><strong>{totals.link}</strong><span>importáveis por link</span></div>
      <div><strong>{totals.manual}</strong><span>com download manual</span></div>
      <div><strong>{totals.local}</strong><span>dependem da prefeitura</span></div>
    </section>

    <section className={landing.section}>
      <div className={landing.sectionHead}><h2>Como funciona</h2><p>Cinco passos, sempre com uma pessoa conferindo antes de qualquer valor ser publicado.</p></div>
      <ol className={landing.steps}>
        {FLOW_STEPS.map(({ icon: StepIcon, title, text, href }, index) => <li key={title}>
          <Link className={landing.stepCard} href={href as Route}>
            <span className={landing.stepNumber}>{index + 1}</span>
            <StepIcon aria-hidden size={20} strokeWidth={1.5} />
            <strong>{title}</strong>
            <span>{text}</span>
          </Link>
        </li>)}
      </ol>
    </section>

    <section className={landing.section}>
      <div className={landing.sectionHead}><h2>Dimensões da matriz</h2><p>Quanto de cada dimensão já tem um caminho de coleta definido.</p></div>
      <ul className={landing.dimensions}>
        {dimensions.map((dimension) => <li key={dimension.name}>
          <div className={landing.dimensionTop}><strong>{dimension.name}</strong><span>{dimension.total} indicadores</span></div>
          <div aria-hidden className={landing.bar}>
            <i className={landing.barLink} style={{ flexGrow: dimension.link }} />
            <i className={landing.barManual} style={{ flexGrow: dimension.manual }} />
            <i className={landing.barLocal} style={{ flexGrow: dimension.local }} />
          </div>
          <p className={landing.legend}><span className={landing.dotLink} />{dimension.link} por link<span className={landing.dotManual} />{dimension.manual} manual<span className={landing.dotLocal} />{dimension.local} prefeitura</p>
        </li>)}
      </ul>
    </section>

    <section className={landing.section}>
      <div className={landing.sectionHead}><h2>Bom saber antes de começar</h2></div>
      <ul className={landing.notes}>
        {GOOD_TO_KNOW.map((note) => <li key={note.title}><BadgeCheck aria-hidden size={18} strokeWidth={1.5} /><div><strong>{note.title}</strong><p>{note.text}</p></div></li>)}
      </ul>
    </section>
  </main>;
}
