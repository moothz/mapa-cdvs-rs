import base64
import html
import json
import math
import os
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from scripts.suggestions import RateLimiter, SuggestionsStore, sanitize_text

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CDVS_FILE = os.path.join(DATA_DIR, 'cdvs.json')
CITIES_FILE = os.path.join(DATA_DIR, 'cities_rs.json')
METADATA_FILE = os.path.join(DATA_DIR, 'metadata.json')

ADMIN_USER = os.getenv('ADMIN_USER', 'admin')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'admin')

# Limitador de requisições por IP para envio de sugestões (5 requisições por 10 min)
suggestion_limiter = RateLimiter(max_requests=5, window_seconds=600)


def normalize_text(text: str) -> str:
    """Remove acentos, converte para minúsculas e remove espaços sobressalentes."""
    if not text:
        return ''
    nfkd = unicodedata.normalize('NFKD', str(text))
    ascii_text = ''.join(c for c in nfkd if not unicodedata.combining(c))
    return ascii_text.lower().strip()


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calcula a distância em linha reta (em km) entre duas coordenadas geográficas."""
    radius_earth_km = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2.0) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return round(radius_earth_km * c, 2)


class DataStore:
    """Gerencia leitura e cache em memória dos dados dos CDVs e Cidades."""
    _cdvs = []
    _cities = {}
    _cities_normalized = {}
    _metadata = {}
    _cdvs_mtime = 0
    _lock = threading.Lock()

    @classmethod
    def load(cls):
        with cls._lock:
            # Recarrega CDVs se o arquivo foi modificado
            if os.path.exists(CDVS_FILE):
                mtime = os.path.getmtime(CDVS_FILE)
                if mtime != cls._cdvs_mtime or not cls._cdvs:
                    try:
                        with open(CDVS_FILE, encoding='utf-8') as f:
                            raw_cdvs = json.load(f)
                            # Pré-indexa string de busca para altíssimo desempenho
                            for cdv in raw_cdvs:
                                haystack_parts = [
                                    cdv.get('nome', ''),
                                    cdv.get('codigo', ''),
                                    cdv.get('municipio', ''),
                                    cdv.get('bairro', ''),
                                    cdv.get('endereco', ''),
                                    cdv.get('cep', ''),
                                    cdv.get('telefone', ''),
                                    cdv.get('whatsapp', '')
                                ]
                                for extra in cdv.get('contatos_extras', []):
                                    haystack_parts.append(extra.get('nome', ''))
                                    haystack_parts.append(extra.get('telefone', ''))
                                cdv['_haystack'] = normalize_text(' '.join(haystack_parts))
                            cls._cdvs = raw_cdvs
                            cls._cdvs_mtime = mtime
                    except Exception as e:
                        print(f"[API DataStore] Erro ao ler {CDVS_FILE}: {e}")

            # Carrega Cidades uma vez
            if not cls._cities and os.path.exists(CITIES_FILE):
                try:
                    with open(CITIES_FILE, encoding='utf-8') as f:
                        cls._cities = json.load(f)
                        cls._cities_normalized = {
                            normalize_text(k): {
                                'chave': k,
                                'nome': v.get('nome', k),
                                'lat': v.get('lat'),
                                'lng': v.get('lng')
                            }
                            for k, v in cls._cities.items()
                        }
                except Exception as e:
                    print(f"[API DataStore] Erro ao ler {CITIES_FILE}: {e}")

    @classmethod
    def get_cdvs(cls, clean: bool = True):
        cls.load()
        if clean:
            return [{k: v for k, v in c.items() if k != '_haystack'} for c in cls._cdvs]
        return cls._cdvs

    @classmethod
    def find_cdv_by_code(cls, code: str):
        cls.load()
        code_upper = code.strip().upper()
        for cdv in cls._cdvs:
            if cdv.get('codigo', '').upper() == code_upper:
                return cdv
        return None

    @classmethod
    def get_cities(cls):
        cls.load()
        return cls._cities

    @classmethod
    def find_city(cls, name: str):
        cls.load()
        norm = normalize_text(name)
        if norm in cls._cities_normalized:
            return cls._cities_normalized[norm]

        # Busca parcial se não encontrar exato
        for key, city in cls._cities_normalized.items():
            if norm == key or norm in key:
                return city
        return None

    @classmethod
    def get_metadata(cls):
        if os.path.exists(METADATA_FILE):
            try:
                with open(METADATA_FILE, encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            'total_cdvs': len(cls.get_cdvs()),
            'ultima_atualizacao': None,
            'fonte': 'Detran-RS Peça Legal (pecalegal.detran.rs.gov.br)',
            'repositorio': 'https://github.com/moothz/mapa-cdvs-rs'
        }


class CDVApiRequestHandler(BaseHTTPRequestHandler):
    """Manipulador HTTP REST da API e Painel Administrativo do Mapa CDVs RS."""

    def _get_client_ip(self) -> str:
        # 1. Cloudflare Connecting IP (mais confiável quando atrás de Cloudflare Proxy/Tunnel)
        cf_ip = self.headers.get('CF-Connecting-IP')
        if cf_ip and cf_ip.strip():
            return cf_ip.strip()

        # 2. True-Client-IP (Cloudflare Enterprise ou proxies corporativos)
        true_ip = self.headers.get('True-Client-IP')
        if true_ip and true_ip.strip():
            return true_ip.strip()

        # 3. X-Forwarded-For (analisa cadeia e prioriza o primeiro IP público)
        forwarded = self.headers.get('X-Forwarded-For')
        if forwarded:
            ips = [ip.strip() for ip in forwarded.split(',') if ip.strip()]
            for ip in ips:
                # Ignora faixas privadas locais/Docker/Loopback se houver IP público na cadeia
                if not (ip.startswith('10.') or ip.startswith('192.168.') or ip.startswith('127.') or
                        ip.startswith('172.16.') or ip.startswith('172.17.') or ip.startswith('172.18.') or
                        ip.startswith('172.19.') or ip.startswith('172.2') or ip.startswith('172.3') or
                        ip.startswith('fc00:') or ip.startswith('fe80:') or ip == '::1'):
                    return ip
            if ips:
                return ips[0]

        # 4. X-Real-IP
        real_ip = self.headers.get('X-Real-IP')
        if real_ip and real_ip.strip():
            return real_ip.strip()

        # 5. IP do socket TCP direto
        return self.client_address[0]

    def _check_basic_auth(self) -> bool:
        auth_header = self.headers.get('Authorization', '')
        if auth_header.startswith('Basic '):
            try:
                decoded = base64.b64decode(auth_header[6:].strip()).decode('utf-8')
                user, passwd = decoded.split(':', 1)
                if user == ADMIN_USER and passwd == ADMIN_PASSWORD:
                    return True
            except Exception:
                pass
        return False

    def _send_auth_required(self):
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Mapa CDVs RS - Administracao"')
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(b"<h1>401 Nao Autorizado</h1><p>Acesso restrito ao administrador.</p>")

    def _send_json(self, status_code: int, data: any):
        content = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        self.end_headers()
        self.wfile.write(content)

    def _send_html(self, status_code: int, html_str: str):
        content = html_str.encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')
        query = parse_qs(parsed.query)

        # Healthcheck
        if path in ('/health', '/api/health'):
            return self._send_json(200, {'status': 'ok', 'service': 'mapa-cdvs-api'})

        # Painel Administrativo Web (/admin)
        if path == '/admin':
            if not self._check_basic_auth():
                return self._send_auth_required()
            return self.render_admin_dashboard()

        # API Administrativa: Listar sugestões (/api/admin/suggestions)
        if path in ('/api/admin/suggestions', '/admin/suggestions'):
            if not self._check_basic_auth():
                return self._send_auth_required()
            return self._send_json(200, SuggestionsStore.load())

        # 1. Busca textual livre (/api/cdvs/search)
        if path in ('/api/cdvs/search', '/cdvs/search'):
            return self.handle_search(query)

        # 2. Busca por proximidade (/api/cdvs/nearby ou /api/cdvs/proximos)
        if path in ('/api/cdvs/nearby', '/cdvs/nearby', '/api/cdvs/proximos', '/cdvs/proximos'):
            return self.handle_nearby(query)

        # 3. Lista geral ou delegação via query string (/api/cdvs)
        if path in ('/api/cdvs', '/cdvs'):
            if 'q' in query:
                return self.handle_search(query)
            if 'lat' in query or 'cidade' in query:
                return self.handle_nearby(query)
            return self._send_json(200, DataStore.get_cdvs())

        # 4. Cidades (/api/cities)
        if path in ('/api/cities', '/cities'):
            return self._send_json(200, DataStore.get_cities())

        # 5. Metadados (/api/metadata)
        if path in ('/api/metadata', '/metadata'):
            return self._send_json(200, DataStore.get_metadata())

        # Rota desconhecida
        return self._send_json(404, {
            'error': 'Endpoint não encontrado',
            'endpoints_disponiveis': [
                'GET /api/cdvs',
                'GET /api/cdvs/search?q={termo}&limit={N}',
                'GET /api/cdvs/nearby?cidade={cidade}&limit=15',
                'GET /api/cdvs/nearby?lat={lat}&lng={lng}&limit=15',
                'GET /api/cities',
                'GET /api/metadata',
                'POST /api/suggestions'
            ]
        })

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/')

        # 1. Submissão pública de sugestão de contato (/api/suggestions)
        if path in ('/api/suggestions', '/suggestions'):
            return self.handle_create_suggestion()

        # 2. Moderação administrativa: Aprovar sugestão (/api/admin/suggestions/<id>/approve)
        if path.startswith('/api/admin/suggestions/') and path.endswith('/approve'):
            if not self._check_basic_auth():
                return self._send_auth_required()
            parts = path.split('/')
            # /api/admin/suggestions/<id>/approve -> parts[4]
            sug_id = parts[4] if len(parts) >= 5 else ''
            return self.handle_approve_suggestion(sug_id)

        # 3. Moderação administrativa: Rejeitar sugestão (/api/admin/suggestions/<id>/reject)
        if path.startswith('/api/admin/suggestions/') and path.endswith('/reject'):
            if not self._check_basic_auth():
                return self._send_auth_required()
            parts = path.split('/')
            sug_id = parts[4] if len(parts) >= 5 else ''
            return self.handle_reject_suggestion(sug_id)

        return self._send_json(404, {'error': 'Endpoint não encontrado'})

    def handle_create_suggestion(self):
        client_ip = self._get_client_ip()
        if not suggestion_limiter.is_allowed(client_ip):
            return self._send_json(429, {
                'error': 'Limite de envio excedido. Aguarde alguns minutos antes de enviar uma nova sugestão.'
            })

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > 65536:
                return self._send_json(413, {'error': 'Payload muito grande.'})

            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body)
        except Exception as e:
            return self._send_json(400, {'error': f'JSON inválido: {e}'})

        cdv_codigo = str(data.get('cdv_codigo', '')).strip().upper()
        nome_contato = str(data.get('nome_contato', '')).strip()
        tipo_contato = str(data.get('tipo', 'whatsapp')).strip().lower()
        telefone = str(data.get('telefone', '')).strip()
        valor_social = str(data.get('valor', '')).strip()
        is_whatsapp = bool(data.get('is_whatsapp', tipo_contato == 'whatsapp'))

        if not cdv_codigo:
            return self._send_json(400, {'error': 'O código do CDV (cdv_codigo) é obrigatório.'})

        cdv = DataStore.find_cdv_by_code(cdv_codigo)
        if not cdv:
            return self._send_json(404, {'error': f"CDV com código '{cdv_codigo}' não encontrado na base."})

        clean_name = sanitize_text(nome_contato, max_length=100)
        if tipo_contato in ('instagram', 'facebook'):
            if not clean_name or clean_name.lower() in ('instagram', 'insta', 'facebook', 'face', 'social', 'perfil'):
                clean_name = 'Insta' if tipo_contato == 'instagram' else 'Face'
        elif len(clean_name) < 2:
            return self._send_json(400, {'error': 'Nome do contato deve ter pelo menos 2 caracteres.'})

        try:
            suggestion = SuggestionsStore.add(
                cdv_codigo=cdv_codigo,
                cdv_nome=cdv.get('nome', ''),
                nome_contato=clean_name,
                telefone=telefone,
                is_whatsapp=is_whatsapp,
                tipo=tipo_contato,
                valor=valor_social or telefone,
                ip=client_ip
            )

            # Notifica moderadores via Telegram se configurado (assíncrono)
            try:
                from scripts.telegram_bot import notify_new_suggestion
                notify_new_suggestion(suggestion)
            except Exception as te:
                print(f"[API] Falha ao despachar notificação para Telegram: {te}")

            return self._send_json(201, {
                'status': 'success',
                'message': 'Sugestão de contato enviada com sucesso! Ela passará por moderação antes de ser publicada.',
                'suggestion': suggestion
            })
        except ValueError as ve:
            return self._send_json(400, {'error': str(ve)})
        except Exception as e:
            return self._send_json(500, {'error': f'Erro ao registrar sugestão: {e}'})

    def handle_approve_suggestion(self, sug_id: str):
        if not sug_id:
            return self._send_json(400, {'error': 'ID da sugestão é obrigatório.'})
        try:
            approved = SuggestionsStore.approve(sug_id)
            # Recarrega DataStore em memória imediatamente
            DataStore.load()
            return self._send_json(200, {
                'status': 'success',
                'message': f"Sugestão '{sug_id}' aprovada e contato adicionado ao CDV.",
                'suggestion': approved
            })
        except KeyError:
            return self._send_json(404, {'error': f"Sugestão '{sug_id}' não encontrada."})
        except Exception as e:
            return self._send_json(500, {'error': f"Erro ao aprovar sugestão: {e}"})

    def handle_reject_suggestion(self, sug_id: str):
        if not sug_id:
            return self._send_json(400, {'error': 'ID da sugestão é obrigatório.'})
        try:
            rejected = SuggestionsStore.reject(sug_id)
            return self._send_json(200, {
                'status': 'success',
                'message': f"Sugestão '{sug_id}' rejeitada.",
                'suggestion': rejected
            })
        except KeyError:
            return self._send_json(404, {'error': f"Sugestão '{sug_id}' não encontrada."})
        except Exception as e:
            return self._send_json(500, {'error': f"Erro ao rejeitar sugestão: {e}"})

    def render_admin_dashboard(self):
        suggestions = SuggestionsStore.load()
        pending_count = sum(1 for s in suggestions if s.get('status') == 'pending')
        approved_count = sum(1 for s in suggestions if s.get('status') == 'approved')
        rejected_count = sum(1 for s in suggestions if s.get('status') == 'rejected')

        rows_html = []
        for s in suggestions:
            status = s.get('status', 'pending')
            status_badge_class = {
                'pending': 'badge-pending',
                'approved': 'badge-approved',
                'rejected': 'badge-rejected'
            }.get(status, 'badge-pending')

            status_label = {
                'pending': '⏳ Pendente',
                'approved': '✅ Aprovado',
                'rejected': '❌ Rejeitado'
            }.get(status, status)

            actions = ''
            if status == 'pending':
                actions = f"""
                <button class="btn btn-approve" onclick="moderate('{s['id']}', 'approve')">Aprovar</button>
                <button class="btn btn-reject" onclick="moderate('{s['id']}', 'reject')">Rejeitar</button>
                """
            else:
                actions = "<span class='text-muted'>Finalizado</span>"

            s_tipo = s.get('tipo', 'whatsapp' if s.get('is_whatsapp') else 'phone')
            tipo_desc = {
                'whatsapp': '💬 WhatsApp',
                'phone': '📞 Apenas Ligação',
                'instagram': '📸 Instagram',
                'facebook': '👥 Facebook'
            }.get(s_tipo, s_tipo)

            rows_html.append(f"""
            <tr id="row-{s['id']}">
                <td><code>{html.escape(s.get('id', ''))}</code></td>
                <td><strong>{html.escape(s.get('cdv_codigo', ''))}</strong><br><small>{html.escape(s.get('cdv_nome', ''))}</small></td>
                <td>{html.escape(s.get('nome_contato', ''))}</td>
                <td>
                    <strong>{html.escape(s.get('telefone_formatado', s.get('telefone', s.get('url', ''))))}</strong><br>
                    <small>{tipo_desc}</small>
                </td>
                <td><span class="badge {status_badge_class}">{status_label}</span></td>
                <td><small>{html.escape(s.get('created_at', '')[:19].replace('T', ' '))}</small></td>
                <td>{actions}</td>
            </tr>
            """)

        html_content = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Painel de Moderação - Mapa CDVs RS</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F8FAFC; margin: 0; padding: 24px; color: #0F172A; }}
    .container {{ max-width: 1100px; margin: 0 auto; background: #FFF; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); padding: 24px; }}
    header {{ display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #E2E8F0; padding-bottom: 16px; margin-bottom: 20px; }}
    h1 {{ font-size: 1.4rem; margin: 0; color: #B45309; }}
    .stats {{ display: flex; gap: 12px; }}
    .stat-card {{ background: #F1F5F9; padding: 8px 16px; border-radius: 8px; font-weight: 600; font-size: 0.85rem; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 0.88rem; }}
    th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #E2E8F0; vertical-align: middle; }}
    th {{ background: #F8FAFC; font-weight: 700; color: #475569; }}
    .badge {{ padding: 4px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; display: inline-block; }}
    .badge-pending {{ background: #FEF3C7; color: #B45309; }}
    .badge-approved {{ background: #ECFDF5; color: #047857; }}
    .badge-rejected {{ background: #FEE2E2; color: #B91C1C; }}
    .btn {{ padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.8rem; margin-right: 4px; transition: 0.15s; }}
    .btn-approve {{ background: #047857; color: #FFF; }}
    .btn-approve:hover {{ background: #065F46; }}
    .btn-reject {{ background: #DC2626; color: #FFF; }}
    .btn-reject:hover {{ background: #B91C1C; }}
    .text-muted {{ color: #94A3B8; font-size: 0.8rem; }}
    .back-link {{ display: inline-block; margin-top: 16px; color: #B45309; text-decoration: none; font-weight: 600; }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>🛡️ Moderação de Sugestões de Contato</h1>
        <p style="margin: 4px 0 0; color: #64748B; font-size: 0.85rem;">Revise e aprove contatos sugeridos pela comunidade</p>
      </div>
      <div class="stats">
        <div class="stat-card">⏳ Pendentes: <strong>{pending_count}</strong></div>
        <div class="stat-card">✅ Aprovados: <strong>{approved_count}</strong></div>
        <div class="stat-card">❌ Rejeitados: <strong>{rejected_count}</strong></div>
      </div>
    </header>

    <div style="overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>CDV</th>
            <th>Contato Sugerido</th>
            <th>Telefone</th>
            <th>Status</th>
            <th>Data</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>
          {"".join(rows_html) if rows_html else "<tr><td colspan='7' style='text-align:center; padding: 32px;'>Nenhuma sugestão registrada até o momento.</td></tr>"}
        </tbody>
      </table>
    </div>

    <a href="/" class="back-link">← Voltar para o Mapa</a>
  </div>

  <script>
    async function moderate(id, action) {{
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = '...';
      try {{
        const resp = await fetch('/api/admin/suggestions/' + id + '/' + action, {{
          method: 'POST'
        }});
        if (resp.ok) {{
          location.reload();
        }} else {{
          const err = await resp.json();
          alert('Erro: ' + (err.error || 'Falha ao processar'));
          btn.disabled = false;
        }}
      }} catch (e) {{
        alert('Erro de comunicação: ' + e);
        btn.disabled = false;
      }}
    }}
  </script>
</body>
</html>"""
        return self._send_html(200, html_content)

    def handle_search(self, query: dict):
        raw_q = query.get('q', [''])[0].strip()
        if not raw_q:
            return self._send_json(400, {
                'error': "Parâmetro 'q' (termo de busca) é obrigatório. Ex: /api/cdvs/search?q=moto"
            })

        try:
            limit = int(query.get('limit', [50])[0])
            limit = max(1, min(500, limit))
        except ValueError:
            limit = 50

        normalized_query = normalize_text(raw_q)
        tokens = normalized_query.split()

        all_cdvs = DataStore.get_cdvs(clean=False)
        matched = []

        for cdv in all_cdvs:
            haystack = cdv.get('_haystack')
            if haystack is None:
                haystack_parts = [
                    cdv.get('nome', ''),
                    cdv.get('codigo', ''),
                    cdv.get('municipio', ''),
                    cdv.get('bairro', ''),
                    cdv.get('endereco', ''),
                    cdv.get('cep', ''),
                    cdv.get('telefone', ''),
                    cdv.get('whatsapp', '')
                ]
                haystack = normalize_text(' '.join(haystack_parts))

            # Todos os tokens da busca precisam estar presentes
            if all(t in haystack for t in tokens):
                matched.append({k: v for k, v in cdv.items() if k != '_haystack'})

        return self._send_json(200, {
            'termo': raw_q,
            'total_encontrados': len(matched),
            'limit': limit,
            'cdvs': matched[:limit]
        })

    def handle_nearby(self, query: dict):
        try:
            limit = int(query.get('limit', [15])[0])
            limit = max(1, min(200, limit))
        except ValueError:
            limit = 15

        raio_km = None
        if 'raio_km' in query:
            try:
                raio_km = float(query['raio_km'][0])
            except ValueError:
                pass

        ref_lat = None
        ref_lng = None
        referencia_info = {}

        cidade_query = query.get('cidade', [''])[0].strip()
        lat_param = query.get('lat', [''])[0].strip()
        lng_param = query.get('lng', [''])[0].strip()

        if cidade_query:
            city = DataStore.find_city(cidade_query)
            if not city:
                return self._send_json(404, {
                    'error': f"Município '{cidade_query}' não encontrado na base do Rio Grande do Sul.",
                    'dica': "Consulte /api/cities para ver os nomes oficiais dos municípios do RS."
                })
            ref_lat = city['lat']
            ref_lng = city['lng']
            referencia_info = {
                'tipo': 'cidade',
                'cidade': city['nome'],
                'lat': ref_lat,
                'lng': ref_lng
            }
        elif lat_param and lng_param:
            try:
                ref_lat = float(lat_param)
                ref_lng = float(lng_param)
            except ValueError:
                return self._send_json(400, {
                    'error': "Valores inválidos para 'lat' e 'lng'. Devem ser números decimais."
                })
            referencia_info = {
                'tipo': 'coordenada',
                'lat': ref_lat,
                'lng': ref_lng
            }
        else:
            return self._send_json(400, {
                'error': "Informe 'cidade' (ex: ?cidade=Passo Fundo) ou coordenadas 'lat' e 'lng' (ex: ?lat=-28.26&lng=-52.41).",
                'exemplo_cidade': "/api/cdvs/nearby?cidade=Passo Fundo&limit=15",
                'exemplo_coords': "/api/cdvs/nearby?lat=-28.2576&lng=-52.4091&limit=15"
            })

        all_cdvs = DataStore.get_cdvs(clean=False)
        with_distance = []

        for cdv in all_cdvs:
            cdv_lat = cdv.get('lat')
            cdv_lng = cdv.get('lng')
            if cdv_lat is not None and cdv_lng is not None:
                dist = haversine_distance(ref_lat, ref_lng, float(cdv_lat), float(cdv_lng))
                if raio_km is not None and dist > raio_km:
                    continue
                # Cria cópia superficial com distancia_km sem campos internos
                item = {k: v for k, v in cdv.items() if k != '_haystack'}
                item['distancia_km'] = dist
                with_distance.append(item)

        # Ordena do mais próximo ao mais distante
        with_distance.sort(key=lambda x: x['distancia_km'])

        return self._send_json(200, {
            'referencia': referencia_info,
            'total_encontrados': len(with_distance),
            'limit': limit,
            'cdvs': with_distance[:limit]
        })

    def log_message(self, format, *args):
        # Desativa logs verbosos no stdout normal para não poluir
        pass


def run_api_server(host: str = '0.0.0.0', port: int = 8000):
    """Inicia o servidor da API no processo atual com suporte a multi-threading."""
    DataStore.load()
    try:
        from scripts.telegram_bot import start_telegram_bot
        start_telegram_bot()
    except Exception as e:
        print(f"[API Server] Aviso ao iniciar bot do Telegram: {e}")

    server = ThreadingHTTPServer((host, port), CDVApiRequestHandler)
    server.daemon_threads = True
    print(f"[API Server] Multi-thread rodando em http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def start_background_api(host: str = '0.0.0.0', port: int = 8000) -> threading.Thread:
    """Inicia o servidor da API em uma thread daemon em background com suporte a multi-threading."""
    DataStore.load()
    try:
        from scripts.telegram_bot import start_telegram_bot
        start_telegram_bot()
    except Exception as e:
        print(f"[API Server] Aviso ao iniciar bot do Telegram: {e}")

    server = ThreadingHTTPServer((host, port), CDVApiRequestHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="ApiServerThread")
    thread.start()
    print(f"[API Server] Thread da API multi-thread iniciada em http://{host}:{port}")
    return thread


if __name__ == '__main__':
    port = int(os.getenv('API_PORT', '8000'))
    run_api_server(port=port)
