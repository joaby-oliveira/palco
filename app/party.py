"""A festa: quem está na festa, a fila de quem vai cantar, os votos e os efeitos sonoros.

Os convidados ficam salvos em data/guests.json (o nome volta na próxima festa).
A fila do palco vive só na memória: fechou o app, a festa acabou.
"""
import itertools
import json
import threading
import time
import uuid

from . import config, store

COLORS = ["#FFC93C", "#FF4FA3", "#7FB2FF", "#5BE3A1", "#FF8A5B", "#C9A2FF", "#FFE08A", "#7FE3E3"]
VOTE_WINDOW = 25  # segundos depois do fim em que ainda dá para votar
# Seção principal da mesa de efeitos quando ninguém mexeu nos favoritos ainda
DEFAULT_FAVORITES = [
    "vine-boom", "anime-wow-sound-effect-mp3cut", "vaias", "ui-rodrigo-faro", "uepa-mp3cut",
    "risada-do-gato", "original-fah", "parei-familia-e-mafia", "love-me-intro",
    "comedy-male-yelling-yee-ha-sound-effects-free-download-mp3cut", "fogos-caruaru-foguete-12x1-8",
    "applause_2", "efeitos-sonoros-brasil-sil-sil-rede-globo", "chicken-on-tree-screaming",
]

_lock = threading.RLock()
_guests: dict[str, dict] = {}
_queue: list[dict] = []        # entradas: {id, song_id, client, added}
_current: dict | None = None   # entrada que está no palco agora
_last: dict | None = None      # última apresentação (para a tela de fim e os votos atrasados)
_online: dict[str, int] = {}   # cliente -> conexões abertas
_fx_seq = itertools.count(1)
fx_event: dict = {"seq": 0}    # último efeito pedido; a tela do telão toca quando o seq muda


def _file():
    return config.DATA_DIR / "guests.json"


def load():
    global _guests
    if _file().exists():
        _guests = json.loads(_file().read_text(encoding="utf-8"))


def _save_guests():
    _file().write_text(json.dumps(_guests, indent=1, ensure_ascii=False), encoding="utf-8")


# ---------- Convidados ----------

def guest(client: str) -> dict | None:
    return _guests.get(client)


def set_guest(client: str, name: str) -> dict:
    name = " ".join(name.split())[:24]
    if not name:
        raise ValueError("Diz um nome!")
    with _lock:
        g = _guests.get(client) or {"color": COLORS[len(_guests) % len(COLORS)]}
        g["name"] = name
        _guests[client] = g
        _save_guests()
    store.touch()
    return g


def singer(client: str, is_host: bool = False) -> dict:
    g = _guests.get(client)
    if g:
        return {"name": g["name"], "color": g["color"]}
    return {"name": config.get("host_name") if is_host else "Alguém", "color": "#FFC93C" if is_host else "#B9ADD1"}


def connected(client: str, delta: int):
    with _lock:
        _online[client] = _online.get(client, 0) + delta
        if _online[client] <= 0:
            _online.pop(client, None)
    store.touch()


# ---------- Fila do palco ----------

def _entry(song_id: str, client: str, host: bool) -> dict:
    return {"id": uuid.uuid4().hex[:8], "song_id": song_id, "client": client, "host": host, "added": time.time()}


def enqueue(song_id: str, client: str, host: bool) -> dict:
    with _lock:
        # Mesma pessoa pedindo a mesma música duas vezes: fica uma só
        for e in _queue:
            if e["song_id"] == song_id and e["client"] == client:
                return e
        e = _entry(song_id, client, host)
        _queue.append(e)
    store.touch()
    return e


def remove(entry_id: str, client: str, host: bool) -> bool:
    with _lock:
        for e in _queue:
            if e["id"] == entry_id:
                if not host and e["client"] != client:
                    raise PermissionError("Só dá para tirar os seus pedidos.")
                _queue.remove(e)
                break
        else:
            return False
    store.touch()
    return True


def drop_song(song_id: str):
    """Música apagada da biblioteca sai da fila."""
    with _lock:
        _queue[:] = [e for e in _queue if e["song_id"] != song_id]
    store.touch()


def to_end(entry_id: str):
    with _lock:
        for e in _queue:
            if e["id"] == entry_id:
                _queue.remove(e)
                _queue.append(e)
                break
    store.touch()


