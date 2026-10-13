import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote, CreditCard, QrCode } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPost } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { enqueueOrder, queuedCount } from "@/lib/offlineQueue";
import { plain, rupiah } from "@/lib/format";
import type { DiscountType, Order, OrderCreate, OrderLineIn, PaymentMethod } from "@/lib/types";
import { cn } from "@/lib/utils";

const METHODS: { id: PaymentMethod; label: string; icon: typeof Banknote }[] = [
  { id: "cash", label: "Tunai", icon: Banknote },
  { id: "qris", label: "QRIS", icon: QrCode },
  { id: "card", label: "Kartu", icon: CreditCard },
];

// crypto.randomUUID() needs a secure context (https or localhost); on plain-http LAN it is
// unavailable, so fall back to a random client-generated id (uniqueness, not secrecy).
const newOrderId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;

export default function CheckoutDialog({
  open,
  onOpenChange,
  lines,
  total: subtotal,
  onDone,
  storeId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: OrderLineIn[];
  total: number;
  onDone: (o: Order) => void;
  storeId: string | null;
}) {
  const qc = useQueryClient();
  // Idempotency key for the whole checkout session: if the request is retried (network hiccup,
  // double tap), the server returns the already-created order instead of charging twice.
  const [clientOrderId, setClientOrderId] = useState(() => newOrderId());
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [cash, setCash] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [dMode, setDMode] = useState<"none" | DiscountType>("none");
  const [dVal, setDVal] = useState("");
  const [dNote, setDNote] = useState("");
  const [approvalPin, setApprovalPin] = useState("");
  const { me, store } = useActiveStore();
  const cap = store?.discount_cap ?? 10;
  const dNum = dMode === "none" || dVal === "" ? 0 : Number(dVal);
  const discountError = dMode === "percent" ? dNum > 100 : dMode === "fixed" ? dNum > subtotal : false;
  // Same rounding as the server (nearest Rupiah); the server recalculates and has the final say.
  const discount = discountError ? 0 : dMode === "percent" ? Math.floor((subtotal * dNum + 50) / 100) : dMode === "fixed" ? dNum : 0;
  const total = subtotal - discount;
  const tendered = cash === "" ? total : Number(cash);
  const change = tendered - total;
  const quick = [...new Set([total, 20000, 50000, 100000, Math.ceil(total / 50000) * 50000].filter((v) => v >= total))].sort((a, b) => a - b).slice(0, 4);

  // Cashier discounts above the store cap need the owner approval PIN (server enforces too).
  const needsApproval = !!me && me.role !== "owner" && discount > 0 && discount * 100 > cap * subtotal;
  const resetForm = () => {
    setCash("");
    setName("");
    setPhone("");
    setMethod("cash");
    setDMode("none");
    setDVal("");
    setDNote("");
    setApprovalPin("");
  };

  const mutation = useMutation({
    mutationFn: (body: OrderCreate) => apiPost<Order>("/orders", body),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success(`Pesanan ${order.order_no} tersimpan`);
      resetForm();
      setClientOrderId(newOrderId()); // next checkout gets a fresh idempotency key
      onDone(order);
    },
    onError: (err, body) => {
      if (!(err instanceof ApiError)) {
        // Server unreachable: park the order locally; the background sync retries it.
        enqueueOrder(body);
        toast.info(`Tidak ada koneksi — pesanan disimpan offline (${queuedCount()} menunggu) dan terkirim otomatis`);
        resetForm();
        setClientOrderId(newOrderId());
        onOpenChange(false);
        return;
      }
      const detail = err.body && typeof err.body === "object" && "detail" in err.body ? String((err.body as { detail: unknown }).detail) : null;
      toast.error(detail ?? "Gagal menyimpan pesanan. Cek koneksi server.");
    },
  });

  const submit = () =>
    mutation.mutate({
      lines,
      payment_method: method,
      cash_tendered: method === "cash" ? tendered : null,
      customer_name: name.trim() || null,
      customer_phone: phone.trim() || null,
      discount_type: discount > 0 ? (dMode as DiscountType) : null,
      discount_value: discount > 0 ? dNum : 0,
      discount_note: discount > 0 ? dNote.trim() || null : null,
      store_id: storeId,
      client_order_id: clientOrderId,
      approval_pin: approvalPin || null,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="checkout-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">Pembayaran</DialogTitle>
          <DialogDescription>{discount > 0 ? `Subtotal ${rupiah(subtotal)} - diskon ${rupiah(discount)}` : "Total tagihan"}</DialogDescription>
          <div className="font-heading text-4xl font-bold tracking-tight text-teal-deep" data-testid="checkout-total">
            {rupiah(total)}
          </div>
        </DialogHeader>

        <div className="space-y-2 rounded-xl border border-dashed border-teal-brand/40 p-3" data-testid="discount-section">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm font-semibold text-teal-deep">Diskon / promo</Label>
            <div className="flex gap-1 rounded-full bg-mint p-1" role="tablist" aria-label="Jenis diskon">
              {(
                [
                  ["none", "Tanpa"],
                  ["percent", "%"],
                  ["fixed", "Rp"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={dMode === id}
                  data-testid={`discount-mode-${id}`}
                  onClick={() => {
                    setDMode(id);
                    setDVal("");
                  }}
                  className={cn("rounded-full px-3 py-1 text-xs font-semibold transition-colors", dMode === id ? "bg-teal-brand text-white" : "text-teal-deep hover:bg-white/60")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {dMode !== "none" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  inputMode="numeric"
                  value={dVal === "" ? "" : dMode === "fixed" ? plain(Number(dVal)) : dVal}
                  onChange={(e) => setDVal(e.target.value.replace(/\D/g, "").slice(0, dMode === "percent" ? 3 : 9))}
                  placeholder={dMode === "percent" ? "mis. 10" : "mis. 5.000"}
                  className="h-9 w-32 font-mono"
                  data-testid="discount-value-input"
                />
                <span className="text-sm text-muted-foreground">{dMode === "percent" ? "%" : "Rupiah"}</span>
                {dMode === "percent" &&
                  [5, 10, 15, 20].map((v) => (
                    <Button key={v} type="button" variant="outline" size="sm" className="rounded-full" onClick={() => setDVal(String(v))} data-testid={`discount-quick-${v}`}>
                      {v}%
                    </Button>
                  ))}
              </div>
              <Input value={dNote} onChange={(e) => setDNote(e.target.value)} maxLength={60} placeholder="Keterangan promo (opsional), mis. member / kemerdekaan" className="h-9" data-testid="discount-note-input" />
              {needsApproval && (
                <div>
                  <Input
                    inputMode="numeric"
                    value={approvalPin}
                    onChange={(e) => setApprovalPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder={`PIN owner — diskon di atas ${cap}% butuh izin`}
                    className="h-9"
                    data-testid="discount-approval-pin"
                  />
                  <p className="mt-1 text-xs text-amber-700">Minta owner memasukkan PIN persetujuan (diatur di Admin → Toko).</p>
                </div>
              )}
              {discountError && (
                <p className="text-xs text-destructive" data-testid="discount-error">
                  {dMode === "percent" ? "Diskon maksimal 100%." : "Diskon tidak boleh lebih besar dari total belanja."}
                </p>
              )}
              {discount > 0 && (
                <p className="text-xs font-semibold text-teal-deep" data-testid="discount-applied">
                  Potongan {rupiah(discount)}
                </p>
              )}
            </>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Metode pembayaran">
          {METHODS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={method === id}
              data-testid={`payment-tab-${id}`}
              onClick={() => setMethod(id)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl border-2 py-3 text-sm font-semibold transition-[border-color,background-color,transform] duration-150 active:scale-95",
                method === id ? "border-teal-brand bg-mint text-teal-deep" : "border-border text-muted-foreground hover:border-teal-brand/50",
              )}
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </div>

        {method === "cash" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cash-tendered">Uang diterima</Label>
              <Input
                id="cash-tendered"
                inputMode="numeric"
                placeholder={plain(total)}
                value={cash === "" ? "" : plain(Number(cash))}
                onChange={(e) => setCash(e.target.value.replace(/\D/g, "").slice(0, 9))}
                className="h-11 font-mono text-lg"
                data-testid="cash-tendered-input"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {quick.map((v, i) => (
                <Button
                  key={v}
                  variant="outline"
                  size="sm"
                  className="rounded-full font-mono"
                  data-testid={i === 0 ? "quick-cash-exact" : `quick-cash-${v / 1000}k`}
                  onClick={() => setCash(String(v))}
                >
                  {i === 0 ? "Uang pas" : plain(v)}
                </Button>
              ))}
            </div>
            <div
              className={cn("flex items-center justify-between rounded-xl px-4 py-3", change < 0 ? "bg-red-50 text-destructive" : "bg-zest/40 text-teal-deep")}
              data-testid="payment-change-display"
            >
              <span className="text-sm font-semibold">{change < 0 ? "Kurang" : "Kembalian"}</span>
              <span className="font-mono text-lg font-semibold">{rupiah(Math.abs(change))}</span>
            </div>
          </div>
        )}
        {method === "qris" && (
          <p className="rounded-xl bg-mint px-4 py-3 text-sm text-teal-deep" data-testid="qris-hint">
            Minta pelanggan scan QRIS toko, lalu konfirmasi setelah pembayaran masuk.
          </p>
        )}
        {method === "card" && (
          <p className="rounded-xl bg-mint px-4 py-3 text-sm text-teal-deep" data-testid="card-hint">
            Proses di mesin EDC, lalu konfirmasi setelah transaksi berhasil.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="customer-name">Nama pelanggan (opsional)</Label>
          <Input id="customer-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="customer-name-input" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="customer-phone">No. WhatsApp pelanggan (opsional, untuk kirim struk)</Label>
          <Input id="customer-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, "").slice(0, 20))} placeholder="08..." data-testid="customer-phone-input" />
        </div>

        <Button
          size="lg"
          className="h-12 rounded-full bg-teal-brand text-base font-semibold hover:bg-teal-deep"
          disabled={mutation.isPending || discountError || (method === "cash" && change < 0) || (needsApproval && approvalPin.length < 4)}
          onClick={submit}
          data-testid="complete-payment-button"
        >
          {mutation.isPending ? "Menyimpan..." : "Selesaikan Pembayaran"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
