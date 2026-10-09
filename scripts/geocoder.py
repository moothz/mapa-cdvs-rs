import json
import os
import time
import urllib.parse
import unicodedata
import requests

CACHE_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'geocache.json')
CITIES_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'cities_rs.json')

def normalize_text(text: str) -> str:
    if not text:
        return ''
    # Remove acentos e converte para maiúsculo
    nfkd = unicodedata.normalize('NFKD', text)
    return ''.join([c for c in nfkd if not unicodedata.combining(c)]).strip().upper()

def load_cities_rs() -> dict:
    if os.path.exists(CITIES_FILE):
        try:
            with open(CITIES_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Geocoder] Erro ao carregar cities_rs.json: {e}")
    return {}

def load_geocache() -> dict:
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Geocoder] Erro ao carregar cache: {e}")
    return {}

def save_geocache(cache: dict):
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Geocoder] Erro ao salvar cache: {e}")

def geocode_cdv(cdv: dict, cities_rs: dict, cache: dict) -> tuple[float, float, str]:
    """
    Retorna (lat, lng, metodo_resolucao)
    Camadas:
    1. Cache local
    2. Coordenadas do Município de referência (garantido e instantâneo)
    3. Opcional: Nominatim com rate limit se endereço completo
    """
    cep = cdv.get('cep', '').replace('.', '').replace('-', '').strip()
    municipio_raw = cdv.get('municipio', '').replace('/RS', '').strip()
    municipio_norm = normalize_text(municipio_raw)
    endereco = cdv.get('endereco', '').strip()
    codigo = cdv.get('codigo', cdv.get('nome', ''))

    cache_key = f"{codigo}_{cep}_{municipio_norm}"

    # 1. Verifica cache local
    if cache_key in cache:
        item = cache[cache_key]
        if item.get('lat') and item.get('lng'):
            return item['lat'], item['lng'], item.get('method', 'cache')

    lat = None
    lng = None
    method = 'none'

    # 2. Tenta Nominatim pelo CEP se disponível (com timeout baixo para não travar)
    if cep and len(cep) == 8:
        try:
            url = f"https://nominatim.openstreetmap.org/search?postalcode={cep}&country=Brazil&format=json&limit=1"
            headers = {'User-Agent': 'MapaCDVsRS/1.0 (m.moothz@gmail.com)'}
            resp = requests.get(url, headers=headers, timeout=3)
            if resp.status_code == 200:
                data = resp.json()
                if data and len(data) > 0:
                    lat = float(data[0]['lat'])
                    lng = float(data[0]['lon'])
                    method = 'nominatim_cep'
                    time.sleep(1.0) # Respeita rate limit
        except Exception:
            pass

    # 3. Fallback inteligente: Centróide do município do RS
    if not lat or not lng:
        # Busca direta ou aproximada no dicionário de cidades do RS
        city_data = cities_rs.get(municipio_norm)
        if not city_data:
            # Tenta buscar por substring se nome tiver variações
            for k, v in cities_rs.items():
                if normalize_text(k) == municipio_norm:
                    city_data = v
                    break

        if city_data and city_data.get('lat') and city_data.get('lng'):
            lat = float(city_data['lat'])
            lng = float(city_data['lng'])
            method = 'municipio_centroid'

    # Se ainda assim não encontrar (muito raro), centro do RS (Santa Maria)
    if not lat or not lng:
        lat = -29.6842
        lng = -53.8069
        method = 'rs_default'

    # Salva no cache
    cache[cache_key] = {
        'lat': lat,
        'lng': lng,
        'method': method,
        'updated_at': int(time.time())
    }

    return lat, lng, method
