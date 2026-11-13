"""Where outgoing requests may go (webhooks): public addresses only, unless an admin listed the host on purpose.

Without this, any user could make the server call localhost, the LAN or a cloud metadata address, and the delivery log
would tell open from closed ports. The target host is resolved here, EVERY address must be public, and the request is
then sent to exactly the address that was checked (see `webhooks.make_sender`), so a DNS answer that changes between
the check and the connection (DNS rebinding) gains nothing. A host the admin lists in the allowed webhook hosts may be
internal: that is a conscious decision (typical: Home Assistant in the LAN).
"""

import ipaddress
import socket
from collections.abc import Callable

Resolver = Callable[[str, int], list[str]]


class TargetNotAllowed(Exception):
    """The target is not a public address (or cannot be resolved)."""


def system_resolver(host: str, port: int) -> list[str]:
    """All addresses of `host` as the system resolves them. Odd forms (0x7f000001, 2130706433, 127.1) come out as IPs."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(info[4][0] for info in infos))


# conftest replaces this name in the tests, so no test needs a network
resolver: Resolver = system_resolver


def _embedded_v4(addr: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    if addr.sixtofour is not None:  # 2002::/16
        return addr.sixtofour
    if addr in ipaddress.ip_network("64:ff9b::/96"):  # NAT64
        return ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
    if addr.teredo is not None:  # 2001::/32 carries the server and the client address
        return addr.teredo[0]
    return None


def is_public(text: str) -> bool:
    try:
        addr = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and (inner := _embedded_v4(addr)) is not None:
        addr = inner
    return (
        addr.is_global and not (addr.is_loopback or addr.is_private or addr.is_link_local or addr.is_multicast
                                or addr.is_reserved or addr.is_unspecified)
        and not (isinstance(addr, ipaddress.IPv4Address) and addr in ipaddress.ip_network("100.64.0.0/10"))
    )


def pick_address(host: str, port: int, allow_internal: bool = False) -> str:
    """The address to connect to. Raises TargetNotAllowed for a host that does not resolve or has any non-public address
    (unless `allow_internal`, for hosts the admin listed)."""
    try:
        addresses = resolver(host, port)
    except (OSError, UnicodeError, ValueError) as exc:
        raise TargetNotAllowed from exc
    if not addresses:
        raise TargetNotAllowed
    if not allow_internal and not all(is_public(a) for a in addresses):
        raise TargetNotAllowed
    return addresses[0]


def pinned_target(url: str, address: str) -> tuple[str, dict, dict]:
    """(url, headers, extensions) that make an HTTP client connect to `address` (the checked one) while the request still
    carries the original host: the Host header, and the name for SNI and the certificate check. IPv6 literals get brackets."""
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    literal = f"[{address}]" if ":" in address else address
    netloc = literal + (f":{parts.port}" if parts.port else "")
    return (
        urlunsplit((parts.scheme, netloc, parts.path, parts.query, "")),
        {"Host": parts.netloc.rsplit("@", 1)[-1]},
        {"sni_hostname": parts.hostname},
    )
