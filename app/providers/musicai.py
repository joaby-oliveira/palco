"""Music.AI (Moises) — https://music.ai/docs/api/reference/

O Music.AI trabalha com "workflows" montados no painel deles. Crie um
workflow com os módulos de separação que quiser (voz + acompanhamento, e
opcionalmente voz principal + backing) e coloque o slug dele nas
configurações. As saídas são reconhecidas pelo nome (vocals, accompaniment,
lead, back...).
"""
import time

import httpx

from .. import config
from .base import Provider, ProviderError, classify, download, ext_from_url

API = "https://api.music.ai/v1"


class MusicAiProvider(Provider):
    name = "musicai"
    label = "Music.AI"

    def __init__(self):
        self._karaoke_cache: dict[str, dict] = {}

    def problem(self):
        if not config.get("musicai_api_key"):
            return "Falta a chave da API do Music.AI."
        if not config.get("musicai_workflow"):
            return "Falta o slug do workflow do Music.AI (crie um no painel deles)."
        return None

    def _headers(self):
        return {"Authorization": config.get("musicai_api_key")}

    def separate_vocals(self, src, out_dir, report):
        h = self._headers()
        report("Enviando para o Music.AI...", 0.0)
        up = _json(httpx.get(f"{API}/upload", headers=h, timeout=60))
        with open(src, "rb") as f:
            httpx.put(up["uploadUrl"], content=f.read(), headers={"Content-Type": "audio/mpeg"}, timeout=600).raise_for_status()
        job = _json(httpx.post(
            f"{API}/job", headers=h, timeout=60,
            json={"name": src.stem, "workflow": config.get("musicai_workflow"), "params": {"inputUrl": up["downloadUrl"]}},
        ))["id"]

        start = time.time()
        while True:
            time.sleep(4)
            info = _json(httpx.get(f"{API}/job/{job}", headers=h, timeout=60))
            status = info.get("status")
            if status == "SUCCEEDED":
                break
            if status == "FAILED":
                err = info.get("error") or {}
                raise ProviderError("Music.AI falhou: " + str(err.get("message") or err))
            label = "Na fila do Music.AI..." if status == "QUEUED" else "Separando no Music.AI..."
            report(label, min(0.95, 0.1 + (time.time() - start) / 90))

        out = {}
        for key, url in (info.get("result") or {}).items():
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            kind = classify(key)
            if kind and kind not in out:
                report("Baixando resultado do Music.AI...", 0.97)
                out[kind] = download(url, out_dir / f"mai_{kind}{ext_from_url(url, '.wav')}")
        if "instrumental" not in out:
            raise ProviderError("O workflow do Music.AI não devolveu o acompanhamento. Saídas: " + ", ".join((info.get("result") or {}).keys()))
        if "vocals" not in out:
            if "lead" in out:
                out["vocals"] = out["lead"]
            else:
                raise ProviderError("O workflow do Music.AI não devolveu a voz.")
        # Se o workflow já separa principal e backing, a segunda etapa usa isso
        if "lead" in out and "backing" in out:
            self._karaoke_cache[str(out["vocals"])] = {"lead": out["lead"], "backing": out["backing"]}
        return out

    def separate_karaoke(self, vocals, out_dir, report):
        return self._karaoke_cache.pop(str(vocals), None)


def _json(r: httpx.Response) -> dict:
    if r.status_code >= 400:
        raise ProviderError(f"Music.AI respondeu {r.status_code}: {r.text[:200]}")
    return r.json()
