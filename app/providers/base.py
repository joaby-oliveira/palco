"""Interface comum dos provedores de separação.

Para adicionar um provedor novo: crie um arquivo nesta pasta com uma classe
que herda de Provider, implemente separate_vocals (e separate_karaoke, se o
serviço souber separar voz principal de backing) e registre em __init__.py.
"""
import re
import shutil
from pathlib import Path
from typing import Callable

import httpx

# report(mensagem, fração 0..1 dentro da etapa atual)
Report = Callable[[str, float], None]


class Cancelled(Exception):
    pass


class ProviderError(Exception):
    pass


class Provider:
    name = ""
    label = ""

    def problem(self) -> str | None:
        """Retorna o motivo de o provedor não estar pronto (ex.: falta chave)."""
        return None

    def separate_vocals(self, src: Path, out_dir: Path, report: Report) -> dict[str, Path]:
        """Separa src em {'instrumental': Path, 'vocals': Path}."""
        raise NotImplementedError

    def separate_karaoke(self, vocals: Path, out_dir: Path, report: Report) -> dict[str, Path] | None:
        """Separa a faixa de voz em {'lead': Path, 'backing': Path}.

        Retorna None se o provedor não tiver essa opção configurada.
        """
        return None


def classify(name: str) -> str | None:
    """Descobre que faixa é um arquivo pelo nome ou rótulo que o serviço deu."""
    n = name.lower()
    if re.search(r"back", n) and re.search(r"instrum", n):
        return None  # ex.: "back-instrum" (backing + instrumental) do MVSEP
    if re.search(r"back|bv|harmon|choir", n):
        return "backing"
    if re.search(r"lead|main|principal", n):
        return "lead"
    if re.search(r"instrum|accomp|no.?vocal|karaoke|other|music", n):
        return "instrumental"
    if re.search(r"vocal|voice|voz", n):
        return "vocals"
    return None


def download(url: str, dest: Path, headers: dict | None = None) -> Path:
    tmp = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=300) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 16):
                f.write(chunk)
    shutil.move(tmp, dest)
    return dest


def ext_from_url(url: str, default: str = ".mp3") -> str:
    m = re.search(r"\.(mp3|wav|flac|m4a|ogg)(?:\?|$)", url.lower())
    return "." + m.group(1) if m else default
