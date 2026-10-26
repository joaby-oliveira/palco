"""Cobrança: pedidos, eventos dos brokers e o acesso de cada conta.

Liga com BILLING=1 (no servidor). Desligada, ou no próprio notebook, o Palco
fica liberado como sempre. O broker principal vem de BILLING_PROVIDER
(abacatepay, se não disser nada); os outros configurados aparecem como
alternativa na hora de pagar.

Passe comprado vira crédito: as 12 ou 24 horas só começam a contar quando o
anfitrião aperta para começar a festa. Plano mensal vale do pagamento até o
fim do mês pago (mais uns dias de folga para a renovação).
"""
import os
import time
import uuid

from .. import accounts, plans
from . import state
from .abacatepay import AbacatePay
from .asaas import Asaas
from .base import Unauthorized  # noqa: F401  (main usa)
from .mercadopago import MercadoPago

BROKERS = {b.name: b for b in (AbacatePay(), Asaas(), MercadoPago())}


def enabled() -> bool:
    return os.environ.get("BILLING", "").lower() in ("1", "true", "sim")


def available() -> list:
    """Brokers configurados, o principal primeiro."""
    primary = os.environ.get("BILLING_PROVIDER", "abacatepay")
    ordered = sorted(BROKERS.values(), key=lambda b: b.name != primary)
    return [b for b in ordered if b.configured()]


def load():
    state.load()


# ---------- Acesso ----------

def access(acc: dict | None) -> dict:
    """O que a conta pode fazer agora: plano em uso, até quando e quanto sobra."""
    if not acc:
        return {"active": False}
    now = time.time()
    unused = [p for p in acc["passes"] if not p.get("start")]
    current = next((p for p in acc["passes"] if p.get("start") and p["until"] > now), None)
    sub = acc.get("subscription")
    out = {"active": False, "unused_passes": [{"order": p["order"], "plan": p["plan"], "hours": p["hours"]} for p in unused],
           "subscription": None}
    if sub:
        out["subscription"] = {"plan": sub["plan"], "name": plans.get(sub["plan"])["name"], "status": sub["status"],
                               "until": sub["period_end"], "provider": sub["provider"]}
    # Passe em uso vale mais que o mensal (não tem limite de músicas)
    if current:
        plan_id, since, until, source = current["plan"], current["start"], current["until"], "pass"
    elif sub and sub["period_end"] > now:
        plan_id, since, until, source = sub["plan"], sub["period_start"], sub["period_end"], "monthly"
    else:
        return out
    plan = plans.get(plan_id)
    used = sum(1 for t in acc["songs"] if t >= since)
    limit = plan["limits"]["songs"]
    out.update(active=True, plan=plan_id, name=plan["name"], source=source, until=until, limits=plan["limits"],
               songs_used=used, songs_left=None if limit is None else max(0, limit - used))
    return out


def record_song(acc: dict):
    with state.lock:
        cutoff = time.time() - 40 * 24 * 3600
        acc["songs"] = [t for t in acc["songs"] if t > cutoff] + [time.time()]
        accounts.save()


def start_pass(acc: dict) -> dict:
    """Começa a contar o passe mais antigo que ainda não foi usado."""
    with state.lock:
        p = next((p for p in acc["passes"] if not p.get("start")), None)
        if not p:
            raise ValueError("Você não tem passe para usar. Compre um em Minha conta.")
        p["start"] = time.time()
        p["until"] = p["start"] + p["hours"] * 3600
        accounts.save()
    return p


# ---------- Pedidos ----------

def checkout(acc: dict, plan_id: str, broker_name: str | None, base_url: str) -> dict:
    plan = plans.get(plan_id)
    brokers = available()
    if not brokers:
        raise ValueError("Nenhuma forma de pagamento configurada no servidor.")
    broker = next((b for b in brokers if b.name == broker_name), brokers[0])
    order = {"id": "pal_" + uuid.uuid4().hex[:16], "account": acc["id"], "plan": plan_id, "kind": plan["kind"],
             "price": plan["price"], "provider": broker.name, "status": "pending", "created": time.time(),
             "ref": None, "sub_id": None}
    urls = {"completion": f"{base_url}/conta?pedido={order['id']}", "back": f"{base_url}/conta",
            "webhook": f"{base_url}/api/billing/webhook/{broker.name}"}
    result = broker.checkout(order, plan, acc, urls)
    order.update(ref=result.get("ref"), sub_id=result.get("sub_id"), url=result["url"])
    with state.lock:
        state.data["orders"][order["id"]] = order
        state.save()
    return order


