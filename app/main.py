"""Servidor do karaokê. Rode com:  .venv\\Scripts\\python -m app"""
import asyncio
import io
import socket
from pathlib import Path

import httpx
import qrcode
import qrcode.image.svg
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config, metadata, party, providers, store, usage, worker, youtube

STATIC = config.ROOT / "static"
STEMS = {"original", "instrumental", "lead", "backing"}

app = FastAPI(title="Karaoke")


@app.middleware("http")
async def no_cache_pages(request: Request, call_next):
    # O navegador sempre confere se as páginas e scripts mudaram (senão roda código velho depois de uma atualização)
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path in ("/", "/m") or request.url.path.startswith("/play/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.on_event("startup")
def _startup():
    config.load()
    store.load()
    party.load()
    worker.start()


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def session_url() -> str:
    return f"http://{lan_ip()}:{config.get('port')}/m"


def is_host(request) -> bool:
    return request.client.host in ("127.0.0.1", "::1", "localhost")


def client_id(request) -> str:
    return request.headers.get("x-client") or request.query_params.get("client") or "anon"


def state(host: bool, client: str = "") -> dict:
    return {
        "songs": store.snapshot(),
        "config": config.public() if host else {"provider": config.get("provider")},
        "providers": providers.listing() if host else [],
        "session_url": session_url(),
        "is_host": host,
        "party": party.snapshot(client),
        "fx": {"names": party.FX, "files": party.fx_files(), "sounds": party.sounds()},
    }


def _song_or_404(song_id: str) -> dict:
    song = store.get(song_id)
    if not song:
        raise HTTPException(404, "Música não encontrada")
    return song


# ---------- Páginas ----------

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/m")
def mobile():
    return FileResponse(STATIC / "mobile.html")


@app.get("/play/{song_id}")
def player(song_id: str):
    return FileResponse(STATIC / "player.html")


# ---------- Estado em tempo real ----------

@app.get("/api/state")
def get_state(request: Request):
    return state(is_host(request), client_id(request))


@app.websocket("/ws")
async def ws(socket_: WebSocket):
    await socket_.accept()
    host = socket_.client.host in ("127.0.0.1", "::1")
    client = socket_.query_params.get("client") or "anon"
    # Quem conta como "na festa" são os celulares; o notebook não entra na conta
    if not host:
        party.connected(client, 1)
    seen, fx_seen = -1, party.fx_event["seq"]
    try:
        while True:
            if store.version != seen:
                seen = store.version
                await socket_.send_json(state(host, client))
            if party.fx_event["seq"] != fx_seen:
                fx_seen = party.fx_event["seq"]
                await socket_.send_json({"fx_event": party.fx_event})
            await asyncio.sleep(0.1)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if not host:
            party.connected(client, -1)


@app.get("/api/qr.svg")
def qr():
    img = qrcode.make(session_url(), image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml")


# ---------- Busca e fila ----------

@app.get("/api/search")
async def search(q: str):
    try:
        return await run_in_threadpool(youtube.search, q)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Falha ao buscar no YouTube: {e}")


@app.get("/api/preview/{video_id}")
async def preview(video_id: str):
    if not video_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(400)
    dest = config.DATA_DIR / "previews" / f"{video_id}.mp3"
    try:
        await run_in_threadpool(youtube.preview, video_id, dest)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Falha na prévia: {e}")
    return FileResponse(dest, media_type="audio/mpeg")


@app.post("/api/songs")
def add_song(request: Request, video: dict = Body(...)):
    artist, title = youtube.guess_artist_title(video.get("title", ""), video.get("channel", ""))
    kind = video.get("kind") or ("karaoke" if youtube.is_karaoke(video.get("title", "")) else "original")
    if kind not in ("original", "karaoke"):
        kind = "original"
    # Com/sem backing vocals: escolhido na hora de adicionar; sem escolha, vale o padrão do ⚙
    backing = video.get("backing")
    want_backing = None if backing is None or kind == "karaoke" else bool(backing)
    song = store.add(video, artist, title, client_id(request), kind, want_backing)
    # Pedido de música: já entra na fila da festa com o nome de quem pediu
    if video.get("queue"):
        party.enqueue(song["id"], client_id(request), is_host(request))
    return song


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str, request: Request):
    song = _song_or_404(song_id)
    if not is_host(request) and song["owner"] != client_id(request):
        raise HTTPException(403, "Só dá para apagar as suas músicas.")
    if song["status"] == "processing":
        worker.cancel(song_id)
        store.update(song_id, step="Cancelando...")
    else:
        store.remove(song_id)
    party.drop_song(song_id)
    return {"ok": True}


@app.post("/api/songs/{song_id}/retry")
def retry(song_id: str, request: Request):
    song = _song_or_404(song_id)
    if not is_host(request) and song["owner"] != client_id(request):
        raise HTTPException(403)
    store.update(song_id, status="queued", step="Na fila", progress=0, error=None)
    return {"ok": True}


@app.post("/api/songs/{song_id}/backing")
def separate_backing(song_id: str, request: Request):
    """Separa os backing vocals de uma música já pronta (gasta mais uma separação)."""
    song = _song_or_404(song_id)
    if not is_host(request):
        raise HTTPException(403)
    if not song.get("separated") or song.get("has_backing"):
        raise HTTPException(400, "Essa música não precisa dessa separação.")
    provider = providers.get(config.get("provider"))
    if provider.name == "none" or provider.problem():
        raise HTTPException(400, provider.problem() or "Escolha um serviço de separação no ⚙.")
    store.update(song_id, status="queued", step="Na fila (backing vocals)", progress=0, task="backing", backing_error=None)
    return {"ok": True}


@app.patch("/api/songs/{song_id}")
def patch_song(song_id: str, request: Request, fields: dict = Body(...)):
    _song_or_404(song_id)
    if not is_host(request):
        raise HTTPException(403)
    allowed = {k: v for k, v in fields.items() if k in ("offset", "key", "title", "artist")}
    store.update(song_id, **allowed)
    return store.get(song_id)


# ---------- Festa: convidados, fila do palco, votos e efeitos ----------

@app.post("/api/me")
def set_me(request: Request, body: dict = Body(...)):
    try:
        return party.set_guest(client_id(request), str(body.get("name", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/stage")
def stage_add(request: Request, body: dict = Body(...)):
    """Entra na fila para cantar uma música da biblioteca."""
    _song_or_404(str(body.get("song_id")))
    return party.enqueue(body["song_id"], client_id(request), is_host(request))


@app.delete("/api/stage/{entry_id}")
def stage_remove(entry_id: str, request: Request):
    try:
        party.remove(entry_id, client_id(request), is_host(request))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@app.post("/api/stage/{entry_id}/later")
def stage_later(entry_id: str, request: Request):
    if not is_host(request):
        raise HTTPException(403)
    party.to_end(entry_id)
    return {"ok": True}


@app.post("/api/stage/start")
def stage_start(request: Request, body: dict = Body(...)):
    """Põe no palco um pedido da fila (entry_id) ou uma música direto (song_id)."""
    if not is_host(request):
        raise HTTPException(403)
    if body.get("song_id"):
        _song_or_404(str(body["song_id"]))
    try:
        return party.start(body.get("entry_id"), body.get("song_id"), body.get("client") or client_id(request), True)
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]))


@app.post("/api/stage/{entry_id}/finish")
def stage_finish(entry_id: str, request: Request):
    if not is_host(request):
        raise HTTPException(403)
    party.finish(entry_id)
    return {"ok": True}


@app.post("/api/vote")
def vote(request: Request, body: dict = Body(...)):
    try:
        party.vote(client_id(request), int(body.get("score", 0)))
    except (LookupError, PermissionError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/fx/{name}")
def fx(name: str, request: Request):
    try:
        party.fx(name, client_id(request))
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]))
    return {"ok": True}


