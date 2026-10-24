"""Separação no próprio notebook (CPU), sem internet e sem custo.

É lenta neste notebook (~10 min por música com o modelo MDX padrão) e
precisa do extra instalado:  uv pip install "audio-separator[cpu]" audioread
"""
import importlib.util

from .. import config
from .base import Provider, ProviderError, classify


class LocalProvider(Provider):
    name = "local"
    label = "Local (CPU, lento)"

    def problem(self):
        if importlib.util.find_spec("audio_separator") is None:
            return 'Separação local não instalada. Rode: uv pip install "audio-separator[cpu]" audioread'
        return None

    def _separate(self, src, out_dir, model, report, what):
        from audio_separator.separator import Separator

        report(f"{what} no notebook (pode levar ~10 min)...", 0.1)
        sep = Separator(output_dir=str(out_dir), output_format="MP3")
        sep.load_model(model_filename=model)
        files = sep.separate(str(src))
        return [(f, out_dir / f.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]) for f in files]

    def separate_vocals(self, src, out_dir, report):
        out = {}
        for name, path in self._separate(src, out_dir, config.get("local_model"), report, "Separando vocais"):
            kind = classify(name)
            if kind in ("instrumental", "vocals"):
                out[kind] = path
        if len(out) < 2:
            raise ProviderError("A separação local não gerou voz e instrumental.")
        return out

    def separate_karaoke(self, vocals, out_dir, report):
        model = config.get("local_karaoke_model")
        if not model:
            return None
        out = {}
        for name, path in self._separate(vocals, out_dir, model, report, "Separando backing vocals"):
            kind = classify(name)
            # Modelos de karaokê do UVR chamam a voz principal de "Vocals" e o resto de "Instrumental"
            kind = {"vocals": "lead", "instrumental": "backing"}.get(kind, kind)
            if kind in ("lead", "backing"):
                out[kind] = path
        return out if len(out) == 2 else None
