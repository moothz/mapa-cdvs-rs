# 🚗 Mapa CDVs RS

[![CI](https://github.com/moothz/mapa-cdvs-rs/actions/workflows/ci.yml/badge.svg)](https://github.com/moothz/mapa-cdvs-rs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](Dockerfile)

Agregador de Centros de Desmanche de Veículos (CDVs) credenciados pelo DETRAN no Rio Grande do Sul.

O objetivo do projeto é ajudar motoristas, mecânicos e pessoas que precisam de autopeças usadas a encontrar desmanches credenciados próximos de sua cidade, facilitando o contato direto (WhatsApp, telefone) e a rota até o local.

---

> [!IMPORTANT]
> **Aviso:** Este projeto é independente e não possui vínculo oficial ou comercial com o DETRAN-RS. Os dados são públicos e coletados para facilitar a localização geográfica. A consulta oficial pode ser feita diretamente no portal [DETRAN-RS Peça Legal](https://pecalegal.detran.rs.gov.br/cdv-portal/mod-consulta/credenciados.xhtml).

---

## Recursos

- **Mapa e Localização:** Visualização de todos os CDVs credenciados no RS, com busca por cidade ou via GPS para ordenar pelos mais próximos.
- **Contatos e Rotas:** Acesso direto a WhatsApp, telefone, rota no Google Maps e botão para baixar os dados do CDV em formato de contato para o celular (`.vcf`).
- **Marcações Pessoais:** Opção de marcar locais como "Favorito" (marcador com coração) ou "Já visto" (opacidade reduzida no mapa), salvos no próprio navegador.
- **Sugestão de Contatos:** Formulário para sugerir números de contato ou WhatsApp atualizados de um CDV, sujeitos à moderação (via painel web ou Telegram).
- **API Pública:** Endpoints para consulta de CDVs, busca textual e consulta por proximidade.
- **Atualização Automática (Scraper):** Conta com um scraper integrado em segundo plano que busca e atualiza os dados automaticamente a partir do site oficial Peça Legal do Detran-RS.

---

## Como Executar

### Pré-requisitos
- Docker e Docker Compose instalados
- `make` (opcional)

### Executando com Docker

1. Clone o repositório:
```bash
git clone https://github.com/moothz/mapa-cdvs-rs.git
cd mapa-cdvs-rs
```

2. Crie o arquivo `.env`:
```bash
cp .env.example .env
```

3. Inicie os containers:
```bash
make up
# ou: docker compose up -d
```

Acesse no navegador: **[http://localhost:3740](http://localhost:3740)**

---

## Moderação de Sugestões

Sugestões enviadas por usuários podem ser aprovadas de duas formas:

1. **Painel Web:** Acesse `http://localhost:3740/admin` (usuário e senha definidos no `.env`).
2. **Terminal / Make:**
```bash
make suggestions                          # Lista sugestões pendentes
make approve-suggestion ID=sug_xxx        # Aprova e adiciona o contato ao CDV
make reject-suggestion ID=sug_xxx         # Rejeita a sugestão
```

---

## Comandos do Makefile

| Comando | Descrição |
|---|---|
| `make up` | Sobe a aplicação em segundo plano na porta 3740 |
| `make down` | Para os containers |
| `make restart` | Reinicia os containers |
| `make test` | Executa a suíte de testes no container |
| `make test-local` | Executa a suíte de testes localmente |
| `make lint` | Executa verificação de código com Ruff |
| `make suggestions` | Lista sugestões de contato pendentes |
| `make approve-suggestion ID=...` | Aprova sugestão e adiciona ao cadastro do CDV |
| `make reject-suggestion ID=...` | Rejeita sugestão de contato |
| `make logs` | Exibe logs unificados dos containers |

---

## API Pública

A aplicação fornece endpoints REST para consulta dos dados:

| Endpoint | Método | Descrição |
|---|---|---|
| `/api/cdvs` | `GET` | Lista todos os CDVs credenciados |
| `/api/cdvs/search?q={termo}` | `GET` | Busca textual (nome, código, município, endereço) |
| `/api/cdvs/nearby?cidade={nome}` | `GET` | CDVs mais próximos de uma cidade |
| `/api/cdvs/nearby?lat={lat}&lng={lng}` | `GET` | CDVs mais próximos por coordenada geográfica |
| `/api/cities` | `GET` | Lista dos 497 municípios do RS com coordenadas |
| `/api/suggestions` | `POST` | Envio de sugestão de telefone/WhatsApp |
| `/api/docs` | `GET` | Documentação interativa Swagger |

---

## Licença

Distribuído sob a licença [MIT](LICENSE). Mantido por [@moothz](https://github.com/moothz).
