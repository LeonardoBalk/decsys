from pathlib import Path
import unittest

from services.ingestion.app.main import import_tables, normalize_table_columns, read_table, workbook_sheets


fixture_directory = Path(__file__).parent / "fixtures" / "import_formats"


class ImportFixtureMatrixTests(unittest.TestCase):
    def test_csv_fixture_matrix_preserves_shape_and_values(self):
        fixture_expectations = [
            ("brazil-decimal.csv", ["municipio", "ano", "valor"], 2, [1234.5, 2345.6]),
            ("caged-monthly.csv", ["codigo_municipio", "mes", "ano", "saldo"], 2, [120, -35]),
            ("invalid-and-duplicate.csv", ["municipio", "ano", "valor"], 4, [10.5, 12.0, None, 10.5]),
        ]

        for file_name, expected_columns, expected_rows, expected_values in fixture_expectations:
            with self.subTest(file_name=file_name):
                source_content = (fixture_directory / file_name).read_bytes()
                source_table = normalize_table_columns(read_table(file_name, source_content))

                self.assertEqual(source_table.columns, expected_columns)
                self.assertEqual(source_table.height, expected_rows)
                self.assertEqual(source_table.get_column(expected_columns[-1]).to_list(), expected_values)

    def test_xlsx_title_rows_are_skipped_before_the_header(self):
        file_name = "title-rows.xlsx"
        source_content = (fixture_directory / file_name).read_bytes()
        source_table = normalize_table_columns(read_table(file_name, source_content))

        self.assertEqual(source_table.columns, ["municipio", "ano", "valor"])
        self.assertEqual(source_table.height, 2)
        self.assertEqual(source_table.get_column("municipio").to_list(), ["Campinas (SP)", "Santos (SP)"])
        self.assertEqual(source_table.get_column("valor").to_list(), [55234.75, 49876.25])

    def test_multi_sheet_workbook_keeps_each_data_table_separate(self):
        file_name = "multiple-domains.xlsx"
        source_content = (fixture_directory / file_name).read_bytes()

        self.assertEqual(
            [sheet["name"] for sheet in workbook_sheets(source_content)],
            ["Municipios", "Unidades da Federacao"],
        )

        imported_tables = import_tables(file_name, source_content, "Municipios", True)

        self.assertEqual([sheet_name for sheet_name, _ in imported_tables], ["Municipios", "Unidades da Federacao"])
        self.assertEqual([source_table.height for _, source_table in imported_tables], [2, 2])
        self.assertEqual(imported_tables[0][1].columns, ["codigo_ibge", "municipio", "ano", "valor"])
        self.assertEqual(imported_tables[1][1].columns, ["uf", "numero_de_municipios"])


if __name__ == "__main__":
    unittest.main()
