"""Uso e limites dos serviços de separação.

MVSEP (plano grátis): 50 separações por dia, arquivos de até 10 min e 100 MB,
1 trabalho por vez. O uso é contado pelo histórico da própria conta no MVSEP,
então inclui separações feitas fora do app. O dia do MVSEP segue o horário
UTC (meia-noite UTC = 21h em Brasília).
"""
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import config

MVSEP_API = "https://mvsep.com/api"
MVSEP_FREE_DAILY = 50
MVSEP_FREE_MAX_MINUTES = 10
MVSEP_FREE_MAX_MB = 100

_cache: dict = {"at": 0.0, "data": None}
_lock = threading.Lock()


def separations_per_song() -> int:
    return 2 if config.get("split_backing") else 1


def invalidate():
    _cache["at"] = 0.0


def get(force: bool = False) -> dict:
    provider = config.get("provider")
    if provider != "mvsep":
        return {"provider": provider, "supported": False,
                "message": "O acompanhamento de uso por enquanto só existe para o MVSEP."}
    with _lock:
        if not force and _cache["data"] and time.time() - _cache["at"] < 30:
            return _cache["data"]
        data = _mvsep()
        _cache.update(at=time.time(), data=data)
        return data


def _mvsep() -> dict:
    token = config.get("mvsep_api_token")
    now = datetime.now(timezone.utc)
    reset = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    base = {
        "provider": "mvsep",
        "supported": True,
        "daily_limit": MVSEP_FREE_DAILY,
        "max_minutes": MVSEP_FREE_MAX_MINUTES,
        "max_mb": MVSEP_FREE_MAX_MB,
        "per_song": separations_per_song(),
        "resets_at": reset.isoformat(),
    }
    if not token:
        return {**base, "error": "Sem token do MVSEP."}
    try:
        user = httpx.get(f"{MVSEP_API}/app/user", params={"api_token": token}, timeout=20).json().get("data") or {}
        today = now.strftime("%Y-%m-%d")
        used, start = 0, 0
        # O histórico vem do mais novo para o mais antigo; para quando chegar em ontem
        while True:
            page = httpx.get(f"{MVSEP_API}/app/separation_history",
                             params={"api_token": token, "start": start, "limit": 25}, timeout=20).json().get("data") or []
            todays = [j for j in page if str(j.get("created_at", "")).startswith(today)]
            used += len(todays)
            if len(todays) < len(page) or len(page) < 25 or start > 200:
                break
            start += 25
    except (httpx.HTTPError, ValueError) as e:
        return {**base, "error": f"Não consegui consultar o MVSEP: {e}"}

    premium_minutes = int(user.get("premium_minutes") or 0)
    remaining = max(0, MVSEP_FREE_DAILY - used)
    return {
        **base,
        "used_today": used,
        "remaining": remaining,
        "songs_left": remaining // base["per_song"],
        "premium_minutes": premium_minutes,
        "plan": "premium" if premium_minutes > 0 else "grátis",
        "queue": len(user.get("current_queue") or []),
    }


def check_before_mvsep(duration_s: int, size_bytes: int, needed: int):
    """Erro amigável antes de enviar, em vez de gastar o envio à toa."""
    from .providers import ProviderError

    info = get(force=True)
    if info.get("error") or info.get("plan") == "premium":
        return
    if duration_s and duration_s > MVSEP_FREE_MAX_MINUTES * 60:
        raise ProviderError(f"No plano grátis do MVSEP a música pode ter até {MVSEP_FREE_MAX_MINUTES} minutos.")
    if size_bytes > MVSEP_FREE_MAX_MB * 1024 * 1024:
        raise ProviderError(f"No plano grátis do MVSEP o arquivo pode ter até {MVSEP_FREE_MAX_MB} MB.")
    if info["remaining"] < needed:
        local = datetime.fromisoformat(info["resets_at"]).astimezone()
        raise ProviderError(
            f"Limite diário do MVSEP atingido ({info['used_today']}/{info['daily_limit']} separações hoje). "
            f"Libera de novo às {local:%H:%M}. Enquanto isso, use uma versão karaokê ou toque sem separação.")
