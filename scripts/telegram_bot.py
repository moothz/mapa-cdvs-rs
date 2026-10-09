import html
import json
import os
import threading
import time
from datetime import datetime

import requests

from scripts.suggestions import SuggestionsStore

_bot_thread = None
_bot_running = False
_lock = threading.Lock()


def is_configured() -> bool:
    """Verifica se o token do bot e o ID do chat do Telegram foram configurados no ambiente."""
    token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
    chat_id = os.getenv('TELEGRAM_CHAT_ID', '').strip()
    return bool(token and chat_id)


def get_bot_token() -> str:
    return os.getenv('TELEGRAM_BOT_TOKEN', '').strip()


def get_chat_id() -> str:
    return os.getenv('TELEGRAM_CHAT_ID', '').strip()


def format_suggestion_message(suggestion: dict) -> str:
    """Formata o texto da notificação da sugestão em HTML para o Telegram."""
    sug_id = suggestion.get('id', '')
    cdv_codigo = suggestion.get('cdv_codigo', '')
    cdv_nome = suggestion.get('cdv_nome', '')
    nome_contato = suggestion.get('nome_contato', '')
    tipo = suggestion.get('tipo', 'whatsapp')
    tel_fmt = suggestion.get('telefone_formatado') or suggestion.get('telefone') or ''
    url = suggestion.get('url', '')
    created_at = suggestion.get('created_at', '')
    ip = suggestion.get('ip', '')

    tipo_labels = {
        'whatsapp': '💬 WhatsApp',
        'phone': '📞 Telefone',
        'instagram': '📸 Instagram',
        'facebook': '👤 Facebook',
    }
    tipo_str = tipo_labels.get(tipo.lower(), f"📌 {tipo.capitalize()}")

    try:
        dt = datetime.fromisoformat(created_at)
        dt_str = dt.strftime('%d/%m/%Y às %H:%M:%S')
    except Exception:
        dt_str = created_at or 'Agora'

    link_line = f"\n🔗 <b>Link Direto:</b> <a href=\"{html.escape(url)}\">{html.escape(url)}</a>" if url and url != '#' else ''
    ip_line = f"\n🌐 <b>IP de Origem:</b> <code>{html.escape(ip)}</code>" if ip else ''

    return (
        "<b>🔔 Nova Sugestão de Contato Recebida</b>\n\n"
        f"🏢 <b>CDV:</b> {html.escape(cdv_nome)} (<code>{html.escape(cdv_codigo)}</code>)\n"
        f"👤 <b>Nome do Contato:</b> {html.escape(nome_contato)}\n"
        f"📌 <b>Tipo:</b> {html.escape(tipo_str)}\n"
        f"📞 <b>Valor/Número:</b> <code>{html.escape(tel_fmt)}</code>"
        f"{link_line}\n"
        f"🆔 <b>ID da Sugestão:</b> <code>{html.escape(sug_id)}</code>\n"
        f"🕒 <b>Enviado em:</b> {html.escape(dt_str)}"
        f"{ip_line}\n\n"
        "<i>Utilize os botões abaixo para moderar esta solicitação:</i>"
    )


def send_suggestion_notification_sync(suggestion: dict) -> bool:
    """Envia notificação com botões inline diretamente (síncrono)."""
    if not is_configured():
        return False

    token = get_bot_token()
    chat_id = get_chat_id()
    sug_id = suggestion.get('id')
    if not sug_id:
        return False

    text = format_suggestion_message(suggestion)
    keyboard = {
        'inline_keyboard': [
            [
                {'text': '✅ Aceitar', 'callback_data': f"approve:{sug_id}"},
                {'text': '❌ Negar', 'callback_data': f"reject:{sug_id}"}
            ]
        ]
    }

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'HTML',
        'reply_markup': keyboard,
        'disable_web_page_preview': True
    }

    try:
        resp = requests.post(url, json=payload, timeout=10)
        if not resp.ok:
            print(f"[Telegram Bot] Falha ao enviar mensagem ({resp.status_code}): {resp.text}")
            return False
        return True
    except Exception as e:
        print(f"[Telegram Bot] Exceção ao enviar mensagem: {e}")
        return False


