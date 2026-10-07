import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from services.ingestion.app import main

MUNIC_PAGE = "https://www.ibge.gov.br/estatisticas/sociais/educacao/10586-pesquisa-de-informacoes-basicas-municipais.html"
MUNIC_FILE = "https://ftp.ibge.gov.br/Perfil_Municipios/2024/Base_de_Dados/Base_MUNIC_2024_20251107.xlsx"
MUNIC_CANDIDATES = [{"name": "Base_MUNIC_2024_20251107.xlsx", "url": MUNIC_FILE}]


class LinkDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_blocked_munic_page_is_resolved_without_downloading_the_page(self):
        blocked = AsyncMock(side_effect=HTTPException(403, "bloqueado por WAF"))
        with patch.object(main, "discover_munic_resources", return_value=MUNIC_CANDIDATES), patch.object(main, "download_source", blocked):
            response = self.client.post("/profile-link", json={"source_url": MUNIC_PAGE})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["kind"], "web_page")
        self.assertEqual(response.json()["download_candidates"], MUNIC_CANDIDATES)
        blocked.assert_not_awaited()

    def test_direct_file_on_munic_path_is_never_treated_as_a_page(self):
        discover = unittest_mock_discover()
        csv_bytes = b"codmun;valor\n3509502;1\n"
        download = AsyncMock(return_value=("base.csv", csv_bytes, "text/csv", "https://ftp.ibge.gov.br/Perfil_Municipios/2024/base.csv"))
        with patch.object(main, "discover_munic_resources", discover), patch.object(main, "download_source", download):
            response = self.client.post("/profile-link", json={"source_url": "https://ftp.ibge.gov.br/Perfil_Municipios/2024/base.csv"})
        self.assertEqual(response.status_code, 200)
        self.assertNotEqual(response.json().get("kind"), "web_page")
        discover.assert_not_called()
        download.assert_awaited_once()


def unittest_mock_discover():
    from unittest.mock import Mock
    return Mock(return_value=MUNIC_CANDIDATES)


if __name__ == "__main__":
    unittest.main()
