"""Servidor do karaokê. Rode com:  .venv\\Scripts\\python -m app"""
import asyncio
import hmac
import io
import json
import os
import socket
from pathlib import Path

import httpx
import qrcode
import qrcode.image.svg
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import camlink, config, dance, metadata, party, providers, store, usage, worker, youtube

STATIC = config.ROOT / "static"
STEMS = {"original", "instrumental", "lead", "backing"}

app = FastAPI(title="Karaoke")

# No servidor (atrás de um proxy com HTTPS) o endereço dos QR codes é o domínio,
# e quem é o anfitrião é decidido pela chave, já que ninguém chega pelo localhost.
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")
HOST_KEY = os.environ.get("HOST_KEY", "")
HOST_COOKIE = "palco_host"


def code_version() -> float:
    """Última mudança no código do servidor. As páginas sempre vêm atualizadas,
    mas o servidor só pega código novo quando o iniciar.bat é aberto de novo."""
    files = [*(config.ROOT / "app").glob("*.py"), *(config.ROOT / "app" / "providers").glob("*.py")]
    return max(f.stat().st_mtime for f in files)


CODE_AT_START = code_version()


@app.middleware("http")
async def no_cache_pages(request: Request, call_next):
    # O navegador sempre confere se as páginas e scripts mudaram (senão roda código velho depois de uma atualização)
    response = await call_next(request)
    path = request.url.path
    if path.startswith(("/static", "/play/", "/review/")) or path in ("/", "/m", "/cam"):
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
    if PUBLIC_URL:
        return f"{PUBLIC_URL}/m"
    return f"http://{lan_ip()}:{config.get('port')}/m"


def cam_url() -> str:
    """Página da câmera do celular (modo dança). Precisa ser HTTPS para o celular liberar a câmera."""
    if PUBLIC_URL:
        return f"{PUBLIC_URL}/cam"
    return f"https://{lan_ip()}:{config.get('https_port')}/cam"


def is_host(request) -> bool:
    if request.client.host in ("127.0.0.1", "::1", "localhost"):
        return True
    cookie = request.cookies.get(HOST_COOKIE, "")
    return bool(HOST_KEY) and hmac.compare_digest(cookie.encode(), HOST_KEY.encode())


def client_id(request) -> str:
    return request.headers.get("x-client") or request.query_params.get("client") or "anon"


def state(host: bool, client: str = "") -> dict:
    return {
        "songs": store.snapshot(),
        "config": config.public() if host else {"provider": config.get("provider")},
        "providers": providers.listing() if host else [],
        "session_url": session_url(),
        "is_host": host,
        # Código mudou depois que o servidor abriu: o telão pede para reiniciar
        "needs_restart": host and code_version() > CODE_AT_START,
        "party": party.snapshot(client),
        "fx": {"sounds": party.sounds(), "favorites": party.favorites()},
    }


def _song_or_404(song_id: str) -> dict:
    song = store.get(song_id)
    if not song:
        raise HTTPException(404, "Música não encontrada")
    return song


# ---------- Páginas ----------

@app.get("/")
def index(host: str = ""):
    # /?host=CHAVE vira este navegador no notebook do anfitrião (fica num cookie)
    if host and HOST_KEY and hmac.compare_digest(host.encode(), HOST_KEY.encode()):
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(HOST_COOKIE, HOST_KEY, max_age=60 * 60 * 24 * 365, httponly=True, secure=True, samesite="lax")
        return response
    return FileResponse(STATIC / "index.html")


@app.get("/m")
def mobile():
    return FileResponse(STATIC / "mobile.html")


@app.get("/review/{song_id}")
def review(song_id: str):
    return FileResponse(STATIC / "review.html")


@app.get("/cam")
def phone_cam():
    return FileResponse(STATIC / "cam.html")


@app.get("/play/{song_id}")
def player(song_id: str):
    # Música do modo dança abre o palco de dança (a fila da festa usa o mesmo link)
    song = store.get(song_id)
    return FileResponse(STATIC / ("dance.html" if song and song.get("kind") == "dance" else "player.html"))


