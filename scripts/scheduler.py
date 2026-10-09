import json
import os
import random
import signal
import time
from datetime import datetime, timedelta

from scripts.geocoder import atomic_write_json
from scripts.scraper import CDVS_FILE, STATE_FILE, run_bootstrap, run_single_page

running = True

def signal_handler(signum, frame):
    global running
    print(f"\n[Scheduler] Recebido sinal {signum}. Finalizando de forma graciosa...")
    running = False
    try:
        from scripts.telegram_bot import stop_telegram_bot
        stop_telegram_bot()
    except Exception:
        pass

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Scheduler] Erro ao ler scraper_state.json: {e}")
    return {
        'current_page': 0,
        'total_pages': 71,
        'last_scraped_at': None,
        'next_scrape_at': None,
        'cycle_count': 0
    }

def save_state(state: dict):
    try:
        atomic_write_json(STATE_FILE, state, indent=2)
    except Exception as e:
        print(f"[Scheduler] Erro ao salvar scraper_state.json: {e}")

def main():
    global running
    cycle_days = float(os.getenv('SCRAPE_CYCLE_DAYS', '4'))
    # Limita entre 3 e 15 dias conforme requisito
    cycle_days = max(3.0, min(15.0, cycle_days))

    bootstrap_on_start = os.getenv('SCRAPE_BOOTSTRAP_ON_START', 'false').lower() == 'true'

    print("=" * 60)
    print(" [Scheduler] Agendador de Coleta Distribuída Detran-RS")
    print(f" [Scheduler] Ciclo configurado: {cycle_days} dias para varredura completa")
    print("=" * 60)

    # Inicia o servidor da API REST em segundo plano
    try:
        from scripts.api import start_background_api
        api_port = int(os.getenv('API_PORT', '8000'))
        start_background_api(host='0.0.0.0', port=api_port)
    except Exception as e:
        print(f"[Scheduler] Erro ao iniciar servidor da API: {e}")

    # Verifica se a base cdvs.json está vazia ou não existe
    if (not os.path.exists(CDVS_FILE) or os.path.getsize(CDVS_FILE) < 50) and bootstrap_on_start:
        print("[Scheduler] Base de CDVs vazia e bootstrap ativado. Executando bootstrap inicial...")
        run_bootstrap()

    state = load_state()

    while running:
        current_page = state.get('current_page', 0)
        total_pages = state.get('total_pages', 71)

        print(f"\n[Scheduler] [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Iniciando coleta da página {current_page} de {total_pages}...")

        try:
            items_count, detected_pages = run_single_page(current_page)
            if detected_pages > 0:
                total_pages = detected_pages
                state['total_pages'] = total_pages

            # Avança para a próxima página
            next_page = (current_page + 1) % total_pages
            if next_page == 0:
                state['cycle_count'] = state.get('cycle_count', 0) + 1
                print(f"[Scheduler] 🎉 Ciclo #{state['cycle_count']} concluído com sucesso!")

            state['current_page'] = next_page
            state['last_scraped_at'] = datetime.now().isoformat()
        except Exception as e:
            print(f"[Scheduler] Erro ao processar página {current_page}: {e}")
            # Em caso de erro, aguarda 10 minutos antes de tentar a mesma página
            retry_wait = 600
            print(f"[Scheduler] Tentando novamente em {retry_wait // 60} minutos...")
            state['next_scrape_at'] = (datetime.now() + timedelta(seconds=retry_wait)).isoformat()
            save_state(state)

            for _ in range(retry_wait):
                if not running:
                    break
                time.sleep(1)
            continue

        # Calcula o intervalo base em segundos
        total_seconds_in_cycle = cycle_days * 24 * 3600
        base_interval = total_seconds_in_cycle / max(1, total_pages)

        # Jitter de até +/- 15% para evitar padrões repetitivos de bot
        jitter_range = base_interval * 0.15
        interval_seconds = int(base_interval + random.uniform(-jitter_range, jitter_range))
        interval_seconds = max(300, interval_seconds) # Pelo menos 5 minutos

        next_time = datetime.now() + timedelta(seconds=interval_seconds)
        state['next_scrape_at'] = next_time.isoformat()
        save_state(state)

        minutes_wait = interval_seconds / 60.0
        print(f"[Scheduler] Página {current_page} concluída. Próxima página ({next_page}) agendada para: {next_time.strftime('%Y-%m-%d %H:%M:%S')} (~{minutes_wait:.1f} min)")

        # Dorme com verificacao e auto-refino progressivo de CDVs antigos sem coordenadas precisas
        refine_check_timer = 0
        for _ in range(interval_seconds):
            if not running:
                break
            time.sleep(1)
            refine_check_timer += 1

            # A cada 120 segundos (2 min) de tempo ocioso, refina 1 CDV que ainda esteja em municipio_centroid
            if refine_check_timer >= 120:
                refine_check_timer = 0
                try:
                    from scripts.scraper import run_refine
                    run_refine(max_items=1)
                except Exception as e:
                    print(f"[Scheduler] Erro no auto-refino em background: {e}")

    print("[Scheduler] Encerrado com sucesso.")

if __name__ == '__main__':
    main()
