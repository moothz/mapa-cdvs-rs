.PHONY: up down restart logs logs-scraper build scrape scrape-full refine status clean test test-local lint audit help suggestions suggestions-all approve-suggestion reject-suggestion

# Carrega variáveis do .env se existir
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

PORT ?= 3740

help:
	@echo "Mapa CDVs RS - Comandos Disponíveis:"
	@echo "  make up          - Sobe os containers em segundo plano"
	@echo "  make down        - Para os containers"
	@echo "  make restart     - Reinicia os containers"
	@echo "  make build       - Reconstrói as imagens Docker"
	@echo "  make test        - Executa a suíte de testes no container"
	@echo "  make test-local  - Executa a suíte de testes com Python local"
	@echo "  make scrape      - Coleta a próxima página da fila"
	@echo "  make scrape-full - Força varredura completa educada"
	@echo "  make refine      - Refina coordenadas dos CDVs com busca precisa"
	@echo "  make suggestions - Lista sugestões de contato pendentes de moderação"
	@echo "  make approve-suggestion ID=sug_xxx - Aprova uma sugestão e adiciona ao CDV"
	@echo "  make reject-suggestion ID=sug_xxx  - Rejeita uma sugestão de contato"
	@echo "  make logs        - Exibe logs unificados em tempo real"
	@echo "  make status      - Exibe status e saúde dos containers"

up:
	@echo "Iniciando Mapa CDVs RS na porta $(PORT)..."
	docker compose up -d web scraper
	@echo "Aplicação disponível em: http://localhost:$(PORT)"

down:
	@echo "Parando containers..."
	docker compose down

restart: down up

logs:
	docker compose logs -f

logs-scraper:
	docker compose logs -f scraper

build:
	@echo "Reconstruindo imagens Docker..."
	docker compose build

test:
	@echo "Executando testes no container do scraper..."
	docker compose exec scraper python -m unittest discover tests -v

test-local:
	@echo "Executando testes com Python local..."
	python3 -m unittest discover tests -v

lint:
	@echo "Executando verificação de código com Ruff..."
	@which ruff >/dev/null 2>&1 && ruff check . || python3 -m py_compile scripts/*.py

audit:
	@echo "Auditando dependências..."
	@which pip-audit >/dev/null 2>&1 && pip-audit || echo "pip-audit não instalado localmente (execute pip install pip-audit)"

scrape:
	@echo "Disparando varredura manual da próxima página..."
	docker compose exec scraper python -m scripts.scraper --once

scrape-full:
	@echo "Disparando varredura completa sob demanda com delay educado..."
	docker compose exec scraper python -m scripts.scraper --full

refine:
	@echo "Refinando coordenadas dos CDVs com busca de alta precisão por endereço..."
	docker compose exec scraper python -m scripts.scraper --refine

suggestions:
	@python3 -m scripts.manage_suggestions list 2>/dev/null || docker compose exec scraper python -m scripts.manage_suggestions list

suggestions-all:
	@python3 -m scripts.manage_suggestions list --all 2>/dev/null || docker compose exec scraper python -m scripts.manage_suggestions list --all

approve-suggestion:
	@if [ -z "$(ID)" ]; then echo "Erro: Informe o ID da sugestão. Ex: make approve-suggestion ID=sug_xxx"; exit 1; fi
	@python3 -m scripts.manage_suggestions approve $(ID) 2>/dev/null || docker compose exec scraper python -m scripts.manage_suggestions approve $(ID)

reject-suggestion:
	@if [ -z "$(ID)" ]; then echo "Erro: Informe o ID da sugestão. Ex: make reject-suggestion ID=sug_xxx"; exit 1; fi
	@python3 -m scripts.manage_suggestions reject $(ID) 2>/dev/null || docker compose exec scraper python -m scripts.manage_suggestions reject $(ID)

status:
	@echo "Status dos containers:"
	docker compose ps
	@echo "\nVerificando porta local $(PORT):"
	@ss -tuln | grep $(PORT) || echo "Porta $(PORT) livre"

clean:
	docker compose down -v --remove-orphans
