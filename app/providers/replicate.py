"""Replicate — https://replicate.com

Usa um modelo de separação hospedado (padrão: cottom/bs-roformer no modo
"vocals"). Para separar principal e backing, coloque nas configurações um
segundo modelo de karaokê; sem ele, a voz original fica numa faixa só.
"""
import time
from pathlib import Path

import httpx

from .. import config
from .base import Provider, ProviderError, classify, download, ext_from_url

API = "https://api.replicate.com/v1"


class ReplicateProvider(Provider):
    name = "replicate"
    label = "Replicate"

    def problem(self):
        if not config.get("replicate_api_token"):
            return "Falta o token da API do Replicate."
        return None

    def _headers(self):
        return {"Authorization": "Bearer " + config.get("replicate_api_token")}

    def _upload(self, src: Path) -> str:
        with open(src, "rb") as f:
            r = httpx.post(f"{API}/files", headers=self._headers(), files={"content": (src.name, f, "audio/mpeg")}, timeout=600)
        return _json(r)["urls"]["get"]

    def _predict(self, model: str, inputs: dict, report, what: str) -> list[str]:
        h = self._headers()
        if ":" in model:
            version = model.split(":", 1)[1]
        else:
            info = _json(httpx.get(f"{API}/models/{model}", headers=h, timeout=60))
            version = (info.get("latest_version") or {}).get("id")
            if not version:
                raise ProviderError(f"Modelo {model} não encontrado no Replicate.")
        pred = _json(httpx.post(f"{API}/predictions", headers=h, json={"version": version, "input": inputs}, timeout=60))
        start = time.time()
        while pred.get("status") not in ("succeeded", "failed", "canceled"):
            time.sleep(3)
            label = "Ligando a GPU do Replicate..." if pred.get("status") == "starting" else f"{what} no Replicate..."
            report(label, min(0.95, 0.1 + (time.time() - start) / 90))
            pred = _json(httpx.get(pred["urls"]["get"], headers=h, timeout=60))
        if pred["status"] != "succeeded":
            raise ProviderError("Replicate falhou: " + str(pred.get("error") or pred["status"]))
        output = pred.get("output")
        if isinstance(output, str):
            return [output]
        if isinstance(output, dict):
            return [v for v in output.values() if isinstance(v, str)]
        return [v for v in (output or []) if isinstance(v, str)]

    def separate_vocals(self, src, out_dir, report):
        report("Enviando para o Replicate...", 0.0)
        url = self._upload(src)
        urls = self._predict(config.get("replicate_model"), {"audio": url, "mode": "vocals", "output_format": "mp3"}, report, "Separando vocais")
        out = {}
        for u in urls:
            kind = classify(u.rsplit("/", 1)[-1])
            if kind in ("instrumental", "vocals") and kind not in out:
                out[kind] = download(u, out_dir / f"rep_{kind}{ext_from_url(u)}")
        if len(out) < 2:
            raise ProviderError("Não achei voz e instrumental na resposta do Replicate: " + ", ".join(urls))
        return out

    def separate_karaoke(self, vocals, out_dir, report):
        model = config.get("replicate_karaoke_model")
        if not model:
            return None
        url = self._upload(vocals)
        urls = self._predict(model, {"audio": url}, report, "Separando backing vocals")
        out = {}
        for u in urls:
            kind = classify(u.rsplit("/", 1)[-1])
            if kind == "vocals":
                kind = "lead"
            if kind in ("lead", "backing") and kind not in out:
                out[kind] = download(u, out_dir / f"rep_{kind}{ext_from_url(u)}")
        return out if len(out) == 2 else None


def _json(r: httpx.Response) -> dict:
    if r.status_code >= 400:
        raise ProviderError(f"Replicate respondeu {r.status_code}: {r.text[:200]}")
    return r.json()