def notify_new_suggestion(suggestion: dict, async_mode: bool = True) -> bool:
    """
    Notifica nova sugestão no Telegram.
    Por padrão executa em thread assíncrona para não onerar o tempo de resposta da API HTTP.
    """
    if not is_configured():
        return False

    if not async_mode:
        return send_suggestion_notification_sync(suggestion)

    thread = threading.Thread(
        target=send_suggestion_notification_sync,
        args=(suggestion,),
        daemon=True,
        name="TelegramNotifyThread"
    )
    thread.start()
    return True


def answer_callback_query(callback_query_id: str, text: str, show_alert: bool = False):
    """Responde à ação de clique no botão com um feedback nativo do Telegram."""
    token = get_bot_token()
    url = f"https://api.telegram.org/bot{token}/answerCallbackQuery"
    try:
        requests.post(url, json={
            'callback_query_id': callback_query_id,
            'text': text,
            'show_alert': show_alert
        }, timeout=8)
    except Exception as e:
        print(f"[Telegram Bot] Erro ao responder callback query: {e}")


def edit_message_text(chat_id: str, message_id: int, text: str, inline_keyboard: list = None):
    """Edita a mensagem no chat após moderação para registrar o status final."""
    token = get_bot_token()
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    payload = {
        'chat_id': chat_id,
        'message_id': message_id,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': True
    }
    if inline_keyboard is not None:
        payload['reply_markup'] = {'inline_keyboard': inline_keyboard}

    try:
        requests.post(url, json=payload, timeout=8)
    except Exception as e:
        print(f"[Telegram Bot] Erro ao editar mensagem: {e}")


def handle_callback_query(callback_query: dict):
    """Processa cliques nos botões 'Aceitar' ou 'Negar' vindos do chat do Telegram."""
    cb_id = callback_query.get('id', '')
    data = callback_query.get('data', '')
    from_user = callback_query.get('from', {})
    cb_msg = callback_query.get('message', {})
    chat = cb_msg.get('chat', {})
    chat_id = str(chat.get('id', ''))
    message_id = cb_msg.get('message_id')

    # Validação do chat autorizado
    configured_chat_id = get_chat_id()
    if configured_chat_id and chat_id != configured_chat_id:
        answer_callback_query(cb_id, '⚠️ Você não possui permissão para moderar neste bot.', show_alert=True)
        return

    if not (data.startswith('approve:') or data.startswith('reject:')):
        answer_callback_query(cb_id, 'Comando não reconhecido.')
        return

    action, sug_id = data.split(':', 1)

    # Identificação do moderador
    user_name = from_user.get('first_name') or from_user.get('username') or 'Moderador'
    if from_user.get('username'):
        user_name = f"@{from_user['username']}"

    # Busca sugestão atual
    all_suggestions = SuggestionsStore.load()
    target = next((s for s in all_suggestions if s.get('id') == sug_id), None)

    if not target:
        answer_callback_query(cb_id, '⚠️ Sugestão não encontrada na base de dados.', show_alert=True)
        if message_id:
            edit_message_text(
                chat_id,
                message_id,
                "<b>⚠️ Esta sugestão não foi encontrada na base de dados (pode ter sido excluída).</b>",
                inline_keyboard=[]
            )
        return

    current_status = target.get('status')
    if current_status != 'pending':
        status_pt = 'aprovada' if current_status == 'approved' else 'rejeitada'
        answer_callback_query(cb_id, f"⚠️ Esta sugestão já foi {status_pt}!", show_alert=True)
        if message_id:
            base_html = format_suggestion_message(target)
            base_html = base_html.replace('\n\n<i>Utilize os botões abaixo para moderar esta solicitação:</i>', '')
            updated_text = f"{base_html}\n\n<b>ℹ️ Já {status_pt.capitalize()} anteriormente.</b>"
            edit_message_text(chat_id, message_id, updated_text, inline_keyboard=[])
        return

    now_str = datetime.now().strftime('%d/%m/%Y às %H:%M:%S')

    if action == 'approve':
        try:
            SuggestionsStore.approve(sug_id)
            # Recarrega DataStore em memória na API se ela estiver ativa
            try:
                from scripts.api import DataStore
                DataStore.load()
            except Exception:
                pass

            answer_callback_query(cb_id, '✅ Sugestão aprovada e adicionada ao CDV!')

            if message_id:
                base_html = format_suggestion_message(target)
                base_html = base_html.replace('\n\n<i>Utilize os botões abaixo para moderar esta solicitação:</i>', '')
                updated_text = f"{base_html}\n\n<b>✅ Aprovado por {html.escape(user_name)} em {now_str}</b>"
                edit_message_text(chat_id, message_id, updated_text, inline_keyboard=[])
        except Exception as e:
            answer_callback_query(cb_id, f"Erro ao aprovar: {e}", show_alert=True)

    elif action == 'reject':
        try:
            SuggestionsStore.reject(sug_id)
            answer_callback_query(cb_id, '❌ Sugestão rejeitada.')

            if message_id:
                base_html = format_suggestion_message(target)
                base_html = base_html.replace('\n\n<i>Utilize os botões abaixo para moderar esta solicitação:</i>', '')
                updated_text = f"{base_html}\n\n<b>❌ Rejeitado por {html.escape(user_name)} em {now_str}</b>"
                edit_message_text(chat_id, message_id, updated_text, inline_keyboard=[])
        except Exception as e:
            answer_callback_query(cb_id, f"Erro ao rejeitar: {e}", show_alert=True)


