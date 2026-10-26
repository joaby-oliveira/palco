"""Interface de um intermediador de pagamento (broker).

Cada broker sabe abrir um checkout (passe = pagamento único, plano = assinatura)
e traduzir o que ele manda (webhook) ou responde (consulta) em eventos do Palco:

    {"id": "...", "type": "paid" | "refunded" | "sub_active" | "sub_renewed" | "sub_cancelled",
     "order": "<id do pedido no Palco>" | None, "sub_id": "...", "customer_id": "...", "email": "..."}

`id` serve para não aplicar o mesmo evento duas vezes (os brokers reenviam).
"""


class Unauthorized(Exception):
    """Webhook sem o segredo certo."""


class Broker:
    name = ""
    label = ""

    def configured(self) -> bool:
        raise NotImplementedError

    def checkout(self, order: dict, plan: dict, account: dict, urls: dict) -> dict:
        """Abre o checkout. urls = {completion, back, webhook}.
        Devolve {"url": página de pagamento, "ref": id do checkout, "sub_id": id da assinatura, se já existir}."""
        raise NotImplementedError

    def parse_webhook(self, headers, query, body: bytes) -> list[dict]:
        raise NotImplementedError

    def check(self, order: dict) -> list[dict]:
        """Consulta o pedido no broker (para quando o webhook ainda não chegou)."""
        return []

    def cancel(self, sub_id: str):
        raise NotImplementedError

    def portal(self, account: dict, order: dict) -> str | None:
        """Link para o cliente ver pagamentos e trocar o cartão, se o broker tiver."""
        return None
