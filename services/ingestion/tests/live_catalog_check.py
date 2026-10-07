"""Verificação ao vivo dos links do catálogo de coleta (src/data/coleta/*.json).

Não faz parte dos testes unitários: depende de rede e de sites externos. Serve para detectar link quebrado
e para conferir que o importador do DECSYS ainda lê cada fonte marcada como "link".

Uso, a partir da raiz do repositório:
    .venv\\Scripts\\python.exe -m services.ingestion.tests.live_catalog_check [--only ECO01,PES01] [--workers 4]

Saída: uma linha por indicador (OK = tabela lida, PAGE = página com arquivos candidatos, FAIL = erro).
Código de saída 1 se algum indicador marcado como "link" falhar.
"""
import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from services.ingestion.app import main

CATALOG_DIR = Path(__file__).resolve().parents[3] / "src" / "data" / "coleta"


def load_link_items(only: set[str] | None) -> list[dict]:
    items = [item for path in sorted(CATALOG_DIR.glob("*.json")) for item in json.loads(path.read_text(encoding="utf-8"))]
    return [item for item in items if item.get("access") == "link" and (not only or item["code"] in only)]


def check(item: dict) -> tuple[str, str, str]:
    client = TestClient(main.app)
    try:
        response = client.post("/profile-link", json={"source_url": item["importUrl"]})
    except Exception as error:  # noqa: BLE001 - relatório, não fluxo de produção
        return item["code"], "FAIL", repr(error)[:160]
    body = response.json()
    if response.status_code != 200:
        return item["code"], "FAIL", f"{response.status_code} {str(body.get('detail', body))[:140]}"
    if body.get("kind") == "web_page":
        return item["code"], "PAGE", f"{len(body['download_candidates'])} arquivos candidatos"
    return item["code"], "OK", f"{len(body.get('columns', []))} colunas, {body.get('row_count', body.get('total_rows', '?'))} linhas"


def run() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--workers", type=int, default=4)
    arguments = parser.parse_args()
    only = {code.strip().upper() for code in arguments.only.split(",") if code.strip()} or None
    items = load_link_items(only)
    with ThreadPoolExecutor(max_workers=arguments.workers) as pool:
        results = list(pool.map(check, items))
    for code, status, detail in results:
        print(f"{status:4} {code}  {detail}")
    failures = [code for code, status, _ in results if status == "FAIL"]
    print(f"\n{len(results) - len(failures)}/{len(results)} fontes por link responderam; falhas: {', '.join(failures) or 'nenhuma'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
