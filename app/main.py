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

from . import accounts, billing, camlink, config, dance, duel, metadata, party, plans, providers, store, usage, worker, youtube

STATIC = config.ROOT / "static"
STEMS = {"original", "instrumental", "lead", "backing"}

app = FastAPI(title="Karaoke")

# No servidor (atrás de um proxy com HTTPS) o endereço dos QR codes é o domínio,
# e quem é o admin (ajustes do servidor) é decidido pela chave, já que ninguém chega pelo localhost.
# Anfitrião de festa qualquer um vira: cada navegador que abre o telão ganha a sua sala.
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
    if path.startswith(("/static", "/play/", "/review/")) or path in ("/", "/m", "/cam", "/conta"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# Deploy sem queda no servidor: o container novo sobe em espera, sem carregar o estado
# nem rodar a fila de preparo, enquanto o antigo ainda atende. Quando o antigo sai, o
# deploy chama /api/activate e só aí o novo lê data/ e entra no ar. A espera é um arquivo
# (e não uma variável) para que, se o servidor reiniciar, o container volte já ativo.
_standby_flag = config.DATA_DIR / f"standby-{os.environ['PALCO_NAME']}" if os.environ.get("PALCO_NAME") else None
_active = False


@app.middleware("http")
async def standby_gate(request: Request, call_next):
    if not _active and request.url.path not in ("/api/health", "/api/activate"):
        return Response("Subindo uma versão nova, um instante...", status_code=503, headers={"Retry-After": "2"})
    return await call_next(request)


def _activate():
    global _active
    config.load()
    store.load()
    party.load()
    accounts.load()
    billing.load()
    worker.start()
    _active = True
    if _standby_flag:
        _standby_flag.unlink(missing_ok=True)


@app.on_event("startup")
def _startup():
    config.load()
    if not (_standby_flag and _standby_flag.exists()):
        _activate()


@app.get("/api/health")
def health():
    if not _active:
        raise HTTPException(503, "Em espera")
    return {"ok": True}


@app.post("/api/activate")
def activate(request: Request):
    # Só o próprio container (docker exec) ativa
    if request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403)
    if not _active:
        _activate()
    return {"ok": True}


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def session_url(room_id: str = "") -> str:
    """Endereço do QR do telão: a página do celular já com o código da sala."""
    base = PUBLIC_URL or f"http://{lan_ip()}:{config.get('port')}"
    return f"{base}/m?sala={room_id}" if room_id else f"{base}/m"


def cam_url() -> str:
    """Página da câmera do celular (modo dança). Precisa ser HTTPS para o celular liberar a câmera."""
    if PUBLIC_URL:
        return f"{PUBLIC_URL}/cam"
    return f"https://{lan_ip()}:{config.get('https_port')}/cam"


def is_admin(request) -> bool:
    """Dono do servidor: mexe nos ajustes do site inteiro (chaves pagas, cookies do YouTube)."""
    if request.client.host in ("127.0.0.1", "::1", "localhost"):
        return True
    cookie = request.cookies.get(HOST_COOKIE, "")
    return bool(HOST_KEY) and hmac.compare_digest(cookie.encode(), HOST_KEY.encode())


def client_id(request) -> str:
    return request.headers.get("x-client") or request.query_params.get("client") or "anon"


def room_of(request) -> tuple[party.Room | None, bool]:
    """A sala do pedido (cabeçalho X-Room ou ?sala=) e se quem pediu é o anfitrião dela."""
    rid = request.headers.get("x-room") or request.query_params.get("sala") or ""
    token = request.headers.get("x-room-token") or request.query_params.get("token") or ""
    return party.find(rid, token)


def need_room(request) -> party.Room:
    room, _ = room_of(request)
    if not room:
        raise HTTPException(404, "Essa festa não existe mais. Escaneia o QR do telão de novo.")
    return room


def need_host(request) -> party.Room:
    room, host = room_of(request)
    if not room or not host:
        raise HTTPException(403, "Só o telão do anfitrião da festa faz isso.")
    return room


def is_room_host(request) -> bool:
    return room_of(request)[1]


# ---------- Cobrança: quem paga a festa ----------

def account_of(request) -> dict | None:
    return accounts.from_token(request.cookies.get(accounts.COOKIE))


def base_url(request) -> str:
    return PUBLIC_URL or str(request.base_url).rstrip("/")


