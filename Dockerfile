FROM python:3.12-alpine

WORKDIR /app

# Instala dependências de sistema necessárias
RUN apk add --no-cache tzdata ca-certificates

# Copia e instala as dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia os scripts e a estrutura necessária
COPY scripts/ ./scripts/
COPY data/ ./data/

# Define timezone padrão para Horário de Brasília
ENV TZ=America/Sao_Paulo
ENV PYTHONUNBUFFERED=1

CMD ["python", "-u", "-m", "scripts.scheduler"]
