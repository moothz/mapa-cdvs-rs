import json
import os
import shutil
import tempfile
import unittest

from scripts.suggestions import RateLimiter, SuggestionsStore, sanitize_text, validate_br_phone


class TestSuggestions(unittest.TestCase):

    def test_validate_br_phone_valid_cases(self):
        cases = [
            ('(54) 99626-7183', '54996267183', '(54) 99626-7183'),
            ('54996267183', '54996267183', '(54) 99626-7183'),
            ('+55 (54) 99626-7183', '54996267183', '(54) 99626-7183'),
            ('+5554996267183', '54996267183', '(54) 99626-7183'),
            ('(51) 3222-1122', '5132221122', '(51) 3222-1122'),
            ('5132221122', '5132221122', '(51) 3222-1122'),
            ('+55 51 3222 1122', '5132221122', '(51) 3222-1122'),
            ('051997335484', '51997335484', '(51) 99733-5484'),  # Zero inicial removido
            ('05137152292', '5137152292', '(51) 3715-2292'),     # Fixo com zero inicial removido
        ]
        for raw, expected_digits, expected_formatted in cases:
            is_valid, digits, formatted = validate_br_phone(raw)
            self.assertTrue(is_valid, f"Deveria ser válido: {raw}")
            self.assertEqual(digits, expected_digits)
            self.assertEqual(formatted, expected_formatted)

    def test_normalize_social_url(self):
        from scripts.suggestions import normalize_social_url
        # Instagram
        ok, handle, url = normalize_social_url('instagram', '@autodemolidoraluiz')
        self.assertTrue(ok)
        self.assertEqual(handle, '@autodemolidoraluiz')
        self.assertEqual(url, 'https://www.instagram.com/autodemolidoraluiz/')

        ok, handle, url = normalize_social_url('instagram', 'https://instagram.com/cdv_pecas')
        self.assertTrue(ok)
        self.assertEqual(handle, '@cdv_pecas')
        self.assertEqual(url, 'https://www.instagram.com/cdv_pecas/')

        # Facebook
        ok, handle, url = normalize_social_url('facebook', 'demolidora.luiz')
        self.assertTrue(ok)
        self.assertEqual(handle, 'demolidora.luiz')
        self.assertEqual(url, 'https://www.facebook.com/demolidora.luiz')

    def test_validate_br_phone_invalid_cases(self):
        invalids = [
            '',
            None,
            '1234',
            '123456789',
            '00999999999',       # DDD 00 inválido
            '5412345678',        # fixo iniciando com 1 inválido
            '54812345678',       # celular não iniciando com 9
            '123456789012345',   # tamanho excessivo
            'abc-def-ghij',
        ]
        for raw in invalids:
            is_valid, digits, formatted = validate_br_phone(raw)
            self.assertFalse(is_valid, f"Deveria ser inválido: {raw}")
            self.assertEqual(digits, '')
            self.assertEqual(formatted, '')

    def test_sanitize_text(self):
        self.assertEqual(sanitize_text('  Carlos Silva  '), 'Carlos Silva')
        self.assertEqual(sanitize_text('<script>alert("xss")</script>Carlos'), 'Carlos')
        self.assertEqual(sanitize_text('Peças\n\r\tVendas'), 'Peças Vendas')

        long_str = 'A' * 150
        sanitized = sanitize_text(long_str, max_length=100)
        self.assertEqual(len(sanitized), 100)

    def test_rate_limiter(self):
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        client_ip = '192.168.1.100'

        # Primeiras 3 requisições permitidas
        self.assertTrue(limiter.is_allowed(client_ip))
        self.assertTrue(limiter.is_allowed(client_ip))
        self.assertTrue(limiter.is_allowed(client_ip))

        # 4ª requisição bloqueada
        self.assertFalse(limiter.is_allowed(client_ip))

        # Outro IP continua permitido
        self.assertTrue(limiter.is_allowed('10.0.0.1'))

        # Reset limpa histórico
        limiter.reset()
        self.assertTrue(limiter.is_allowed(client_ip))

    def test_add_and_approve_suggestion(self):
        # Testa o ciclo completo de sugestão e aprovação
        test_dir = tempfile.mkdtemp()
        try:
            test_sugg_file = os.path.join(test_dir, 'suggestions.json')
            test_cdvs_file = os.path.join(test_dir, 'cdvs.json')

            # Mock dos caminhos no SuggestionsStore
            import scripts.suggestions as s_mod
            orig_sugg = s_mod.SUGGESTIONS_FILE
            orig_cdvs = s_mod.CDVS_FILE

            s_mod.SUGGESTIONS_FILE = test_sugg_file
            s_mod.CDVS_FILE = test_cdvs_file

            # Cria mock de CDV
            mock_cdvs = [{
                'nome': 'TESTE CDV',
                'codigo': 'CDV99999',
                'telefone': '5133334444',
                'whatsapp': ''
            }]
            with open(test_cdvs_file, 'w', encoding='utf-8') as f:
                json.dump(mock_cdvs, f)

            # 1. Adiciona sugestão
            sug = SuggestionsStore.add(
                cdv_codigo='CDV99999',
                cdv_nome='TESTE CDV',
                nome_contato='Vendedor João',
                telefone='(54) 99626-7183',
                is_whatsapp=True,
                ip='127.0.0.1'
            )

            self.assertEqual(sug['status'], 'pending')
            self.assertEqual(sug['cdv_codigo'], 'CDV99999')
            self.assertEqual(sug['telefone'], '54996267183')
            self.assertEqual(sug['telefone_formatado'], '(54) 99626-7183')

            # 2. Verifica se foi gravado
            loaded = SuggestionsStore.load()
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0]['id'], sug['id'])

            # 3. Aprova sugestão
            approved = SuggestionsStore.approve(sug['id'])
            self.assertEqual(approved['status'], 'approved')

            # 4. Verifica se CDV recebeu contato extra
            with open(test_cdvs_file, encoding='utf-8') as f:
                updated_cdvs = json.load(f)

            target_cdv = updated_cdvs[0]
            self.assertIn('contatos_extras', target_cdv)
            self.assertEqual(len(target_cdv['contatos_extras']), 1)
            extra = target_cdv['contatos_extras'][0]
            self.assertEqual(extra['nome'], 'Vendedor João')
            self.assertEqual(extra['telefone'], '54996267183')
            self.assertTrue(extra['whatsapp'])

            # 5. Restaura caminhos originais
            s_mod.SUGGESTIONS_FILE = orig_sugg
            s_mod.CDVS_FILE = orig_cdvs

        finally:
            shutil.rmtree(test_dir, ignore_errors=True)

    def test_reject_suggestion(self):
        test_dir = tempfile.mkdtemp()
        try:
            test_sugg_file = os.path.join(test_dir, 'suggestions.json')

            import scripts.suggestions as s_mod
            orig_sugg = s_mod.SUGGESTIONS_FILE
            s_mod.SUGGESTIONS_FILE = test_sugg_file

            sug = SuggestionsStore.add(
                cdv_codigo='CDV00001',
                cdv_nome='CDV SPAM',
                nome_contato='Spam Bot',
                telefone='51999998888',
                is_whatsapp=False
            )

            rejected = SuggestionsStore.reject(sug['id'])
            self.assertEqual(rejected['status'], 'rejected')

            loaded = SuggestionsStore.load()
            self.assertEqual(loaded[0]['status'], 'rejected')

            s_mod.SUGGESTIONS_FILE = orig_sugg
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)

    def test_social_contact_autofill_names(self):
        test_dir = tempfile.mkdtemp()
        try:
            test_sugg_file = os.path.join(test_dir, 'suggestions.json')

            import scripts.suggestions as s_mod
            orig_sugg = s_mod.SUGGESTIONS_FILE
            s_mod.SUGGESTIONS_FILE = test_sugg_file

            # Instagram com nome vazio -> auto-preenche 'Insta'
            sug_insta = SuggestionsStore.add(
                cdv_codigo='CDV00001',
                cdv_nome='CDV Peças RS',
                nome_contato='',
                tipo='instagram',
                valor='@cdv_insta'
            )
            self.assertEqual(sug_insta['nome_contato'], 'Insta')

            # Facebook com nome 'Facebook' -> normaliza para 'Face'
            sug_face = SuggestionsStore.add(
                cdv_codigo='CDV00001',
                cdv_nome='CDV Peças RS',
                nome_contato='Facebook',
                tipo='facebook',
                valor='cdv.oficial'
            )
            self.assertEqual(sug_face['nome_contato'], 'Face')

            # Instagram com nome personalizado mantido
            sug_custom = SuggestionsStore.add(
                cdv_codigo='CDV00001',
                cdv_nome='CDV Peças RS',
                nome_contato='Vendas Instagram',
                tipo='instagram',
                valor='@cdv_pecas'
            )
            self.assertEqual(sug_custom['nome_contato'], 'Vendas Instagram')

            s_mod.SUGGESTIONS_FILE = orig_sugg
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
