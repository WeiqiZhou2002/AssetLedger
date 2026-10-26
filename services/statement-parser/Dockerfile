FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.6.14 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home parser
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

FROM runtime-base AS test
COPY --from=ghcr.io/astral-sh/uv:0.6.14 /uv /usr/local/bin/uv
COPY --chown=parser:parser pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project
COPY --chown=parser:parser app ./app
COPY --chown=parser:parser tests ./tests
USER parser
CMD ["pytest", "-q", "-p", "no:cacheprovider"]

FROM runtime-base AS runtime
COPY --from=builder /app/.venv /app/.venv
COPY --chown=parser:parser app ./app
USER parser
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
