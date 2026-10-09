import json
import os
import re
import time
import unicodedata
import urllib.parse

import requests

CACHE_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'geocache.json')
CITIES_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'cities_rs.json')

def get_user_agent() -> str:
    contact_email = os.getenv('GEOCODER_CONTACT_EMAIL', '').strip()
    if contact_email:
        return f'MapaCDVsRS/1.0 ({contact_email})'
    return os.getenv('GEOCODER_USER_AGENT', 'MapaCDVsRS/1.0 (+https://github.com/moothz/mapa-cdvs-rs)')

def atomic_write_json(filepath: str, data: any, indent: int = 2):
    """Grava JSON de forma atômica para evitar arquivos corrompidos ou truncados."""
    dirname = os.path.dirname(os.path.abspath(filepath))
    os.makedirs(dirname, exist_ok=True)
    temp_path = f"{filepath}.tmp.{os.getpid()}"
    try:
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
        os.replace(temp_path, filepath)
    except Exception as e:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
        raise e

def normalize_text(text: str) -> str:
    if not text:
        return ''
    nfkd = unicodedata.normalize('NFKD', text)
    return ''.join([c for c in nfkd if not unicodedata.combining(c)]).strip().upper()

def clean_address(addr: str) -> str:
    """
    Limpa o endereço removendo parênteses e complementos que atrapalham o geocoder.
    Ex: 'RODOVIA BR-290 (DA PONTE DO IBIRAPUITA ATE O FIM)' -> 'RODOVIA BR-290'
    """
    if not addr:
        return ''
    clean = re.sub(r'\(.*?\)', '', addr)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean

def load_cities_rs() -> dict:
    if os.path.exists(CITIES_FILE):
        try:
            with open(CITIES_FILE, encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Geocoder] Erro ao carregar cities_rs.json: {e}")
    return {}

def load_geocache() -> dict:
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Geocoder] Erro ao carregar cache: {e}")
    return {}

def save_geocache(cache: dict):
    try:
        atomic_write_json(CACHE_FILE, cache, indent=2)
    except Exception as e:
        print(f"[Geocoder] Erro ao salvar cache: {e}")

def query_google_geocoding(query: str, api_key: str) -> tuple[float | None, float | None]:
    try:
        url = f"https://maps.googleapis.com/maps/api/geocode/json?address={urllib.parse.quote(query)}&key={api_key}"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if data.get('results') and len(data['results']) > 0:
                loc = data['results'][0]['geometry']['location']
                return float(loc['lat']), float(loc['lng'])
    except Exception:
        pass
    return None, None

