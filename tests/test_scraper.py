import os
import tempfile
import unittest
from unittest.mock import patch

try:
    from scripts.scraper import update_metadata
    SCRAPER_AVAILABLE = True
except ImportError:
    SCRAPER_AVAILABLE = False


class TestScraper(unittest.TestCase):
    def test_update_metadata(self):
        if not SCRAPER_AVAILABLE:
            self.skipTest("Dependências do scraper (beautifulsoup4/requests) não instaladas neste ambiente.")

        with tempfile.TemporaryDirectory() as tmpdir:
            temp_meta = os.path.join(tmpdir, "metadata.json")
            with patch('scripts.scraper.METADATA_FILE', temp_meta):
                update_metadata(450)
                self.assertTrue(os.path.exists(temp_meta))

                import json
                with open(temp_meta, encoding='utf-8') as f:
                    meta = json.load(f)

                self.assertEqual(meta['total_cdvs'], 450)
                self.assertIn('Detran-RS', meta['fonte'])


if __name__ == '__main__':
    unittest.main()
