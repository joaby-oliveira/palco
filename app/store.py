"""Biblioteca de músicas e fila de processamento, salvas em data/library.json."""
import json
import shutil
import threading
import time
import uuid

from . import config

_lock = threading.RLock()
_songs: dict[str, dict] = {}
version = 0  # muda a cada alteração; os navegadores recebem o estado novo


def _file():
    return config.DATA_DIR / "library.json"


def load():
    global _songs
    if _file().exists():
        _songs = json.loads(_file().read_text(encoding="utf-8"))
    # Processamentos interrompidos (app fechado no meio) voltam para a fila
    for s in _songs.values():
        if s["status"] == "processing":
            s.update(status="queued", step="Na fila", progress=0)


def _save():
    global version
    version += 1
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(_songs, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_file())


def touch():
    """Avisa os navegadores que algo mudou (ex.: configurações)."""
    with _lock:
        _save()


def song_dir(song_id: str):
    return config.SONGS_DIR / song_id


def add(video: dict, artist: str, title: str, owner: str, kind: str = "original", want_backing: bool | None = None) -> dict:
    with _lock:
        for s in _songs.values():
            # O mesmo vídeo pode estar no repertório para cantar e para dançar
            same_mode = (s.get("kind") == "dance") == (kind == "dance")
            if s["video_id"] == video["id"] and same_mode and s["status"] in ("queued", "processing", "ready"):
                return s
        song = {
            "id": uuid.uuid4().hex[:10],
            "video_id": video["id"],
            "title": title,
            "artist": artist,
            "channel": video.get("channel", ""),
            "duration": video.get("duration", 0),
            "thumbnail": video.get("thumbnail", ""),
            "cover": video.get("thumbnail", ""),
            "owner": owner,
            "kind": kind,            # original | karaoke (vídeo que já é instrumental) | dance (vídeo de coreografia)
            "separated": False,      # True quando a voz foi separada
            "want_backing": want_backing,  # separar backing vocals? None = padrão do ⚙
            "warning": None,
            "status": "queued",
            "step": "Na fila",
            "progress": 0.0,
            "error": None,
            "provider": None,
            "key": None,
            "has_lyrics": False,
            "lyrics_synced": False,
            "has_backing": False,
            "offset": 0.0,
            "created": time.time(),
        }
        _songs[song["id"]] = song
        _save()
        return song


def get(song_id: str) -> dict | None:
    with _lock:
        s = _songs.get(song_id)
        return dict(s) if s else None


def update(song_id: str, **fields):
    with _lock:
        if song_id in _songs:
            _songs[song_id].update(fields)
            _save()


def remove(song_id: str):
    with _lock:
        _songs.pop(song_id, None)
        _save()
    shutil.rmtree(song_dir(song_id), ignore_errors=True)


def next_queued() -> str | None:
    with _lock:
        queued = sorted((s for s in _songs.values() if s["status"] == "queued"), key=lambda s: s["created"])
        return queued[0]["id"] if queued else None


def snapshot() -> list[dict]:
    with _lock:
        return sorted((dict(s) for s in _songs.values()), key=lambda s: s["created"])


def read_lyrics(song_id: str) -> dict | None:
    f = song_dir(song_id) / "lyrics.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def write_lyrics(song_id: str, payload: dict):
    d = song_dir(song_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "lyrics.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    update(song_id, has_lyrics=bool(payload["lines"]), lyrics_synced=payload["synced"])
