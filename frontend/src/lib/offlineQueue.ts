// Offline order queue: when checkout can't reach the server (Wi-Fi drop, server restart),
// the order is parked in localStorage and retried in the background. Retries are safe
// because the backend dedupes on client_order_id — a retried order returns the existing
// one instead of charging the customer twice.
import { ApiError, apiPost } from "@/lib/api";
import type { OrderCreate } from "@/lib/types";

const KEY = "nubuah.offlineQueue.v1";

export interface QueuedOrder {
  client_order_id: string;
  body: OrderCreate;
  saved_at: number;
  attempts: number;
}

export function queuedOrders(): QueuedOrder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function queuedCount(): number {
  return queuedOrders().length;
}

function save(orders: QueuedOrder[]): void {
  localStorage.setItem(KEY, JSON.stringify(orders));
  emit();
}

export function enqueueOrder(body: OrderCreate): void {
  const id = body.client_order_id;
  if (!id) return;
  const q = queuedOrders().filter((o) => o.client_order_id !== id); // replace, never duplicate
  q.push({ client_order_id: id, body, saved_at: Date.now(), attempts: 0 });
  save(q);
}

export function removeQueued(client_order_id: string): void {
  save(queuedOrders().filter((o) => o.client_order_id !== client_order_id));
}

function bumpAttempts(client_order_id: string): number {
  const q = queuedOrders();
  const item = q.find((o) => o.client_order_id === client_order_id);
  if (item) {
    item.attempts += 1;
    save(q);
    return item.attempts;
  }
  return 0;
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
 * Try to send every queued order, oldest first. Network/5xx failures stay queued for the
 * next round; 4xx validation failures (e.g. prices changed while offline) are retried a
 * few times then parked — the cashier must re-enter them, so they are kept visible.
 */
export async function syncOfflineQueue(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const item of queuedOrders()) {
    try {
      await apiPost("/orders", item.body);
      removeQueued(item.client_order_id);
      sent += 1;
    } catch (err) {
      const attempts = bumpAttempts(item.client_order_id);
      if (err instanceof ApiError && err.status < 500 && attempts >= 3) {
        failed += 1; // parked: needs manual re-entry, stays in the queue list
      }
    }
  }
  return { sent, failed };
}
