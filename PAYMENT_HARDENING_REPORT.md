# NuBuah Payment Hardening Report

Date: 2026-10-22

## Scope completed

This source tree contains a bounded payment-hardening pass focused on four areas:

1. Safe refund accounting and refund idempotency.
2. Payment-intent idempotency, duplicate-attempt prevention, and ambiguous provider outcomes.
3. Verified webhook/order-update convergence for authoritative paid transitions.
4. Migration/operational checks for the payment-hardening indexes and unsafe duplicate keys.

Not completed in this pass:

- real QRIS provider integration;
- production webhook secret provisioning;
- full FastAPI runtime verification;
- real MongoDB integration/concurrency verification;
- final production readiness review.

## Major implementation changes

### Refund accounting

Files:

- `backend/models/payment.py`
- `backend/lib/payments/base.py`
- `backend/lib/payments/mock.py`
- `backend/lib/db.py`
- `backend/lib/payments/service.py`
- `backend/routers/payments.py`
- `backend/routers/reports.py`
- `backend/lib/payments/refund_rules.py`
- `backend/tests/test_refund_rules.py`
- `backend/tests/test_refunds_service.py`

Implemented:

- durable `refunds` ledger with states `pending | succeeded | failed | ambiguous`;
- refund idempotency scoped to attempt + key;
- atomic refundable-capacity reservation before provider calls;
- cumulative successful refunds cannot exceed collected amount;
- definitive provider failures release reservation;
- provider timeouts remain ambiguous and reserved until reconciliation;
- repeated refund confirmation/reconciliation does not duplicate provider calls;
- reports read successful refunds from the ledger, with legacy attempt-summary fallback.

### Payment-intent idempotency and ambiguity

Files:

- `backend/models/payment.py`
- `backend/lib/db.py`
- `backend/lib/payments/service.py`
- `backend/tests/test_payment_intents.py`

Implemented:

- stable `request_fingerprint`, `provider_idempotency_key`, and `provider_attempted` fields on payment attempts;
- server-derived amount/currency from the order (no client-controlled amount/currency);
- unique store-scoped payment-intent key scope: `pay_store_idem`;
- same-key reuse with changed order/provider/amount/currency/method/payload returns `idempotency_conflict`;
- duplicate-key race recovery validates the winning database row;
- unkeyed duplicate attempts reuse one open pending/ambiguous attempt;
- provider timeouts/connection failures remain ambiguous and require reconciliation;
- safe retry after confirmed pre-creation failure uses a new key or unkeyed retry;
- creating an intent does not mark the order paid.

### Webhook/order-update convergence

Files:

- `backend/lib/payments/service.py`
- `backend/tests/test_payment_webhooks.py`

Implemented:

- convergent order-side settlement for authoritative paid attempts;
- if an attempt is paid but the order update was previously lost, later polls/callbacks reconcile the order;
- paid-state propagation is idempotent and does not duplicate points ledger entries;
- webhook tests cover forged callbacks, replay, amount mismatch, unknown status, out-of-order failure/success, late payment, wrong-store scope, and lost order update recovery.

### Migration/operational checks

Files:

- `backend/lib/payments/migration_checks.py`
- `backend/scripts/check_payment_hardening.py`
- `backend/tests/test_payment_migration_checks.py`

Implemented:

- pure duplicate-key detection helpers;
- read-only JSON operational check for required payment indexes and unsafe duplicate keys;
- optional `--create-indexes` mode that invokes the existing `ensure_indexes()`;
- nonzero exit when blocking migration issues are found.

## Database/index changes

Required payment indexes are declared in `backend/lib/db.py`, including:

- `payment_attempts.pay_store_idem` unique `(store_id, idempotency_key)` for keyed payment intents;
- existing provider reference, order, and status indexes;
- `payment_events.payev_id` unique event-id dedupe;
- `refunds.refund_attempt_idem` unique `(attempt_id, idempotency_key)` for refund retries;
- refund provider/order/status indexes.

Migration requirement:

1. Run the read-only check:

   ```bash
   cd backend
   python3 scripts/check_payment_hardening.py
   ```

2. Resolve any reported duplicate payment-intent or refund key groups.

3. Create/verify indexes only after review:

   ```bash
   python3 scripts/check_payment_hardening.py --create-indexes
   ```

## Verification performed

