import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
import requests
from bs4 import BeautifulSoup

from scripts.geocoder import load_cities_rs, load_geocache, save_geocache, geocode_cdv, atomic_write_json

BASE_URL = "https://pecalegal.detran.rs.gov.br/cdv-portal/mod-consulta/credenciados.xhtml"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
}

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
CDVS_FILE = os.path.join(DATA_DIR, 'cdvs.json')
METADATA_FILE = os.path.join(DATA_DIR, 'metadata.json')
STATE_FILE = os.path.join(DATA_DIR, 'scraper_state.json')

def load_cdvs() -> dict:
    if os.path.exists(CDVS_FILE):
        try:
            with open(CDVS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # indexa por codigo se for lista
                if isinstance(data, list):
                    return {item.get('codigo', item.get('nome')): item for item in data}
                return data
        except Exception as e:
            print(f"[Scraper] Erro ao ler cdvs.json: {e}")
    return {}

def save_cdvs(cdvs_dict: dict):
    cdvs_list = list(cdvs_dict.values())
    # Ordena alfabeticamente por nome
    cdvs_list.sort(key=lambda x: x.get('nome', ''))
    try:
        atomic_write_json(CDVS_FILE, cdvs_list, indent=2)
    except Exception as e:
        print(f"[Scraper] Erro ao salvar cdvs.json: {e}")

    # Atualiza metadata
    update_metadata(len(cdvs_list))

def update_metadata(total_cdvs: int):
    metadata = {
        'total_cdvs': total_cdvs,
        'ultima_atualizacao': datetime.now().isoformat(),
        'fonte': 'Detran-RS Peça Legal (pecalegal.detran.rs.gov.br)',
        'repositorio': 'https://github.com/moothz/mapa-cdvs-rs'
    }
    try:
        atomic_write_json(METADATA_FILE, metadata, indent=2)
    except Exception as e:
        print(f"[Scraper] Erro ao salvar metadata.json: {e}")

def scrape_page(page_num: int) -> tuple[list[dict], int]:
    """
    Retorna (itens_encontrados, total_paginas_detectadas)
    """
    url = f"{BASE_URL}?page={page_num}"
    print(f"[Scraper] Requisitando página {page_num}...")
    
    resp = requests.get(url, headers=HEADERS, timeout=20)
    if resp.status_code != 200:
        raise Exception(f"HTTP {resp.status_code} ao acessar página {page_num}")

    soup = BeautifulSoup(resp.text, 'html.parser')

    # Detecta total de páginas (ex: "Página 1 de 71")
    total_pages = 71
    paginator_match = re.search(r'Página\s+\d+\s+de\s+(\d+)', resp.text)
    if paginator_match:
        total_pages = int(paginator_match.group(1))

    items = []
    panels = soup.find_all('div', class_='desmanches-nomeFantasia')
    
    for name_el in panels:
        name = name_el.get_text(strip=True)
        panel = name_el.find_parent('div', class_='ui-panel') or name_el.parent
        
        cdv_data = {
            'nome': name,
            'codigo': '',
            'telefone': '',
            'whatsapp': '',
            'whatsapp_url': '',
            'email': '',
            'endereco': '',
            'complemento': '',
            'bairro': '',
            'cep': '',
            'municipio': '',
            'maps_url': '',
            'coletado_em': datetime.now().isoformat()
        }

        table = panel.find('table', class_='desmanches-panelGrid') if panel else None
        if table:
            for row in table.find_all('tr'):
                tds = row.find_all('td')
                if len(tds) == 2:
                    label = tds[0].get_text(strip=True).replace(':', '').strip()
                    val_cell = tds[1]

                    # Google Maps link
                    gmap_link = val_cell.find('a', title='GoogleMaps')
                    if gmap_link:
                        cdv_data['maps_url'] = gmap_link.get('href', '')
                        cdv_data['endereco'] = gmap_link.get_text(strip=True)

                    # Whatsapp link
                    wa_link = val_cell.find('a', title='Whatsapp')
                    if wa_link:
                        cdv_data['whatsapp_url'] = wa_link.get('href', '')
                        cdv_data['whatsapp'] = wa_link.get_text(strip=True)

                    text_val = val_cell.get_text(' ', strip=True)

                    if label == 'Código':
                        cdv_data['codigo'] = text_val
                    elif label == 'Telefone':
                        # Extrai telefone principal
                        cdv_data['telefone'] = text_val
                    elif label == 'E-mail':
                        cdv_data['email'] = text_val
                    elif label == 'Endereço' and not cdv_data['endereco']:
                        cdv_data['endereco'] = text_val
                    elif label == 'Compl.':
                        cdv_data['complemento'] = text_val
                    elif label == 'Bairro':
                        cdv_data['bairro'] = text_val
                    elif label == 'Cep':
                        cdv_data['cep'] = text_val
                    elif label == 'Município':
                        cdv_data['municipio'] = text_val

        # Se não tiver código único, usa fallback
        if not cdv_data['codigo']:
            cdv_data['codigo'] = re.sub(r'\W+', '_', cdv_data['nome']).lower()

        # Limpa telefone retirando repetição do texto de whatsapp se presente
        if '/ Whatsapp:' in cdv_data['telefone']:
            parts = cdv_data['telefone'].split('/ Whatsapp:')
            cdv_data['telefone'] = parts[0].strip()

        items.append(cdv_data)

    return items, total_pages

def process_and_enrich_items(items: list[dict], cities_rs: dict, geocache: dict) -> list[dict]:
    enriched = []
    for cdv in items:
        # Busca automática com precisão máxima por Nome Fantasia e Endereço por padrão
        lat, lng, method = geocode_cdv(cdv, cities_rs, geocache, force_precise=True)
        cdv['lat'] = lat
        cdv['lng'] = lng
        cdv['geo_method'] = method
        enriched.append(cdv)
    return enriched

def run_single_page(page_num: int):
    cities_rs = load_cities_rs()
    geocache = load_geocache()
    cdvs = load_cdvs()

    items, total_pages = scrape_page(page_num)
    enriched = process_and_enrich_items(items, cities_rs, geocache)

    for item in enriched:
        code = item.get('codigo')
        if code and code in cdvs and 'contatos_extras' in cdvs[code]:
            item['contatos_extras'] = cdvs[code]['contatos_extras']
        cdvs[code] = item

    save_geocache(geocache)
    save_cdvs(cdvs)

    print(f"[Scraper] Página {page_num} processada com sucesso. {len(enriched)} CDVs obtidos.")
    return len(enriched), total_pages

def run_bootstrap():
    """
    Executa a varredura inicial completa com pequeno delay educado entre requisições.
    Útil para gerar o snapshot completo de largada.
    """
    print("[Scraper] Iniciando coleta inicial completa (Bootstrap)...")
    cities_rs = load_cities_rs()
    geocache = load_geocache()
    cdvs = load_cdvs()

    # Pega página 0 para descobrir total
    first_items, total_pages = scrape_page(0)
    enriched = process_and_enrich_items(first_items, cities_rs, geocache)
    for item in enriched:
        code = item.get('codigo')
        if code and code in cdvs and 'contatos_extras' in cdvs[code]:
            item['contatos_extras'] = cdvs[code]['contatos_extras']
        cdvs[code] = item
    print(f"[Scraper] Página 0/{total_pages - 1} coletada. {len(enriched)} itens.")

    for p in range(1, total_pages):
        time.sleep(1.5) # Delay educado entre requisições
        try:
            items, _ = scrape_page(p)
            enriched = process_and_enrich_items(items, cities_rs, geocache)
            for item in enriched:
                code = item.get('codigo')
                if code and code in cdvs and 'contatos_extras' in cdvs[code]:
                    item['contatos_extras'] = cdvs[code]['contatos_extras']
                cdvs[code] = item
            print(f"[Scraper] Página {p}/{total_pages - 1} coletada. Total acumulado: {len(cdvs)}")
            # Salva a cada 10 páginas
            if p % 10 == 0:
                save_geocache(geocache)
                save_cdvs(cdvs)
        except Exception as e:
            print(f"[Scraper] Erro na página {p}: {e}")

    save_geocache(geocache)
    save_cdvs(cdvs)
    print(f"[Scraper] Bootstrap concluído! Total final de CDVs: {len(cdvs)}")

def run_refine(max_items: int = None):
    """
    Refina as coordenadas dos CDVs existentes que estao marcados apenas com municipio_centroid
    utilizando a busca precisa por Nome e Endereco.
    """
    print("[Scraper] Iniciando refinamento de coordenadas para precisão máxima...")
    cities_rs = load_cities_rs()
    geocache = load_geocache()
    cdvs = load_cdvs()

    # Prioriza os que estão com municipio_centroid
    candidates = [
        item for item in cdvs.values() 
        if item.get('geo_method') in ('municipio_centroid', 'rs_default', None)
    ]
    print(f"[Scraper] Encontrados {len(candidates)} CDVs para refinamento de precisão.")

    refined_count = 0
    for idx, cdv in enumerate(candidates):
        if max_items and idx >= max_items:
            break

        nome = cdv.get('nome')
        codigo = cdv.get('codigo')
        print(f"[{idx+1}/{len(candidates)}] Refinando {codigo} - {nome}...")

        lat, lng, method = geocode_cdv(cdv, cities_rs, geocache, force_precise=True)
        if method != 'municipio_centroid':
            cdv['lat'] = lat
            cdv['lng'] = lng
            cdv['geo_method'] = method
            refined_count += 1
            print(f"  -> Sucesso ({method}): {lat}, {lng}")
        else:
            print("  -> Permanece centróide do município")

        # Salva periodicamente
        if (idx + 1) % 5 == 0:
            save_geocache(geocache)
            save_cdvs(cdvs)

    save_geocache(geocache)
    save_cdvs(cdvs)
    print(f"[Scraper] Refinamento concluído! {refined_count} CDVs com coordenadas de alta precisão.")

def run_once():
    """Executa a coleta da próxima página de acordo com o scraper_state.json e avança o estado."""
    state = {}
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                state = json.load(f)
        except Exception as e:
            print(f"[Scraper] Erro ao carregar {STATE_FILE}: {e}")

    current_page = state.get('current_page', 0)
    total_pages = state.get('total_pages', 71)

    print(f"[Scraper] Executando coleta pontual (--once) da página {current_page}/{total_pages}...")
    items_count, detected_pages = run_single_page(current_page)
    if detected_pages > 0:
        total_pages = detected_pages
        state['total_pages'] = total_pages

    next_page = (current_page + 1) % total_pages
    state['current_page'] = next_page
    state['last_scraped_at'] = datetime.now().isoformat()
    try:
        atomic_write_json(STATE_FILE, state, indent=2)
    except Exception as e:
        print(f"[Scraper] Erro ao salvar estado: {e}")

    print(f"[Scraper] Coleta pontual finalizada. Próxima página na fila: {next_page}.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Coletor de CDVs credenciados DETRAN-RS")
    parser.add_argument('--page', type=int, help="Número da página específica para coletar")
    parser.add_argument('--bootstrap', '--full', dest='bootstrap', action='store_true', help="Coleta todas as páginas para gerar snapshot inicial")
    parser.add_argument('--once', action='store_true', help="Coleta a próxima página da fila")
    parser.add_argument('--refine', action='store_true', help="Refina CDVs existentes com busca precisa de endereço")
    parser.add_argument('--limit', type=int, help="Limite de itens para refinar")
    args = parser.parse_args()

    if args.bootstrap:
        run_bootstrap()
    elif args.refine:
        run_refine(args.limit)
    elif args.once:
        run_once()
    elif args.page is not None:
        run_single_page(args.page)
    else:
        # Padrão: testa página 0
        run_single_page(0)
