FROM python:3.11-slim

WORKDIR /app

# Install system dependencies — cache bust: 2026-03-12
RUN apt-get update && apt-get install -y \
    libmagic1 \
    poppler-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create non-root user (uid/gid 1001) for security hardening
RUN groupadd -g 1001 app && useradd -r -u 1001 -g app app

COPY . .

# Ensure tmp dir exists and writable for OCR/PDF processing
RUN mkdir -p /app/tmp && chown -R app:app /app

USER app

# Default: run FastAPI
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
