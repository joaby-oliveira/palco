from .base import Cancelled, Provider, ProviderError
from .local import LocalProvider
from .musicai import MusicAiProvider
from .mvsep import MvsepProvider
from .none import NoneProvider
from .replicate import ReplicateProvider

PROVIDERS: dict[str, Provider] = {p.name: p for p in (MvsepProvider(), MusicAiProvider(), ReplicateProvider(), LocalProvider(), NoneProvider())}


def get(name: str) -> Provider:
    return PROVIDERS.get(name) or PROVIDERS["mvsep"]


def listing() -> list[dict]:
    return [{"name": p.name, "label": p.label, "problem": p.problem()} for p in PROVIDERS.values()]
