import os
import unittest
import tempfile
from scripts.geocoder import (
    clean_address,
    normalize_text,
    get_user_agent,
    atomic_write_json,
    load_cities_rs
)
from scripts.api import haversine_distance


class TestGeocoder(unittest.TestCase):
    def test_clean_address(self):
        # Remove complementos entre parênteses e espaços redundantes
        raw = "RODOVIA BR-290 (DA PONTE DO IBIRAPUITA ATE O FIM)   KM 575"
        cleaned = clean_address(raw)
        self.assertEqual(cleaned, "RODOVIA BR-290 KM 575")

        self.assertEqual(clean_address(""), "")
        self.assertEqual(clean_address(None), "")

    def test_normalize_text(self):
        # Remove acentos, caracteres diacríticos e converte para maiúsculas
        text = "São José do Norte - Peça Legal / Mecânica & Acessórios"
        norm = normalize_text(text)
        self.assertEqual(norm, "SAO JOSE DO NORTE - PECA LEGAL / MECANICA & ACESSORIOS")

    def test_get_user_agent_default(self):
        # Testa User-Agent anônimo padrão sem vazamento de email
        if 'GEOCODER_CONTACT_EMAIL' in os.environ:
            del os.environ['GEOCODER_CONTACT_EMAIL']
        ua = get_user_agent()
        self.assertIn("MapaCDVsRS/1.0", ua)
        self.assertNotIn("m.moothz@gmail.com", ua)

    def test_get_user_agent_with_email(self):
        os.environ['GEOCODER_CONTACT_EMAIL'] = "test@example.com"
        try:
            ua = get_user_agent()
            self.assertEqual(ua, "MapaCDVsRS/1.0 (test@example.com)")
        finally:
            del os.environ['GEOCODER_CONTACT_EMAIL']

    def test_haversine_distance(self):
        # Coordenadas: Porto Alegre (-30.0346, -51.2177) até Caxias do Sul (-29.1678, -51.1794)
        # Distância aproximada: ~96 km
        dist = haversine_distance(-30.0346, -51.2177, -29.1678, -51.1794)
        self.assertAlmostEqual(dist, 96.5, delta=3.0)

        # Mesma coordenada deve retornar 0 km
        dist_zero = haversine_distance(-30.0, -51.0, -30.0, -51.0)
        self.assertEqual(dist_zero, 0.0)

    def test_atomic_write_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = os.path.join(tmpdir, "test.json")
            data = {"status": "ok", "items": [1, 2, 3]}
            atomic_write_json(test_file, data)

            self.assertTrue(os.path.exists(test_file))
            import json
            with open(test_file, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            self.assertEqual(loaded, data)

    def test_load_cities_rs(self):
        cities = load_cities_rs()
        self.assertIsInstance(cities, dict)
        self.assertGreater(len(cities), 400)
        self.assertIn("PORTO ALEGRE", cities)


if __name__ == '__main__':
    unittest.main()
