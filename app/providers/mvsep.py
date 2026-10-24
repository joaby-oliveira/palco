"""MVSEP — https://mvsep.com (documentação: https://mvsep.com/en/full_api).

Duas etapas:
1. BS Roformer (sep_type 40) separa voz e instrumental.
2. MVSep Karaoke (sep_type 49) separa a voz em principal e backing.
No plano grátis o MVSEP aceita só um trabalho na fila por vez, então as
etapas rodam uma depois da outra.
"""
import time
from pathlib import Path

import httpx

from .. import config
from .base import Provider, ProviderError, Report, classify, download, ext_from_url

API = "https://mvsep.com/api"

# Modelos em ordem de qualidade (do melhor para o pior), pela tabela do MVSEP.
# Alguns são só para contas premium; nesse caso o app passa para o próximo.
VOCAL_MODELS = [171, 172, 81, 29, 5, 142, 4, 3]   # sep_type 40, BS Roformer
KARAOKE_MODELS = [8, 6, 7, 5, 3, 2, 1, 0]         # sep_type 49, MVSep Karaoke


class PremiumOnly(ProviderError):
    pass


class MvsepProvider(Provider):
    name = "mvsep"
    label = "MVSEP"

    def problem(self):
        if not config.get("mvsep_api_token"):
            return "Falta o token da API do MVSEP (pegue em mvsep.com/user-api)."
        return None

    def __init__(self):
        self._premium_only: set[tuple[int, int]] = set()

    def _run_best(self, src, sep_type, preferred, ranking, out_dir, prefix, report):
        """Tenta o modelo preferido e desce na lista se o MVSEP pedir conta premium."""
        order = ranking[ranking.index(preferred):] if preferred in ranking else [preferred] + ranking
        for model in order:
            if (sep_type, model) in self._premium_only:
                continue
            try:
                return self._run(src, sep_type, model, out_dir, prefix, report)
            except PremiumOnly:
                self._premium_only.add((sep_type, model))
        raise ProviderError("Nenhum modelo do MVSEP disponível para esta conta.")

    def _run(self, src: Path, sep_type: int, model: int, out_dir: Path, prefix: str, report: Report) -> list[tuple[str, Path]]:
        token = config.get("mvsep_api_token")
        report("Enviando para o MVSEP...", 0.0)
        with open(src, "rb") as f:
            r = httpx.post(
                f"{API}/separation/create",
                data={"api_token": token, "sep_type": sep_type, "add_opt1": model, "output_format": 0},
                files={"audiofile": (src.name, f, "audio/mpeg")},
                timeout=600,
            )
        body = _json(r)
        if not body.get("success"):
            msg = str((body.get("data") or {}).get("message") or "; ".join(body.get("errors") or []) or body)
            if "premium" in msg.lower():
                raise PremiumOnly(msg)
            raise ProviderError("MVSEP recusou o envio: " + msg)
        job = body["data"]["hash"]

        start = time.time()
        while True:
            time.sleep(4)
            body = _json(httpx.get(f"{API}/separation/get", params={"hash": job}, timeout=60))
            status = body.get("status")
            data = body.get("data") or {}
            if status == "done":
                break
            if status in ("failed", "not_found"):
                raise ProviderError("MVSEP falhou: " + str(data.get("message") or status))
            if status in ("waiting", "distributing") and data.get("current_order") is not None:
                report(f"Na fila do MVSEP (posição {data.get('current_order')})...", 0.1)
            else:
                # O MVSEP não informa o progresso; estima pelo tempo (~1,5 min por etapa)
                report("Separando no MVSEP...", min(0.95, 0.15 + (time.time() - start) / 120))

        files = data.get("files") or []
        results = []
        for i, item in enumerate(files):
            if isinstance(item, str):
                url, label = item, item
            else:
                url = item.get("url") or item.get("download") or item.get("link")
                label = " ".join(str(item.get(k, "")) for k in ("type", "name", "download", "url"))
            if not url:
                continue
            dest = out_dir / f"{prefix}_{i}{ext_from_url(url)}"
            report("Baixando resultado do MVSEP...", 0.97)
            download(url, dest)
            results.append((label, dest))
        if not results:
            raise ProviderError("MVSEP terminou mas não devolveu arquivos.")
        return results

    def separate_vocals(self, src, out_dir, report):
        files = self._run_best(src, config.get("mvsep_vocals_sep_type"), config.get("mvsep_vocals_model"), VOCAL_MODELS, out_dir, "mv1", report)
        out = {}
        for label, path in files:
            kind = classify(label)
            if kind in ("instrumental", "vocals") and kind not in out:
                out[kind] = path
        if "instrumental" not in out or "vocals" not in out:
            raise ProviderError("Não achei voz e instrumental na resposta do MVSEP: " + ", ".join(l for l, _ in files))
        return out

    def separate_karaoke(self, vocals, out_dir, report):
        files = self._run_best(vocals, config.get("mvsep_karaoke_sep_type"), config.get("mvsep_karaoke_model"), KARAOKE_MODELS, out_dir, "mv2", report)
        out = {}
        for label, path in files:
            kind = classify(label)
            if kind == "vocals":
                kind = "lead"
            if kind in ("lead", "backing") and kind not in out:
                out[kind] = path
        if "lead" not in out or "backing" not in out:
            raise ProviderError("Não achei voz principal e backing na resposta do MVSEP: " + ", ".join(l for l, _ in files))
        return out


def _json(r: httpx.Response) -> dict:
    try:
        return r.json()
    except ValueError:
        raise ProviderError(f"MVSEP respondeu {r.status_code}: {r.text[:200]}")
