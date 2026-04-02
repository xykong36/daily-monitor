FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY config.py main.py ./
COPY src/ src/
RUN mkdir -p /app/data /app/logs /app/output
CMD ["python", "main.py"]
