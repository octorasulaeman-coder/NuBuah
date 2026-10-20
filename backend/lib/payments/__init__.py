"""Payment package. The config module is importable without any database driver so the
pure pieces (config rules, state machine, provider adapters) stay unit-testable; the
service/registry are loaded lazily on first access.

NOTE: `from lib.payments import create_intent` still works — module __getattr__
resolves service-level names on demand.
"""

from lib.payments.config import CONFIG, PaymentConfigError, load_payment_config

_LAZY_SERVICE = {
    "create_intent", "get_attempt", "handle_webhook", "refresh_status",
    "request_refund", "sweep_expirations",
}


def __getattr__(name):  # PEP 562
    if name in _LAZY_SERVICE:
        from lib.payments import service

        return getattr(service, name)
    if name == "get_adapter":
        from lib.payments.registry import get_adapter

        return get_adapter
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "CONFIG", "PaymentConfigError", "load_payment_config",
    "get_adapter",
    "create_intent", "get_attempt", "handle_webhook", "refresh_status",
    "request_refund", "sweep_expirations",
]
