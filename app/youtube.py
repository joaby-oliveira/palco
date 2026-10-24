"""Busca, prévia e download de áudio do YouTube com yt-dlp."""
import re
import subprocess
from pathlib import Path

import yt_dlp

from . import config

_QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}
# Em servidor (IP de datacenter) o YouTube pede login: um cookies.txt exportado do
# navegador nesse caminho resolve. Em casa não precisa.
COOKIES = config.DATA_DIR / "youtube-cookies.txt"


def _base() -> dict:
    return {**_QUIET, "cookiefile": str(COOKIES)} if COOKIES.exists() else dict(_QUIET)


# Vídeo curto e estável para conferir se os cookies passam pelo bloqueio
_TEST_VIDEO = "jNQXAC9IVRw"


def _is_bot_check(msg: str) -> bool:
    return "not a bot" in msg or "Sign in to confirm" in msg


def friendly_error(msg: str) -> str:
    """Troca o "Sign in to confirm you're not a bot" do YouTube pelo que fazer."""
    if not _is_bot_check(msg):
        return msg
    if COOKIES.exists():
        return ("O YouTube recusou os cookies (venceram ou a conta saiu). Exporte de novo e envie em "
                "Ajustes do anfitrião › YouTube.")
    return ("O YouTube pediu login para baixar (acontece em servidor). Envie os cookies de uma conta "
            "em Ajustes do anfitrião › YouTube.")


def cookies_info() -> dict:
    if not COOKIES.exists():
        return {"set": False}
    return {"set": True, "updated": COOKIES.stat().st_mtime}


def save_cookies(text: str) -> dict:
    """Guarda um cookies.txt (formato Netscape) e confere no YouTube se ele resolve o bloqueio."""
    lines = [ln for ln in text.splitlines() if ln.strip() and (not ln.startswith("#") or ln.startswith("#HttpOnly_"))]
    youtube_lines = [ln for ln in lines if len(ln.split("\t")) >= 7 and "youtube.com" in ln.split("\t")[0]]
    if not youtube_lines:
        raise ValueError("Esse arquivo não tem cookies do youtube.com. Exporte com a extensão "
                         "\"Get cookies.txt LOCALLY\" estando em youtube.com, logado.")
    tmp = COOKIES.with_suffix(".tmp")
    tmp.write_text(text if text.startswith("# Netscape") else "# Netscape HTTP Cookie File\n" + text, encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(COOKIES)
    try:
        with yt_dlp.YoutubeDL({**_base(), "format": "bestaudio/best"}) as ydl:
            ydl.extract_info(f"https://www.youtube.com/watch?v={_TEST_VIDEO}", download=False)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        return {**cookies_info(), "ok": False,
                "message": friendly_error(msg) if _is_bot_check(msg) else f"Cookies salvos, mas o teste falhou: {msg}"}
    return {**cookies_info(), "ok": True, "message": "Cookies salvos e testados: o YouTube liberou o download."}


def delete_cookies():
    COOKIES.unlink(missing_ok=True)


def _video_id(text: str) -> str | None:
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", text)
    return m.group(1) if m else None


def _entry(e: dict) -> dict:
    thumbs = e.get("thumbnails") or []
    thumb = thumbs[-1]["url"] if thumbs else f"https://i.ytimg.com/vi/{e['id']}/hqdefault.jpg"
    return {
        "id": e["id"],
        "title": e.get("title") or "",
        "channel": e.get("channel") or e.get("uploader") or "",
        "duration": int(e.get("duration") or 0),
        "thumbnail": thumb,
    }


def search(query: str) -> list[dict]:
    vid = _video_id(query)
    with yt_dlp.YoutubeDL({**_base(), "extract_flat": True, "skip_download": True}) as ydl:
        if vid:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            return [_entry(info)]
        info = ydl.extract_info(f"ytsearch{config.get('search_results')}:{query}", download=False)
    return [_entry(e) for e in info.get("entries") or [] if e.get("id")]


def preview(video_id: str, dest: Path) -> Path:
    """Recorta 5 segundos do meio da música para a prévia."""
    if dest.exists():
        return dest
    with yt_dlp.YoutubeDL({**_base(), "format": "bestaudio/best"}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    start = max(0, int((info.get("duration") or 60) / 2))
    headers = "".join(f"{k}: {v}\r\n" for k, v in (info.get("http_headers") or {}).items())
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-headers", headers, "-ss", str(start), "-t", "5",
         "-i", info["url"], "-vn", "-ac", "2", "-b:a", "128k", str(dest)],
        check=True, timeout=60,
    )
    return dest


