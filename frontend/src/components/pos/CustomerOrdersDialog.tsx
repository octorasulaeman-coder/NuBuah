import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  X, Search, QrCode, Banknote, RefreshCcw,
  CalendarClock, CheckCircle2, Clock,
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { CashierQueue, Customer, DiscountType, Order, OrderStatus, PaymentAttemptPublic } from "@/lib/types";
import { useActiveStore } from "@/lib/auth";
import { rupiah, fmtLongDateTimeWIB } from "@/lib/format";
import QrisPaymentDialog from "@/components/payments/QrisPaymentDialog";

const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  received: "confirmed",
  confirmed: "preparing",
  preparing: "ready",
  ready: "completed",
};

const EMPTY_QUEUE: CashierQueue = { unpaid: [], processing: [], ready: [], completed: [] };

type PayAdjustments = {
  tendered?: number;
  discount_type?: "percent" | "fixed" | null;
  discount_value?: number;
  discount_note?: string;
  coupon_code?: string;
  redeem_points?: number;
  approval_pin?: string;
};

function itemSummary(o: Order): string {
  const names = o.lines.map((l) => l.name).filter(Boolean);
  const suffix = names.length > 3 ? ` +${names.length - 3}` : "";
  return `${names.slice(0, 3).join(", ")}${suffix} · ${o.item_count} item`;
}

