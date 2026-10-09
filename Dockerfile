FROM python:3.12-alpine

WORKDIR /app

# Instala dependências de sistema necessárias
RUN apk add --no-cache tzdata ca-certificates

# Copia e instala as dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Cria usuário não-privilegiado (UID 1000 alinhado ao host Linux)
RUN addgroup -g 1000 appgroup && \
    adduser -u 1000 -G appgroup -s /bin/sh -D appuser

# Copia os scripts e a estrutura necessária
COPY scripts/ ./scripts/
COPY data/ ./data/
COPY tests/ ./tests/

RUN chown -R appuser:appgroup /app

# Define timezone padrão para Horário de Brasília
ENV TZ=America/Sao_Paulo
ENV PYTHONUNBUFFERED=1

USER appuser

CMD ["python", "-u", "-m", "scripts.scheduler"]
