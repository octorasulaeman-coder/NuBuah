import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, CalendarClock, CreditCard, QrCode } from "lucide-react";
import { toast } from "sonner";
import { apiGet, ApiError, apiPost } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { rupiah } from "@/lib/format";
import type { Customer, DiscountType, Order, PaymentAttemptPublic, PaymentsConfig, PaymentMethod } from "@/lib/types";
import QrisPaymentDialog from "@/components/payments/QrisPaymentDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Pending customer (phone) orders for today — the cashier takes payment at pickup.
 * After payment the parent opens the standard ReceiptSuccessDialog (format choice + download). */
export default function CustomerOrdersDialog({ open, onClose, onPaid }: { open: boolean; onClose: () => void; onPaid?: (order: Order) => void }) {
  const qc = useQueryClient();
  const { storeId, isOwner, store } = useActiveStore();
  const [paying, setPaying] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [cash, setCash] = useState("");
  const [cashTouched, setCashTouched] = useState(false);
  const [dMode, setDMode] = useState<"none" | DiscountType>("none");
  const [dVal, setDVal] = useState("");
  const [dNote, setDNote] = useState("");
  const [approvalPin, setApprovalPin] = useState("");
  const [canceling, setCanceling] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  // P3: when a payment provider is configured, QRIS goes through a real attempt
  // (QR + backend-confirmed status). Without one, QRIS stays a manual record as before.
  const [qrisAttempt, setQrisAttempt] = useState<PaymentAttemptPublic | null>(null);
  const [qrisOrder, setQrisOrder] = useState<Order | null>(null);
  const paymentsConfig = useQuery({
    queryKey: ["payments-config"],
    queryFn: () => apiGet<PaymentsConfig>("/payments/config"),
    staleTime: 300_000,
    retry: false,
  });
  const qrisOnline = paymentsConfig.data?.enabled === true && (paymentsConfig.data.methods ?? []).includes("qris");
  const intent = useMutation({
    mutationFn: (order: Order) =>
      apiPost<PaymentAttemptPublic>("/payments/intents", { order_id: order.id, method: "qris", idempotency_key: crypto.randomUUID() }),
    onSuccess: (att) => setQrisAttempt(att),
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Gagal membuat kode QR");
      setPaying(null);
      setQrisOrder(null);
    },
  });
  const cap = store?.discount_cap ?? 10;

  const q = useQuery({
    queryKey: ["orders", "pending", storeId],
    queryFn: () => apiGet<Order[]>(`/orders/pending${storeId ? `?store_id=${storeId}` : ""}`),
    enabled: open && !!storeId,
    refetchInterval: 15_000,
  });

  // P5: surface the customer's points balance at payment confirmation. Must live BELOW
  // the `q` declaration — a hook may not reference bindings declared later (TDZ crash).
  const payingOrder = (q.data ?? []).find((o) => o.id === paying);
  const payerPoints = useQuery({
    queryKey: ["customer-by-phone", payingOrder?.customer_phone ?? ""],
    queryFn: () => apiGet<Customer[]>(`/customers?search=${encodeURIComponent(payingOrder!.customer_phone!)}`),
    enabled: !!payingOrder?.customer_phone,
    staleTime: 15_000,
  });
  const payer = payerPoints.data?.find((c) => c.phone === payingOrder?.customer_phone) ?? null;

  const pay = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { payment_method: PaymentMethod; cash_tendered: number | null; discount_type: DiscountType | null; discount_value: number; discount_note: string | null; approval_pin: string | null };
    }) => apiPost<Order>(`/orders/${id}/pay`, body),
    onSuccess: (order) => {
      toast.success(`${order.order_no} lunas — ${rupiah(order.total)}`);
      setPaying(null);
      setCash("");
      setCashTouched(false);
      setDMode("none");
      setDVal("");
      setDNote("");
      setApprovalPin("");
      qc.invalidateQueries({ queryKey: ["orders"] });
      onPaid?.(order); // parent shows the standard receipt dialog (format choice, no auto-print)
    },
    onError: (e) => {
      const detail = e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in e.body ? String((e.body as { detail: unknown }).detail) : null;
      toast.error(detail ?? "Gagal. Coba lagi.");
    },
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => apiPost<Order>(`/orders/${id}/cancel`, { reason }),
    onSuccess: (order) => {
      toast.success(`${order.order_no} dibatalkan`);
      setCanceling(null);
      setCancelReason("");
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e) => {
      const detail = e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in e.body ? String((e.body as { detail: unknown }).detail) : null;
      toast.error(detail ?? "Gagal. Coba lagi.");
    },
  });

  if (!open) return null;

  const discountOf = (subtotal: number) => {
    if (dMode === "none" || !dVal) return 0;
    const v = Number(dVal) || 0;
    if (dMode === "percent") return Math.round((subtotal * Math.min(v, 100)) / 100);
    return Math.min(v, subtotal);
  };

  const orders = q.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} data-testid="customer-orders-dialog">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-heading text-lg font-extrabold italic text-teal-deep">Pesanan online — belum bayar</h3>
          <button onClick={onClose} className="text-sm font-semibold text-muted-foreground">Tutup</button>
        </div>
        {q.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Memuat…</p>}
        {!q.isLoading && orders.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="customer-orders-empty">
            Tidak ada pesanan yang menunggu pembayaran.
          </p>
        )}

        <ul className="grid gap-2 lg:grid-cols-2">
          {orders.map((o) => (
            <li key={o.id} className="rounded-xl border p-3" data-testid={`pending-order-${o.order_no}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-teal-deep">{o.order_no}</span>
                <span className="text-xs text-muted-foreground">{new Date(o.created_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              {o.fulfillment === "scheduled" && o.scheduled_for && (
                <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-teal-deep" data-testid={`pickup-${o.order_no}`}>
                  <CalendarClock size={12} /> Ambil: {new Date(o.scheduled_for).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
              <p className="mt-1 text-sm">
                {o.customer_name ? `${o.customer_name} · ` : ""}
                <span className="text-muted-foreground">{o.customer_phone}</span>
              </p>
              <ul className="mt-1 space-y-1" data-testid={`pending-lines-${o.order_no}`}>
                {o.lines.map((l, i) => (
                  <li key={i} className="text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {l.qty}× {l.name}
                      </span>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">{rupiah(l.line_total ?? l.unit_price * l.qty)}</span>
                    </div>
                    {l.options?.length > 0 && (
                      <p className="pl-4 text-xs leading-snug text-muted-foreground">{l.options.map((op) => op.label).join(", ")}</p>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-heading text-base font-extrabold">{rupiah(o.total)}</span>
                {paying !== o.id && canceling !== o.id ? (
                  <div className="flex items-center gap-2">
                    <Button size="sm" className="rounded-full bg-teal-brand hover:bg-teal-deep" onClick={() => { setPaying(o.id); setMethod("cash"); setCash(String(o.total)); setCashTouched(false); setDMode("none"); setDVal(""); setDNote(""); setApprovalPin(""); }} data-testid={`pay-button-${o.order_no}`}>
                      Terima bayar
                    </Button>
                    <Button size="sm" variant="ghost" className="rounded-full text-destructive hover:text-destructive" onClick={() => { setCanceling(o.id); setCancelReason(""); }} data-testid={`cancel-button-${o.order_no}`}>
                      Batal
                    </Button>
                  </div>
                ) : canceling === o.id ? (
                  <span className="text-xs font-semibold text-amber-700">membatalkan…</span>
                ) : (
                  <span className="text-xs font-semibold text-amber-700">diproses…</span>
                )}
              </div>

              {canceling === o.id && (
                <div className="mt-3 space-y-2 rounded-lg bg-red-50 p-2" data-testid={`cancel-form-${o.order_no}`}>
                  <Input
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    maxLength={120}
                    placeholder="Alasan batal — mis. tidak jadi, duplikat, pelanggan batal"
                    className="h-8 bg-white"
                    data-testid={`cancel-reason-${o.order_no}`}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      className="flex-1 rounded-full"
                      disabled={cancel.isPending || cancelReason.trim().length < 2}
                      onClick={() => cancel.mutate({ id: o.id, reason: cancelReason.trim() })}
                      data-testid={`confirm-cancel-${o.order_no}`}
                    >
                      {cancel.isPending ? "Menyimpan…" : "Ya, batalkan pesanan"}
                    </Button>
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => setCanceling(null)}>Kembali</Button>
                  </div>
                </div>
              )}

              {paying === o.id && (() => {
                const disc = discountOf(o.total);
                const grand = o.total - disc;
                const needsApproval = !isOwner && disc > 0 && (o.total === 0 || disc * 100 > cap * o.total);
                const cashNum = cash === "" ? grand : Number(cash) || 0;
                return (
                <div className="mt-3 space-y-2 rounded-lg bg-muted/60 p-2" data-testid={`pay-form-${o.order_no}`}>
                  <div className="flex gap-1.5">
                    {(
                      [
                        ["cash", "Tunai", Banknote],
                        ["qris", "QRIS", QrCode],
                        ["card", "Kartu", CreditCard],
                      ] as const
                    ).map(([m, label, Icon]) => (
                      <button
                        key={m}
                        onClick={() => setMethod(m)}
                        className={`flex flex-1 items-center justify-center gap-1 rounded-full border px-2 py-1.5 text-xs font-semibold ${method === m ? "border-teal-brand bg-mint text-teal-deep" : "bg-white"}`}
                      >
                        <Icon size={13} /> {label}
                      </button>
                    ))}
                  </div>
                  {method === "cash" && (
                    <div className="flex items-center gap-2">
                      <Input
                        inputMode="numeric"
                        value={cash}
                        onChange={(e) => { setCashTouched(true); setCash(e.target.value.replace(/\D/g, "").slice(0, 9)); }}
                        onFocus={() => setCashTouched(true)}
                        className="h-8"
                        data-testid={`cash-input-${o.order_no}`}
                      />
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {cash === "" ? `uang pas ${rupiah(grand)}` : `kembali ${rupiah(Math.max(0, cashNum - grand))}`}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <select
                      value={dMode}
                      onChange={(e) => {
                        const m = e.target.value as "none" | DiscountType;
                        setDMode(m);
                        const d = discountOf(o.total);
                        if (!cashTouched) setCash(String(o.total - d));
                      }}
                      className="h-8 rounded-md border bg-white px-2 text-xs"
                      data-testid={`discount-mode-${o.order_no}`}
                    >
                      <option value="none">Tanpa diskon</option>
                      <option value="percent">Diskon %</option>
                      <option value="fixed">Diskon Rp</option>
                    </select>
                    {dMode !== "none" && (
                      <Input
                        inputMode="numeric"
                        value={dVal}
                        onChange={(e) => {
                          setDVal(e.target.value.replace(/\D/g, "").slice(0, 7));
                          const v = Number(e.target.value.replace(/\D/g, "")) || 0;
                          const d = dMode === "percent" ? Math.round((o.total * Math.min(v, 100)) / 100) : Math.min(v, o.total);
                          if (!cashTouched) setCash(String(o.total - d));
                        }}
                        placeholder={dMode === "percent" ? "%" : "Rp"}
                        className="h-8 w-24"
                        data-testid={`discount-value-${o.order_no}`}
                      />
                    )}
                  </div>
                  {dMode !== "none" && (
                    <Input value={dNote} onChange={(e) => setDNote(e.target.value)} maxLength={60} placeholder="Keterangan promo (opsional)" className="h-8" data-testid={`discount-note-${o.order_no}`} />
                  )}
                  {needsApproval && (
                    <Input
                      inputMode="numeric"
                      value={approvalPin}
                      onChange={(e) => setApprovalPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder={`PIN owner — diskon di atas ${cap}% butuh izin`}
                      className="h-8"
                      data-testid={`approval-pin-${o.order_no}`}
                    />
                  )}
                  {disc > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Diskon {rupiah(disc)}{dNote.trim() ? ` · ${dNote.trim()}` : ""} → total <b>{rupiah(grand)}</b>
                    </p>
                  )}
                  {payer && (
                    <p className="rounded-full bg-mint px-3 py-1 text-[11px] font-semibold text-teal-deep" data-testid="payer-points">
                      {payer.name} — saldo {payer.points} poin
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 rounded-full bg-teal-brand hover:bg-teal-deep"
                      disabled={
                        pay.isPending ||
                        intent.isPending ||
                        (method === "cash" && cashNum < grand) ||
                        (needsApproval && approvalPin.length < 4) ||
                        (dMode !== "none" && !dVal)
                      }
                      onClick={() => {
                        if (method === "qris" && qrisOnline) {
                          // start a real payment attempt; the QR dialog reports the outcome
                          setQrisOrder(o);
                          intent.mutate(o);
                          return;
                        }
                        pay.mutate({
                          id: o.id,
                          body: {
                            payment_method: method,
                            cash_tendered: method === "cash" ? (cash === "" ? grand : Number(cash)) : null,
                            discount_type: dMode === "none" ? null : dMode,
                            discount_value: dMode === "none" ? 0 : Number(dVal) || 0,
                            discount_note: dNote.trim() || null,
                            approval_pin: approvalPin || null,
                          },
                        })
                      }}
                      data-testid={`confirm-pay-${o.order_no}`}
                    >
                      {pay.isPending ? "Menyimpan…" : `Lunas — ${rupiah(grand)}`}
                    </Button>
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => setPaying(null)}>Batal</Button>
                  </div>
                </div>
                );
              })()}
            </li>
          ))}
        </ul>
      </div>
      {qrisAttempt && (
        <QrisPaymentDialog
          attempt={qrisAttempt}
          pollBase="/payments"
          onPaid={() => {
            toast.success("Pembayaran diterima");
            setQrisAttempt(null);
            setQrisOrder(null);
            setPaying(null);
            qc.invalidateQueries({ queryKey: ["orders", "pending", storeId] });
          }}
          onRetry={() => {
            if (qrisOrder) intent.mutate(qrisOrder);
          }}
          onClose={() => {
            setQrisAttempt(null);
            setQrisOrder(null);
            setPaying(null);
          }}
        />
      )}
    </div>
  );
}
