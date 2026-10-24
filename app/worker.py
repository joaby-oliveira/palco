"""Processa a fila, uma música por vez: baixa, separa, analisa e busca letra."""
import shutil
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import config, metadata, providers, store, usage, youtube
from .providers import Cancelled

_cancel: set[str] = set()


def cancel(song_id: str):
    _cancel.add(song_id)


def _to_mp3(src: Path, dest: Path):
    if src.suffix.lower() == ".mp3":
        shutil.move(src, dest)
        return
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-b:a", "256k", str(dest)], check=True)
    src.unlink(missing_ok=True)


def process(song_id: str):
    song = store.get(song_id)
    out = store.song_dir(song_id)
    work = out / "work"
    work.mkdir(parents=True, exist_ok=True)
    provider = providers.get(config.get("provider"))

    def stage(lo: float, hi: float):
        def report(msg: str, frac: float):
            if song_id in _cancel:
                raise Cancelled()
            store.update(song_id, step=msg, progress=round(lo + (hi - lo) * max(0.0, min(1.0, frac)), 3))
        return report

    if song.get("task") == "backing":
        _separate_backing(song, out, work, provider, stage(0.0, 1.0))
        return

    karaoke_video = song.get("kind") == "karaoke"
    problem = None if karaoke_video else provider.problem()
    # Sem separação: versões karaokê já são instrumentais, e sem serviço
    # configurado a música toca inteira (dá para separar depois).
    separate = not karaoke_video and not problem and provider.name != "none"
    store.update(song_id, status="processing", provider=provider.label if separate else None, error=None, warning=None)

    report = stage(0.0, 0.15 if separate else 0.6)
    report("Baixando música do YouTube...", 0)
    original = out / "original.mp3"
    if not original.exists():
        youtube.download_audio(song["video_id"], out, lambda f: report("Baixando música do YouTube...", f))

    if not separate:
        _finish(song, out, work, stage(0.6, 1.0), original, separated=False, has_backing=False,
                warning=None if karaoke_video else (problem or "Separação desligada"))
        return

    split = song.get("want_backing")
    if split is None:
        split = config.get("split_backing")
    if provider.name == "mvsep":
        usage.check_before_mvsep(song.get("duration") or 0, original.stat().st_size, 2 if split else 1)

    stems = provider.separate_vocals(original, work, stage(0.15, 0.6 if split else 0.9))
    _to_mp3(stems["instrumental"], out / "instrumental.mp3")

    karaoke = None
    if split:
        report = stage(0.6, 0.9)
        report("Separando voz principal dos backing vocals...", 0)
        karaoke = provider.separate_karaoke(stems["vocals"], work, report)
    if karaoke:
        _to_mp3(karaoke["lead"], out / "lead.mp3")
        _to_mp3(karaoke["backing"], out / "backing.mp3")
    else:
        # Sem segunda etapa: toda a voz original fica no controle "Vocais originais"
        _to_mp3(stems["vocals"], out / "lead.mp3")
        (out / "backing.mp3").unlink(missing_ok=True)

    _finish(song, out, work, stage(0.9, 1.0), out / "instrumental.mp3", separated=True, has_backing=bool(karaoke), warning=None)


def _separate_backing(song, out, work, provider, report):
    """Segunda etapa sob demanda: divide a voz original em principal + backing."""
    if provider.name == "none" or provider.problem():
        raise providers.ProviderError(provider.problem() or "Escolha um serviço de separação no ⚙.")
    store.update(song["id"], status="processing", progress=0, error=None)
    vocals = out / "lead.mp3"  # sem backing separado, aqui está a voz inteira
    if provider.name == "mvsep":
        usage.check_before_mvsep(song.get("duration") or 0, vocals.stat().st_size, 1)
    report("Separando voz principal dos backing vocals...", 0)
    result = provider.separate_karaoke(vocals, work, report)
    if not result:
        raise providers.ProviderError(f"O serviço {provider.label} (como está configurado) não separa backing vocals.")
    _to_mp3(result["lead"], work / "lead_new.mp3")
    _to_mp3(result["backing"], out / "backing.mp3")
    (work / "lead_new.mp3").replace(vocals)
    shutil.rmtree(work, ignore_errors=True)
    store.update(song["id"], status="ready", step="Pronta", progress=1.0, has_backing=True, task=None, backing_error=None)


def _finish(song, out, work, report, key_source, separated, has_backing, warning):
    report("Detectando tom da música...", 0)
    key = metadata.detect_key(key_source)
    report("Buscando letra sincronizada...", 0.5)
    if not store.read_lyrics(song["id"]):
        # Versões karaokê têm outra duração; a sincronia é ajustada depois no player
        tolerance = None if song.get("kind") == "karaoke" else 8
        found = metadata.best_lyrics(song["artist"], song["title"], song["duration"], tolerance)
        if found:
            store.write_lyrics(song["id"], metadata.lyrics_payload(found))
            # O nome que vem do LRCLIB é mais confiável que o título do vídeo
            if found["artist"] and found["title"]:
                store.update(song["id"], artist=found["artist"], title=found["title"])
    shutil.rmtree(work, ignore_errors=True)
    store.update(song["id"], status="ready", step="Pronta", progress=1.0, key=key,
                 separated=separated, has_backing=has_backing, warning=warning)


def _loop():
    while True:
        song_id = store.next_queued()
        if not song_id:
            time.sleep(1)
            continue
        song = store.get(song_id) or {}
        backing_task = song.get("task") == "backing"
        try:
            process(song_id)
        except Cancelled:
            if backing_task:  # cancelar a separação de backing não apaga a música
                store.update(song_id, status="ready", step="Pronta", progress=1.0, task=None)
            else:
                store.remove(song_id)
        except Exception as e:  # noqa: BLE001 — qualquer falha vira mensagem na tela
            traceback.print_exc()
            msg = str(e) or e.__class__.__name__
            if not store.get(song_id):
                pass
            elif backing_task:  # a música continua tocável; só avisa da falha
                store.update(song_id, status="ready", step="Pronta", progress=1.0, task=None, backing_error=msg)
            else:
                store.update(song_id, status="error", step="Erro", error=msg)
        finally:
            _cancel.discard(song_id)
            usage.invalidate()


def start():
    threading.Thread(target=_loop, daemon=True, name="worker").start()