Environment limitation: this machine does not have the full backend test/runtime dependencies, MongoDB server, or pytest installed. Verification was done with compile checks, stdlib unittest tests, and a small local pytest shim for existing pure tests.

### Compile check

```bash
python3 -m compileall -q lib/payments models/payment.py lib/db.py routers/payments.py routers/reports.py tests/test_refund_rules.py tests/test_refunds_service.py tests/test_payment_intents.py tests/test_payment_webhooks.py tests/test_payment_migration_checks.py scripts/check_payment_hardening.py
```

Result:

```text
RC 0
```

### Focused payment regression suite

```bash
python3 -m unittest tests.test_refund_rules tests.test_refunds_service tests.test_payment_intents tests.test_payment_webhooks tests.test_payment_migration_checks
```

Result:

```text
........................................
----------------------------------------------------------------------
Ran 40 tests in 0.063s

OK
```

### Existing pure tests executed with local pytest shim

```text
tests.test_payments: passed 16, failed 0, skipped 0
tests.test_idempotency: passed 8, failed 0, skipped 0
```

## Known limitations

- Real MongoDB unique-index behavior and multi-client concurrency were not verified here.
- Real MongoDB index creation against existing data was not executed here.
- Full FastAPI route runtime imports were not executed here.
- The original full pytest suite was not run because `pytest` is unavailable in this environment.
- No real QRIS provider was integrated; provider behavior remains adapter-contract plus mock simulation only.

## Remaining risks

1. Migration/data cleanup may be required before the new unique indexes can be created.
2. Real provider webhooks must implement verified authentication according to that provider's current documentation.
3. Ambiguous outcomes still require provider status support or manual reconciliation.
4. Partial-refund loyalty policy remains a business-policy decision.
5. Production readiness still requires dependency installation, MongoDB integration tests, route smoke tests, secret provisioning, and provider certification.

## Task 3 addendum — webhook event lifecycle

Subsequent work added durable webhook event lifecycle handling in `backend/lib/payments/service.py` and `backend/models/payment.py`:

- event states: `received | processing | processed | failed`;
- atomic event claiming before financial side effects;
- recoverable processing failures with bounded retries;
- `manual_reconciliation_required` escalation;
- explicit failure codes for missing fields, duplicate provider refs, amount/currency mismatch, unknown status, wrong store, transition review, and processing errors;
- late payment after cancelled/completed orders is recorded but flagged for review;
- operational helper `list_events_needing_attention(...)`.

Regression tests: `backend/tests/test_payment_webhooks.py`.

## Task 4 addendum — review route and migration checks

Subsequent verification work added:

- owner-only read-only route: `GET /payments/events/review?store_id=...&limit=...`;
- required webhook lifecycle indexes in `backend/lib/payments/migration_checks.py`:
  - `payev_status_updated`
  - `payev_retry_due`
  - `payev_manual`

The migration checker now covers payment intent keys, refund keys, payment event lifecycle indexes, and stale unprocessed events.

## Task 6 addendum — same-key refund race and review serialization

Task 6 fixed two audit findings:

1. Refund duplicate-key race safety:
   - `_insert_refund_record()` now returns `(record, created)`;
   - duplicate-key recovery no longer reserves capacity or initiates provider refunds;
   - concurrent same-key requests converge on one logical refund request;
   - deterministic race tests cover winner-success and winner-timeout outcomes.

2. Payment-event review serialization:
   - `list_events_needing_attention()` returns an explicit safe projection;
   - Mongo `_id` and internal/raw payload fields are excluded;
   - route behavior remains read-only and owner-only.

Regression tests added/updated in:
- `backend/tests/test_refunds_service.py`
- `backend/tests/test_payment_webhooks.py`

## Task 7 addendum — premature pending-refund reconciliation

Task 7 fixed premature provider-status reconciliation for duplicate refund retries:

- duplicate-key fast path no longer calls `get_refund_status()` for ordinary `pending` refund rows;
- only `ambiguous` rows may be probed for reconciliation;
- pending rows preserve reservations and remain owned by the original request or explicit recovery;
- provider-call boundary exceptions remain ambiguous, never confirmed success/failure;
- deterministic tests cover pending-before-provider-call, ambiguous duplicate safety, and provider-call boundary crashes.

