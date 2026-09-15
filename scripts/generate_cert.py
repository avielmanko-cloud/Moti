"""Generates a self-signed HTTPS certificate for MOTI so a Meta Quest (or any
other headset) can open the /mr page. WebXR only runs in a "secure context" —
https, or http on localhost — and a Quest reaches this PC over the LAN, so
plain http won't do. Run this once (start_quest.bat does it automatically);
the cert covers localhost plus every local IP this machine currently has, and
is regenerated automatically if the machine's IP changes later.
"""
import datetime
import ipaddress
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

CERT_DIR = Path(__file__).resolve().parent.parent / "certs"
CERT_PATH = CERT_DIR / "cert.pem"
KEY_PATH = CERT_DIR / "key.pem"


def local_ips() -> set[str]:
    ips = {"127.0.0.1"}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return ips


def cert_covers(ips: set[str]) -> bool:
    if not CERT_PATH.exists():
        return False
    cert = x509.load_pem_x509_certificate(CERT_PATH.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    covered = {str(v) for v in san.get_values_for_type(x509.IPAddress)}
    return ips.issubset(covered)


def generate(ips: set[str]) -> None:
    CERT_DIR.mkdir(exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "moti.local")])
    san = x509.SubjectAlternativeName(
        [x509.DNSName("localhost"), x509.DNSName("moti.local")]
        + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(san, critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    CERT_PATH.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_PATH.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )


def ensure_cert() -> tuple[Path, Path, set[str]]:
    ips = local_ips()
    if not cert_covers(ips):
        generate(ips)
    return CERT_PATH, KEY_PATH, ips


if __name__ == "__main__":
    cert_path, key_path, ips = ensure_cert()
    print(f"Certificate ready: {cert_path}")
    print("Open on your Meta Quest browser (accept the self-signed warning once):")
    for ip in sorted(ips - {"127.0.0.1"}):
        print(f"  https://{ip}:8443/mr")
