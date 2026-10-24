"""Configuração do app: provedor de separação, chaves de API e ajustes.

Fica salva em data/config.json. Variáveis de ambiente com o mesmo nome em
maiúsculas (ex.: MVSEP_API_TOKEN) servem de valor inicial.
"""
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SONGS_DIR = DATA_DIR / "songs"
CONFIG_FILE = DATA_DIR / "config.json"

DEFAULTS = {
    # Provedor de separação em uso: mvsep | musicai | replicate | local
    "provider": "mvsep",
    # Separar voz principal dos backing vocals em toda música (gasta mais uma
    # separação). Desligado: a separação de backing é feita só quando pedida.
    "split_backing": False,
    # MVSEP (https://mvsep.com/user-api)
    "mvsep_api_token": "",
    "mvsep_vocals_sep_type": 40,      # BS Roformer (vocals, instrumental)
    "mvsep_vocals_model": 171,        # 124 bands — o melhor da lista (SDR voz 12.33, instrumental 18.64)
    "mvsep_karaoke_sep_type": 49,     # MVSep Karaoke (lead/back vocals)
    "mvsep_karaoke_model": 8,         # BS Roformer 124 bands by MVSep Team — o melhor (SDR 10.77)
    # Music.AI (https://music.ai/dashboard) — workflow criado no painel deles
    "musicai_api_key": "",
    "musicai_workflow": "",
    # Replicate (https://replicate.com/account/api-tokens)
    "replicate_api_token": "",
    "replicate_model": "cottom/bs-roformer",
    "replicate_karaoke_model": "",
    # Local (CPU) — precisa do extra "local" instalado
    "local_model": "UVR-MDX-NET-Inst_HQ_3.onnx",
    "local_karaoke_model": "",
    # Quantos resultados mostrar na busca do YouTube
    "search_results": 5,
    # Atraso do som na caixa Bluetooth, em segundos (a letra espera por ele)
    "bt_delay": 0.0,
    # Nome de quem está no notebook, para a fila da festa
    "host_name": "Anfitrião",
    # Volume dos efeitos sonoros (0 a 1)
    "fx_volume": 0.7,
    "port": 8000,
    # Parâmetros da nota da dança calibrados na tela de análise (vazio = padrões do dance-score.js)
    "dance_params": {},
    # Porta HTTPS: o celular só libera a câmera em página segura (modo dança)
    "https_port": 8443,
}

SECRET_KEYS = {"mvsep_api_token", "musicai_api_key", "replicate_api_token"}

_lock = threading.Lock()
_config: dict = {}


def load() -> dict:
    global _config
    DATA_DIR.mkdir(exist_ok=True)
    SONGS_DIR.mkdir(exist_ok=True)
    cfg = dict(DEFAULTS)
    for key in DEFAULTS:
        env = os.environ.get(key.upper())
        if env:
            cfg[key] = type(DEFAULTS[key])(env) if not isinstance(DEFAULTS[key], bool) else env.lower() in ("1", "true", "sim")
    if CONFIG_FILE.exists():
        cfg.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
    _config = cfg
    return cfg


def get(key: str):
    return _config.get(key, DEFAULTS.get(key))


def update(values: dict) -> dict:
    with _lock:
        for key, value in values.items():
            if key not in DEFAULTS:
                continue
            # Campo de chave vazio vindo da tela significa "não mexer"
            if key in SECRET_KEYS and value in (None, ""):
                continue
            default = DEFAULTS[key]
            if isinstance(default, bool):
                value = bool(value)
            elif isinstance(default, int):
                value = int(value)
            elif isinstance(default, float):
                value = float(value)
            _config[key] = value
        CONFIG_FILE.write_text(json.dumps(_config, indent=2, ensure_ascii=False), encoding="utf-8")
    return public()


def public() -> dict:
    """Configuração sem as chaves secretas, para mandar ao navegador."""
    out = {k: v for k, v in _config.items() if k not in SECRET_KEYS}
    for key in SECRET_KEYS:
        out[key + "_set"] = bool(_config.get(key))
    return out
