"""O que dá para comprar: passes por festa e planos mensais.

Preços em centavos. Limites (None = sem limite):
- songs: músicas novas preparadas no período (o que gasta separação de voz).
  Música que já está no repertório não conta.
- guests: celulares na mesma festa.
- screens: telões com festa aberta ao mesmo tempo na mesma conta.
- dance: modo dança liberado.
"""

PLANS = {
    "passe12": {
        "kind": "pass", "name": "Passe Festa 12h", "price": 1990, "hours": 12,
        "pitch": "Uma festa inteira, sem limite de músicas",
        "limits": {"songs": None, "guests": 30, "screens": 1, "dance": True},
    },
    "passe24": {
        "kind": "pass", "name": "Passe Festa 24h", "price": 2990, "hours": 24,
        "pitch": "Para a festa que vira o dia",
        "limits": {"songs": None, "guests": 30, "screens": 1, "dance": True},
    },
    "festeiro": {
        "kind": "monthly", "name": "Festeiro", "price": 3990,
        "pitch": "Para quem faz festa todo mês",
        "limits": {"songs": 60, "guests": 30, "screens": 1, "dance": False},
    },
    "animador": {
        "kind": "monthly", "name": "Animador", "price": 7990, "featured": True,
        "pitch": "O mais escolhido: tudo liberado",
        "limits": {"songs": 200, "guests": None, "screens": 1, "dance": True},
    },
    "casa": {
        "kind": "monthly", "name": "Casa / Bar", "price": 19990,
        "pitch": "Para bar, buffet e quem anima eventos",
        "limits": {"songs": 1000, "guests": None, "screens": 3, "dance": True},
    },
}

# Plano mensal: o acesso dura o mês pago e mais uns dias, para a renovação ter tempo de cair
MONTH = 31 * 24 * 3600
GRACE = 3 * 24 * 3600


def get(plan_id: str) -> dict:
    plan = PLANS.get(plan_id)
    if not plan:
        raise KeyError("Esse plano não existe.")
    return plan


def public() -> list[dict]:
    return [dict(p, id=pid) for pid, p in PLANS.items()]
