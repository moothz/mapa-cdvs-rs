import unittest

from scripts.api import DataStore


class TestApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        DataStore.load()

    def test_datastore_load(self):
        cdvs = DataStore.get_cdvs()
        self.assertIsInstance(cdvs, list)
        self.assertGreater(len(cdvs), 0)

        # Garante que _haystack não vaze para o consumidor final
        first = cdvs[0]
        self.assertNotIn('_haystack', first)
        self.assertIn('nome', first)
        self.assertIn('codigo', first)

    def test_datastore_find_city(self):
        city = DataStore.find_city("Porto Alegre")
        self.assertIsNotNone(city)
        self.assertEqual(city['nome'].upper(), "PORTO ALEGRE")
        self.assertAlmostEqual(city['lat'], -30.0346, delta=0.5)
        self.assertAlmostEqual(city['lng'], -51.2177, delta=0.5)

        # Teste com cidade com acento
        city_accent = DataStore.find_city("caxias do sul")
        self.assertIsNotNone(city_accent)

        # Teste com cidade inexistente
        city_none = DataStore.find_city("Cidade Inexistente XPTO")
        self.assertIsNone(city_none)

    def test_metadata(self):
        meta = DataStore.get_metadata()
        self.assertIsInstance(meta, dict)
        self.assertIn('total_cdvs', meta)
        self.assertGreater(meta['total_cdvs'], 0)

    def test_search_haystack_indexing(self):
        raw_cdvs = DataStore.get_cdvs(clean=False)
        self.assertGreater(len(raw_cdvs), 0)
        # O haystack pré-indexado deve existir na lista interna
        self.assertIn('_haystack', raw_cdvs[0])
        self.assertTrue(len(raw_cdvs[0]['_haystack']) > 0)

    def test_find_cdv_by_code(self):
        first_cdv = DataStore.get_cdvs()[0]
        code = first_cdv['codigo']
        found = DataStore.find_cdv_by_code(code)
        self.assertIsNotNone(found)
        self.assertEqual(found['codigo'], code)
        self.assertIsNone(DataStore.find_cdv_by_code('CDV_INEXISTENTE_99999'))

    def test_get_client_ip_resolution(self):
        from scripts.api import CDVApiRequestHandler

        class DummyHandler:
            headers = {}
            client_address = ('127.0.0.1', 12345)
            _get_client_ip = CDVApiRequestHandler._get_client_ip

        handler = DummyHandler()

        # 1. Cloudflare CF-Connecting-IP tem prioridade máxima
        handler.headers = {
            'CF-Connecting-IP': '177.136.24.10',
            'X-Real-IP': '192.168.3.20',
            'X-Forwarded-For': '192.168.3.20'
        }
        self.assertEqual(handler._get_client_ip(), '177.136.24.10')

        # 2. True-Client-IP quando CF-Connecting-IP não existe
        handler.headers = {
            'True-Client-IP': '189.40.12.5',
            'X-Real-IP': '192.168.3.20'
        }
        self.assertEqual(handler._get_client_ip(), '189.40.12.5')

        # 3. X-Forwarded-For seleciona o primeiro IP público, ignorando proxy reverso privado (192.168.3.20)
        handler.headers = {
            'X-Forwarded-For': '201.88.99.1, 192.168.3.20',
            'X-Real-IP': '192.168.3.20'
        }
        self.assertEqual(handler._get_client_ip(), '201.88.99.1')

        # 4. X-Real-IP quando não há cabeçalhos especiais
        handler.headers = {
            'X-Real-IP': '200.180.50.3'
        }
        self.assertEqual(handler._get_client_ip(), '200.180.50.3')

        # 5. Socket direto
        handler.headers = {}
        self.assertEqual(handler._get_client_ip(), '127.0.0.1')


if __name__ == '__main__':
    unittest.main()
