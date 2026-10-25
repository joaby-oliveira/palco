"""A festa: quem está na festa, a fila de quem vai cantar, os votos e os efeitos sonoros.

Cada anfitrião tem a sua festa (uma sala, com um código curto). Os convidados
entram pelo QR do telão, que leva o código. O repertório e os sons são de todos;
fila, palco, votos, efeitos e quem está online são de cada sala.

Os convidados ficam salvos em data/guests.json (o nome volta na próxima festa)
e as salas em data/rooms.json (a fila sobrevive a um deploy). Sala parada há
mais de ROOM_TTL some.
"""
import itertools
import json
import re
import secrets
import threading
import time
import uuid

from . import config, store

COLORS = ["#FFC93C", "#FF4FA3", "#7FB2FF", "#5BE3A1", "#FF8A5B", "#C9A2FF", "#FFE08A", "#7FE3E3"]
VOTE_WINDOW = 25  # segundos depois do fim em que ainda dá para votar
ROOM_TTL = 3 * 24 * 3600
# Código da sala: sem letras e números que se confundem (O/0, I/1, L)
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_RE = re.compile(r"^[A-Z0-9]{4,8}$")
# Seção principal da mesa de efeitos quando ninguém mexeu nos favoritos ainda
DEFAULT_FAVORITES = [
    "vine-boom", "anime-wow-sound-effect-mp3cut", "vaias", "ui-rodrigo-faro", "uepa-mp3cut",
    "risada-do-gato", "original-fah", "parei-familia-e-mafia", "love-me-intro",
    "comedy-male-yelling-yee-ha-sound-effects-free-download-mp3cut", "fogos-caruaru-foguete-12x1-8",
    "applause_2", "efeitos-sonoros-brasil-sil-sil-rede-globo", "chicken-on-tree-screaming",
]

_lock = threading.RLock()
_guests: dict[str, dict] = {}
_rooms: dict[str, "Room"] = {}
_fx_seq = itertools.count(1)


def _file():
    return config.DATA_DIR / "guests.json"


def _rooms_file():
    return config.DATA_DIR / "rooms.json"


def load():
    global _guests
    if _file().exists():
        _guests = json.loads(_file().read_text(encoding="utf-8"))
    if _rooms_file().exists():
        for rid, data in json.loads(_rooms_file().read_text(encoding="utf-8")).items():
            _rooms[rid] = Room(rid, data["token"], data)
    _expire()


def _save_guests():
    _file().write_text(json.dumps(_guests, indent=1, ensure_ascii=False), encoding="utf-8")