GATE_MESSAGES = {
    "login": "Para começar a festa, entre na sua conta e escolha um passe ou plano.",
    "none": "A festa ainda não foi liberada. Escolha um passe ou plano em Minha conta.",
    "unused": "Você tem um passe guardado. Aperte para começar a contar as horas da festa.",
    "expired": "O passe ou plano desta festa acabou. Renove em Minha conta para continuar.",
}
GUEST_GATE = "A festa ainda não foi liberada pelo anfitrião. Peça para ele ativar no telão."


def room_access(room: party.Room | None) -> dict:
    """Se a festa pode usar o Palco agora. Sem cobrança, no notebook ou na festa do dono, sempre pode."""
    if not billing.enabled() or not room or room.free:
        return {"ok": True}
    acc = accounts.get(room.account)
    if not acc:
        return {"ok": False, "reason": "login"}
    a = billing.access(acc)
    if a["active"]:
        return {"ok": True, "account": acc, "access": a}
    reason = "unused" if a["unused_passes"] else ("expired" if acc["passes"] or acc.get("subscription") else "none")
    return {"ok": False, "reason": reason, "account": acc, "access": a}


def need_access(room: party.Room | None, host: bool, new_song: bool = False, dance_mode: bool = False) -> dict:
    """Barra (402) o que a festa não pode fazer agora; devolve o acesso para contar o uso."""
    gate = room_access(room)
    if not gate["ok"]:
        raise HTTPException(402, GATE_MESSAGES[gate["reason"]] if host else GUEST_GATE)
    a = gate.get("access")
    if not a:
        return gate
    if dance_mode and not a["limits"]["dance"]:
        raise HTTPException(402, f"O modo dança não está no plano {a['name']}. Dá para trocar de plano em Minha conta.")
    if new_song and a["songs_left"] == 0:
        msg = f"As {a['limits']['songs']} músicas novas do plano {a['name']} acabaram. Músicas que já estão no repertório continuam liberadas."
        raise HTTPException(402, msg if host else "Acabaram as músicas novas do plano da festa. Escolha uma que já está pronta.")
    return gate


def attach_room(room: party.Room, acc: dict):
    """O telão de quem está logado vira festa da conta. Passou do número de telões do plano: o mais antigo sai."""
    if room.account == acc["id"]:
        return
    room.set_owner(account=acc["id"])
    a = billing.access(acc)
    screens = a["limits"]["screens"] if a.get("active") else 1
    others = sorted((r for r in party.rooms_of(acc["id"]) if r.id != room.id), key=lambda r: r.touched)
    for old in others[:max(0, len(others) + 1 - screens)]:
        old.set_owner(account="")


def billing_state(room: party.Room | None, host: bool, acc: dict | None) -> dict:
    if not billing.enabled():
        return {"enabled": False}
    gate = room_access(room)
    out = {"enabled": True, "ok": gate["ok"], "reason": gate.get("reason"),
           "message": None if gate["ok"] else (GATE_MESSAGES[gate["reason"]] if host else GUEST_GATE)}
    if host:
        out["account"] = accounts.public(acc) if acc else None
        out["access"] = billing.access(acc) if acc else {"active": False}
        out["free"] = bool(room and room.free)
    return out