def download_audio(video_id: str, out_dir: Path, progress) -> Path:
    """Baixa o áudio e converte para original.mp3."""
    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d):
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        if d.get("status") == "downloading" and total:
            progress(min(1.0, (d.get("downloaded_bytes") or 0) / total))

    opts = {
        **_base(),
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "progress_hooks": [hook],
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "320"}],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    src = out_dir / "source.mp3"
    dest = out_dir / "original.mp3"
    src.replace(dest)
    return dest


def download_video(video_id: str, out_dir: Path, progress) -> Path:
    """Baixa o vídeo (até 720p, 30 fps, H.264 + AAC, que todo navegador toca) em video.mp4."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # Vídeo e áudio vêm separados: a barra conta os dois downloads em sequência
    done = {"parts": 0}

    def hook(d):
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        if d.get("status") == "downloading" and total:
            progress(min(1.0, (done["parts"] + (d.get("downloaded_bytes") or 0) / total) / 2))
        elif d.get("status") == "finished":
            done["parts"] += 1

    opts = {
        **_base(),
        "format": "bv*+ba/b",
        "format_sort": ["res:720", "fps:30", "vcodec:h264", "acodec:aac"],
        "merge_output_format": "mp4",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "progress_hooks": [hook],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    dest = out_dir / "video.mp4"
    (out_dir / "source.mp4").replace(dest)
    return dest


KARAOKE_RE =re.compile(r"karaok|instrumental|playback|sem voz|backing track|minus one", re.I)


def is_karaoke(title: str) -> bool:
    return bool(KARAOKE_RE.search(title))


JUST_DANCE_RE = re.compile(r"just\s*dance(\s*\d{4})?(\s*(edition|unlimited|plus|\+))?", re.I)


def guess_dance_title(title: str, channel: str) -> tuple[str, str]:
    """'Just Dance 2024 - Flowers by Miley Cyrus | Gameplay' -> ('Miley Cyrus', 'Flowers')."""
    parts = [p for p in re.split(r"\s*[|｜]\s*", title) if not JUST_DANCE_RE.fullmatch(p.strip(" -–—:()[]"))]
    clean = JUST_DANCE_RE.sub("", " ".join(parts[:1]) or title)
    clean = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", clean).strip(" -–—:'\"")
    # 'Fanmade Gameplay: Thriller by ...': o que vem antes dos dois-pontos é descrição do vídeo
    head, sep, _ = clean.partition(" by ")
    if sep and ":" in head:
        clean = clean[head.rindex(":") + 1:].strip(" '\"")
    m = re.match(r"['\"“]?(.+?)['\"”]?\s+by\s+(.+)$", clean, re.I)
    if m:
        return m.group(2).strip(" .'\""), m.group(1).strip(" .'\"")
    return guess_artist_title(clean, channel)


def guess_artist_title(title: str, channel: str) -> tuple[str, str]:
    """'Artista - Música (Clipe Oficial)' -> ('Artista', 'Música')."""
    clean = re.sub(r"\s*[\(\[][^\)\]]*(oficial|official|video|vídeo|clipe|lyric|letra|audio|áudio|hd|4k|remaster)[^\)\]]*[\)\]]", "", title, flags=re.I)
    clean = re.sub(r"\s*[\(\[][^\)\]]*(karaok|instrumental|playback)[^\)\]]*[\)\]]", "", clean, flags=re.I)
    clean = re.sub(r"\b(vers[aã]o\s+)?(karaok[eê]|instrumental|playback)\b\s*(version|vers[aã]o)?", "", clean, flags=re.I)
    clean = re.sub(r"\s*\|.*$", "", clean).strip(" -–—")
    channel = re.sub(r"\s*-\s*Topic$", "", channel).strip()
    for sep in (" - ", " – ", " — ", " -", "- "):
        if sep in clean:
            artist, song = clean.split(sep, 1)
            return artist.strip(" .") or channel, song.strip(" .")
    return channel, clean