def _poll_loop():
    """Loop contínuo de polling para receber cliques nos botões via getUpdates."""
    global _bot_running
    last_offset = 0

    while _bot_running:
        if not is_configured():
            time.sleep(5)
            continue

        token = get_bot_token()
        url = f"https://api.telegram.org/bot{token}/getUpdates"
        params = {
            'offset': last_offset,
            'timeout': 20,
            'allowed_updates': json.dumps(['callback_query'])
        }

        try:
            resp = requests.get(url, params=params, timeout=25)
            if resp.status_code == 200:
                data = resp.json()
                if data.get('ok'):
                    for update in data.get('result', []):
                        update_id = update.get('update_id', 0)
                        if update_id >= last_offset:
                            last_offset = update_id + 1

                        cb_query = update.get('callback_query')
                        if cb_query:
                            try:
                                handle_callback_query(cb_query)
                            except Exception as err:
                                print(f"[Telegram Bot] Erro ao tratar callback: {err}")
            elif resp.status_code in (401, 404):
                print(f"[Telegram Bot] Token de bot inválido ({resp.status_code}). Pausando por 60s...")
                time.sleep(60)
            else:
                time.sleep(3)
        except requests.exceptions.Timeout:
            continue
        except Exception as e:
            # Em falha passageira de conexão, aguarda brevemente
            print(f"[Telegram Bot] Erro na requisição de polling: {e}")
            time.sleep(3)


def start_telegram_bot() -> bool:
    """
    Inicia o bot do Telegram em segundo plano se configurado.
    Retorna True se iniciado, False caso não configurado.
    """
    global _bot_thread, _bot_running
    if not is_configured():
        return False

    with _lock:
        if _bot_running and _bot_thread and _bot_thread.is_alive():
            return True

        _bot_running = True
        _bot_thread = threading.Thread(
            target=_poll_loop,
            daemon=True,
            name="TelegramBotPollThread"
        )
        _bot_thread.start()
        print("[Telegram Bot] Notificações e Moderação via Telegram iniciadas!")
        return True


def stop_telegram_bot():
    """Encerra a thread de polling do bot do Telegram."""
    global _bot_running
    _bot_running = False
