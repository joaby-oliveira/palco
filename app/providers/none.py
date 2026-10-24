"""Sem separação: a música toca inteira, com a letra. Útil sem nenhum serviço configurado."""
from .base import Provider


class NoneProvider(Provider):
    name = "none"
    label = "Nenhuma (música inteira)"
