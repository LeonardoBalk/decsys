"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MouseEvent } from "react";
import { ChartNoAxesCombined, Compass, Database, FileUp, History, House, ListTree, SlidersHorizontal } from "lucide-react";
import styles from "../page.module.css";
import { confirmLeavingUnsavedWork } from "@/lib/unsaved-changes";

type NavigationItem = { href: Route; label: string; icon: typeof House; isActive: (pathname: string) => boolean };

const navigationGroups: { label: string | null; items: NavigationItem[] }[] = [
  { label: null, items: [{ href: "/", label: "Início", icon: House, isActive: (pathname) => pathname === "/" }] },
  {
    label: "Dados",
    items: [
      { href: "/coleta", label: "Onde coletar", icon: Compass, isActive: (pathname) => pathname.startsWith("/coleta") },
      { href: "/importar", label: "Nova importação", icon: FileUp, isActive: (pathname) => pathname.startsWith("/importar") && !pathname.startsWith("/importacoes") },
      { href: "/importacoes", label: "Importações salvas", icon: History, isActive: (pathname) => pathname.startsWith("/importacoes") },
      { href: "/dados-revisados", label: "Dados revisados", icon: Database, isActive: (pathname) => pathname.startsWith("/dados-revisados") },
      { href: "/indicadores", label: "Indicadores", icon: ListTree, isActive: (pathname) => pathname.startsWith("/indicadores") }
    ]
  },
  {
    label: "Painéis",
    items: [
      { href: "/iiu", label: "Índice IIU", icon: ChartNoAxesCombined, isActive: (pathname) => pathname === "/iiu" },
      { href: "/iiu/configuracao", label: "Pesos e benchmarks", icon: SlidersHorizontal, isActive: (pathname) => pathname.startsWith("/iiu/configuracao") }
    ]
  }
];

export function Sidebar() {
  const pathname = usePathname();

  function guardNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (!confirmLeavingUnsavedWork()) event.preventDefault();
  }

  return <aside className={styles.sidebar}>
    <div className={styles.sidebarTop}>
      <Link className={styles.brandLink} href="/" onClick={guardNavigation}>
        <p className={styles.productName}>DECSYS</p>
        <span className={styles.brandTagline}>Dados para cidades inteligentes</span>
      </Link>
      <nav aria-label="Navegação principal">
        {navigationGroups.map((group) => <div className={styles.navGroup} key={group.label ?? "inicio"}>
          {group.label ? <p className={styles.navGroupLabel}>{group.label}</p> : null}
          {group.items.map(({ href, label, icon: NavigationIcon, isActive }) => {
            const active = isActive(pathname);
            return <Link aria-current={active ? "page" : undefined} className={active ? styles.activeNav : undefined} href={href} key={href} onClick={guardNavigation}><NavigationIcon size={18} strokeWidth={1.5} />{label}</Link>;
          })}
        </div>)}
      </nav>
    </div>
    <p className={styles.sidebarFootnote}>Ferramenta interna de pesquisa</p>
  </aside>;
}