def _save_rooms():
    tmp = _rooms_file().with_suffix(".tmp")
    tmp.write_text(json.dumps({rid: r.dump() for rid, r in _rooms.items()}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_rooms_file())


def _expire():
    now = time.time()
    for rid in [rid for rid, r in _rooms.items() if now - r.touched > ROOM_TTL]:
        del _rooms[rid]


# ---------- Convidados (valem para qualquer sala) ----------

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


# ---------- Salas ----------

def create() -> "Room":
    with _lock:
        _expire()
        rid = "".join(secrets.choice(CODE_CHARS) for _ in range(5))
        while rid in _rooms:
            rid = "".join(secrets.choice(CODE_CHARS) for _ in range(5))
        room = _rooms[rid] = Room(rid, secrets.token_urlsafe(18))
        _save_rooms()
    return room


def find(rid: str, token: str = "") -> tuple["Room | None", bool]:
    """A sala do código e se quem pediu é o anfitrião dela (tem a chave).
    Sala que sumiu (parada demais) volta com a mesma chave, se o anfitrião aparecer."""
    rid = (rid or "").strip().upper()
    if not CODE_RE.match(rid):
        return None, False
    with _lock:
        room = _rooms.get(rid)
        if not room and len(token) >= 16:
            room = _rooms[rid] = Room(rid, token)
            _save_rooms()
    if not room:
        return None, False
    return room, bool(token) and secrets.compare_digest(token.encode(), room.token.encode())


def drop_song(song_id: str):
    """Música apagada da biblioteca sai da fila de todas as salas."""
    with _lock:
        for room in _rooms.values():
            room.queue[:] = [e for e in room.queue if e["song_id"] != song_id]
        _save_rooms()
    store.touch()


class Room:
    def __init__(self, rid: str, token: str, data: dict | None = None):
        data = data or {}
        self.id = rid
        self.token = token
        self.host_name: str = data.get("host_name") or "Anfitrião"
        self.queue: list[dict] = data.get("queue", [])   # entradas: {id, song_id, client, host, added}
        self.current: dict | None = data.get("current")  # entrada que está no palco agora
        self.last: dict | None = data.get("last")        # última apresentação (tela de fim e votos atrasados)
        self.touched: float = data.get("touched") or time.time()
        self.online: dict[str, int] = {}                 # convidado -> conexões abertas
        self.fx_event: dict = {"seq": 0}                 # último efeito; o telão toca quando o seq muda

    def dump(self) -> dict:
        return {"token": self.token, "host_name": self.host_name, "queue": self.queue,
                "current": self.current, "last": self.last, "touched": self.touched}

    def _changed(self):
        self.touched = time.time()
        _save_rooms()

    def set_host_name(self, name: str):
        name = " ".join(str(name).split())[:24]
        with _lock:
            self.host_name = name or "Anfitrião"
            self._changed()
        store.touch()

    def singer(self, client: str, is_host: bool = False) -> dict:
        g = _guests.get(client)
        if g:
            return {"name": g["name"], "color": g["color"]}
        return {"name": self.host_name if is_host else "Alguém", "color": "#FFC93C" if is_host else "#B9ADD1"}

    def connected(self, client: str, delta: int):
        with _lock:
            self.online[client] = self.online.get(client, 0) + delta
            if self.online[client] <= 0:
                self.online.pop(client, None)
        store.touch()

    # ---------- Fila do palco ----------

    @staticmethod
    def _entry(song_id: str, client: str, host: bool) -> dict:
        return {"id": uuid.uuid4().hex[:8], "song_id": song_id, "client": client, "host": host, "added": time.time()}

    def enqueue(self, song_id: str, client: str, host: bool) -> dict:
        with _lock:
            # Mesma pessoa pedindo a mesma música duas vezes: fica uma só
            for e in self.queue:
                if e["song_id"] == song_id and e["client"] == client:
                    return e
            e = self._entry(song_id, client, host)
            self.queue.append(e)
            self._changed()
        store.touch()
        return e

    def remove(self, entry_id: str, client: str, host: bool) -> bool:
        with _lock:
            for e in self.queue:
                if e["id"] == entry_id:
                    if not host and e["client"] != client:
                        raise PermissionError("Só dá para tirar os seus pedidos.")
                    self.queue.remove(e)
                    break
            else:
                return False
            self._changed()
        store.touch()
        return True

    def to_end(self, entry_id: str):
        with _lock:
            for e in self.queue:
                if e["id"] == entry_id:
                    self.queue.remove(e)
                    self.queue.append(e)
                    break
            self._changed()
        store.touch()

    def start(self, entry_id: str | None = None, song_id: str | None = None, client: str = "", host: bool = True) -> dict:
        """Põe alguém no palco: uma entrada da fila, ou uma música direto (o anfitrião clicou em "Cantar agora")."""
        with _lock:
            e = next((x for x in self.queue if x["id"] == entry_id), None) if entry_id else None
            if e:
                self.queue.remove(e)
            elif song_id:
                e = self._entry(song_id, client, host)
            else:
                raise KeyError("Esse pedido não está mais na fila.")
            e = dict(e, started=time.time(), votes={})
            self.current = e
            self._changed()
        store.touch()
        return e

    def finish(self, entry_id: str):
        with _lock:
            if self.current and self.current["id"] == entry_id:
                self.last = dict(self.current, finished=time.time())
                self.current = None
            self._changed()
        store.touch()

    def vote(self, client: str, score: int):
        with _lock:
            target = self.current
            if not target and self.last and time.time() - self.last["finished"] < VOTE_WINDOW:
                target = self.last
            if not target:
                raise LookupError("Ninguém está cantando agora.")
            if target["client"] == client:
                raise PermissionError("Votar em si mesmo não vale!")
            target["votes"][client] = max(0, min(100, int(score)))
            self._changed()
        store.touch()

    def _public_entry(self, e: dict | None) -> dict | None:
        if not e:
            return None
        out = {k: v for k, v in e.items() if k != "votes"}
        out["singer"] = self.singer(e["client"], e.get("host", False))
        if "votes" in e:
            votes = list(e["votes"].values())
            out["vote_count"] = len(votes)
            out["score"] = round(sum(votes) / len(votes)) if votes else None
        return out

    def snapshot(self, client: str) -> dict:
        with _lock:
            last = self.last if self.last and time.time() - self.last["finished"] < 600 else None
            mine_vote = None
            for e in (self.current, last):
                if e and client in e.get("votes", {}):
                    mine_vote = e["votes"][client]
                    break
            return {
                "queue": [self._public_entry(e) for e in self.queue],
                "current": self._public_entry(self.current),
                "last": self._public_entry(last),
                "last_votable": bool(last and time.time() - last["finished"] < VOTE_WINDOW),
                "my_vote": mine_vote,
                "online": len(self.online),
                "me": _guests.get(client),
            }

    # ---------- Efeitos sonoros ----------

    def fx(self, name: str, client: str, host: bool = False):
        """Toca um som de data/sounds no telão desta sala, ou "stop" (cala tudo)."""
        custom = {s["id"]: s for s in sounds()}
        if name != "stop" and name not in custom:
            raise KeyError("Som desconhecido.")
        snd = custom.get(name, {"name": "Silêncio", "emoji": "🤫"})
        # O cliente vai junto: um som novo da mesma pessoa corta o anterior dela
        self.fx_event = {"seq": next(_fx_seq), "name": name, "label": snd["name"], "emoji": snd.get("emoji", "🔊"),
                         "client": client, "by": self.singer(client, host)["name"]}


def empty_snapshot(client: str) -> dict:
    """Sem sala (celular que não veio pelo QR): nada de fila, só quem é a pessoa."""
    return {"queue": [], "current": None, "last": None, "last_votable": False, "my_vote": None,
            "online": 0, "me": _guests.get(client)}


# ---------- Sons (de todas as salas) ----------

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
