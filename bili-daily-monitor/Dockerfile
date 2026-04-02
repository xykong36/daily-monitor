FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Download BBDown Linux x86_64 binary
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && curl -fsSL -o /tmp/bbdown.zip \
       https://github.com/nilaoda/BBDown/releases/download/1.6.3/BBDown_1.6.3_20240814_linux-x64.zip \
    && mkdir -p /app/bin \
    && unzip /tmp/bbdown.zip -d /app/bin/ \
    && chmod +x /app/bin/BBDown \
    && rm /tmp/bbdown.zip \
    && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Copy application code
COPY config.py main.py weekly.py ./
COPY src/ src/
COPY .env .env

# Persistent data volume
VOLUME /app/data /app/logs

CMD ["python", "main.py"]
