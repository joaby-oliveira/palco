"""Certificado HTTPS próprio para a rede de casa.

O navegador do celular só libera a câmera em página HTTPS. O app gera um
certificado autoassinado para o IP do notebook (em data/tls/) e serve a mesma
página também numa porta HTTPS. Na primeira vez o celular mostra um aviso de
segurança: é só tocar em Avançado › Continuar.
"""
import datetime
import ipaddress
from pathlib import Path

from . import config


def ensure(ip: str) -> tuple[Path, Path]:
    """Caminhos (certificado, chave), gerando de novo se o IP do notebook mudou."""
    d = config.DATA_DIR / "tls"
    cert, key, stamp = d / "cert.pem", d / "key.pem", d / "ip.txt"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text().strip() == ip:
        return cert, key

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    d.mkdir(parents=True, exist_ok=True)
    private = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Palco (karaokê de casa)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    names = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    if ip != "127.0.0.1":
        names.append(x509.IPAddress(ipaddress.ip_address(ip)))
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(private.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(private, hashes.SHA256())
    )
    key.write_bytes(private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    stamp.write_text(ip)
    return cert, key