Regression tests updated in `backend/tests/test_refunds_service.py`.

## Unified customer queue addendum

The POS customer workflow was unified for average cashier use:

- added `GET /orders/cashier-queue`, returning `unpaid`, `processing`, `ready`, and `completed` groups;
- unpaid customer/scheduled orders are included regardless of scheduled pickup date;
- the POS top bar now has one `Pesanan` action button/count;
- `CustomerOrdersDialog` is now the unified `Pesanan pelanggan` workspace with tabs:
  - `Perlu tindakan`
  - `Sedang diproses`
  - `Riwayat`
- unpaid cards use `Terima bayar` / `Batal`;
- paid processing cards use one action-first `Lanjut` button;
- ready cards use `Sudah diambil`;
- cards distinguish `Ambil sekarang` vs `Terjadwal ...`;
- search supports order number / phone;
- the queue auto-refreshes every 10 seconds.

Files changed:

- `backend/routers/orders.py`
- `frontend/src/components/pos/CustomerOrdersDialog.tsx`
- `frontend/src/pages/Pos.tsx`
- `frontend/src/lib/types.ts`

Frontend build compatibility was also corrected after the initial unified-queue implementation:

- `Pos.tsx` uses the named `CustomerOrdersDialog` export;
- currency formatting uses the existing `rupiah` helper;
- `QrisPaymentDialog` uses its default export and required `pollBase` / `onRetry` props.

Follow-up cashier fixes:

- counter payment now sends the backend-required `payment_method` field;
- completed/cancelled history cards no longer show a no-op `Lanjut` button;
- successful cash/QRIS customer payments reopen the existing POS receipt dialog for print/download;
- order cards now include an expandable cashier detail view with line items, qty, options, notes, and line totals;
- frontend build compatibility was extended by restoring `useMenu` exports (`LiveProduct`, `defaultGroupsFor`) and fixing strict TypeScript status/typing/nullability issues in the unified queue and menu editor;
- `Riwayat` in the unified customer queue now supports `Hari ini` and `7 hari`, with the backend `cashier-queue` endpoint accepting `history_days` and limiting completed/cancelled history to that window;
- scheduled customer times are formatted explicitly as `Asia/Jakarta` so UTC storage no longer displays as the wrong local hour;
- future scheduled unpaid orders remain visible under `Sedang diproses` instead of bulking urgent `Perlu tindakan`;
- successful customer payment now auto-advances `Ambil sekarang` orders to `ready` and scheduled orders to `confirmed`;
- paid processing orders support one-click `Tandai Siap` via `POST /orders/{id}/ready`;
- card payment remains backend-compatible but is hidden from cashier/customer payment UIs, leaving only Tunai and QRIS;
- online payment panel now supports cashier payment-time discount, coupon, and point redemption parity with manual checkout;
- coupon/point values already selected during self-checkout are prefilled and locked from cashier changes;
- cash quick-amount buttons are dynamically based on final payable amount;
- API serializers normalize naive `scheduled_for` values to UTC-aware datetimes so public/staff screens display the intended Asia/Jakarta time;
- payment-time coupon/point integration was re-audited and corrected to use the existing customer-helper contracts (`validate_and_price_coupon`, `reserve_coupon`, `redeem_points`, `release_coupon`, `refund_redeem`), including reservation/refund behavior when a concurrent payment attempt loses the race.

## Handoff packaging note

The handoff ZIP generated after these addenda includes Tasks 1–7 plus the unified customer queue changes and excludes backups, `.env`, caches, generated bytecode, and dependency directories. It is a source handoff only, not a production build.

## Backups in this tree

Pre-change file backups are preserved under:

- `backups/pre_refund_accounting_backup`
- `backups/pre_payment_intent_idempotency_backup`
- `backups/pre_webhook_order_update_backup`
- `backups/pre_webhook_reliability_backup`
- `backups/pre_payment_event_review_route_backup`
- `backups/pre_task6_refund_race_route_serialization_backup`
- `backups/pre_task7_pending_refund_reconciliation_backup`
- `backups/pre_unified_customer_queue_ui_backup`
- `backups/pre_customer_queue_pay_receipt_fix_backup`
- `backups/pre_build_and_order_detail_fix_backup`
- `backups/pre_history_7day_filter_backup`
- `backups/pre_final_customer_queue_workflow_backup`
