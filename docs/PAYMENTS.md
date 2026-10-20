# NuBuah Payments — Provider Foundation & Integration Guide

**Status: provider-independent foundation implemented. No merchant or payment provider
is selected. No live QRIS integration exists or is claimed to exist.**

The POS runs correctly with payments disabled (default). Payment endpoints answer
`503` until a provider is configured. Nothing in this document commits the business to
a provider — that decision comes later, per the procedure below.

## 1. What exists today

| Component | Location | Purpose |
|---|---|---|
| Payment attempts | `backend/models/payment.py` | One record per payment obligation; order stays authoritative for order content |
| Adapter interface | `backend/lib/payments/base.py` | `create_payment`, `get_payment_status`, `verify_webhook`, `normalize_status`, `request_refund` |
| State machine | `backend/lib/payments/transitions.py` | Paid is terminal; late money flagged; ambiguity → `needs_review` |
| Payment service | `backend/lib/payments/service.py` | The **only** path that can mark an order paid; idempotent intents; guarded transitions; reconciliation polls; rerun-safe expiry sweep; refund tracking |
| Webhook pipeline | `service.handle_webhook` | verify → dedupe (unique `(provider, event_id)`) → orphan/amount-mismatch handling → guarded outcome |
| Mock provider | `backend/lib/payments/mock.py` | Dev/test adapter with HMAC-signed webhooks; simulates success/failure/expire/timeout/ambiguous |
| Config | `backend/lib/payments/config.py` | Env-driven; **hard-refuses mock in production** |
| Registry | `backend/lib/payments/registry.py` | Provider name → adapter factory; unknown provider → safe 503 |
| Frontend | `frontend/src/components/payments/QrisPaymentDialog.tsx` | QR + countdown + backend polling; never trusts local state for "paid" |

Invariants that any future adapter must preserve:

1. An order becomes `paid` only via `lib/payments/service.py`, through an atomic
   guarded update, with an audit record. Never from a frontend action, a redirect, a
   query parameter, or a displayed QR.
2. Unverified notifications are rejected (`401`) and never treated as payment proof.
3. Duplicate/out-of-order notifications change nothing (paid is terminal).
4. Amount/currency mismatches flag `needs_review`; they never mark anything paid.
5. Late money (after expiry) is recorded with `late_payment=True` and surfaced for a
   human — never silently dropped, never auto-refunded.
6. Secrets stay on the server: nothing payment-related reaches browser code except
   `PaymentAttemptPublic` (no diagnostics beyond a safe failure code).

## 2. Configuration

See `backend/.env.example` (placeholders only — never commit real credentials):

```
PAYMENT_PROVIDER=        # adapter name; empty = payments disabled
PAYMENT_ENABLED=0
PAYMENT_MODE=sandbox     # sandbox | production
PAYMENT_API_KEY=         # server-side only
PAYMENT_WEBHOOK_SECRET=  # server-side only
PAYMENT_REQUEST_TIMEOUT=10
PAYMENT_EXPIRY_MINUTES=15
MOCK_PAYMENT_BEHAVIOR=success    # dev/test simulation switch
DEV_PAYMENT_CONTROLS=1           # dev-only; set 0 outside dev machines
```

Startup behavior: `mode=production` + `provider=mock` → **the process refuses to
start** (`PaymentConfigError`). A selected provider with no registered adapter →
payment endpoints answer 503; nothing pretends to work.

## 3. Running the mock in development

```
PAYMENT_PROVIDER=mock
PAYMENT_ENABLED=1
PAYMENT_MODE=sandbox
MOCK_PAYMENT_BEHAVIOR=success   # or failure | expire | timeout | ambiguous
```

- Cashier POS: open a pending order → QRIS now creates a real attempt → QR dialog.
- Customer: public menu success screen → "Bayar sekarang — QRIS".
- Settle an attempt without a wallet: `POST /dev/payments/{attempt_id}/settle?outcome=success`
  (only exists while mock + non-production + `DEV_PAYMENT_CONTROLS=1`). This feeds a
  **signed** mock notification through the real webhook pipeline.
- Timeout/ambiguous simulation: with `MOCK_PAYMENT_BEHAVIOR=timeout`, intent creation
  fails with a safe code and creates **no** obligation — reconcile by polling status,
  never by blind retry.

## 4. Future provider-selection procedure (P3.10)

Do **not** pick a provider from code alone. When the business is ready:

1. **Review current official API docs** for each candidate (QRIS support, fees,
   settlement time, merchant eligibility, sandbox quality, webhook security, refunds,
   reconciliation tooling, operational requirements).
2. **Confirm merchant eligibility and activation** — business registration documents,
   QRIS registration (usually via an acquirer/aggregator), settlement account.
3. **Implement the adapter** — subclass `PaymentProviderAdapter` in
   `backend/lib/payments/<provider>.py`, following the interface contract in
   `base.py`. Map request/response/status/expiration/refund vocabulary.
4. **Implement notification authentication** exactly per the provider's docs
   (signature construction, token verification, replay protection). Unit-test the
   verify function including bad-signature and tampered-body cases.
5. **Register** the adapter in `lib/payments/registry.py` and set the env vars.
6. **Sandbox test matrix**: success, failure, expiry, duplicate callback, delayed
   callback, out-of-order callback (failure after success), amount mismatch, unknown
   reference, provider downtime, late payment after order cancellation, refund.
7. **Verify reconciliation**: reports must match provider dashboard totals for a test
   day; `payment_attempts` must reconcile with orders and `payment_events`.
8. **Controlled production validation**: small real amounts, one store, owner watching
   every transition, rollback = disable `PAYMENT_ENABLED` (checkout falls back to
   manual QRIS recording instantly).
9. **Enable live** only after sign-off. Keep `PAYMENT_MODE=production` as the final
   gate — the mock cannot coexist with it by construction.

## 5. Refunds

`POST /payments/{attempt_id}/refund` (staff) calls the adapter's `request_refund`.
Refunds are recorded on the **attempt** (`refund_status`, `refund_ref`); the order's
payment history is never rewritten. Until a provider with real refund support is
integrated, the mock's refund is a simulation and must not be treated as money moved.

## 6. Honest limitations (as of this commit)

- No real provider integrated; QRIS payments are manual-recording or mock only.
- Reconciliation UI for `needs_review` / `late_payment` attempts is a staff-facing
  list in the database / future admin screen — flagged attempts are visible in
  `payment_attempts` and the audit log today.
- Loyalty/coupon integration with payments arrives in P5; analytics treatment of
  refunds in P4.
