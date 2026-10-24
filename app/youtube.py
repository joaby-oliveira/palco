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
