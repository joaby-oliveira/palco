"""Estado da cobrança em data/billing.json: pedidos, eventos já aplicados e
o que cada broker precisa lembrar (ids dos produtos criados lá)."""
import json
import threading

from .. import config

lock = threading.RLock()
data: dict = {"orders": {}, "events": [], "brokers": {}}


def _file():
    return config.DATA_DIR / "billing.json"


def load():
    global data
    if _file().exists():
        data = {"orders": {}, "events": [], "brokers": {}, **json.loads(_file().read_text(encoding="utf-8"))}


def save():
    with lock:
        # Só os últimos eventos importam para pegar reenvio
        data["events"] = data["events"][-2000:]
        tmp = _file().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_file())


def broker(name: str) -> dict:
    return data["brokers"].setdefault(name, {})