function fulfillmentBadge(o: Order) {
  if (o.fulfillment === "scheduled" && o.scheduled_for) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">
        <CalendarClock className="h-3.5 w-3.5" /> Terjadwal · {fmtLongDateTimeWIB(o.scheduled_for)}
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

export function CustomerOrdersDialog({
  open, onClose, storeId, onPaid,
}: {
  open: boolean;
  onClose: () => void;
  storeId?: string | null;
  onPaid?: (order: Order) => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"action" | "processing" | "ready" | "history">("action");
  const [historyDays, setHistoryDays] = useState<1 | 7>(7);
  const [search, setSearch] = useState("");
  const [payingOrder, setPayingOrder] = useState<Order | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["orders", "cashier-queue", storeId, historyDays],
    enabled: open && !!storeId,
    queryFn: () => apiGet<CashierQueue>(`/orders/cashier-queue?store_id=${storeId}&include_completed=true&history_days=${historyDays}`),
    refetchInterval: 10_000,
  });
  const queue = q.data ?? EMPTY_QUEUE;

  const filtered = useMemo(() => {
    const rows = {
      action: queue.unpaid.filter((o) => matchesSearch(o, search)),
      processing: queue.processing.filter((o) => matchesSearch(o, search)),
      ready: queue.ready.filter((o) => matchesSearch(o, search)),
      history: queue.completed.filter((o) => matchesSearch(o, search)),
    };
    return rows;
  }, [queue, search]);

  const counts = useMemo(() => ({
    action: queue.unpaid.length,
    processing: queue.processing.length,
    ready: queue.ready.length,
    history: queue.completed.length,
  }), [queue]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["orders", "cashier-queue"] });

  const mAdvance = useMutation({
    mutationFn: async (o: Order) => {
      const status = o.status as OrderStatus | undefined;
      const next = status ? NEXT_STATUS[status] : undefined;
      if (!next) return o;
      return apiPost<Order>(`/orders/${o.id}/status`, { status: next });
    },
    onSuccess: (_d, o) => {
      toast.success(o.status === "ready" ? "Pesanan ditandai sudah diambil" : "Status pesanan diperbarui");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mMarkReady = useMutation({
    mutationFn: async (o: Order) => apiPost<Order>(`/orders/${o.id}/ready`, {}),
    onSuccess: () => {
      toast.success("Pesanan ditandai siap");
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
    mutationFn: async ({ order, ...adjustments }: { order: Order } & PayAdjustments) => {
      const paid = await apiPost<Order>(`/orders/${order.id}/pay`, {
        payment_method: "cash",
        cash_tendered: adjustments.tendered,
        discount_type: adjustments.discount_type || undefined,
        discount_value: adjustments.discount_value,
        discount_note: adjustments.discount_note || undefined,
        coupon_code: adjustments.coupon_code || undefined,
        redeem_points: adjustments.redeem_points,
        approval_pin: adjustments.approval_pin || undefined,
      });
      return { paid, tendered: adjustments.tendered };
    },
    onSuccess: ({ paid, tendered }) => {
      toast.success(
        tendered != null ? `Lunas. Kembalian ${rupiah(Math.max(0, tendered - paid.total))} · tunai ${rupiah(tendered)}` : "Lunas.",
      );
      setPayingOrder(null);
      invalidate();
      onPaid?.(paid);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mQris = useMutation({
    mutationFn: async (order: Order) => {
      const attempt = await apiPost<PaymentAttemptPublic>("/payments/intents", {
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
    { key: "ready" as const, label: "Belum diambil", count: counts.ready },
    { key: "history" as const, label: "Riwayat", count: counts.history },
  ];

  const renderOrder = (o: Order, opts: { actionTab?: boolean }) => {
    const status = o.status as OrderStatus | undefined;
    const unpaid = o.payment_status !== "paid";
    const terminal = status === "completed" || status === "cancelled";
    const isCashierOrder = o.channel !== "customer";
    const showPayAtPickup = !!o.pay_at_pickup || (isCashierOrder && o.fulfillment === "scheduled" && unpaid);
    const canAdvance = !!status && !!NEXT_STATUS[status];
    const primaryLabel = unpaid ? "Terima bayar" : status === "ready" ? "Sudah diambil" : "Tandai Siap";
    return (
      <div key={o.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-extrabold tracking-tight text-slate-900">{o.order_no}</span>
              <span className={`rounded-full px-2 py-1 text-xs font-bold ${isCashierOrder ? "bg-slate-200 text-slate-700" : "bg-teal-100 text-teal-700"}`}>
                {isCashierOrder ? "Kasir" : "Customer"}
              </span>
              {showPayAtPickup && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700">Bayar saat ambil</span>}
              {paymentBadge(o)}
              {status === "ready" && <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold text-green-700">Siap diambil</span>}
              {status === "completed" && <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">Selesai</span>}
              {status === "cancelled" && <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-bold text-red-700">Dibatalkan</span>}
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
            <div className="text-xl font-black text-slate-900">{rupiah(o.total)}</div>
            <div className="text-xs text-slate-500">{itemSummary(o)}</div>
          </div>
        </div>

        <div className="mt-3">
          <button
            onClick={() => setDetailId(detailId === o.id ? null : o.id)}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-200"
          >
            {detailId === o.id ? "Sembunyikan detail" : "Lihat detail"}
          </button>
        </div>

        {detailId === o.id && (
          <div className="mt-3 rounded-2xl bg-slate-50 p-3">
            <div className="space-y-2">
              {o.lines.map((line, idx) => {
                const options = (line.options ?? []).map((opt) => opt.label).join(", ");
                return (
                  <div key={`${line.product_id}-${idx}`} className="flex items-start justify-between gap-3 border-b border-slate-200 pb-2 last:border-0 last:pb-0">
                    <div>
                      <div className="text-sm font-bold text-slate-800">
                        {line.qty} × {line.name}
                        {line.size ? ` (${line.size})` : ""}
                      </div>
                      {options && <div className="mt-0.5 text-xs text-slate-500">{options}</div>}
                      {line.note && <div className="mt-0.5 text-xs italic text-slate-500">Catatan: {line.note}</div>}
                    </div>
                    <div className="text-sm font-bold text-slate-700">{rupiah(line.line_total)}</div>
                  </div>
                );
              })}
            </div>
            {o.discount_note && (
              <div className="mt-3 rounded-xl bg-white px-3 py-2 text-xs text-slate-600">
                <span className="font-bold">Catatan diskon:</span> {o.discount_note}
              </div>
            )}
          </div>
        )}

        {!terminal && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {unpaid ? (
              <>
                <button
                  onClick={() => setPayingOrder(o)}
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
            ) : canAdvance ? (
              <button
                disabled={status === "ready" ? mAdvance.isPending : mMarkReady.isPending}
                onClick={() => (status === "ready" ? mAdvance.mutate(o) : mMarkReady.mutate(o))}
                className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-60"
              >
                <CheckCircle2 className="h-4 w-4" /> {primaryLabel}
              </button>
            ) : null}
          </div>
        )}
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
          {tab === "history" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {([
                [1, "Hari ini"],
                [7, "7 hari"],
              ] as const).map(([days, label]) => (
                <button
                  key={days}
                  onClick={() => setHistoryDays(days)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                    historyDays === days ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
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
              {tab === "ready" && "Tidak ada pesanan lunas yang menunggu diambil."}
              {tab === "history" && "Belum ada riwayat pesanan pelanggan."}
            </div>
          )}
          {rows.map((o) => renderOrder(o, { actionTab: tab === "action" }))}
        </div>
      </div>

      {payingOrder && (
        <CashPayPanel
          order={payingOrder}
          storeId={storeId}
          onClose={() => setPayingOrder(null)}
          onCash={(adjustments) => mCashPay.mutate({ order: payingOrder, ...adjustments })}
          onQris={() => mQris.mutate(payingOrder)}
          cashPending={mCashPay.isPending}
          qrisPending={mQris.isPending}
        />
      )}

      {mQris.data && (
        <QrisPaymentDialog
          attempt={mQris.data.attempt}
          pollBase="/payments"
          onClose={() => mQris.reset()}
          onPaid={() => {
            const current = mQris.data;
            if (current) {
              onPaid?.({ ...current.order, payment_status: "paid", payment_method: "qris" });
            }
            mQris.reset();
            setPayingOrder(null);
            invalidate();
          }}
          onRetry={() => {
            const current = mQris.data;
            if (current) mQris.mutate(current.order);
          }}
        />
      )}

      {cancelOrder && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/45" onClick={() => setCancelOrder(null)} />
          <div className="relative w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-extrabold text-slate-900">Batalkan pesanan?</h3>
            <p className="mt-1 text-sm text-slate-500">
              {cancelOrder.order_no} · {rupiah(cancelOrder.total)}
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
  order, storeId, onClose, onCash, onQris, cashPending, qrisPending,
}: {
  order: Order;
  storeId?: string | null;
  onClose: () => void;
  onCash: (adjustments: PayAdjustments) => void;
  onQris: () => void;
  cashPending: boolean;
  qrisPending: boolean;
}) {
  const [tendered, setTendered] = useState<string>("");
  const [confirm, setConfirm] = useState(false);
  const [discountType, setDiscountType] = useState<"none" | "percent" | "fixed">(
    order.discount_type === "percent" || order.discount_type === "fixed" ? order.discount_type : "none",
  );
  const [discountValue, setDiscountValue] = useState<string>(order.discount_value ? String(order.discount_value) : "");
  const [discountNote, setDiscountNote] = useState<string>(order.discount_note ?? "");
  const [couponCode, setCouponCode] = useState<string>(order.coupon_code ?? "");
  const [pointsInput, setPointsInput] = useState<string>(order.points_redeemed ? String(order.points_redeemed) : "");
  const [approvalPin, setApprovalPin] = useState<string>("");
  const tenderNum = Number(tendered || 0);
  const { me, store } = useActiveStore();
  const cap = store?.discount_cap ?? 10;

  const couponLocked = !!order.coupon_code;
  const pointsLocked = !!order.points_redeemed;
  const trimmedCoupon = couponCode.trim();
  const customerIdentity = order.customer_phone ?? "";
  const memberIdentity = order.member_no ?? customerIdentity;
  const subtotal = order.lines.reduce((sum, line) => sum + line.line_total, 0);

  const customerQ = useQuery<Customer[]>({
    queryKey: ["customer-by-identity", storeId, memberIdentity],
    queryFn: () => apiGet(`/customers?search=${encodeURIComponent(memberIdentity.trim())}`),
    enabled: memberIdentity.trim().length >= 6, // member IDs are 8 chars (NB######) — don't gate them out
    staleTime: 30_000,
    retry: false,
  });
  const staffMatch =
    customerQ.data?.find((customer) =>
      customer.phone === memberIdentity.trim() || (customer.member_no ?? "") === memberIdentity.trim().toUpperCase(),
    ) ?? null;
  const looksLikeMemberId = /^[A-Za-z]/.test(memberIdentity.trim());
  const fallbackMemberQ = useQuery<{ found: boolean; name?: string; is_member?: boolean; points?: number; member_no?: string | null }>({
    queryKey: ["public-member-by-identity", memberIdentity.trim().toUpperCase()],
    // Member IDs (NB…) may exist in the public member registry even when the staff
    // customer search returns empty/fails, so always try the public lookup for IDs.
    enabled: !!memberIdentity && looksLikeMemberId,
    queryFn: () => apiPost("/public/points/lookup", { key: memberIdentity.trim().toUpperCase() }),
    retry: false,
  });
  const matchedCustomer =
    staffMatch ??
    (fallbackMemberQ.data?.found
      ? {
          id: `member:${fallbackMemberQ.data.member_no ?? memberIdentity}`,
          store_id: order.store_id,
          name: fallbackMemberQ.data.name ?? "Member",
          phone: customerIdentity || memberIdentity,
          member_no: fallbackMemberQ.data.member_no ?? null,
          is_member: !!fallbackMemberQ.data.is_member,
          points: fallbackMemberQ.data.points ?? 0,
          created_at: "",
          updated_at: "",
        }
      : null);

  const loyaltyQ = useQuery({
    queryKey: ["loyalty-config", storeId],
    queryFn: () => apiGet<{ redeem_value_per_point: number }>(`/loyalty/config${storeId ? `?store_id=${storeId}` : ""}`),
    staleTime: 300_000,
    retry: false,
  });

  const couponPreview = useMutation({
    mutationFn: async () => apiPost<{ amount: number }>(`/coupons/validate?store_id=${storeId}`, {
      code: trimmedCoupon,
      subtotal,
      lines: order.lines,
    }),
    onError: (e: Error) => toast.error(e.message),
  });

  const discountNum = Number(discountValue || 0);
  const discountAmount = discountType === "percent"
    ? Math.round((subtotal * discountNum) / 100)
    : discountType === "fixed"
      ? discountNum
      : 0;
  const discountErr = discountAmount > 0 && discountAmount > subtotal ? "Diskon melebihi total belanja" : null;
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  const couponAmount = couponLocked
    ? order.coupon_amount ?? 0
    : couponPreview.isSuccess ? Math.min(afterDiscount, couponPreview.data.amount) : 0;
  const pointsNum = Number(pointsInput || 0);
  const redeemValuePerPoint = loyaltyQ.data?.redeem_value_per_point ?? 10;
  const pointsValue = pointsLocked
    ? order.redeem_value_amount ?? pointsNum * redeemValuePerPoint
    : pointsNum * redeemValuePerPoint;
  const totalPayable = Math.max(0, afterDiscount - couponAmount - pointsValue);
  const needsApproval = !!me && me.role !== "owner" && discountAmount > 0 && discountAmount * 100 > cap * subtotal;
  const approvalOk = !needsApproval || approvalPin.trim().length > 0;
  const valid = tenderNum >= totalPayable && !discountErr && approvalOk;

  const quickCash = useMemo(() => {
    const values = Array.from(new Set([
      totalPayable,
      20000,
      50000,
      100000,
      Math.ceil(totalPayable / 50000) * 50000,
    ])).filter((v) => v >= totalPayable).sort((a, b) => a - b);
    return values.slice(0, 4);
  }, [totalPayable]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl">
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

        <div className="mt-4 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-slate-800">{order.customer_name || "Pelanggan"}</span>
            <span>·</span>
            <span>{order.customer_phone}</span>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Diskon / promo</div>
          <div className="grid grid-cols-3 gap-2">
            {(["none", "percent", "fixed"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setDiscountType(mode)}
                className={`rounded-xl px-3 py-2 text-xs font-bold ${discountType === mode ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {mode === "none" ? "Tanpa" : mode === "percent" ? "%" : "Rp"}
              </button>
            ))}
          </div>
          {discountType !== "none" && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  inputMode="numeric"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder={discountType === "percent" ? "0" : "0"}
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-right text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500"
                />
                {discountType === "percent" && (
                  <div className="flex gap-1">
                    {[5, 10, 15, 20].map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setDiscountValue(String(p))}
                        className={`rounded-full px-2 py-1 text-xs font-bold ${discountValue === String(p) ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                )}
                {discountType === "fixed" && <span className="text-xs font-semibold text-slate-500">Rupiah</span>}
              </div>
              <input
                value={discountNote}
                onChange={(e) => setDiscountNote(e.target.value)}
                placeholder="Keterangan promo (opsional), mis. member / kemerdekaan"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
              />
              {discountAmount > 0 && (
                <div className="text-xs font-semibold text-teal-deep">
                  Potongan {rupiah(discountAmount)}
                </div>
              )}
              {discountErr && <div className="text-xs font-semibold text-red-500">{discountErr}</div>}
              {needsApproval && (
                <>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={approvalPin}
                    onChange={(e) => setApprovalPin(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={`PIN owner — diskon di atas ${cap}% butuh izin`}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <p className="text-xs text-slate-500">
                    Minta owner memasukkan PIN persetujuan (diatur di Admin → Toko).
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Kupon</div>
          <div className="flex gap-2">
            <input
              value={couponCode}
              onChange={(e) => { setCouponCode(e.target.value.toUpperCase()); couponPreview.reset(); }}
              disabled={couponLocked}
              placeholder={couponLocked ? order.coupon_code ?? "" : "Kode kupon"}
              className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold uppercase outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100"
            />
            {!couponLocked && (
              <button
                type="button"
                disabled={!trimmedCoupon || couponPreview.isPending}
                onClick={() => couponPreview.mutate()}
                className="rounded-xl bg-slate-100 px-4 text-sm font-bold text-slate-600 hover:bg-slate-200 disabled:opacity-50"
              >
                Pakai
              </button>
            )}
          </div>
          {couponLocked && <div className="mt-1 text-xs text-slate-500">Kupon dari self-checkout tidak bisa diubah kasir.</div>}
          {!couponLocked && couponPreview.isSuccess && <div className="mt-1 text-xs font-semibold text-emerald-600">Kupon valid · potongan {rupiah(couponPreview.data.amount)}</div>}
          {!couponLocked && couponPreview.isError && <div className="mt-1 text-xs font-semibold text-red-500">{couponPreview.error.message}</div>}
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Poin</div>
          {pointsLocked ? (
            <>
              <input
                inputMode="numeric"
                value={pointsInput}
                onChange={(e) => setPointsInput(e.target.value.replace(/[^\d]/g, ""))}
                disabled
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-right text-sm font-bold outline-none disabled:bg-slate-100"
              />
              <div className="mt-1 text-xs text-slate-500">Poin dari self-checkout tidak bisa diubah kasir.</div>
            </>
          ) : matchedCustomer?.is_member ? (
            <>
              <div className="mb-2 text-xs text-slate-600">
                {matchedCustomer.name} · {matchedCustomer.member_no ?? matchedCustomer.phone} — saldo {matchedCustomer.points} poin
              </div>
              <input
                inputMode="numeric"
                value={pointsInput}
                onChange={(e) => setPointsInput(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="Poin"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-right text-sm font-bold outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </>
          ) : (
            <p className="text-xs text-slate-500">
              Customer ini belum teridentifikasi sebagai member. Masukkan/minta customer menggunakan No. HP atau ID member saat self-checkout untuk menukar poin.
            </p>
          )}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <div className="rounded-2xl border border-emerald-500 bg-emerald-50 p-3 text-center text-sm font-bold text-emerald-700">
            <Banknote className="mx-auto mb-1 h-4 w-4" /> Tunai
          </div>
          <button
            onClick={onQris}
            disabled={qrisPending}
            className="rounded-2xl border border-slate-200 p-3 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            <QrCode className="mx-auto mb-1 h-4 w-4" /> QRIS
          </button>
        </div>

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
            {quickCash.map((v) => (
              <button
                key={v}
                onClick={() => setTendered(String(v))}
                className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200"
              >
                {v === totalPayable ? "Uang pas" : rupiah(v)}
              </button>
            ))}
          </div>
          <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Subtotal <span className="float-right font-bold text-slate-900">{rupiah(subtotal)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="mt-1 rounded-2xl bg-slate-50 px-4 py-2 text-sm text-slate-600">
              Diskon <span className="float-right font-bold text-red-500">-{rupiah(discountAmount)}</span>
            </div>
          )}
          {couponAmount > 0 && (
            <div className="mt-1 rounded-2xl bg-slate-50 px-4 py-2 text-sm text-slate-600">
              Kupon <span className="float-right font-bold text-red-500">-{rupiah(couponAmount)}</span>
            </div>
          )}
          {pointsValue > 0 && (
            <div className="mt-1 rounded-2xl bg-slate-50 px-4 py-2 text-sm text-slate-600">
              Poin <span className="float-right font-bold text-red-500">-{rupiah(pointsValue)}</span>
            </div>
          )}
          <div className="mt-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">
            Total tagihan <span className="float-right text-lg">{rupiah(totalPayable)}</span>
            {valid && (
              <span className="mt-1 block text-right text-xs font-semibold">
                Kembali {rupiah(Math.max(0, tenderNum - totalPayable))}
              </span>
            )}
          </div>
        </div>

        {!confirm ? (
          <button
            onClick={() => setConfirm(true)}
            disabled={!valid || cashPending}
            className="mt-5 w-full rounded-2xl bg-emerald-600 py-3 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Lanjut bayar tunai
          </button>
        ) : (
          <div className="mt-5 space-y-2">
            <button
              onClick={() => onCash({
                tendered: tenderNum,
                discount_type: discountNum > 0 && discountType !== "none" ? discountType : undefined,
                discount_value: discountNum > 0 ? discountNum : undefined,
                discount_note: discountNum > 0 ? discountNote.trim() || undefined : undefined,
                coupon_code: couponLocked
                  ? order.coupon_code ?? undefined
                  : couponPreview.isSuccess ? trimmedCoupon.toUpperCase() : undefined,
                redeem_points: pointsLocked
                  ? order.points_redeemed ?? undefined
                  : matchedCustomer?.is_member ? pointsNum || undefined : undefined,
                approval_pin: needsApproval ? approvalPin.trim() || undefined : undefined,
              })}
              disabled={cashPending}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {cashPending ? "Memproses…" : `Konfirmasi lunas ${rupiah(totalPayable)}`}
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
