import json
import os
import re
import threading
import time
import uuid
from datetime import datetime

from scripts.geocoder import atomic_write_json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CDVS_FILE = os.path.join(DATA_DIR, 'cdvs.json')
SUGGESTIONS_FILE = os.path.join(DATA_DIR, 'suggestions.json')

# Regex para telefones brasileiros:
# DDD (11 a 99) + 8 dígitos (fixo iniciando com 2-5) ou 9 dígitos (celular iniciando com 9)
BR_PHONE_REGEX = re.compile(r'^[1-9]{2}(?:9[1-9]\d{7}|[2-5]\d{7})$')


def validate_br_phone(phone: str) -> tuple[bool, str, str]:
    """
    Valida e normaliza telefone brasileiro.
    Remove automaticamente zero inicial caso colado (ex: 051997335484 -> 51997335484).
    Retorna (is_valid, clean_digits, formatted_phone).
    """
    if not phone:
        return False, '', ''

    digits = re.sub(r'\D', '', str(phone).strip())

    # Remove zero inicial (ex: 051997335484 -> 51997335484)
    if digits.startswith('0') and len(digits) in (11, 12):
        digits = digits[1:]

    # Remove DDI 55 se presente em números de 12 ou 13 dígitos
    if digits.startswith('55') and len(digits) in (12, 13):
        digits = digits[2:]

    # Remove zero inicial que tenha sobrado após DDI
    if digits.startswith('0') and len(digits) in (11, 12):
        digits = digits[1:]

    if not BR_PHONE_REGEX.match(digits):
        return False, '', ''

    # Formata amigavelmente: (XX) 9XXXX-XXXX ou (XX) XXXX-XXXX
    ddd = digits[:2]
    rest = digits[2:]
    if len(rest) == 9:
        formatted = f"({ddd}) {rest[:5]}-{rest[5:]}"
    else:
        formatted = f"({ddd}) {rest[:4]}-{rest[4:]}"

    return True, digits, formatted


def normalize_social_url(tipo: str, valor: str) -> tuple[bool, str, str]:
    """
    Valida e formata links de redes sociais (instagram, facebook).
    Retorna (is_valid, handle_or_clean, full_url).
    """
    val = sanitize_text(valor, max_length=150).strip()
    if not val:
        return False, '', ''

    # Remove @ inicial
    if val.startswith('@'):
        val = val[1:]

    tipo = tipo.lower()
    if tipo == 'instagram':
        # Se for URL completa, extrai ou normaliza
        m = re.search(r'(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)', val)
        handle = m.group(1) if m else re.sub(r'[^a-zA-Z0-9._]', '', val)
        if not handle:
            return False, '', ''
        return True, f"@{handle}", f"https://www.instagram.com/{handle}/"

    elif tipo == 'facebook':
        m = re.search(r'(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9._-]+)', val)
        handle = m.group(1) if m else re.sub(r'[^a-zA-Z0-9._-]', '', val)
        if not handle:
            return False, '', ''
        return True, handle, f"https://www.facebook.com/{handle}"

    return False, '', ''


def sanitize_text(text: str, max_length: int = 100) -> str:
    """Remove tags HTML, scripts, estilos, caracteres de controle e limita o tamanho da string."""
    if not text:
        return ''
    # Remove blocos script e style completos incluindo conteúdo interno
    clean = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', str(text), flags=re.IGNORECASE | re.DOTALL)
    # Remove qualquer outra tag HTML
    clean = re.sub(r'<[^>]+>', '', clean)
    # Remove quebras de linha e caracteres de controle
    clean = re.sub(r'[\r\n\t\x00-\x1f\x7f]', ' ', clean)
    # Remove múltiplos espaços
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:max_length]


class RateLimiter:
    """Limitador de requisições por IP em memória (Thread-safe)."""

    def __init__(self, max_requests: int = 5, window_seconds: int = 600):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._requests = {}
        self._lock = threading.Lock()

    def is_allowed(self, client_ip: str) -> bool:
        now = time.time()
        with self._lock:
            timestamps = self._requests.get(client_ip, [])
            # Mantém apenas requisições dentro da janela de tempo
            valid_timestamps = [ts for ts in timestamps if now - ts < self.window_seconds]
            if len(valid_timestamps) >= self.max_requests:
                self._requests[client_ip] = valid_timestamps
                return False
            valid_timestamps.append(now)
            self._requests[client_ip] = valid_timestamps
            return True

    def reset(self):
        with self._lock:
            self._requests.clear()


