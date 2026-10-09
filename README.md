# 🚗 Mapa CDVs RS - Centros de Desmanche Credenciados

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](Dockerfile)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9.4-199900?logo=leaflet&logoColor=white)](https://leafletjs.com/)
[![Nginx](https://img.shields.io/badge/Nginx-Alpine-009639?logo=nginx&logoColor=white)](nginx.conf)

Aplicação web pública para visualização geográfica e busca inteligente por **proximidade** de todos os **Centros de Desmanche de Veículos (CDVs) credenciados pelo DETRAN-RS**.

A plataforma organiza os estabelecimentos em um mapa interativo e permite ao cidadão encontrar desmanches credenciados mais próximos de sua localização atual (via GPS do celular/computador ou por cidade/CEP), facilitando o acesso a peças automotivas com procedência legal e rastreabilidade garantida.

---

> [!IMPORTANT]
> ### ⚠️ Aviso de Utilidade Pública & Desvinculação Legal
> **Este projeto é um agregador independente sem qualquer vínculo institucional ou comercial com o DETRAN-RS ou Governo do Estado do Rio Grande do Sul.**
>
> As informações exibidas são públicas e coletadas periodicamente para facilitar a consulta por proximidade geográfica e incentivar o comércio legal de peças usadas.
>
> 🔗 Para a consulta oficial direta na fonte, acesse o portal do DETRAN-RS:  
> **[Peça Legal RS - Consulta de Credenciados](https://pecalegal.detran.rs.gov.br/cdv-portal/mod-consulta/credenciados.xhtml)**

---

## ✨ Funcionalidades

- **🗺️ Mapa Interativo Completo:**
  - Marcadores de todos os CDVs credenciados no estado do Rio Grande do Sul.
  - Agrupamento inteligente de pins (*Marker Clustering*) para áreas com grande concentração de credenciados (Porto Alegre, Vale dos Sinos, Serra, etc.).
  - Totalmente gratuito e baseado em **OpenStreetMap + Leaflet.js** (sem limite de requisições ou cobranças de chaves de API).
- **📍 Busca por Proximidade Instantânea:**
  - **Localização via GPS:** Botão *"Usar minha localização"* obtém suas coordenadas atuais no navegador.
  - **Busca por Cidade:** Digite qualquer um dos 497 municípios do RS com autocomplete instantâneo.
  - **Cálculo de Distância:** Cálculo de distância em linha reta (fórmula de *Haversine*) executado diretamente no cliente em menos de 1ms, reordenando a lista do CDV mais próximo ao mais distante.
  - **Filtro de Raio:** Filtre apenas CDVs em até 15 km, 30 km, 50 km, 100 km ou 200 km de você.
- **⚡ Ações Rápidas em 1 Clique:**
  - 💬 **WhatsApp:** Inicie uma conversa direta para orçar peças sem precisar cadastrar o contato.
  - 📞 **Ligar:** Discagem imediata no smartphone.
  - 🗺️ **Como Chegar:** Abre o trajeto e navegação ponto-a-ponto diretamente no **Google Maps** ou **Waze**.
- **🛡️ Coleta Periódica Anti-Bloqueio (Espaçamento de 3 a 5 dias):**
  - O coletor automatizado não sobrecarrega os servidores governamentais com varreduras em lote.
  - As 71 páginas de credenciados são consultadas de forma **espaçada ao longo de 4 dias** (~1 página a cada 80 minutos com *jitter* aleatório).
  - O estado da coleta é persistido em `data/scraper_state.json`. Se o serviço for reiniciado, ele continua exatamente da página onde parou.
- **📱 100% Responsivo:**
  - *Split view* (mapa e lista lateral) em telas grandes.
  - Visualização otimizada com abas dinâmicas em smartphones.
  - Esquema visual institucional com a identidade do Peça Legal e DETRAN-RS.

---

## 🏛️ Arquitetura do Sistema

```mermaid
flowchart TD
    subgraph Host / Docker Compose (Porta 3740)
        ENV[".env"] --> COMPOSE[docker-compose.yml]
        
        subgraph Servico Web
            NGINX["nginx:alpine (Servidor Web)"]
            STATIC["Frontend Estático<br/>(Leaflet + Vanilla JS + CSS)"]
            DATA["Base Consolidada<br/>(cdvs.json, cities_rs.json)"]
            STATIC --> NGINX
            DATA --> NGINX
        end

        subgraph Servico Coletor Periodico
            SCRAPER["scraper (python:3.12-alpine)"]
            SCHEDULER["scripts/scheduler.py<br/>Ciclo: 4 dias (espaçado)"]
            SCRAPER --> SCHEDULER
            SCHEDULER -->|1 req a cada ~80 min| DETRAN["DETRAN-RS Pecalegal"]
            SCHEDULER -->|Persiste dados| DATA
        end

        subgraph Exposição Externa Opcional
            TUNNEL["cloudflared (Cloudflare Tunnel)"]
            TUNNEL -.->|HTTPS Reverso Seguro| NGINX
        end
    end

    USER["Cidadão / Usuário"] -->|HTTP :3740 ou HTTPS Cloudflare| NGINX
```

---

## 🚀 Como Executar

### Pré-requisitos
- [Docker](https://docs.docker.com/engine/install/) (v20+)
- [Docker Compose](https://docs.docker.com/compose/) (v2+)
- `make` (opcional, para atalhos)

### 1. Clonar o Repositório
```bash
git clone https://github.com/moothz/mapa-cdvs-rs.git
cd mapa-cdvs-rs
```

### 2. Configurar Variáveis de Ambiente
Copie o arquivo de exemplo:
```bash
cp .env.example .env
```

Configurações disponíveis no `.env`:
| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3740` | Porta local do host onde o Nginx responderá |
| `SCRAPE_CYCLE_DAYS` | `4` | Tempo (em dias) para completar uma rodada das 71 páginas |
| `SCRAPE_BOOTSTRAP_ON_START` | `false` | Se deve forçar varredura completa ao subir container vazio |
| `CLOUDFLARE_TUNNEL_TOKEN` | *vazio* | Token para publicar externamente via Cloudflare Tunnel |

### 3. Iniciar com Docker Compose (ou Makefile)
Via `make`:
```bash
make up
```

Ou diretamente via Docker Compose:
```bash
docker compose up -d web scraper
```

Acesse a aplicação no navegador em:  
👉 **[http://localhost:3740](http://localhost:3740)**

---

## 🛠️ Comandos Úteis do `Makefile`

| Comando | Descrição |
|---|---|
| `make up` | Sobe a aplicação em segundo plano na porta 3740 |
| `make down` | Para todos os containers do projeto |
| `make logs` | Visualiza logs unificados em tempo real |
| `make logs-scraper` | Acompanha a execução do agendador do scraper |
| `make scrape` | Força a consulta imediata da próxima página |
| `make scrape-full` | Força uma varredura completa manual com delay educado |
| `make build` | Reconstrói as imagens dos containers |
| `make status` | Verifica saúde dos containers e ocupação da porta |

---

## 🌐 Publicação Externa com Cloudflare Tunnel (Opcional)

Se desejar expor o agregador publicamente na internet com certificado SSL/HTTPS gratuito e sem abrir portas no seu roteador:

1. Crie um tunnel no painel do Cloudflare Zero Trust e obtenha o token do túnel.
2. No seu arquivo `.env`, preencha:
   ```ini
   CLOUDFLARE_TUNNEL_TOKEN=seu_token_aqui
   ```
3. Inicie incluindo o container do túnel:
   ```bash
   make up-tunnel
   ```

O container `cloudflared` conectará diretamente à Cloudflare e apontará o tráfego de forma segura para o serviço `web`.

---

## 📁 Estrutura de Diretórios

```
mapa-cdvs-rs/
├── .env.example               # Exemplo de variáveis de ambiente
├── .gitignore                 # Arquivos ignorados pelo controle de versão
├── docker-compose.yml         # Orquestração Docker (Nginx, Scraper, Tunnel)
├── Dockerfile                 # Imagem Python para o crawler
├── LICENSE                    # Licença MIT
├── Makefile                   # Atalhos de gerenciamento
├── nginx.conf                 # Configuração do Nginx com gzip e headers
├── README.md                  # Este documento
├── requirements.txt           # Dependências do coletor (requests, beautifulsoup4)
├── data/
│   ├── cdvs.json              # Base consolidada de todos os CDVs (dados + lat/lng)
│   ├── cities_rs.json         # Coordenadas de referência dos 497 municípios do RS
│   ├── geocache.json          # Cache de geocodificação de endereços
│   ├── scraper_state.json     # Estado do ciclo distribuído de coleta
│   └── metadata.json          # Data/hora e contadores da base
├── scripts/
│   ├── __init__.py
│   ├── scraper.py             # Módulo de extração do portal Detran-RS
│   ├── geocoder.py            # Geocodificador em camadas com cache
│   └── scheduler.py           # Agendador contínuo com ciclo de 3 a 5 dias
└── src/
    ├── index.html             # Interface web principal
    ├── styles.css             # Tema Detran-RS Peça Legal e responsividade
    └── app.js                 # Lógica do mapa Leaflet, GPS e cálculo Haversine
```

---

## 📜 Licença

Distribuído sob a licença livre **MIT**. Consulte o arquivo [LICENSE](LICENSE) para obter mais detalhes.

Desenvolvido por [@moothz](https://github.com/moothz).
