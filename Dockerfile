# Palco no servidor: um container só, atrás de um proxy que cuida do HTTPS.
# Os dados (músicas, sons, configuração) ficam no volume /app/data.
FROM python:3.12-slim

# ffmpeg converte os áudios; deno é o runtime de JavaScript que o yt-dlp usa no YouTube;
# libgl/libglib são do OpenCV que vem com o MediaPipe (modo dança)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 curl ca-certificates unzip \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get purge -y unzip && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml .
RUN uv pip install --system --no-cache -r pyproject.toml
COPY app app
COPY static static

ENV PORT=8000 HTTPS_PORT=0 PYTHONUNBUFFERED=1
EXPOSE 8000
VOLUME /app/data
# O YouTube muda direto e versões velhas do yt-dlp param de baixar: atualiza a cada início
CMD ["sh", "-c", "uv pip install --system -q -U --no-cache yt-dlp; exec python -m app"]