@app.get("/media/fx/{name}")
def fx_file(name: str):
    f = party.fx_files().get(Path(name).stem)
    if not f or f != name:
        raise HTTPException(404)
    return FileResponse(config.DATA_DIR / "fx" / f)


@app.get("/media/sounds/{name}")
def sound_file(name: str):
    if not any(s["file"] == name for s in party.sounds()):
        raise HTTPException(404)
    return FileResponse(config.DATA_DIR / "sounds" / name)


# ---------- Letra e capa ----------

@app.get("/api/songs/{song_id}/lyrics")
def get_lyrics(song_id: str):
    _song_or_404(song_id)
    return store.read_lyrics(song_id) or {"synced": False, "lines": []}


@app.get("/api/songs/{song_id}/lyrics/search")
async def lyrics_search(song_id: str, q: str | None = None):
    song = _song_or_404(song_id)
    artist, title = (song["artist"], song["title"]) if not q else (q, "")
    items = await run_in_threadpool(metadata.search_lyrics, artist, title)
    # O texto completo fica no servidor; a tela só precisa escolher
    return [{k: v for k, v in it.items() if k not in ("lrc", "plain")} for it in items]


@app.post("/api/songs/{song_id}/lyrics")
async def set_lyrics(song_id: str, body: dict = Body(...)):
    _song_or_404(song_id)
    r = await run_in_threadpool(lambda: httpx.get(f"https://lrclib.net/api/get/{int(body['lrclib_id'])}", headers=metadata.UA, timeout=20))
    if r.status_code != 200:
        raise HTTPException(502, "Não consegui baixar essa letra do LRCLIB.")
    it = r.json()
    payload = metadata.lyrics_payload({"id": it["id"], "lrc": it.get("syncedLyrics") or "", "plain": it.get("plainLyrics") or ""})
    store.write_lyrics(song_id, payload)
    store.update(song_id, offset=0.0)
    return payload


