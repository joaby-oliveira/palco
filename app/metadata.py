"""Letras sincronizadas (LRCLIB), capas (iTunes) e detecção de tom."""
import re
import subprocess
from pathlib import Path

import httpx
import numpy as np

UA = {"User-Agent": "karaoke-caseiro/0.1 (uso pessoal)"}


# ---------- Letras (https://lrclib.net/docs) ----------

def search_lyrics(artist: str, title: str) -> list[dict]:
    queries = [{"artist_name": artist, "track_name": title}, {"q": f"{artist} {title}"}, {"q": title}]
    seen, results = set(), []
    for params in queries:
        try:
            r = httpx.get("https://lrclib.net/api/search", params=params, headers=UA, timeout=20)
            items = r.json() if r.status_code == 200 else []
        except (httpx.HTTPError, ValueError):
            items = []
        for it in items:
            if it.get("id") in seen or not (it.get("syncedLyrics") or it.get("plainLyrics")):
                continue
            seen.add(it.get("id"))
            results.append({
                "id": it["id"],
                "artist": it.get("artistName") or "",
                "title": it.get("trackName") or "",
                "album": it.get("albumName") or "",
                "duration": int(it.get("duration") or 0),
                "synced": bool(it.get("syncedLyrics")),
                "lrc": it.get("syncedLyrics") or "",
                "plain": it.get("plainLyrics") or "",
            })
        if len(results) >= 15:
            break
    # Sincronizadas primeiro
    results.sort(key=lambda x: not x["synced"])
    return results


def best_lyrics(artist: str, title: str, duration: int, tolerance: int | None = 8) -> dict | None:
    """Escolhe a letra sincronizada com duração mais próxima da música.

    tolerance=None aceita qualquer duração (ex.: versões karaokê).
    """
    candidates = [r for r in search_lyrics(artist, title) if r["synced"]]
    if duration:
        if tolerance is not None:
            candidates = [r for r in candidates if not r["duration"] or abs(r["duration"] - duration) <= tolerance]
        candidates.sort(key=lambda r: abs(r["duration"] - duration) if r["duration"] else 99)
    return candidates[0] if candidates else None


def lyrics_from_text(text: str) -> dict:
    """Letra colada à mão: aceita LRC com tempos ou texto simples."""
    if re.search(r"\[\d+:\d+(?:\.\d+)?\]", text):
        return {"source_id": None, "synced": True, "lines": parse_lrc(text)}
    return {"source_id": None, "synced": False,
            "lines": [{"t": None, "text": t.strip()} for t in text.strip().splitlines()]}


def parse_lrc(lrc: str) -> list[dict]:
    lines = []
    for raw in lrc.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        text = re.sub(r"\[[^\]]*\]", "", raw).strip()
        for m, s in stamps:
            lines.append({"t": round(int(m) * 60 + float(s), 2), "text": text})
    lines.sort(key=lambda l: l["t"])
    return lines


def lyrics_payload(item: dict) -> dict:
    if item.get("lrc"):
        return {"source_id": item["id"], "synced": True, "lines": parse_lrc(item["lrc"])}
    return {"source_id": item["id"], "synced": False,
            "lines": [{"t": None, "text": t.strip()} for t in (item.get("plain") or "").splitlines()]}


# ---------- Capas (iTunes Search API) ----------

def search_covers(term: str) -> list[str]:
    try:
        r = httpx.get("https://itunes.apple.com/search", params={"term": term, "entity": "album", "limit": 40}, headers=UA, timeout=20)
        items = r.json().get("results", [])
    except (httpx.HTTPError, ValueError):
        return []
    urls = []
    for it in items:
        art = it.get("artworkUrl100")
        if art:
            big = art.replace("100x100bb", "1000x1000bb")
            if big not in urls:
                urls.append(big)
    return urls


# ---------- Tom (nota e escala) ----------

# Perfis de Krumhansl-Schmuckler
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def detect_key(audio: Path) -> dict | None:
    """Estima a tonalidade a partir do instrumental."""
    sr = 11025
    try:
        raw = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", str(audio), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
            capture_output=True, check=True, timeout=120,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return None
    y = np.frombuffer(raw, dtype=np.float32)
    if len(y) < sr * 10:
        return None
    n = 4096
    hop = 2048
    frames = np.lib.stride_tricks.sliding_window_view(y, n)[::hop]
    spec = np.abs(np.fft.rfft(frames * np.hanning(n), axis=1))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    valid = (freqs > 55) & (freqs < 2000)
    pitch = np.round(12 * np.log2(freqs[valid] / 440.0) + 69).astype(int) % 12
    chroma = np.zeros(12)
    energy = np.log1p(spec[:, valid]).sum(axis=0)
    np.add.at(chroma, pitch, energy)
    chroma = (chroma - chroma.mean()) / (chroma.std() or 1)

    best = None
    for i in range(12):
        for scale, profile in (("Major", _MAJOR), ("Minor", _MINOR)):
            p = np.roll(profile, i)
            score = np.corrcoef(chroma, p)[0, 1]
            if best is None or score > best[0]:
                best = (score, NOTES[i], scale)
    return {"note": best[1], "scale": best[2]}
