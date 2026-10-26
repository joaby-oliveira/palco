"""Mercado Pago (https://www.mercadopago.com.br/developers). Broker alternativo.

Passe = Checkout Pro (preferência); plano = assinatura sem plano associado
(preapproval). O webhook só avisa que algo mudou: o status de verdade é
sempre buscado na API, então um aviso forjado não libera nada.

Webhook: em Suas integrações › Webhooks, aponte para
https://SEU-DOMINIO/api/billing/webhook/mercadopago com os eventos Pagamentos
e Planos e assinaturas. A assinatura secreta vai em MERCADOPAGO_WEBHOOK_SECRET.
"""
import hashlib
import hmac
import json
import os

import httpx

from .base import Broker, Unauthorized

API = "https://api.mercadopago.com"


class MercadoPago(Broker):
    name = "mercadopago"
    label = "Mercado Pago"

    @property
    def token(self) -> str:
        return os.environ.get("MERCADOPAGO_ACCESS_TOKEN", "")

    def configured(self) -> bool:
        return bool(self.token)

    def _call(self, method: str, path: str, **kwargs) -> dict:
        r = httpx.request(method, API + path, headers={"Authorization": f"Bearer {self.token}"}, timeout=30, **kwargs)
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400:
            raise RuntimeError(f"Mercado Pago: {body.get('message') or r.text[:200]}")
        return body

    def checkout(self, order, plan, account, urls):
        if plan["kind"] == "monthly":
            sub = self._call("POST", "/preapproval", json={
                "reason": f"Palco · {plan['name']}",
                "external_reference": order["id"],
                "payer_email": account["email"],
                "auto_recurring": {"frequency": 1, "frequency_type": "months",
                                   "transaction_amount": plan["price"] / 100, "currency_id": "BRL"},
                "back_url": urls["completion"],
                "status": "pending",
            })
            return {"url": sub["init_point"], "ref": sub["id"], "sub_id": sub["id"]}
        pref = self._call("POST", "/checkout/preferences", json={
            "items": [{"id": order["plan"], "title": f"Palco · {plan['name']}", "quantity": 1,
                       "unit_price": plan["price"] / 100, "currency_id": "BRL"}],
            "external_reference": order["id"],
            "payer": {"email": account["email"], "name": account["name"]},
            "back_urls": {"success": urls["completion"], "pending": urls["completion"], "failure": urls["back"]},
            "auto_return": "approved",
            "notification_url": urls["webhook"],
        })
        return {"url": pref["init_point"], "ref": pref["id"]}

    def _verify(self, headers, query, data_id: str):
        secret = os.environ.get("MERCADOPAGO_WEBHOOK_SECRET", "")
        if not secret:
            return  # sem segredo, vale a consulta à API (abaixo), que é a fonte da verdade
        parts = dict(p.strip().split("=", 1) for p in headers.get("x-signature", "").split(",") if "=" in p)
        manifest = f"id:{data_id.lower()};request-id:{headers.get('x-request-id', '')};ts:{parts.get('ts', '')};"
        expected = hmac.new(secret.encode(), manifest.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, parts.get("v1", "")):
            raise Unauthorized()

    def parse_webhook(self, headers, query, body):
        msg = json.loads(body or b"{}") if body else {}
        kind = msg.get("type") or query.get("type") or query.get("topic") or ""
        data_id = str((msg.get("data") or {}).get("id") or query.get("data.id") or query.get("id") or "")
        if not data_id:
            return []
        self._verify(headers, query, data_id)
        if kind == "payment":
            return self._payment_events(self._call("GET", f"/v1/payments/{data_id}"))
        if kind == "subscription_preapproval":
            return self._preapproval_events(self._call("GET", f"/preapproval/{data_id}"))
        if kind == "subscription_authorized_payment":
            ap = self._call("GET", f"/authorized_payments/{data_id}")
            if (ap.get("payment") or {}).get("status") == "approved":
                return [{"id": f"mercadopago:ap:{data_id}", "type": "sub_renewed", "sub_id": ap.get("preapproval_id"),
                         "order": ap.get("external_reference")}]
        return []

    def _payment_events(self, pay: dict) -> list[dict]:
        # Pagamento de assinatura chega também como subscription_authorized_payment
        if (pay.get("metadata") or {}).get("preapproval_id") or pay.get("operation_type") == "recurring_payment":
            return []
        types = {"approved": "paid", "refunded": "refunded", "charged_back": "refunded"}
        if pay.get("status") not in types:
            return []
        return [{"id": f"mercadopago:pay:{pay['id']}:{pay['status']}", "type": types[pay["status"]],
                 "order": pay.get("external_reference"), "email": (pay.get("payer") or {}).get("email")}]

    def _preapproval_events(self, sub: dict) -> list[dict]:
        types = {"authorized": "sub_active", "cancelled": "sub_cancelled"}
        if sub.get("status") not in types:
            return []
        return [{"id": f"mercadopago:sub:{sub['id']}:{sub['status']}", "type": types[sub["status"]],
                 "sub_id": sub["id"], "order": sub.get("external_reference")}]

    def check(self, order):
        if order["kind"] == "monthly":
            return self._preapproval_events(self._call("GET", f"/preapproval/{order['sub_id']}"))
        found = self._call("GET", "/v1/payments/search", params={"external_reference": order["id"]})
        events = []
        for pay in found.get("results", []):
            events += self._payment_events(pay)
        return events

    def cancel(self, sub_id):
        self._call("PUT", f"/preapproval/{sub_id}", json={"status": "cancelled"})