def query_nominatim(query: str) -> tuple[float | None, float | None]:
    try:
        url = "https://nominatim.openstreetmap.org/search?q=" + urllib.parse.quote(query) + "&format=json&limit=1"
        headers = {'User-Agent': get_user_agent()}
        resp = requests.get(url, headers=headers, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if data and len(data) > 0:
                return float(data[0]['lat']), float(data[0]['lon'])
    except Exception:
        pass
    return None, None

def geocode_cdv(cdv: dict, cities_rs: dict, cache: dict, force_precise: bool = False) -> tuple[float, float, str]:
    """
    Geocodificação em camadas para precisão máxima no local do CDV:
    1. Google Geocoding API (se GOOGLE_GEOCODING_API_KEY configurada)
    2. Nominatim: Nome Fantasia + Município (muito eficaz para estabelecimentos)
    3. Nominatim: Endereço limpo (Rua + Número) + Município
    4. Nominatim: Bairro + Município
    5. Nominatim: CEP (se válido)
    6. Fallback final: Centróide do Município
    """
    codigo = cdv.get('codigo', cdv.get('nome', ''))
    cep = cdv.get('cep', '').replace('.', '').replace('-', '').strip()
    municipio_raw = cdv.get('municipio', '').replace('/RS', '').strip()
    municipio_norm = normalize_text(municipio_raw)
    endereco = clean_address(cdv.get('endereco', ''))
    bairro = cdv.get('bairro', '').strip()
    nome = cdv.get('nome', '').strip()

    cache_key = f"{codigo}_{cep}_{municipio_norm}"

    # Se já estiver em cache com método preciso (exato), retorna imediatamente
    if cache_key in cache and not force_precise:
        item = cache[cache_key]
        method = item.get('method', '')
        # Métodos precisos aceitos no cache sem reprocessar
        if item.get('lat') and item.get('lng') and method in ('nominatim_name', 'nominatim_address', 'nominatim_bairro', 'nominatim_cep', 'google_api'):
            return item['lat'], item['lng'], method

    google_api_key = os.getenv('GOOGLE_GEOCODING_API_KEY') or os.getenv('GOOGLE_MAPS_API_KEY')

    # 1. Google Geocoding API (se chave informada)
    if google_api_key:
        g_query = f"{nome}, {endereco}, {municipio_raw}, RS, Brazil"
        lat, lng = query_google_geocoding(g_query, google_api_key)
        if lat and lng:
            cache[cache_key] = {'lat': lat, 'lng': lng, 'method': 'google_api', 'updated_at': int(time.time())}
            return lat, lng, 'google_api'

    # 2. Nominatim: Nome Fantasia + Município
    if nome and municipio_raw:
        nom_query1 = f"{nome}, {municipio_raw}, RS, Brazil"
        lat, lng = query_nominatim(nom_query1)
        time.sleep(1.0) # rate limit
        if lat and lng:
            cache[cache_key] = {'lat': lat, 'lng': lng, 'method': 'nominatim_name', 'updated_at': int(time.time())}
            return lat, lng, 'nominatim_name'

    # 3. Nominatim: Endereço + Município
    if endereco and municipio_raw:
        nom_query2 = f"{endereco}, {municipio_raw}, RS, Brazil"
        lat, lng = query_nominatim(nom_query2)
        time.sleep(1.0)
        if lat and lng:
            cache[cache_key] = {'lat': lat, 'lng': lng, 'method': 'nominatim_address', 'updated_at': int(time.time())}
            return lat, lng, 'nominatim_address'

    # 4. Nominatim: Bairro + Município
    if bairro and municipio_raw and bairro.upper() != 'CENTRO':
        nom_query3 = f"{bairro}, {municipio_raw}, RS, Brazil"
        lat, lng = query_nominatim(nom_query3)
        time.sleep(1.0)
        if lat and lng:
            cache[cache_key] = {'lat': lat, 'lng': lng, 'method': 'nominatim_bairro', 'updated_at': int(time.time())}
            return lat, lng, 'nominatim_bairro'

    # 5. Nominatim: CEP
    if cep and len(cep) == 8:
        nom_query4 = f"postalcode={cep}&country=Brazil"
        try:
            url = f"https://nominatim.openstreetmap.org/search?{nom_query4}&format=json&limit=1"
            resp = requests.get(url, headers={'User-Agent': get_user_agent()}, timeout=5)
            time.sleep(1.0)
            if resp.status_code == 200 and resp.json():
                item = resp.json()[0]
                lat = float(item['lat'])
                lng = float(item['lon'])
                cache[cache_key] = {'lat': lat, 'lng': lng, 'method': 'nominatim_cep', 'updated_at': int(time.time())}
                return lat, lng, 'nominatim_cep'
        except Exception:
            pass

    # 6. Fallback final: Centróide do Município
    city_data = cities_rs.get(municipio_norm)
    if not city_data:
        for k, v in cities_rs.items():
            if normalize_text(k) == municipio_norm:
                city_data = v
                break

    if city_data and city_data.get('lat') and city_data.get('lng'):
        lat = float(city_data['lat'])
        lng = float(city_data['lng'])
        method = 'municipio_centroid'
    else:
        lat = -29.6842
        lng = -53.8069
        method = 'rs_default'

    cache[cache_key] = {
        'lat': lat,
        'lng': lng,
        'method': method,
        'updated_at': int(time.time())
    }

    return lat, lng, method