# ---------- Estado em tempo real ----------

@app.get("/api/state")
def get_state(request: Request):
    return state(is_host(request), client_id(request))


@app.websocket("/ws")
async def ws(socket_: WebSocket):
    await socket_.accept()
    host = is_host(socket_)
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


# ---------- Celular como câmera do modo dança ----------

@app.websocket("/ws/cam")
async def cam_socket(socket_: WebSocket):
    """Celular mandando os pontos do corpo de quem dança."""
    await socket_.accept()
    cam_id = (socket_.query_params.get("id") or "celular")[:20]
    camlink.cams.add(socket_)
    await socket_.send_text(json.dumps({"type": "stages", "n": len(camlink.stages)}))
    await camlink.cam_status(cam_id, True)
    try:
        while True:
            await camlink.to_stages(await socket_.receive_text())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        camlink.cams.discard(socket_)
        await camlink.cam_status(cam_id, False)


@app.websocket("/ws/stage-cam")
async def stage_cam_socket(socket_: WebSocket):
    """Palco de dança (só no notebook) recebendo os pontos dos celulares."""
    if socket_.client.host not in ("127.0.0.1", "::1"):
        await socket_.close()
        return
    await socket_.accept()
    camlink.stages.add(socket_)
    await camlink.stage_count()
    try:
        while True:
            await socket_.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        camlink.stages.discard(socket_)
        await camlink.stage_count()


@app.get("/api/qr.svg")
def qr(target: str = ""):
    img = qrcode.make(cam_url() if target == "cam" else session_url(), image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
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
    kind = video.get("kind") or ("karaoke" if youtube.is_karaoke(video.get("title", "")) else "original")
    if kind not in ("original", "karaoke", "dance"):
        kind = "original"
    guess = youtube.guess_dance_title if kind == "dance" else youtube.guess_artist_title
    artist, title = guess(video.get("title", ""), video.get("channel", ""))
    # Com/sem backing vocals: escolhido na hora de adicionar; sem escolha, vale o padrão do ⚙
    backing = video.get("backing")
    want_backing = None if backing is None or kind != "original" else bool(backing)
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
        party.fx(name, client_id(request), is_host(request))
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]))
    return {"ok": True}


@app.post("/api/sounds/{sound_id}/favorite")
def favorite(sound_id: str, body: dict = Body(...)):
    """Põe ou tira um som da seção principal da mesa (vale para todo mundo da festa)."""
    try:
        party.set_favorite(sound_id, bool(body.get("fav")))
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]))
    return {"favorites": party.favorites()}


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

@app.get("/media/{song_id}/video.mp4")
def dance_video(song_id: str):
    f = store.song_dir(song_id) / "video.mp4"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="video/mp4")


@app.post("/api/songs/{song_id}/dance-sessions")
def save_dance_session(song_id: str, request: Request, body: dict = Body(...)):
    """Guarda uma dança (pontos de cada quadro e notas) para a tela de análise."""
    _song_or_404(song_id)
    if not is_host(request):
        raise HTTPException(403)
    return dance.save_session(song_id, body)


@app.get("/api/songs/{song_id}/dance-sessions")
def dance_sessions(song_id: str):
    _song_or_404(song_id)
    return dance.list_sessions(song_id)


@app.get("/api/songs/{song_id}/dance-sessions/{session_id}")
def dance_session(song_id: str, session_id: str):
    f = dance.session_file(song_id, session_id)
    if not f:
        raise HTTPException(404, "Análise não encontrada")
    return FileResponse(f, media_type="application/json")


@app.delete("/api/songs/{song_id}/dance-sessions/{session_id}")
def delete_dance_session(song_id: str, session_id: str, request: Request):
    if not is_host(request):
        raise HTTPException(403)
    dance.delete_session(song_id, session_id)
    return {"ok": True}


@app.get("/media/{song_id}/pose.json")
def dance_pose(song_id: str):
    """Gabarito do modo dança: pose do coach quadro a quadro e os movimentos."""
    f = store.song_dir(song_id) / "pose.json"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="application/json")


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
