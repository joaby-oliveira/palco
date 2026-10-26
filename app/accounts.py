"""Contas de quem paga (anfitriões): e-mail, senha, passes e assinatura.

Ficam em data/accounts.json. A senha vai com scrypt e a sessão é um token
aleatório num cookie; no arquivo fica só o hash do token.
"""
import hashlib
import json
import re
import secrets
import threading
import time
import uuid

from . import config

COOKIE = "palco_conta"
SESSION_TTL = 90 * 24 * 3600
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_lock = threading.RLock()
_accounts: dict[str, dict] = {}


def _file():
    return config.DATA_DIR / "accounts.json"


def load():
    global _accounts
    if _file().exists():
        _accounts = json.loads(_file().read_text(encoding="utf-8"))


def save():
    with _lock:
        tmp = _file().with_suffix(".tmp")
        tmp.write_text(json.dumps(_accounts, indent=1, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_file())


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"{salt.hex()}:{digest.hex()}"


def _check_password(password: str, stored: str) -> bool:
    salt, _ = stored.split(":")
    return secrets.compare_digest(_hash_password(password, bytes.fromhex(salt)), stored)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def get(account_id: str | None) -> dict | None:
    return _accounts.get(account_id or "")


def by_email(email: str) -> dict | None:
    email = (email or "").strip().lower()
    return next((a for a in _accounts.values() if a["email"] == email), None)


def find(pred) -> dict | None:
    return next((a for a in _accounts.values() if pred(a)), None)


def create(email: str, password: str, name: str, phone: str = "", tax_id: str = "") -> dict:
    email = (email or "").strip().lower()
    name = " ".join((name or "").split())[:60]
    if not EMAIL_RE.match(email):
        raise ValueError("Esse e-mail não parece certo.")
    if len(password or "") < 8:
        raise ValueError("A senha precisa ter pelo menos 8 caracteres.")
    if not name:
        raise ValueError("Diz o seu nome.")
    with _lock:
        if by_email(email):
            raise ValueError("Já existe uma conta com esse e-mail. Entre com a senha.")
        acc = {
            "id": uuid.uuid4().hex[:12],
            "email": email,
            "name": name,
            "phone": _digits(phone)[:13],
            "tax_id": _digits(tax_id)[:14],   # CPF ou CNPJ (o Asaas exige)
            "password": _hash_password(password),
            "created": time.time(),
            "sessions": {},                   # hash do token -> expira em
            "passes": [],                     # {order, plan, hours, bought, start, until}
            "subscription": None,             # {plan, provider, sub_id, order, status, period_start, period_end}
            "songs": [],                      # quando cada música nova foi preparada (conta o limite)
            "customers": {},                  # provedor -> id do cliente lá
        }
        _accounts[acc["id"]] = acc
        save()
    return acc


def update_profile(acc: dict, values: dict) -> dict:
    with _lock:
        if "name" in values and " ".join(str(values["name"]).split()):
            acc["name"] = " ".join(str(values["name"]).split())[:60]
        if "phone" in values:
            acc["phone"] = _digits(str(values["phone"]))[:13]
        if "tax_id" in values:
            acc["tax_id"] = _digits(str(values["tax_id"]))[:14]
        save()
    return acc


def login(email: str, password: str) -> dict:
    acc = by_email(email)
    if not acc or not _check_password(password or "", acc["password"]):
        raise ValueError("E-mail ou senha não conferem.")
    return acc


def new_session(acc: dict) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        acc["sessions"] = {h: exp for h, exp in acc["sessions"].items() if exp > now}
        acc["sessions"][_token_hash(token)] = now + SESSION_TTL
        save()
    return token


def end_session(token: str):
    h = _token_hash(token or "")
    with _lock:
        for acc in _accounts.values():
            if acc["sessions"].pop(h, None):
                save()
                return


def from_token(token: str | None) -> dict | None:
    if not token:
        return None
    h = _token_hash(token)
    now = time.time()
    for acc in _accounts.values():
        exp = acc["sessions"].get(h)
        if exp and exp > now:
            return acc
    return None


def public(acc: dict) -> dict:
    return {"id": acc["id"], "email": acc["email"], "name": acc["name"],
            "phone": acc.get("phone", ""), "tax_id_set": bool(acc.get("tax_id"))}
