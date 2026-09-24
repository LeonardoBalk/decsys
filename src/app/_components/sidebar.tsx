"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MouseEvent } from "react";
import { ChartNoAxesCombined, Database, FileUp, History, ListTree } from "lucide-react";
import styles from "../page.module.css";
import { confirmLeavingUnsavedWork } from "@/lib/unsaved-changes";

const navigationItems = [
  { href: "/", label: "Nova importação", icon: FileUp, isActive: (pathname: string) => pathname === "/" },
  { href: "/importacoes", label: "Importações salvas", icon: History, isActive: (pathname: string) => pathname.startsWith("/importacoes") },
  { href: "/dados-revisados", label: "Dados revisados", icon: Database, isActive: (pathname: string) => pathname.startsWith("/dados-revisados") },
  { href: "/indicadores", label: "Indicadores", icon: ListTree, isActive: (pathname: string) => pathname.startsWith("/indicadores") },
  { href: "/iiu", label: "Índice IIU", icon: ChartNoAxesCombined, isActive: (pathname: string) => pathname.startsWith("/iiu") },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  function guardNavigation(event: MouseEvent<HTMLAnchorElement>) {
    if (!confirmLeavingUnsavedWork()) event.preventDefault();
  }

  return <aside className={styles.sidebar}>
    <div className={styles.sidebarTop}>
      <p className={styles.productName}>DECSYS</p>
      <nav aria-label="Navegação principal">
        {navigationItems.map(({ href, label, icon: NavigationIcon, isActive }) => {
          const active = isActive(pathname);
          return <Link aria-current={active ? "page" : undefined} className={active ? styles.activeNav : undefined} href={href} key={href} onClick={guardNavigation}><NavigationIcon size={20} strokeWidth={1.5} />{label}</Link>;
        })}
      </nav>
    </div>
  </aside>;
}
