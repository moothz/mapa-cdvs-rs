import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from scripts import telegram_bot
from scripts.suggestions import SuggestionsStore


class TestTelegramBot(unittest.TestCase):

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.suggestions_file = os.path.join(self.test_dir, 'suggestions.json')
        self.cdvs_file = os.path.join(self.test_dir, 'cdvs.json')

        # Mock de arquivos de dados
        self._orig_sug_file = SuggestionsStore.save
        from scripts import suggestions
        suggestions.SUGGESTIONS_FILE = self.suggestions_file
        suggestions.CDVS_FILE = self.cdvs_file

        with open(self.cdvs_file, 'w', encoding='utf-8') as f:
            json.dump([{
                'codigo': '00123',
                'nome': 'Desmanche Teste RS',
                'contatos_extras': []
            }], f)

        with open(self.suggestions_file, 'w', encoding='utf-8') as f:
            json.dump([], f)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_is_configured(self):
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_CHAT_ID': ''}):
            self.assertFalse(telegram_bot.is_configured())

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '1234:TOKEN', 'TELEGRAM_CHAT_ID': ''}):
            self.assertFalse(telegram_bot.is_configured())

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_CHAT_ID': '987654'}):
            self.assertFalse(telegram_bot.is_configured())

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '1234:TOKEN', 'TELEGRAM_CHAT_ID': '987654'}):
            self.assertTrue(telegram_bot.is_configured())

    def test_format_suggestion_message(self):
        suggestion = {
            'id': 'sug_test123',
            'cdv_codigo': '00123',
            'cdv_nome': 'Desmanche <Teste> & Cia',
            'nome_contato': 'João & Maria',
            'tipo': 'whatsapp',
            'telefone': '51999998888',
            'telefone_formatado': '(51) 99999-8888',
            'url': 'https://api.whatsapp.com/send?phone=5551999998888',
            'created_at': '2026-10-09T14:30:00',
            'ip': '192.168.1.1'
        }
        msg = telegram_bot.format_suggestion_message(suggestion)
        self.assertIn('&lt;Teste&gt; &amp; Cia', msg)
        self.assertIn('João &amp; Maria', msg)
        self.assertIn('(51) 99999-8888', msg)
        self.assertIn('sug_test123', msg)
        self.assertIn('💬 WhatsApp', msg)

    @patch('requests.post')
    def test_notify_new_suggestion_when_configured(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_post.return_value = mock_resp

        suggestion = {
            'id': 'sug_abc999',
            'cdv_codigo': '00123',
            'cdv_nome': 'CDV Passo Fundo',
            'nome_contato': 'Carlos Silva',
            'tipo': 'whatsapp',
            'telefone': '54999991111',
            'telefone_formatado': '(54) 99999-1111',
            'url': 'https://api.whatsapp.com/send?phone=5554999991111',
            'created_at': '2026-10-09T14:00:00',
            'ip': '127.0.0.1'
        }

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': 'fake_token', 'TELEGRAM_CHAT_ID': '998877'}):
            ok = telegram_bot.send_suggestion_notification_sync(suggestion)
            self.assertTrue(ok)
            mock_post.assert_called_once()
            args, kwargs = mock_post.call_args
            self.assertIn('https://api.telegram.org/botfake_token/sendMessage', args[0])
            payload = kwargs['json']
            self.assertEqual(payload['chat_id'], '998877')
            self.assertEqual(payload['parse_mode'], 'HTML')
            keyboard = payload['reply_markup']['inline_keyboard']
            self.assertEqual(keyboard[0][0]['text'], '✅ Aceitar')
            self.assertEqual(keyboard[0][0]['callback_data'], 'approve:sug_abc999')
            self.assertEqual(keyboard[0][1]['text'], '❌ Negar')
            self.assertEqual(keyboard[0][1]['callback_data'], 'reject:sug_abc999')

    @patch('requests.post')
    def test_notify_new_suggestion_when_disabled(self, mock_post):
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_CHAT_ID': ''}):
            ok = telegram_bot.notify_new_suggestion({'id': 'sug_123'}, async_mode=False)
            self.assertFalse(ok)
            mock_post.assert_not_called()

    @patch('requests.post')
    def test_handle_callback_query_approve(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_post.return_value = mock_resp

        # Adiciona sugestão na base
        sug = SuggestionsStore.add(
            cdv_codigo='00123',
            cdv_nome='Desmanche Teste RS',
            nome_contato='Roberto Vendedor',
            telefone='(51) 99999-2222',
            is_whatsapp=True
        )

        cb_query = {
            'id': 'cb_12345',
            'data': f"approve:{sug['id']}",
            'from': {'id': 998877, 'username': 'admin_teste', 'first_name': 'Admin'},
            'message': {
                'message_id': 555,
                'chat': {'id': 998877},
                'text': 'Mensagem original'
            }
        }

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': 'token123', 'TELEGRAM_CHAT_ID': '998877'}):
            telegram_bot.handle_callback_query(cb_query)

            # Verifica se foi aprovado na store
            updated = next(s for s in SuggestionsStore.load() if s['id'] == sug['id'])
            self.assertEqual(updated['status'], 'approved')

            # Verifica chamadas ao Telegram (answerCallbackQuery e editMessageText)
            self.assertEqual(mock_post.call_count, 2)
            calls = mock_post.call_args_list

            # 1. answerCallbackQuery
            answer_call = calls[0]
            self.assertIn('answerCallbackQuery', answer_call[0][0])
            self.assertIn('✅ Sugestão aprovada', answer_call[1]['json']['text'])

            # 2. editMessageText
            edit_call = calls[1]
            self.assertIn('editMessageText', edit_call[0][0])
            self.assertIn('@admin_teste', edit_call[1]['json']['text'])
            self.assertEqual(edit_call[1]['json']['reply_markup']['inline_keyboard'], [])

    @patch('requests.post')
    def test_handle_callback_query_reject(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_post.return_value = mock_resp

        sug = SuggestionsStore.add(
            cdv_codigo='00123',
            cdv_nome='Desmanche Teste RS',
            nome_contato='Fake Contato',
            telefone='(51) 99999-3333',
            is_whatsapp=True
        )

        cb_query = {
            'id': 'cb_67890',
            'data': f"reject:{sug['id']}",
            'from': {'id': 998877, 'first_name': 'Moderador 1'},
            'message': {
                'message_id': 556,
                'chat': {'id': 998877},
                'text': 'Mensagem original'
            }
        }

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': 'token123', 'TELEGRAM_CHAT_ID': '998877'}):
            telegram_bot.handle_callback_query(cb_query)

            updated = next(s for s in SuggestionsStore.load() if s['id'] == sug['id'])
            self.assertEqual(updated['status'], 'rejected')

            self.assertEqual(mock_post.call_count, 2)
            calls = mock_post.call_args_list
            self.assertIn('answerCallbackQuery', calls[0][0][0])
            self.assertIn('❌ Sugestão rejeitada', calls[0][1]['json']['text'])

    @patch('requests.post')
    def test_handle_callback_query_unauthorized_chat(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_post.return_value = mock_resp

        cb_query = {
            'id': 'cb_hacker',
            'data': 'approve:sug_xyz',
            'from': {'id': 11111, 'first_name': 'Intruso'},
            'message': {
                'message_id': 999,
                'chat': {'id': 11111},
                'text': '...'
            }
        }

        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': 'token123', 'TELEGRAM_CHAT_ID': '998877'}):
            telegram_bot.handle_callback_query(cb_query)

            # Deve rejeitar imediatamente o callback e não tentar aprovar
            mock_post.assert_called_once()
            call_args = mock_post.call_args
            self.assertIn('answerCallbackQuery', call_args[0][0])
            self.assertTrue(call_args[1]['json']['show_alert'])
            self.assertIn('permissão', call_args[1]['json']['text'])

    def test_start_telegram_bot_when_disabled(self):
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_CHAT_ID': ''}):
            started = telegram_bot.start_telegram_bot()
            self.assertFalse(started)
