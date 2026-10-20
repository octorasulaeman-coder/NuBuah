// Offline order queue: when checkout can't reach the server (Wi-Fi drop, server restart),
// the order is parked in localStorage and retried in the background. Retries are safe
// because the backend dedupes on client_order_id — a retried order returns the existing
// one instead of charging the customer twice.
//
// Retry policy (bounded, documented):
// - transient failures (network down, 5xx): exponential backoff with jitter, at most
//   MAX_ATTEMPTS tries, then parked for manual re-entry.
// - permanent failures (4xx validation, e.g. prices changed while offline): at most
//   PERMANENT_MAX_ATTEMPTS tries, then parked — re-entry is a human decision.
// - a parked order is NEVER auto-retried and NEVER treated as paid; it stays visible
//   (parked flag + lastError) until the cashier re-enters or discards it.
// - offline support is limited to ORDER SUBMISSION. Payment confirmation (any QRIS flow)
//   always requires a live server — the queue never simulates payment success.
import { ApiError, apiPost } from "@/lib/api";
import type { OrderCreate } from "@/lib/types";

const KEY = "nubuah.offlineQueue.v1";

export const MAX_ATTEMPTS = 8; // transient: then park for manual re-entry
export const PERMANENT_MAX_ATTEMPTS = 3; // 4xx validation: then park
const BASE_BACKOFF_MS = 15_000; // 15s -> 30s -> 60s ... capped
const MAX_BACKOFF_MS = 10 * 60_000;

export type QueueErrorKind = "network" | "server" | "validation";

export interface QueuedOrder {
  client_order_id: string;
  body: OrderCreate;
  saved_at: number;
  attempts: number;
  /** earliest time (epoch ms) the next automatic attempt may run */
  next_attempt_at: number;
  /** classified outcome of the last attempt */
  last_error?: QueueErrorKind;
  /** permanent: automatic retries have stopped; needs manual re-entry */
  parked?: boolean;
}

// --- storage with shape normalization (entries written by older builds lack the
// new fields; they are filled with safe defaults instead of being discarded) ---
function normalize(raw: unknown): QueuedOrder[] {
  if (!Array.isArray(raw)) return [];
  const out: QueuedOrder[] = [];
  for (const item of raw as Array<Partial<QueuedOrder>>) {
    if (!item || typeof item !== "object" || !item.client_order_id || !item.body) continue;
    out.push({
      client_order_id: item.client_order_id,
      body: item.body,
      saved_at: item.saved_at ?? Date.now(),
      attempts: item.attempts ?? 0,
      next_attempt_at: item.next_attempt_at ?? 0,
      last_error: item.last_error,
      parked: item.parked ?? false,
    });
  }
  return out;
}

export function queuedOrders(): QueuedOrder[] {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function queuedCount(): number {
  return queuedOrders().length;
}

/** orders still trying to sync vs orders that need a human */
export function queueSummary(): { pending: number; parked: number } {
  const q = queuedOrders();
  return { pending: q.filter((o) => !o.parked).length, parked: q.filter((o) => o.parked).length };
}

function save(orders: QueuedOrder[]): void {
  localStorage.setItem(KEY, JSON.stringify(orders));
  emit();
}

function bodiesEqual(a: OrderCreate, b: OrderCreate): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function enqueueOrder(body: OrderCreate): void {
  let id = body.client_order_id;
  if (!id) return;
  const q = queuedOrders().filter((o) => o.client_order_id !== id); // replace, never duplicate
  const previous = queuedOrders().find((o) => o.client_order_id === id);
  if (previous && !bodiesEqual(previous.body, body)) {
    // the queued order was EDITED (different content under the same key). The backend
    // rightfully rejects key reuse with different content (409), so this is a new
    // logical checkout and gets a fresh key.
    id = crypto.randomUUID();
    body = { ...body, client_order_id: id };
  }
  q.push({ client_order_id: id, body, saved_at: Date.now(), attempts: 0, next_attempt_at: 0 });
  save(q);
}

export function removeQueued(client_order_id: string): void {
  save(queuedOrders().filter((o) => o.client_order_id !== client_order_id));
}

/** a human re-enters a parked order: fresh start for attempts */
export function requeue(client_order_id: string): void {
  const q = queuedOrders();
  const item = q.find((o) => o.client_order_id === client_order_id);
  if (item) {
    item.attempts = 0;
    item.next_attempt_at = 0;
    item.last_error = undefined;
    item.parked = false;
    save(q);
  }
}

function backoffMs(attempts: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

function recordAttempt(item: QueuedOrder, kind: QueueErrorKind, permanent: boolean): QueuedOrder {
  const q = queuedOrders();
  const current = q.find((o) => o.client_order_id === item.client_order_id);
  if (!current) return item;
  current.attempts += 1;
  current.last_error = kind;
  const limit = permanent ? PERMANENT_MAX_ATTEMPTS : MAX_ATTEMPTS;
  if (current.attempts >= limit) {
    current.parked = true; // stops automatic retries; stays visible for manual re-entry
  } else {
    current.next_attempt_at = Date.now() + backoffMs(current.attempts);
  }
  save(q);
  return current;
}

// --- tiny pub/sub so badges update when the queue changes ---
type Listener = () => void;
const listeners = new Set<Listener>();

export function onQueueChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  listeners.forEach((l) => l());
}

/**
 * Try to send every queued order that is due, oldest first. Network/5xx failures use
 * bounded backoff; 4xx validation failures are retried a few times then parked. Parked
 * orders are never auto-retried — the cashier must re-enter them deliberately.
 */
export async function syncOfflineQueue(now: number = Date.now()): Promise<{ sent: number; failed: number; skipped: number }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of queuedOrders()) {
    if (item.parked) {
      skipped += 1;
      continue;
    }
    if (item.next_attempt_at > now) {
      skipped += 1;
      continue;
    }
    try {
      await apiPost("/orders", item.body);
      removeQueued(item.client_order_id);
      sent += 1;
    } catch (err) {
      failed += 1;
      if (err instanceof ApiError && err.status < 500) {
        recordAttempt(item, "validation", true); // prices changed etc — permanent
      } else {
        const status = err instanceof ApiError ? err.status : undefined;
        recordAttempt(item, status ? "server" : "network", false);
      }
    }
  }
  return { sent, failed, skipped };
}
