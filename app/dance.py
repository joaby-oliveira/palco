"""Modo dança: marca a pose do coach no vídeo e as batidas da música.

O resultado fica em data/songs/<id>/pose.json e é o gabarito que o palco usa
para dar nota a quem dança na frente da webcam (o navegador roda o mesmo
detector, o MediaPipe Pose, na imagem da câmera).
"""
import json
import re
import secrets
import subprocess
import time
from pathlib import Path

import httpx
import numpy as np

from . import config, store

FPS = 15  # quadros de referência por segundo
# Pontos do MediaPipe que entram na comparação: ombros, cotovelos, punhos, quadris, joelhos, tornozelos
KEYPOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
MODEL = "pose_landmarker_lite.task"
MODEL_URL = f"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/{MODEL}"


class MissingDependency(RuntimeError):
    pass


def _model() -> Path:
    path = config.DATA_DIR / "models" / MODEL
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = httpx.get(MODEL_URL, follow_redirects=True, timeout=120)
        r.raise_for_status()
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(r.content)
        tmp.replace(path)
    return path


def extract_poses(video: Path, report) -> dict:
    """Pose do coach a cada 1/FPS segundo: 12 pontos [x, y, visibilidade] ou None."""
    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
    except ImportError as e:
        raise MissingDependency('O modo dança precisa do MediaPipe: uv pip install --python .venv mediapipe') from e

    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(_model())),
        running_mode=vision.RunningMode.VIDEO, num_poses=1)
    cap = cv2.VideoCapture(str(video))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    width, height = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    frames: list = []
    try:
        with vision.PoseLandmarker.create_from_options(opts) as landmarker:
            i = 0
            while cap.grab():
                t = i / src_fps
                i += 1
                if t + 1e-6 < len(frames) / FPS:
                    continue
                ok, frame = cap.retrieve()
                if not ok:
                    break
                # O detector trabalha em 256 px; reduzir antes deixa a conversão bem mais rápida
                small = cv2.resize(frame, (640, round(640 * height / width)) if width else (640, 360))
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
                result = landmarker.detect_for_video(image, int(t * 1000))
                if result.pose_landmarks:
                    p = result.pose_landmarks[0]
                    frames.append([v for k in KEYPOINTS for v in (round(p[k].x, 3), round(p[k].y, 3), round(p[k].visibility, 2))])
                else:
                    frames.append(None)
                if i % 60 == 0:
                    report(i / total)
    finally:
        cap.release()
    return {"fps": FPS, "aspect": round(width / height, 4) if height else 16 / 9, "frames": frames}


def detect_beats(audio: Path) -> tuple[float, list[float]]:
    """Batidas da música: tempo pela autocorrelação do fluxo espectral e grade
    (período e fase) ajustada para a música inteira."""
    sr, n, hop = 11025, 1024, 256
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(audio), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=180,
    ).stdout
    y = np.frombuffer(raw, dtype=np.float32)
    if len(y) < sr * 10:
        return 0.0, []
    frames = np.lib.stride_tricks.sliding_window_view(y, n)[::hop]
    spec = np.log1p(10 * np.abs(np.fft.rfft(frames * np.hanning(n), axis=1)))
    flux = np.maximum(0, np.diff(spec, axis=0)).sum(axis=1)
    rate = sr / hop
    w = int(rate)  # tira a média móvel de 1 s: sobra só o ataque das notas
    env = np.maximum(0, flux - np.convolve(flux, np.ones(w) / w, mode="same"))
    env /= env.max() or 1

    # Tempo: autocorrelação entre 70 e 180 BPM, com preferência perto de 120
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(int(rate * 60 / 180), int(rate * 60 / 70) + 1)
    bpms = 60 * rate / lags
    weight = np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
    lag = lags[np.argmax(ac[lags] * weight)]

    # Período fino e fase: a grade que mais cai em cima dos ataques
    best = (-1.0, float(lag), 0.0)
    for period in np.arange(lag - 1, lag + 1, 0.02):
        count = int((len(env) - 1) / period)
        if count < 8:
            continue
        for phase in np.arange(0, period, 0.5):
            idx = (phase + period * np.arange(count)).astype(int)
            idx = idx[idx < len(env)]
            score = env[idx].mean()
            if score > best[0]:
                best = (score, period, phase)
    _, period, phase = best
    beats = (phase + period * np.arange(int((len(env) - phase) / period))) / rate + n / 2 / sr
    return round(60 * rate / period, 1), [round(float(b), 3) for b in beats]


def moves(beats: list[float], frames: list, duration: float) -> list[list[float]]:
    """Divide a música em movimentos de um compasso (dois tempos nas lentas),
    pulando os trechos em que o coach não aparece (abertura, telas de fim)."""
    if len(beats) < 4:
        beats = [i * 0.5 for i in range(int(duration / 0.5))]
    period = (beats[-1] - beats[0]) / max(1, len(beats) - 1)
    step = 4 if period < 0.6 else 2
    out = []
    for i in range(0, len(beats) - step, step):
        start, end = beats[i], beats[i + step]
        window = frames[int(start * FPS):int(end * FPS)]
        if window and sum(f is not None for f in window) / len(window) >= 0.6:
            out.append([round(start, 3), round(end, 3)])
    return out


def analyze(video: Path, audio: Path, dest: Path, report):
    """Gera o pose.json: pose quadro a quadro, batidas e movimentos."""
    report("Marcando os passos do coach...", 0)
    data = extract_poses(video, lambda f: report("Marcando os passos do coach...", f * 0.9))
    report("Contando as batidas...", 0.92)
    bpm, beats = detect_beats(audio)
    data.update(bpm=bpm, beats=beats, moves=moves(beats, data["frames"], len(data["frames"]) / FPS))
    if not data["moves"]:
        raise RuntimeError("Não achei ninguém dançando nesse vídeo. Tenta outro (um com o dançarino de corpo inteiro).")
    dest.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


# ---------- Danças gravadas (tela de análise) ----------
# Cada dança com nota fica em data/songs/<id>/sessions/<sessão>.json (pontos de
# cada quadro e nota de cada movimento) e um resumo pequeno em <sessão>.summary.json.

SESSION_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")


def _sessions_dir(song_id: str) -> Path:
    return store.song_dir(song_id) / "sessions"


def session_file(song_id: str, session_id: str) -> Path | None:
    if not SESSION_RE.match(session_id):
        return None
    f = _sessions_dir(song_id) / f"{session_id}.json"
    return f if f.exists() else None


def save_session(song_id: str, data: dict) -> dict:
    session_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    data = {**data, "id": session_id, "song_id": song_id, "created": time.time()}
    d = _sessions_dir(song_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{session_id}.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    summary = {k: data.get(k) for k in ("id", "created", "end", "sources", "params")}
    summary["players"] = [{k: p.get(k) for k in ("name", "score", "stars")} for p in data.get("players") or []]
    summary["frames"] = sum(1 for f in data.get("frames") or [] if len(f) > 1 and f[1] is not None)
    (d / f"{session_id}.summary.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    return summary


def list_sessions(song_id: str) -> list[dict]:
    d = _sessions_dir(song_id)
    if not d.exists():
        return []
    items = [json.loads(f.read_text(encoding="utf-8")) for f in d.glob("*.summary.json")]
    return sorted(items, key=lambda s: s["created"], reverse=True)


def delete_session(song_id: str, session_id: str):
    f = session_file(song_id, session_id)
    if f:
        f.unlink()
        f.with_name(f"{session_id}.summary.json").unlink(missing_ok=True)
