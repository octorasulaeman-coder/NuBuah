"""Provider registry: name -> adapter factory. A provider may be SELECTED in config
only if it appears here AND its configuration is complete (P3.3/P3.9)."""

from lib.payments.base import PaymentProviderAdapter
from lib.payments.config import CONFIG, PaymentConfigError
from lib.payments.mock import MockProvider

_FACTORIES = {
    "mock": lambda cfg: MockProvider(webhook_secret=cfg.webhook_secret or "mock-dev-secret"),
    # real providers are added here after their adapter is implemented against the
    # provider's official docs — see docs/PAYMENTS.md for the procedure.
}


def get_adapter(cfg=CONFIG) -> PaymentProviderAdapter:
    """Resolve the configured provider to a live adapter. Raises PaymentConfigError
    (callers translate to 503) when payments are disabled or the adapter is missing."""
    if not cfg.enabled:
        raise PaymentConfigError("payments are disabled (PAYMENT_PROVIDER / PAYMENT_ENABLED)")
    factory = _FACTORIES.get(cfg.provider)
    if factory is None:
        raise PaymentConfigError(
            f"payment provider {cfg.provider!r} is selected but no adapter is implemented"
        )
    return factory(cfg)


def adapter_names() -> list[str]:
    return sorted(_FACTORIES)
