.PHONY: up down restart logs logs-scraper build scrape status up-tunnel clean

# Carrega variáveis do .env se existir
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

PORT ?= 3740

up:
	@echo "Iniciando Mapa CDVs RS na porta $(PORT)..."
	docker compose up -d web scraper
	@echo "Aplicação disponível em: http://localhost:$(PORT)"

up-tunnel:
	@echo "Iniciando Mapa CDVs RS com Cloudflare Tunnel..."
	docker compose --profile tunnel up -d
	@echo "Aplicação local em: http://localhost:$(PORT)"

down:
	@echo "Parando containers..."
	docker compose --profile tunnel down

restart: down up

logs:
	docker compose logs -f

logs-scraper:
	docker compose logs -f scraper

build:
	@echo "Reconstruindo imagens Docker..."
	docker compose build

scrape:
	@echo "Disparando varredura manual de uma página..."
	docker compose exec scraper python -m scripts.scraper --once

scrape-full:
	@echo "Disparando varredura completa sob demanda com delay educado..."
	docker compose exec scraper python -m scripts.scraper --full

refine:
	@echo "Refinando coordenadas dos CDVs com busca de alta precisão por endereço..."
	docker compose exec scraper python -m scripts.scraper --refine

status:
	@echo "Status dos containers:"
	docker compose ps
	@echo "\nVerificando porta local $(PORT):"
	@ss -tuln | grep $(PORT) || echo "Porta $(PORT) livre"

clean:
	docker compose down -v --remove-orphans