def state(room: party.Room | None, host: bool, admin: bool, client: str = "", acc: dict | None = None) -> dict:
    public = {"provider": config.get("provider"), "dance_params": config.get("dance_params")}
    return {
        "songs": store.snapshot(),
        "config": config.public() if admin else public,
        "providers": providers.listing() if admin else [],
        "room": {"id": room.id, "host_name": room.host_name} if room else None,
        "session_url": session_url(room.id if room else ""),
        "is_host": host,
        "is_admin": admin,
        # Código mudou depois que o servidor abriu: o telão pede para reiniciar
        "needs_restart": admin and code_version() > CODE_AT_START,
        "party": room.snapshot(client) if room else party.empty_snapshot(client),
        "fx": {"sounds": party.sounds(), "favorites": party.favorites()},
        "billing": billing_state(room, host, acc),
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


@app.get("/conta")
def account_page():
    return FileResponse(STATIC / "conta.html")


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

@app.post("/api/rooms")
def create_room(request: Request):
    """Festa nova: quem abre o telão vira o anfitrião dela (guarda a chave no navegador)."""
    room = party.create()
    if is_admin(request):
        room.set_owner(free=True)
    elif acc := account_of(request):
        attach_room(room, acc)
    return {"id": room.id, "token": room.token}


@app.patch("/api/room")
def patch_room(request: Request, body: dict = Body(...)):
    room = need_host(request)
    if "host_name" in body:
        room.set_host_name(body["host_name"])
    return {"id": room.id, "host_name": room.host_name}


@app.post("/api/room/people")
def add_person(request: Request, body: dict = Body(...)):
    """O telão põe na festa alguém sem celular (para chamar para um duelo)."""
    try:
        return need_host(request).add_offline(str(body.get("name", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/state")
def get_state(request: Request):
    room, host = room_of(request)
    admin, acc = is_admin(request), account_of(request)
    if room and host:
        # A festa é de quem está no telão: o dono do servidor (grátis) ou a conta logada
        if admin and not room.free:
            room.set_owner(free=True)
        elif acc and not admin:
            attach_room(room, acc)
    return state(room, host, admin, client_id(request), acc)


@app.websocket("/ws")
async def ws(socket_: WebSocket):
    await socket_.accept()
    room, host = room_of(socket_)
    admin, acc = is_admin(socket_), account_of(socket_)
    client = socket_.query_params.get("client") or "anon"
    if room and not host:
        # Festa cheia (limite de convidados do plano): o celular novo não entra
        gate = room_access(room)
        limit = gate["access"]["limits"]["guests"] if gate.get("access") else None
        if not room.admit(client, limit):
            await socket_.send_json({"blocked": f"A festa está cheia: o plano do anfitrião vai até {limit} celulares."})
            await socket_.close()
            return
    # Quem conta como "na festa" são os celulares; o telão não entra na conta
    if room and not host:
        room.connected(client, 1)
    elif room:
        room.seen_host(client)
    seen, fx_seen = -1, room.fx_event["seq"] if room else 0
    try:
        while True:
            if store.version != seen:
                seen = store.version
                await socket_.send_json(state(room, host, admin, client, acc))
            if room and room.fx_event["seq"] != fx_seen:
                fx_seen = room.fx_event["seq"]
                await socket_.send_json({"fx_event": room.fx_event})
            await asyncio.sleep(0.1)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if room and not host:
            room.connected(client, -1)


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
def qr(target: str = "", sala: str = ""):
    room, _ = party.find(sala)
    img = qrcode.make(cam_url() if target == "cam" else session_url(room.id if room else ""), image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml")


# ---------- Conta e pagamento (passe por festa e planos mensais) ----------

def _login_response(acc: dict) -> Response:
    response = Response(json.dumps(accounts.public(acc)), media_type="application/json")
    response.set_cookie(accounts.COOKIE, accounts.new_session(acc), max_age=accounts.SESSION_TTL, httponly=True,
                        secure=PUBLIC_URL.startswith("https"), samesite="lax")
    return response


def need_account(request) -> dict:
    acc = account_of(request)
    if not acc:
        raise HTTPException(401, "Entre na sua conta primeiro.")
    return acc


@app.get("/api/account")
def get_account(request: Request):
    acc = account_of(request)
    return {
        "billing": billing.enabled(),
        "account": accounts.public(acc) if acc else None,
        "access": billing.access(acc) if acc else None,
        "plans": plans.public(),
        "brokers": [{"name": b.name, "label": b.label} for b in billing.available()],
        "orders": [{k: o.get(k) for k in ("id", "plan", "price", "provider", "status", "created")}
                   for o in billing.orders_of(acc)][:20] if acc else [],
    }


@app.post("/api/account/register")
def register(body: dict = Body(...)):
    try:
        acc = accounts.create(str(body.get("email", "")), str(body.get("password", "")), str(body.get("name", "")),
                              str(body.get("phone", "")), str(body.get("tax_id", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _login_response(acc)


@app.post("/api/account/login")
def login(body: dict = Body(...)):
    try:
        acc = accounts.login(str(body.get("email", "")), str(body.get("password", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _login_response(acc)


@app.post("/api/account/logout")
def logout(request: Request):
    accounts.end_session(request.cookies.get(accounts.COOKIE, ""))
    response = Response('{"ok": true}', media_type="application/json")
    response.delete_cookie(accounts.COOKIE)
    return response


@app.patch("/api/account")
def patch_account(request: Request, body: dict = Body(...)):
    return accounts.public(accounts.update_profile(need_account(request), body))


@app.post("/api/billing/checkout")
async def billing_checkout(request: Request, body: dict = Body(...)):
    acc = need_account(request)
    try:
        order = await run_in_threadpool(billing.checkout, acc, str(body.get("plan", "")), body.get("provider"), base_url(request))
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e.args[0]))
    except (RuntimeError, httpx.HTTPError) as e:
        raise HTTPException(502, f"Não consegui abrir o pagamento: {e}")
    return {"id": order["id"], "url": order["url"]}


@app.get("/api/billing/orders/{order_id}")
async def billing_order(order_id: str, request: Request):
    acc = need_account(request)
    order = billing.order(order_id)
    if not order or order["account"] != acc["id"]:
        raise HTTPException(404, "Pedido não encontrado.")
    await run_in_threadpool(billing.sync, order)
    return {"id": order["id"], "plan": order["plan"], "status": order["status"], "access": billing.access(acc)}


@app.post("/api/billing/pass/start")
def billing_start_pass(request: Request):
    acc = need_account(request)
    try:
        billing.start_pass(acc)
    except ValueError as e:
        raise HTTPException(400, str(e))
    store.touch()
    return billing.access(acc)


@app.post("/api/billing/cancel")
async def billing_cancel(request: Request):
    acc = need_account(request)
    try:
        await run_in_threadpool(billing.cancel_subscription, acc)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except (RuntimeError, httpx.HTTPError) as e:
        raise HTTPException(502, f"Não consegui cancelar: {e}")
    return billing.access(acc)


@app.get("/api/billing/portal")
async def billing_portal(request: Request):
    url = await run_in_threadpool(billing.portal, need_account(request))
    if not url:
        raise HTTPException(404, "Esse pagamento não tem portal do cliente.")
    return {"url": url}


@app.post("/api/billing/webhook/{provider}")
async def billing_webhook(provider: str, request: Request):
    broker = billing.BROKERS.get(provider)
    if not broker:
        raise HTTPException(404)
    body = await request.body()
    try:
        events = await run_in_threadpool(broker.parse_webhook, request.headers, dict(request.query_params), body)
    except billing.Unauthorized:
        raise HTTPException(401)
    except ValueError:
        raise HTTPException(400)
    for event in events:
        billing.apply(event, provider)
    store.touch()
    return {"ok": True}


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
        raise HTTPException(502, f"Falha na prévia: {youtube.friendly_error(str(e))}")
    return FileResponse(dest, media_type="audio/mpeg")


# ---------- Cookies do YouTube (servidor com IP de datacenter) ----------

@app.get("/api/youtube/cookies")
def youtube_cookies(request: Request):
    if not is_admin(request):
        raise HTTPException(403)
    return youtube.cookies_info()


@app.post("/api/youtube/cookies")
async def set_youtube_cookies(request: Request, body: dict = Body(...)):
    if not is_admin(request):
        raise HTTPException(403, "Os cookies só podem ser mudados pelo dono do servidor.")
    try:
        return await run_in_threadpool(youtube.save_cookies, str(body.get("text") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/youtube/cookies")
def delete_youtube_cookies(request: Request):
    if not is_admin(request):
        raise HTTPException(403)
    youtube.delete_cookies()
    return youtube.cookies_info()


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
    room, host = room_of(request)
    new = not store.find_video(video.get("id", ""), kind)
    gate = {} if is_admin(request) else need_access(room, host, new_song=new, dance_mode=kind == "dance")
    song = store.add(video, artist, title, client_id(request), kind, want_backing)
    if new and gate.get("account"):
        billing.record_song(gate["account"])
    # Pedido de música: já entra na fila da festa com o nome de quem pediu
    if video.get("queue"):
        if room:
            room.enqueue(song["id"], client_id(request), host)
    return song


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str, request: Request):
    song = _song_or_404(song_id)
    if not is_admin(request) and song["owner"] != client_id(request):
        raise HTTPException(403, "Só dá para apagar as músicas que você pediu.")
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
    if not (is_admin(request) or is_room_host(request)) and song["owner"] != client_id(request):
        raise HTTPException(403, "Só dá para tentar de novo as músicas que você pediu.")
    store.update(song_id, status="queued", step="Na fila", progress=0, error=None)
    return {"ok": True}


@app.post("/api/songs/{song_id}/backing")
def separate_backing(song_id: str, request: Request):
    """Separa os backing vocals de uma música já pronta (gasta mais uma separação)."""
    song = _song_or_404(song_id)
    if not (is_admin(request) or is_room_host(request)):
        raise HTTPException(403, "Só o telão do anfitrião faz isso.")
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
    if not (is_admin(request) or is_room_host(request)):
        raise HTTPException(403, "Só o telão do anfitrião faz isso.")
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
    """Entra na fila para cantar uma música da biblioteca. Com rival, é um duelo;
    o telão do anfitrião também escolhe quem é o cantor A (client)."""
    room, host = room_of(request)
    if not room:
        need_room(request)
    need_access(room, host)
    _song_or_404(str(body.get("song_id")))
    client = (host and body.get("client")) or client_id(request)
    try:
        return room.enqueue(body["song_id"], client, host and client == client_id(request), body.get("rival") or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/stage/{entry_id}")
def stage_remove(entry_id: str, request: Request):
    room, host = room_of(request)
    if not room:
        need_room(request)
    try:
        room.remove(entry_id, client_id(request), host)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@app.post("/api/stage/{entry_id}/later")
def stage_later(entry_id: str, request: Request):
    need_host(request).to_end(entry_id)
    return {"ok": True}


@app.post("/api/stage/start")
def stage_start(request: Request, body: dict = Body(...)):
    """Põe no palco um pedido da fila (entry_id) ou uma música direto (song_id)."""
    room = need_host(request)
    need_access(room, True)
    if body.get("song_id"):
        _song_or_404(str(body["song_id"]))
    client = body.get("client") or client_id(request)
    try:
        return room.start(body.get("entry_id"), body.get("song_id"), client, client == client_id(request), body.get("rival") or None)
    except KeyError as e:
        raise HTTPException(404, str(e.args[0]))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/stage/{entry_id}/finish")
def stage_finish(entry_id: str, request: Request):
    need_host(request).finish(entry_id)
    return {"ok": True}


@app.post("/api/vote")
def vote(request: Request, body: dict = Body(...)):
    try:
        need_room(request).vote(client_id(request), body.get("score"), body.get("pick"))
    except (LookupError, PermissionError, ValueError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/fx/{name}")
def fx(name: str, request: Request):
    room, host = room_of(request)
    if not room:
        need_room(request)
    try:
        room.fx(name, client_id(request), host)
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


# ---------- Duelo: quem canta cada linha ----------

@app.get("/api/songs/{song_id}/duel")
async def get_duel(song_id: str):
    """Divisão da letra para o duelo (a salva, ou a automática na primeira vez)."""
    _song_or_404(song_id)
    try:
        return await run_in_threadpool(duel.get, song_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/songs/{song_id}/duel/detect")
async def detect_duel(song_id: str):
    """Sugestão automática (não salva: o editor mostra e a pessoa confere)."""
    _song_or_404(song_id)
    try:
        return await run_in_threadpool(duel.detect, song_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/songs/{song_id}/duel")
def set_duel(song_id: str, request: Request, body: dict = Body(...)):
    _song_or_404(song_id)
    if not (is_admin(request) or is_room_host(request)):
        raise HTTPException(403, "Só o telão do anfitrião faz isso.")
    try:
        duel.save(song_id, list(body.get("parts") or []), "manual")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return duel.get(song_id)


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
    if not (is_admin(request) or is_room_host(request)):
        raise HTTPException(403, "Só o telão do anfitrião guarda a dança.")
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
    if not (is_admin(request) or is_room_host(request)):
        raise HTTPException(403, "Só o telão do anfitrião apaga a dança.")
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
    if not is_admin(request):
        raise HTTPException(403)
    return await run_in_threadpool(usage.get, force)


# ---------- Configurações ----------

@app.get("/api/config")
def get_config(request: Request):
    if not is_admin(request):
        raise HTTPException(403)
    return {"config": config.public(), "providers": providers.listing()}


@app.post("/api/config")
def set_config(request: Request, values: dict = Body(...)):
    if not is_admin(request):
        raise HTTPException(403, "Esses ajustes só podem ser mudados pelo dono do servidor.")
    config.update(values)
    usage.invalidate()
    store.touch()
    return {"config": config.public(), "providers": providers.listing()}


app.mount("/static", StaticFiles(directory=STATIC), name="static")