@app.post("/api/songs/{song_id}/lyrics/text")
def set_lyrics_text(song_id: str, body: dict = Body(...)):
    """Letra colada à mão (texto simples ou LRC)."""
    _song_or_404(song_id)
    payload = metadata.lyrics_from_text(str(body.get("text", "")))
    if not payload["lines"]:
        raise HTTPException(400, "A letra está vazia.")
    store.write_lyrics(song_id, payload)
    store.update(song_id, offset=0.0)
    return payload


@app.put("/api/songs/{song_id}/lyrics/times")
def set_lyrics_times(song_id: str, body: dict = Body(...)):
    """Tempos gravados no player (sincronia em tempo real)."""
    _song_or_404(song_id)
    current = store.read_lyrics(song_id)
    times = body.get("times") or []
    if not current or len(times) != len(current["lines"]):
        raise HTTPException(400, "A letra mudou; abra o player de novo.")
    for line, t in zip(current["lines"], times):
        line["t"] = None if t is None else round(max(0.0, float(t)), 2)
    current["synced"] = all(l["t"] is not None for l in current["lines"])
    store.write_lyrics(song_id, current)
    store.update(song_id, offset=0.0)
    return current


@app.get("/api/songs/{song_id}/covers")
async def covers(song_id: str, q: str | None = None):
    song = _song_or_404(song_id)
    urls = await run_in_threadpool(metadata.search_covers, q or f"{song['artist']} {song['title']}")
    if not q:
        urls += [u for u in await run_in_threadpool(metadata.search_covers, song["artist"]) if u not in urls]
    return [song["thumbnail"]] + urls


@app.post("/api/songs/{song_id}/cover")
def set_cover(song_id: str, body: dict = Body(...)):
    _song_or_404(song_id)
    store.update(song_id, cover=str(body["url"]))
    return {"ok": True}


# ---------- Áudio ----------

@app.get("/media/{song_id}/{stem}.mp3")
def media(song_id: str, stem: str):
    if stem not in STEMS:
        raise HTTPException(404)
    f = store.song_dir(song_id) / f"{stem}.mp3"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="audio/mpeg")


# ---------- Uso do serviço de separação ----------

@app.get("/api/usage")
async def get_usage(request: Request, force: bool = False):
    if not is_host(request):
        raise HTTPException(403)
    return await run_in_threadpool(usage.get, force)


# ---------- Configurações ----------

@app.get("/api/config")
def get_config(request: Request):
    if not is_host(request):
        raise HTTPException(403)
    return {"config": config.public(), "providers": providers.listing()}


@app.post("/api/config")
def set_config(request: Request, values: dict = Body(...)):
    if not is_host(request):
        raise HTTPException(403, "As configurações só podem ser mudadas no notebook.")
    config.update(values)
    usage.invalidate()
    store.touch()
    return {"config": config.public(), "providers": providers.listing()}


app.mount("/static", StaticFiles(directory=STATIC), name="static")
