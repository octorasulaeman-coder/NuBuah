import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  X, Search, QrCode, Banknote, CreditCard, RefreshCcw,
  CalendarClock, CheckCircle2, Clock,
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { CashierQueue, Order, PaymentAttempt } from "@/lib/types";
import { fmtIDR } from "@/lib/format";
import { QrisPaymentDialog } from "@/components/payments/QrisPaymentDialog";

const NEXT_STATUS: Partial<Record<Order["status"], Order["status"]>> = {
  received: "confirmed",
  confirmed: "preparing",
  preparing: "ready",
  ready: "completed",
};

const EMPTY_QUEUE: CashierQueue = { unpaid: [], processing: [], ready: [], completed: [] };

function itemSummary(o: Order): string {
  const names = o.lines.map((l) => l.name).filter(Boolean);
  const suffix = names.length > 3 ? ` +${names.length - 3}` : "";
  return `${names.slice(0, 3).join(", ")}${suffix} · ${o.item_count} item`;
}

function fulfillmentBadge(o: Order) {
  if (o.fulfillment === "scheduled" && o.scheduled_for) {
    const when = new Date(o.scheduled_for).toLocaleString("id-ID", {
      weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">
        <CalendarClock className="h-3.5 w-3.5" /> Terjadwal · {when}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-700">
      <Clock className="h-3.5 w-3.5" /> Ambil sekarang
    </span>
  );
}

function paymentBadge(o: Order) {
  if (o.payment_status === "paid") {
    return <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-700">Lunas</span>;
  }
  return <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700">Belum bayar</span>;
}

function matchesSearch(o: Order, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [o.order_no, o.customer_phone, o.customer_name ?? ""]
    .some((v) => (v || "").toLowerCase().includes(needle));
}

export function CustomerOrdersDialog({ open, onClose, storeId }: { open: boolean; onClose: () => void; storeId?: string | null }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"action" | "processing" | "history">("action");
  const [search, setSearch] = useState("");
  const [payingId, setPayingId] = useState<string | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const q = useQuery({
    queryKey: ["orders", "cashier-queue", storeId],
    enabled: open && !!storeId,
    queryFn: () => apiGet<CashierQueue>(`/orders/cashier-queue?store_id=${storeId}&include_completed=true`),
    refetchInterval: 10_000,
  });
  const queue = q.data ?? EMPTY_QUEUE;

  const filtered = useMemo(() => {
    const rows = {
      action: [...queue.unpaid, ...queue.ready].filter((o) => matchesSearch(o, search)),
      processing: queue.processing.filter((o) => matchesSearch(o, search)),
      history: queue.completed.filter((o) => matchesSearch(o, search)),
    };
    return rows;
  }, [queue, search]);

  const counts = useMemo(() => ({
    action: queue.unpaid.length + queue.ready.length,
    processing: queue.processing.length,
    history: queue.completed.length,
  }), [queue]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["orders", "cashier-queue"] });

  const payingOrder = useMemo(
    () => queue.unpaid.find((o) => o.id === payingId),
    [queue.unpaid, payingId],
  );

  const mAdvance = useMutation({
    mutationFn: async (o: Order) => {
      const next = NEXT_STATUS[o.status];
      if (!next) return o;
      return apiPost<Order>(`/orders/${o.id}/status`, { status: next });
    },
    onSuccess: (_d, o) => {
      toast.success(o.status === "ready" ? "Pesanan ditandai sudah diambil" : "Status pesanan diperbarui");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mCancel = useMutation({
    mutationFn: async ({ order, reason }: { order: Order; reason: string }) => {
      await apiPost<Order>(`/orders/${order.id}/cancel`, { reason });
    },
    onSuccess: () => {
      toast.success("Pesanan dibatalkan");
      setCancelOrder(null);
      setCancelReason("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mCashPay = useMutation({
    mutationFn: async ({
      order, method, tendered,
    }: {
      order: Order;
      method: "cash" | "card";
      tendered?: number;
    }) => {
      const discount = 0;
      const change = method === "cash" && tendered != null ? Math.max(0, tendered - order.total) : undefined;
      const paid = await apiPost<Order>(`/orders/${order.id}/pay`, {
        method, cash_tendered: method === "cash" ? tendered : undefined, discount_value: discount || undefined,
      });
      return { paid, method, tendered, change };
    },
    onSuccess: ({ method, tendered, change }) => {
      toast.success(
        method === "cash"
          ? `Lunas. Kembalian ${fmtIDR(change ?? 0)}${tendered != null ? ` · tunai ${fmtIDR(tendered)}` : ""}`
          : "Lunas.",
      );
      setPayingId(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mQris = useMutation({
    mutationFn: async (order: Order) => {
      const attempt = await apiPost<PaymentAttempt>("/payments/intents", {
        order_id: order.id,
        method: "qris",
        idempotency_key: crypto.randomUUID(),
      });
      return { order, attempt };
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!open) return null;

  const tabs = [
    { key: "action" as const, label: "Perlu tindakan", count: counts.action },
    { key: "processing" as const, label: "Sedang diproses", count: counts.processing },
    { key: "history" as const, label: "Riwayat", count: counts.history },
  ];

  const renderOrder = (o: Order, opts: { actionTab?: boolean }) => {
    const unpaid = o.payment_status !== "paid";
    const primaryLabel = unpaid ? "Terima bayar" : o.status === "ready" ? "Sudah diambil" : "Lanjut";
    return (
      <div key={o.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-extrabold tracking-tight text-slate-900">{o.order_no}</span>
              {paymentBadge(o)}
              {o.status === "ready" && <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold text-green-700">Siap diambil</span>}
              {opts.actionTab && o.fulfillment === "scheduled" && o.scheduled_for && new Date(o.scheduled_for) < new Date() && (
                <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-bold text-red-700">Terlambat</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {fulfillmentBadge(o)}
              <span className="text-xs text-slate-500">{o.customer_phone}{o.customer_name ? ` · ${o.customer_name}` : ""}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xl font-black text-slate-900">{fmtIDR(o.total)}</div>
            <div className="text-xs text-slate-500">{itemSummary(o)}</div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {unpaid ? (
            <>
              <button
                onClick={() => setPayingId(o.id)}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700"
              >
                <Banknote className="h-4 w-4" /> {primaryLabel}
              </button>
              <button
                onClick={() => { setCancelOrder(o); setCancelReason(""); }}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Batal
              </button>
            </>
          ) : (
            <button
              disabled={mAdvance.isPending}
              onClick={() => mAdvance.mutate(o)}
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-60"
            >
              <CheckCircle2 className="h-4 w-4" /> {primaryLabel}
            </button>
          )}
        </div>
      </div>
    );
  };

  const rows = filtered[tab];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/35" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-3xl overflow-hidden rounded-3xl bg-slate-50 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <h2 className="text-xl font-extrabold text-slate-900">Pesanan pelanggan</h2>
            <p className="text-sm text-slate-500">Bayar, proses, dan serahkan pesanan online/terjadwal.</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => q.refetch()}
              className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"
              title="Muat ulang"
            >
              <RefreshCcw className="h-5 w-5" />
            </button>
            <button onClick={onClose} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="border-b border-slate-200 bg-white px-5 pb-4">
          <div className="flex flex-wrap gap-2">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-full px-4 py-2 text-sm font-bold ${
                  tab === t.key ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {t.label}
                {t.count > 0 && (
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${tab === t.key ? "bg-white/20" : "bg-white text-slate-700"}`}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari no. pesanan / no. HP"
              className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        <div className="max-h-[62vh] space-y-3 overflow-y-auto px-5 py-4">
          {q.isLoading && <div className="py-12 text-center text-slate-500">Memuat pesanan…</div>}
          {q.isError && <div className="py-12 text-center text-red-500">Gagal memuat pesanan.</div>}
          {q.isSuccess && rows.length === 0 && (
            <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-slate-500">
              {tab === "action" && "Tidak ada pesanan yang butuh tindakan."}
              {tab === "processing" && "Tidak ada pesanan yang sedang diproses."}
              {tab === "history" && "Belum ada riwayat pesanan pelanggan."}
            </div>
          )}
          {rows.map((o) => renderOrder(o, { actionTab: tab === "action" }))}
        </div>
      </div>

      {payingOrder && (
        <CashPayPanel
          order={payingOrder}
          onClose={() => setPayingId(null)}
          onCash={(method, tendered) => mCashPay.mutate({ order: payingOrder, method, tendered })}
          onQris={() => mQris.mutate(payingOrder)}
          cashPending={mCashPay.isPending}
          qrisPending={mQris.isPending}
        />
      )}

      {mQris.data && (
        <QrisPaymentDialog
          attempt={mQris.data.attempt}
          amount={mQris.data.order.total}
          onClose={() => mQris.reset()}
          onPaid={() => {
            mQris.reset();
            setPayingId(null);
            invalidate();
          }}
        />
      )}

      {cancelOrder && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/45" onClick={() => setCancelOrder(null)} />
          <div className="relative w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-extrabold text-slate-900">Batalkan pesanan?</h3>
            <p className="mt-1 text-sm text-slate-500">
              {cancelOrder.order_no} · {fmtIDR(cancelOrder.total)}
            </p>
            <input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Alasan batal"
              className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setCancelOrder(null)} className="rounded-xl px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">
                Tutup
              </button>
              <button
                disabled={cancelReason.trim().length < 3 || mCancel.isPending}
                onClick={() => mCancel.mutate({ order: cancelOrder, reason: cancelReason.trim() })}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-60"
              >
                Batalkan pesanan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CashPayPanel({
  order, onClose, onCash, onQris, cashPending, qrisPending,
}: {
  order: Order;
  onClose: () => void;
  onCash: (method: "cash" | "card", tendered?: number) => void;
  onQris: () => void;
  cashPending: boolean;
  qrisPending: boolean;
}) {
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [tendered, setTendered] = useState<string>("");
  const [confirm, setConfirm] = useState(false);
  const tenderNum = Number(tendered || 0);
  const valid = method === "card" || tenderNum >= order.total;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Terima pembayaran</div>
            <div className="mt-1 text-2xl font-black text-slate-900">{order.order_no}</div>
            <div className="text-sm text-slate-500">{order.customer_phone}</div>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2">
          {([
            ["cash", "Tunai", Banknote],
            ["card", "Kartu", CreditCard],
            ["qris", "QRIS", QrCode],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => {
                if (key === "qris") onQris();
                else setMethod(key);
              }}
              disabled={key === "qris" && qrisPending}
              className={`rounded-2xl border p-3 text-sm font-bold ${
                method === key ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
              } ${key === "qris" ? "col-span-3 mt-1 inline-flex items-center justify-center gap-2" : ""}`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {method === "cash" && (
          <div className="mt-4">
            <div className="mb-1 text-sm font-bold text-slate-600">Uang tunai diterima</div>
            <input
              inputMode="numeric"
              value={tendered}
              onChange={(e) => setTendered(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="0"
              className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-right text-lg font-bold outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {[5000, 10000, 20000, 50000, 100000].map((v) => (
                <button
                  key={v}
                  onClick={() => setTendered(String(v))}
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200"
                >
                  {fmtIDR(v)}
                </button>
              ))}
            </div>
            <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Total <span className="font-bold text-slate-900">{fmtIDR(order.total)}</span>
              {valid && (
                <span className="float-right font-bold text-emerald-600">
                  Kembali {fmtIDR(Math.max(0, tenderNum - order.total))}
                </span>
              )}
            </div>
          </div>
        )}

        {!confirm ? (
          <button
            onClick={() => setConfirm(true)}
            disabled={!valid || cashPending}
            className="mt-5 w-full rounded-2xl bg-emerald-600 py-3 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {method === "cash" ? "Lanjut bayar tunai" : "Lanjut bayar kartu"}
          </button>
        ) : (
          <div className="mt-5 space-y-2">
            <button
              onClick={() => onCash(method, method === "cash" ? tenderNum : undefined)}
              disabled={cashPending}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {cashPending ? "Memproses…" : `Konfirmasi lunas ${fmtIDR(order.total)}`}
            </button>
            <button onClick={() => setConfirm(false)} className="w-full rounded-2xl py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">
              Kembali
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
