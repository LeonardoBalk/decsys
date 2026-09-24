import type { Metadata } from "next";
import { Inter, Source_Code_Pro } from "next/font/google";
import "@/styles/tokens.css";
import "./globals.css";
import styles from "./page.module.css";
import { Sidebar } from "./_components/sidebar";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", weight: "variable", display: "swap" });
const sourceCodePro = Source_Code_Pro({ subsets: ["latin"], variable: "--font-source-code-pro", display: "swap" });

export const metadata: Metadata = {
  title: "Decsys",
  description: "Revisão e tratamento de indicadores urbanos"
};

export default function DecsysLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${inter.variable} ${sourceCodePro.variable}`} lang="pt-BR">
      <body>
        <div className={styles.applicationShell}>
          <Sidebar />
          {children}
        </div>
      </body>
    </html>
  );
}