def orders_of(acc: dict) -> list[dict]:
    mine = [o for o in state.data["orders"].values() if o["account"] == acc["id"]]
    return sorted(mine, key=lambda o: -o["created"])


def order(order_id: str) -> dict | None:
    return state.data["orders"].get(order_id)


def sync(o: dict) -> dict:
    """Pedido ainda pendente: pergunta ao broker (o webhook pode demorar ou nem chegar, em teste)."""
    if o["status"] == "pending" and o["provider"] in BROKERS:
        try:
            for event in BROKERS[o["provider"]].check(o):
                apply(event, o["provider"])
        except Exception as e:  # noqa: BLE001
            print(f"  Cobrança: não consegui conferir o pedido {o['id']}: {e}")
    return o


def cancel_subscription(acc: dict):
    sub = acc.get("subscription")
    if not sub or sub["status"] != "active":
        raise ValueError("Você não tem assinatura ativa.")
    BROKERS[sub["provider"]].cancel(sub["sub_id"])
    with state.lock:
        sub["status"] = "cancelled"
        accounts.save()


def portal(acc: dict) -> str | None:
    sub = acc.get("subscription")
    o = order(sub["order"]) if sub else None
    return BROKERS[o["provider"]].portal(acc, o) if o else None


# ---------- Eventos ----------

def _order_for(event: dict) -> dict | None:
    if event.get("order") and event["order"] in state.data["orders"]:
        return state.data["orders"][event["order"]]
    if event.get("sub_id"):
        return next((o for o in state.data["orders"].values() if o.get("sub_id") == event["sub_id"]), None)
    return None


def apply(event: dict, provider: str) -> bool:
    """Aplica um evento de pagamento. Devolve False se já tinha sido aplicado ou não é nosso."""
    with state.lock:
        if event["id"] in state.data["events"]:
            return False
        o = _order_for(event)
        acc = accounts.get(o["account"]) if o else None
        # Assinatura renovada antes de sabermos o id dela: acha pela conta da assinatura
        if not acc and event.get("sub_id"):
            acc = accounts.find(lambda a: (a.get("subscription") or {}).get("sub_id") == event["sub_id"])
        if not acc:
            print(f"  Cobrança: evento {event['id']} ({event['type']}) sem pedido conhecido")
            return False
        state.data["events"].append(event["id"])
        _apply(event, provider, o, acc)
        state.save()
        accounts.save()
    return True


def _apply(event: dict, provider: str, o: dict | None, acc: dict):
    now = time.time()
    kind = event["type"]
    if kind == "paid" and o and o["kind"] == "pass":
        o["status"] = "paid"
        o["paid"] = now
        if not any(p["order"] == o["id"] for p in acc["passes"]):
            acc["passes"].append({"order": o["id"], "plan": o["plan"], "hours": plans.get(o["plan"])["hours"],
                                  "bought": now, "start": None, "until": None})
    elif kind == "refunded" and o:
        o["status"] = "refunded"
        for p in acc["passes"]:
            if p["order"] == o["id"]:
                # Estornado: passe some (ou acaba agora, se já estava em uso)
                p["start"] = p.get("start") or now
                p["until"] = min(p.get("until") or now, now)
    elif kind in ("sub_active", "sub_renewed"):
        sub = acc.get("subscription")
        sub_id = event.get("sub_id") or (o or {}).get("sub_id")
        same = sub and sub.get("sub_id") == sub_id
        if o:
            o["status"] = "paid"
            o["sub_id"] = o.get("sub_id") or sub_id
        if kind == "sub_active" and same and sub["status"] == "active":
            return  # já ativa (o webhook e a consulta contam a mesma ativação)
        if sub and not same and sub["status"] == "active" and sub["provider"] in BROKERS:
            # Trocou de plano: a assinatura antiga para de cobrar
            try:
                BROKERS[sub["provider"]].cancel(sub["sub_id"])
            except Exception as e:  # noqa: BLE001
                print(f"  Cobrança: não consegui cancelar a assinatura antiga {sub['sub_id']}: {e}")
        plan_id = o["plan"] if o else sub["plan"]
        acc["subscription"] = {"plan": plan_id, "provider": provider, "sub_id": sub_id,
                               "order": o["id"] if o else sub["order"], "status": "active",
                               "period_start": now, "period_end": now + plans.MONTH + plans.GRACE}
    elif kind == "sub_cancelled":
        sub = acc.get("subscription")
        if sub and sub.get("sub_id") == event.get("sub_id"):
            # Continua valendo até o fim do mês que já foi pago
            sub["status"] = "cancelled"