class SuggestionsStore:
    """Gerencia leitura, escrita e moderação das sugestões de contato."""
    _lock = threading.Lock()

    @classmethod
    def load(cls) -> list[dict]:
        with cls._lock:
            if os.path.exists(SUGGESTIONS_FILE):
                try:
                    with open(SUGGESTIONS_FILE, encoding='utf-8') as f:
                        data = json.load(f)
                        if isinstance(data, list):
                            return data
                except Exception as e:
                    print(f"[SuggestionsStore] Erro ao ler {SUGGESTIONS_FILE}: {e}")
            return []

    @classmethod
    def save(cls, suggestions: list[dict]):
        with cls._lock:
            atomic_write_json(SUGGESTIONS_FILE, suggestions, indent=2)

    @classmethod
    def add(cls, cdv_codigo: str, cdv_nome: str, nome_contato: str, telefone: str = '',
            is_whatsapp: bool = True, tipo: str = 'whatsapp', valor: str = '', ip: str = '127.0.0.1') -> dict:
        # Normaliza tipo
        tipo_normalizado = str(tipo or 'phone').lower().strip()
        clean_name = sanitize_text(nome_contato, max_length=100)
        if tipo_normalizado in ('instagram', 'facebook'):
            default_label = 'Insta' if tipo_normalizado == 'instagram' else 'Face'
            if not clean_name or clean_name.lower() in ('instagram', 'insta', 'facebook', 'face', 'social', 'perfil'):
                clean_name = default_label
        elif len(clean_name) < 2:
            raise ValueError("Nome do contato deve ter pelo menos 2 caracteres.")
        if tipo_normalizado in ('instagram', 'facebook'):
            raw_val = valor or telefone
            is_valid, handle_or_clean, full_url = normalize_social_url(tipo_normalizado, raw_val)
            if not is_valid:
                raise ValueError(f"Perfil de {tipo_normalizado.capitalize()} inválido. Informe o usuário ou link (ex: @perfil ou https://...).")
            clean_phone = ''
            formatted_phone = handle_or_clean
            contact_url = full_url
            contact_type = tipo_normalizado
        else:
            raw_phone = telefone or valor
            is_valid, clean_phone, formatted_phone = validate_br_phone(raw_phone)
            if not is_valid:
                raise ValueError("Número de telefone inválido para o padrão brasileiro (DDD + 8 ou 9 dígitos).")
            contact_type = 'whatsapp' if is_whatsapp else 'phone'
            contact_url = f"https://api.whatsapp.com/send?phone=55{clean_phone}" if is_whatsapp else f"tel:{clean_phone}"

        new_suggestion = {
            'id': f"sug_{uuid.uuid4().hex[:8]}",
            'cdv_codigo': cdv_codigo.strip().upper(),
            'cdv_nome': cdv_nome.strip(),
            'nome_contato': clean_name,
            'tipo': contact_type,
            'telefone': clean_phone,
            'telefone_formatado': formatted_phone,
            'url': contact_url,
            'is_whatsapp': bool(contact_type == 'whatsapp'),
            'status': 'pending',  # 'pending', 'approved', 'rejected'
            'created_at': datetime.now().isoformat(),
            'ip': ip,
            'reviewed_at': None
        }

        all_suggestions = cls.load()
        all_suggestions.insert(0, new_suggestion)
        cls.save(all_suggestions)
        return new_suggestion

    @classmethod
    def approve(cls, suggestion_id: str) -> dict:
        """Aprova sugestão e adiciona o contato aos contatos_extras do CDV correspondente."""
        all_suggestions = cls.load()
        target = None
        for s in all_suggestions:
            if s.get('id') == suggestion_id:
                target = s
                break

        if not target:
            raise KeyError(f"Sugestão com ID '{suggestion_id}' não encontrada.")

        target['status'] = 'approved'
        target['reviewed_at'] = datetime.now().isoformat()
        cls.save(all_suggestions)

        # Adiciona contato aos contatos_extras no cdvs.json
        cdv_codigo = target.get('cdv_codigo')
        if os.path.exists(CDVS_FILE):
            with cls._lock:
                try:
                    with open(CDVS_FILE, encoding='utf-8') as f:
                        cdvs_list = json.load(f)

                    updated = False
                    for cdv in cdvs_list:
                        if cdv.get('codigo') == cdv_codigo:
                            extras = cdv.get('contatos_extras', [])
                            s_tipo = target.get('tipo', 'whatsapp' if target.get('is_whatsapp') else 'phone')
                            s_tel = target.get('telefone', '')
                            s_url = target.get('url', '')
                            if not s_url and target.get('is_whatsapp'):
                                s_url = f"https://api.whatsapp.com/send?phone=55{s_tel}"

                            # Evita duplicação do mesmo ID ou mesmo contato
                            duplicate = any(
                                e.get('id') == target['id'] or
                                (s_tel and e.get('telefone') == s_tel) or
                                (s_url and e.get('url') == s_url)
                                for e in extras
                            )
                            if not duplicate:
                                extras.append({
                                    'id': target['id'],
                                    'tipo': s_tipo,
                                    'nome': target['nome_contato'],
                                    'telefone': s_tel,
                                    'telefone_formatado': target.get('telefone_formatado', ''),
                                    'whatsapp': bool(s_tipo == 'whatsapp'),
                                    'whatsapp_url': s_url if s_tipo == 'whatsapp' else '',
                                    'url': s_url,
                                    'adicionado_em': datetime.now().isoformat()
                                })
                                cdv['contatos_extras'] = extras
                                updated = True
                            break

                    if updated:
                        atomic_write_json(CDVS_FILE, cdvs_list, indent=2)
                except Exception as e:
                    print(f"[SuggestionsStore] Erro ao atualizar {CDVS_FILE}: {e}")
                    raise e

        return target

    @classmethod
    def reject(cls, suggestion_id: str) -> dict:
        """Rejeita uma sugestão pendente."""
        all_suggestions = cls.load()
        target = None
        for s in all_suggestions:
            if s.get('id') == suggestion_id:
                target = s
                break

        if not target:
            raise KeyError(f"Sugestão com ID '{suggestion_id}' não encontrada.")

        target['status'] = 'rejected'
        target['reviewed_at'] = datetime.now().isoformat()
        cls.save(all_suggestions)
        return target
