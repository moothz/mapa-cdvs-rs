# 🤝 Guia de Contribuição - Mapa CDVs RS

Agradecemos imensamente seu interesse em contribuir com o **Mapa CDVs RS**! Este projeto é um agregador público e de código aberto desenvolvido para ajudar a comunidade a encontrar peças automotivas com procedência legal e rastreabilidade no estado do Rio Grande do Sul.

---

## 🛠️ Ambiente de Desenvolvimento Local

### Pré-requisitos
- [Docker](https://docs.docker.com/engine/install/) e [Docker Compose](https://docs.docker.com/compose/)
- [Python 3.12+](https://www.python.org/) (para testes locais sem Docker, opcional)
- `make` (opcional, para atalhos)

### 1. Clonar e Configurar
```bash
git clone https://github.com/moothz/mapa-cdvs-rs.git
cd mapa-cdvs-rs
cp .env.example .env
```

### 2. Inicializar a Aplicação
Com `make`:
```bash
make up
```
Ou diretamente com Docker Compose:
```bash
docker compose up -d web scraper
```
Acesse no seu navegador em: **http://localhost:3740**

---

## 🧪 Como Executar os Testes

Executar a suíte completa de testes no container:
```bash
make test
```
Ou localmente via Python:
```bash
make test-local
# ou
pytest tests/ -v
```

---

## 🎨 Padrões de Código e Linting

O repositório utiliza o [Ruff](https://astral.sh/ruff) para linting e verificação de boas práticas em Python:
```bash
ruff check .
ruff format --check .
```

---

## 🚀 Fluxo de Envio de Contribuições (Pull Requests)

1. Crie um fork do repositório no GitHub.
2. Crie uma branch para sua funcionalidade ou correção:
   ```bash
   git checkout -b feat/minha-melhoria
   ```
3. Realize suas alterações seguindo os padrões do `.editorconfig`.
4. Garanta que todos os testes passem (`make test`).
5. Envie um commit descritivo:
   ```bash
   git commit -m "feat: adiciona filtro por tipo de veículo"
   ```
6. Envie a branch para seu fork e abra um **Pull Request** para a branch `main`.

Agradecemos imensamente por ajudar a construir uma ferramenta útil para o Rio Grande do Sul!
