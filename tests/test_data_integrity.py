import json
import os
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CDVS_FILE = os.path.join(DATA_DIR, 'cdvs.json')
CITIES_FILE = os.path.join(DATA_DIR, 'cities_rs.json')
METADATA_FILE = os.path.join(DATA_DIR, 'metadata.json')


class TestDataIntegrity(unittest.TestCase):
    def test_cities_rs_structure(self):
        self.assertTrue(os.path.exists(CITIES_FILE), "cities_rs.json deve existir")
        with open(CITIES_FILE, encoding='utf-8') as f:
            cities = json.load(f)

        self.assertIsInstance(cities, dict)
        self.assertEqual(len(cities), 497, "O RS possui 497 municípios oficiais")

        for _, info in list(cities.items())[:20]:
            self.assertIn('nome', info)
            self.assertIn('lat', info)
            self.assertIn('lng', info)
            self.assertIsInstance(info['lat'], (int, float))
            self.assertIsInstance(info['lng'], (int, float))

    def test_cdvs_json_structure(self):
        self.assertTrue(os.path.exists(CDVS_FILE), "cdvs.json deve existir")
        with open(CDVS_FILE, encoding='utf-8') as f:
            cdvs = json.load(f)

        self.assertIsInstance(cdvs, list)
        self.assertGreater(len(cdvs), 100, "Deve haver mais de 100 CDVs cadastrados")

        for cdv in cdvs:
            self.assertIn('nome', cdv)
            self.assertIn('codigo', cdv)
            self.assertIn('municipio', cdv)

            # Se possuir coordenadas, devem estar dentro dos limites aproximados do RS e Brasil Sul
            lat = cdv.get('lat')
            lng = cdv.get('lng')
            if lat is not None and lng is not None:
                self.assertTrue(-34.5 <= float(lat) <= -26.0, f"Latitude {lat} fora dos limites do RS para {cdv.get('nome')}")
                self.assertTrue(-58.5 <= float(lng) <= -49.0, f"Longitude {lng} fora dos limites do RS para {cdv.get('nome')}")

    def test_metadata_structure(self):
        if not os.path.exists(METADATA_FILE):
            self.skipTest("metadata.json é gerado em tempo de execução pelo scraper")
        with open(METADATA_FILE, encoding='utf-8') as f:
            meta = json.load(f)

        self.assertIn('total_cdvs', meta)
        self.assertIn('ultima_atualizacao', meta)
        self.assertIn('fonte', meta)


if __name__ == '__main__':
    unittest.main()