def start(entry_id: str | None = None, song_id: str | None = None, client: str = "", host: bool = True) -> dict:
    """Põe alguém no palco: uma entrada da fila, ou uma música direto (o anfitrião clicou em "Cantar agora")."""
    global _current
    with _lock:
        e = next((x for x in _queue if x["id"] == entry_id), None) if entry_id else None
        if e:
            _queue.remove(e)
        elif song_id:
            e = _entry(song_id, client, host)
        else:
            raise KeyError("Esse pedido não está mais na fila.")
        e = dict(e, started=time.time(), votes={})
        _current = e
    store.touch()
    return e


def finish(entry_id: str):
    global _current, _last
    with _lock:
        if _current and _current["id"] == entry_id:
            _last = dict(_current, finished=time.time())
            _current = None
    store.touch()


def vote(client: str, score: int):
    with _lock:
        target = _current
        if not target and _last and time.time() - _last["finished"] < VOTE_WINDOW:
            target = _last
        if not target:
            raise LookupError("Ninguém está cantando agora.")
        if target["client"] == client:
            raise PermissionError("Votar em si mesmo não vale!")
        target["votes"][client] = max(0, min(100, int(score)))
    store.touch()


def _public_entry(e: dict | None) -> dict | None:
    if not e:
        return None
    out = {k: v for k, v in e.items() if k != "votes"}
    out["singer"] = singer(e["client"], e.get("host", False))
    if "votes" in e:
        votes = list(e["votes"].values())
        out["vote_count"] = len(votes)
        out["score"] = round(sum(votes) / len(votes)) if votes else None
    return out


def snapshot(client: str) -> dict:
    with _lock:
        last = _last if _last and time.time() - _last["finished"] < 600 else None
        mine_vote = None
        for e in (_current, last):
            if e and client in e.get("votes", {}):
                mine_vote = e["votes"][client]
                break
        return {
            "queue": [_public_entry(e) for e in _queue],
            "current": _public_entry(_current),
            "last": _public_entry(last),
            "last_votable": bool(last and time.time() - last["finished"] < VOTE_WINDOW),
            "my_vote": mine_vote,
            "online": len(_online),
            "me": _guests.get(client),
        }


# ---------- Efeitos sonoros ----------

def fx(name: str, client: str, host: bool = False):
    """Toca um som de data/sounds no telão, ou "stop" (cala tudo)."""
    global fx_event
    custom = {s["id"]: s for s in sounds()}
    if name != "stop" and name not in custom:
        raise KeyError("Som desconhecido.")
    snd = custom.get(name, {"name": "Silêncio", "emoji": "🤫"})
    # O cliente vai junto: um som novo da mesma pessoa corta o anterior dela
    fx_event = {"seq": next(_fx_seq), "name": name, "label": snd["name"], "emoji": snd.get("emoji", "🔊"),
                "client": client, "by": singer(client, host)["name"]}


def _sounds_dir():
    return config.DATA_DIR / "sounds"


def sounds() -> list[dict]:
    """Sons em data/sounds: os listados em sounds.json (com nome e cor) e
    qualquer outro .mp3/.wav/.ogg jogado na pasta (o nome vem do arquivo)."""
    d = _sounds_dir()
    if not d.exists():
        return []
    listed = []
    index = d / "sounds.json"
    if index.exists():
        listed = [dict({"emoji": "🔊"}, **s) for s in json.loads(index.read_text(encoding="utf-8")) if (d / s["file"]).exists()]
    known = {s["file"] for s in listed}
    for f in sorted(d.iterdir()):
        if f.suffix.lower() in (".mp3", ".wav", ".ogg") and f.name not in known:
            listed.append({"id": f.stem, "name": f.stem.replace("-", " ").replace("_", " "), "file": f.name, "color": "#3A2A5A", "emoji": "🔊"})
    return listed


def favorites() -> list[str]:
    """Sons da seção principal, na ordem (as teclas 1 a 0 do palco seguem essa ordem)."""
    f = _sounds_dir() / "favorites.json"
    ids = json.loads(f.read_text(encoding="utf-8")) if f.exists() else DEFAULT_FAVORITES
    have = {s["id"] for s in sounds()}
    return [i for i in ids if i in have]


def set_favorite(sound_id: str, fav: bool):
    if sound_id not in {s["id"] for s in sounds()}:
        raise KeyError("Som desconhecido.")
    with _lock:
        ids = [i for i in favorites() if i != sound_id]
        if fav:
            ids.append(sound_id)
        (_sounds_dir() / "favorites.json").write_text(json.dumps(ids, ensure_ascii=False, indent=1), encoding="utf-8")
    store.touch()
