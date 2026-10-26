"""Asaas (https://docs.asaas.com). Broker alternativo.

Passe = cobrança avulsa; plano = assinatura mensal. As duas com billingType
UNDEFINED: o cliente escolhe PIX, boleto ou cartão na fatura do Asaas.
O Asaas exige CPF/CNPJ do cliente.

Webhook: em Integrações › Webhooks, aponte para
https://SEU-DOMINIO/api/billing/webhook/asaas com o token de autenticação
igual a ASAAS_WEBHOOK_TOKEN (eventos de cobrança e de assinatura).
ASAAS_SANDBOX=1 usa o ambiente de testes.
"""
import datetime as dt
import hmac
import json
import os

import httpx

from . import state
from .base import Broker, Unauthorized

PAID = {"RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"}


class Asaas(Broker):
    name = "asaas"
    label = "Asaas"

    @property
    def key(self) -> str:
        return os.environ.get("ASAAS_API_KEY", "")

    @property
    def api(self) -> str:
        sandbox = os.environ.get("ASAAS_SANDBOX", "").lower() in ("1", "true", "sim")
        return "https://api-sandbox.asaas.com/v3" if sandbox else "https://api.asaas.com/v3"

    def configured(self) -> bool:
        return bool(self.key)

    def _call(self, method: str, path: str, **kwargs) -> dict:
        r = httpx.request(method, self.api + path, headers={"access_token": self.key, "User-Agent": "Palco"},
                          timeout=30, **kwargs)
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400:
            errors = "; ".join(e.get("description", "") for e in body.get("errors", [])) or r.text[:200]
            raise RuntimeError(f"Asaas: {errors}")
        return body

    def _customer(self, account: dict) -> str:
        mem = state.broker(self.name).setdefault("customers", {})
        if account["id"] in mem:
            return mem[account["id"]]
        if not account.get("tax_id"):
            raise ValueError("Para pagar pelo Asaas, informe o CPF (ou CNPJ) na sua conta.")
        body = {"name": account["name"], "email": account["email"], "cpfCnpj": account["tax_id"],
                "externalReference": account["id"], "notificationDisabled": True}
        if account.get("phone"):
            body["mobilePhone"] = account["phone"]
        cid = self._call("POST", "/customers", json=body)["id"]
        with state.lock:
            mem[account["id"]] = cid
            state.save()
        return cid

    def checkout(self, order, plan, account, urls):
        today = dt.date.today()
        body = {
            "customer": self._customer(account),
            "billingType": "UNDEFINED",
            "value": plan["price"] / 100,
            "description": f"Palco · {plan['name']}",
            "externalReference": order["id"],
            "callback": {"successUrl": urls["completion"], "autoRedirect": True},
        }
        if plan["kind"] == "monthly":
            sub = self._call("POST", "/subscriptions", json=dict(body, cycle="MONTHLY", nextDueDate=today.isoformat()))
            first = self._call("GET", f"/subscriptions/{sub['id']}/payments")["data"][0]
            return {"url": first["invoiceUrl"], "ref": first["id"], "sub_id": sub["id"]}
        pay = self._call("POST", "/payments", json=dict(body, dueDate=(today + dt.timedelta(days=1)).isoformat()))
        return {"url": pay["invoiceUrl"], "ref": pay["id"]}

    def parse_webhook(self, headers, query, body):
        token = os.environ.get("ASAAS_WEBHOOK_TOKEN", "")
        if not token or not hmac.compare_digest(headers.get("asaas-access-token", "").encode(), token.encode()):
            raise Unauthorized()
        msg = json.loads(body)
        kind = msg.get("event", "")
        eid = f"asaas:{msg.get('id') or kind}"
        payment = msg.get("payment") or {}
        if kind in ("PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"):
            if payment.get("subscription"):
                return [{"id": eid, "type": "sub_renewed", "sub_id": payment["subscription"],
                         "order": payment.get("externalReference")}]
            return [{"id": eid, "type": "paid", "order": payment.get("externalReference")}]
        if kind == "PAYMENT_REFUNDED" and not payment.get("subscription"):
            return [{"id": eid, "type": "refunded", "order": payment.get("externalReference")}]
        if kind in ("SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED"):
            sub = msg.get("subscription") or {}
            return [{"id": eid, "type": "sub_cancelled", "sub_id": sub.get("id"), "order": sub.get("externalReference")}]
        return []

    def check(self, order):
        if order["kind"] == "monthly":
            pays = self._call("GET", f"/subscriptions/{order['sub_id']}/payments")["data"]
            if any(p.get("status") in PAID for p in pays):
                return [{"id": f"asaas:check:{order['sub_id']}:active", "type": "sub_active", "order": order["id"],
                         "sub_id": order["sub_id"]}]
            return []
        pay = self._call("GET", f"/payments/{order['ref']}")
        if pay.get("status") in PAID:
            return [{"id": f"asaas:check:{pay['id']}:paid", "type": "paid", "order": order["id"]}]
        return []

    def cancel(self, sub_id):
        self._call("DELETE", f"/subscriptions/{sub_id}")
