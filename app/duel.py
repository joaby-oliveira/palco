"""Modo duelo: divide a letra entre dois cantores (A, B ou os dois juntos).

A divisão automática olha a faixa da voz separada: o tom (F0) e o timbre de
cada linha. Se as linhas formam dois grupos bem distintos (homem e mulher, ou
duas vozes bem diferentes), cada grupo vira um cantor. Se não dá para
distinguir (ou a música não teve a voz separada), divide pelas estrofes: o
refrão (linhas que se repetem) é dos dois e as outras estrofes alternam.
"""
import re
import subprocess
from pathlib import Path

import numpy as np

from . import store

SR, N, HOP = 16000, 1024, 320  # quadros de 64 ms a cada 20 ms
F0_MIN, F0_MAX = 70, 900
PARTS = ("a", "b", "ab")
MIN_GAP = 6        # semitons entre o tom típico dos dois grupos de linhas
MIN_TIMBRE = 0.35  # silhueta dos grupos só pelo timbre


def _decode(audio: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(audio), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=180,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _mel_bank(bands: int = 26) -> np.ndarray:
    hz = lambda m: 700 * (10 ** (m / 2595) - 1)
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    edges = hz(np.linspace(mel(80), mel(7600), bands + 2))
    freqs = np.fft.rfftfreq(N, 1 / SR)
    bank = np.zeros((bands, len(freqs)), dtype=np.float32)
    for i in range(bands):
        lo, mid, hi = edges[i:i + 3]
        bank[i] = np.clip(np.minimum((freqs - lo) / (mid - lo), (hi - freqs) / (hi - mid)), 0, None)
    return bank


def frame_features(y: np.ndarray) -> dict:
    """Por quadro: energia, tom (log2 do F0, NaN sem tom) e timbre (MFCC sem o c0)."""
    frames = np.lib.stride_tricks.sliding_window_view(y, N)[::HOP]
    rms = np.sqrt((frames ** 2).mean(axis=1))
    win = np.hanning(N).astype(np.float32)
    lag_lo, lag_hi = SR // F0_MAX, SR // F0_MIN
    bank = _mel_bank()
    dct = np.cos(np.pi / bank.shape[0] * (np.arange(bank.shape[0]) + 0.5)[None, :] * np.arange(1, 13)[:, None])
    f0 = np.full(len(frames), np.nan, dtype=np.float32)
    mfcc = np.zeros((len(frames), 12), dtype=np.float32)
    for s in range(0, len(frames), 2000):
        chunk = frames[s:s + 2000] * win
        spec = np.fft.rfft(chunk, 2 * N, axis=1)
        ac = np.fft.irfft(np.abs(spec) ** 2, axis=1)[:, :lag_hi + 2]
        ac = ac / np.maximum(ac[:, :1], 1e-9)
        seg = ac[:, lag_lo:lag_hi + 1]
        best = seg.max(axis=1)
        # O menor atraso perto do pico evita pegar o tom uma oitava abaixo
        lag = lag_lo + np.argmax(seg >= best[:, None] * 0.9, axis=1)
        voiced = best > 0.45
        f0[s:s + 2000][voiced] = np.log2(SR / lag[voiced])
        power = np.abs(np.fft.rfft(chunk, axis=1)) ** 2
        mfcc[s:s + 2000] = np.log(power @ bank.T + 1e-8) @ dct.T
    return {"rms": rms, "f0": f0, "mfcc": mfcc}


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", text.lower()).strip()


def by_stanza(lines: list[dict]) -> list:
    """Sem como ouvir as vozes: as estrofes alternam e o refrão que mais se repete é dos dois."""
    stanzas, cur = [], []
    for i, l in enumerate(lines):
        gap = i and l.get("t") is not None and lines[i - 1].get("t") is not None and l["t"] - lines[i - 1]["t"] > 7
        if not (l.get("text") or "").strip() or gap:
            if cur:
                stanzas.append(cur)
            cur = []
        if (l.get("text") or "").strip():
            cur.append(i)
    if cur:
        stanzas.append(cur)
    # Estrofe comprida demais (letra sem linhas em branco) vira blocos de 4
    stanzas = [st[k:k + size] for st in stanzas for size in [4 if len(st) > 8 else len(st)] for k in range(0, len(st), size)]
    counts: dict[str, int] = {}
    for l in lines:
        if _norm(l.get("text") or ""):
            counts[_norm(l["text"])] = counts.get(_norm(l["text"]), 0) + 1
    # Refrão: as estrofes que mais se repetem (música que repete um verso inteiro
    # não vira toda "dos dois")
    reps = [sum(counts[_norm(lines[i]["text"])] for i in st) / len(st) for st in stanzas]
    top = max(reps, default=1)
    chorus = [top >= 2 and r >= top - 0.25 for r in reps]
    if all(chorus):
        chorus = [False] * len(stanzas)
    parts: list = [None] * len(lines)
    turn = "a"
    for st, ch in zip(stanzas, chorus):
        for i in st:
            parts[i] = "ab" if ch else turn
        if not ch:
            turn = "b" if turn == "a" else "a"
    return parts


def _kmeans2(x: np.ndarray, tries: int = 8) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(0)
    best = None
    for _ in range(tries):
        c = x[rng.choice(len(x), 2, replace=False)]
        for _ in range(50):
            lab = np.argmin(((x[:, None] - c[None]) ** 2).sum(-1), axis=1)
            if lab.min() == lab.max():
                break
            new = np.stack([x[lab == k].mean(0) for k in (0, 1)])
            if np.allclose(new, c):
                break
            c = new
        cost = ((x - c[lab]) ** 2).sum()
        if lab.min() != lab.max() and (best is None or cost < best[0]):
            best = (cost, lab, c)
    if best is None:
        return np.zeros(len(x), dtype=int), x[:2]
    return best[1], best[2]


def _silhouette(x: np.ndarray, lab: np.ndarray) -> float:
    d = np.sqrt(((x[:, None] - x[None]) ** 2).sum(-1))
    s = []
    for i in range(len(x)):
        same = lab == lab[i]
        if same.sum() < 2:
            s.append(0.0)
            continue
        a = d[i, same].sum() / (same.sum() - 1)
        b = d[i, ~same].mean()
        s.append((b - a) / max(a, b, 1e-9))
    return float(np.mean(s))


def by_voice(lines: list[dict], feats: dict, offset: float = 0.0) -> tuple[list | None, str]:
    """Divide pelas vozes da faixa da voz separada. None quando as vozes não se separam bem."""
    rms, f0, mfcc = feats["rms"], feats["f0"], feats["mfcc"]
    loud = rms > max(np.percentile(rms, 95) * 0.12, 1e-4)
    starts = [None if l.get("t") is None else l["t"] + offset for l in lines]
    rows, idx, frame_sets = [], [], []
    for i, l in enumerate(lines):
        if not (l.get("text") or "").strip() or starts[i] is None:
            continue
        nxt = next((starts[j] for j in range(i + 1, len(lines)) if starts[j] is not None), starts[i] + 6)
        a, b = int((starts[i] + 0.1) * SR / HOP), int(min(nxt, starts[i] + 8) * SR / HOP)
        sel = np.arange(max(0, a), min(b, len(rms)))
        sel = sel[loud[sel]]
        pitched = sel[~np.isnan(f0[sel])]
        if len(pitched) < 8:
            continue
        rows.append(np.concatenate([[np.median(f0[pitched])], mfcc[sel].mean(0)]))
        idx.append(i)
        frame_sets.append(pitched)
    if len(rows) < 6:
        return None, "Poucas linhas com voz para comparar."
    x = np.array(rows)
    x = (x - x.mean(0)) / (x.std(0) + 1e-6)
    x[:, 0] *= 2.5  # o tom pesa mais que cada coeficiente do timbre
    lab, cent = _kmeans2(x)
    small = min((lab == 0).mean(), (lab == 1).mean())
    pitch = np.array([r[0] for r in rows])
    gap = abs(np.median(pitch[lab == 0]) - np.median(pitch[lab == 1])) * 12  # semitons
    # Um cantor só já muda uns 3 a 5 semitons do verso para o refrão; homem e
    # mulher ficam bem mais longe. Sem essa distância, só com o timbre bem diferente.
    if small < 0.15 or _silhouette(x, lab) < 0.18 or (gap < MIN_GAP and _silhouette(x[:, 1:], lab) < MIN_TIMBRE):
        return None, "Não achei duas vozes bem diferentes."
    # Linha isolada entre duas do outro cantor, perto da fronteira: segue as vizinhas
    dist = np.sqrt(((x[:, None] - cent[None]) ** 2).sum(-1))
    margin = np.abs(dist[:, 0] - dist[:, 1])
    for k in range(1, len(lab) - 1):
        if lab[k - 1] == lab[k + 1] != lab[k] and margin[k] < np.median(margin) * 0.5:
            lab[k] = lab[k - 1]
    # Cantor A é quem canta primeiro
    first = lab[0]
    names = {first: "a", 1 - first: "b"}
    parts: list = [None] * len(lines)
    hi_a = np.median(pitch[lab == first]) > np.median(pitch[lab != first])
    for k, i in enumerate(idx):
        parts[i] = names[lab[k]]
        # Com tons bem diferentes, linha em que os dois tons aparecem é dos dois
        if gap >= MIN_GAP:
            fr = f0[frame_sets[k]]
            mid = (np.median(pitch[lab == 0]) + np.median(pitch[lab == 1])) / 2
            hi = (fr > mid).mean()
            if 0.3 <= hi <= 0.7:
                parts[i] = "ab"
    # Linhas sem voz suficiente seguem a linha cantada anterior (ou a seguinte)
    sung = [i for i, l in enumerate(lines) if (l.get("text") or "").strip()]
    last = None
    for i in sung:
        if parts[i] is None:
            parts[i] = last
        last = parts[i] or last
    for i in reversed(sung):
        if parts[i] is None:
            parts[i] = last
        last = parts[i] or last
    a_label = "mais aguda" if hi_a else "mais grave"
    return parts, f"Dividi pelas vozes: A é a voz {a_label}, B a outra."


def detect(song_id: str) -> dict:
    """Sugestão de divisão para a música (não salva)."""
    song = store.get(song_id) or {}
    lyr = store.read_lyrics(song_id) or {"lines": []}
    lines = lyr["lines"]
    if not lines:
        raise ValueError("A música não tem letra.")
    lead = store.song_dir(song_id) / "lead.mp3"
    note = "Sem a voz separada, dividi pelas estrofes: elas alternam e o refrão que mais se repete é dos dois."
    if song.get("separated") and lead.exists() and lyr.get("synced"):
        parts, why = by_voice(lines, frame_features(_decode(lead)), song.get("offset") or 0.0)
        if parts:
            return {"parts": parts, "source": "voz", "note": why}
        note = f"{why} Dividi pelas estrofes: elas alternam e o refrão que mais se repete é dos dois."
    elif not lyr.get("synced"):
        note = "A letra não tem tempos, então dividi pelas estrofes: elas alternam e o refrão que mais se repete é dos dois."
    return {"parts": by_stanza(lines), "source": "estrofes", "note": note}


def get(song_id: str) -> dict:
    """Divisão salva da música; sem nenhuma, calcula a automática e guarda."""
    lyr = store.read_lyrics(song_id) or {"lines": []}
    if lyr.get("parts") and len(lyr["parts"]) == len(lyr["lines"]):
        return {"parts": lyr["parts"], "source": lyr.get("parts_source", "manual"), "note": lyr.get("parts_note", "")}
    res = detect(song_id)
    save(song_id, res["parts"], res["source"], res["note"])
    return res


def save(song_id: str, parts: list, source: str = "manual", note: str = ""):
    lyr = store.read_lyrics(song_id)
    if not lyr or len(parts) != len(lyr["lines"]):
        raise ValueError("A letra mudou; abra a divisão de novo.")
    lyr["parts"] = [p if p in PARTS else None for p in parts]
    lyr["parts_source"] = source
    lyr["parts_note"] = note
    store.write_lyrics(song_id, lyr)
