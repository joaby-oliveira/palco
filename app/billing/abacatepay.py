"""AbacatePay (API v2, https://docs.abacatepay.com). O broker principal.

Passe = checkout de pagamento único (PIX ou cartão); plano = checkout de
assinatura (só cartão). Os produtos são criados na loja na primeira compra,
com externalId "palco-<plano>", e os ids ficam em data/billing.json.

Webhook: cadastre https://SEU-DOMINIO/api/billing/webhook/abacatepay com o
mesmo segredo de ABACATEPAY_WEBHOOK_SECRET e os eventos checkout.completed,
checkout.refunded, subscription.completed, subscription.renewed e
subscription.cancelled.
"""
import base64
import hashlib
import hmac
import json
import os

import httpx

from . import state
from .base import Broker, Unauthorized

API = "https://api.abacatepay.com/v2"
# Chave pública com que a AbacatePay assina o corpo dos webhooks (X-Webhook-Signature)
SIGNATURE_KEY = (
    "t9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7"
    "RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hy"
    "zGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9"
)


class AbacatePay(Broker):
    name = "abacatepay"
    label = "AbacatePay"

    @property
    def key(self) -> str:
        return os.environ.get("ABACATEPAY_API_KEY", "")

    def configured(self) -> bool:
        return bool(self.key)

    def _mem(self) -> dict:
        # Dev mode e produção têm lojas (e produtos e clientes) diferentes
        return state.broker(f"abacatepay-{hashlib.sha256(self.key.encode()).hexdigest()[:8]}")

    def _call(self, method: str, path: str, **kwargs) -> dict:
        r = httpx.request(method, API + path, headers={"Authorization": f"Bearer {self.key}"}, timeout=30, **kwargs)
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400 or not body.get("success", False):
            raise RuntimeError(f"AbacatePay: {body.get('error') or r.text[:200] or r.status_code}")
        return body["data"]

    def _product(self, plan_id: str, plan: dict) -> str:
        with state.lock:
            products = self._mem().setdefault("products", {})
            # Preço mudou no plans.py: produto novo (os antigos ficam lá, sem uso)
            ext = f"palco-{plan_id}-{plan['price']}"
            if ext in products:
                return products[ext]
            found = next((p for p in self._call("GET", "/products/list") if p.get("externalId") == ext), None)
            if not found:
                body = {"externalId": ext, "name": f"Palco · {plan['name']}", "price": plan["price"], "currency": "BRL",
                        "description": plan["pitch"]}
                if plan["kind"] == "monthly":
                    body["cycle"] = "MONTHLY"
                found = self._call("POST", "/products/create", json=body)
            products[ext] = found["id"]
            state.save()
            return found["id"]

    def _customer(self, account: dict) -> str:
        mem = self._mem().setdefault("customers", {})
        if account["id"] in mem:
            return mem[account["id"]]
        body = {"email": account["email"], "name": account["name"], "metadata": {"palco_account": account["id"]}}
        if account.get("phone"):
            body["cellphone"] = account["phone"]
        if account.get("tax_id"):
            body["taxId"] = account["tax_id"]
        cid = self._call("POST", "/customers/create", json=body)["id"]
        with state.lock:
            mem[account["id"]] = cid
            state.save()
        return cid

    def checkout(self, order, plan, account, urls):
        body = {
            "items": [{"id": self._product(order["plan"], plan), "quantity": 1}],
            "customerId": self._customer(account),
            "externalId": order["id"],
            "completionUrl": urls["completion"],
            "returnUrl": urls["back"],
            "metadata": {"palco_order": order["id"], "palco_account": account["id"]},
        }
        if plan["kind"] == "monthly":
            body["methods"] = ["CARD"]
            data = self._call("POST", "/subscriptions/create", json=body)
        else:
            body["methods"] = ["PIX", "CARD"]
            data = self._call("POST", "/checkouts/create", json=body)
        return {"url": data["url"], "ref": data["id"]}

    def parse_webhook(self, headers, query, body):
        secret = os.environ.get("ABACATEPAY_WEBHOOK_SECRET", "")
        if not secret or not hmac.compare_digest(query.get("webhookSecret", "").encode(), secret.encode()):
            raise Unauthorized()
        signature = headers.get("x-webhook-signature")
        if signature:
            expected = base64.b64encode(hmac.new(SIGNATURE_KEY.encode(), body, hashlib.sha256).digest()).decode()
            if not hmac.compare_digest(expected.encode(), signature.encode()):
                raise Unauthorized()
        msg = json.loads(body)
        return [e for e in [self._event(msg)] if e]

    def _event(self, msg: dict) -> dict | None:
        kind, data = msg.get("event", ""), msg.get("data") or {}
        customer = data.get("customer") or {}
        base = {"id": f"abacatepay:{msg.get('id') or kind}", "customer_id": customer.get("id"), "email": customer.get("email")}
        if kind in ("checkout.completed", "checkout.refunded"):
            co = data.get("checkout") or {}
            if co.get("frequency") == "SUBSCRIPTION":
                return None  # a assinatura chega pelos eventos subscription.*
            return dict(base, type="paid" if kind == "checkout.completed" else "refunded", order=co.get("externalId"))
        if kind.startswith("subscription."):
            sub = data.get("subscription") or {}
            types = {"subscription.completed": "sub_active", "subscription.renewed": "sub_renewed",
                     "subscription.cancelled": "sub_cancelled"}
            if kind not in types:
                return None
            payment = data.get("payment") or {}
            return dict(base, type=types[kind], sub_id=sub.get("id"), order=payment.get("externalId") or sub.get("externalId"))
        return None

    def check(self, order):
        if order["kind"] == "monthly":
            try:
                sub = self._call("GET", "/subscriptions/get", params={"externalId": order["id"]})
            except RuntimeError:
                return []
            if sub.get("status") == "ACTIVE":
                return [{"id": f"abacatepay:check:{sub['id']}:active", "type": "sub_active", "order": order["id"],
                         "sub_id": sub["id"], "customer_id": sub.get("customerId")}]
            return []
        co = self._call("GET", "/checkouts/get", params={"id": order["ref"]})
        if co.get("status") == "PAID":
            return [{"id": f"abacatepay:check:{co['id']}:paid", "type": "paid", "order": order["id"]}]
        if co.get("status") == "REFUNDED":
            return [{"id": f"abacatepay:check:{co['id']}:refunded", "type": "refunded", "order": order["id"]}]
        return []

    def cancel(self, sub_id):
        self._call("POST", "/subscriptions/cancel", json={"id": sub_id})

    def portal(self, account, order):
        cid = self._mem().get("customers", {}).get(account["id"])
        if not cid or not order.get("ref"):
            return None
        try:
            return self._call("POST", "/customer-portal/create", json={"customerId": cid, "checkoutId": order["ref"]})["url"]
        except RuntimeError:
            return None
