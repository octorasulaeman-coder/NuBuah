import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, QrCode } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { enqueueOrder, queuedCount } from "@/lib/offlineQueue";
import { plain, rupiah } from "@/lib/format";
import SchedulePicker from "@/components/SchedulePicker";
import type { Customer, DiscountType, Order, OrderCreate, OrderLineIn, PaymentMethod } from "@/lib/types";
import { cn } from "@/lib/utils";

// Card remains supported by the backend/API, but is intentionally hidden from the
// cashier UI per current store workflow (cash and QRIS only).
const METHODS: { id: PaymentMethod; label: string; icon: typeof Banknote }[] = [
  { id: "cash", label: "Tunai", icon: Banknote },
  { id: "qris", label: "QRIS", icon: QrCode },
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
  const [scheduled, setScheduled] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const [payAtPickup, setPayAtPickup] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [redeemPts, setRedeemPts] = useState("");
  const { me, store } = useActiveStore();

  // P5: coupon preview (server-priced against these exact lines) + points balance lookup
  const couponPreview = useMutation({
    mutationFn: () =>
      apiPost<{ code: string; amount: number }>(`/coupons/validate${storeId ? `?store_id=${storeId}` : ""}`, {
        code: couponCode.trim().toUpperCase(),
        subtotal,
        lines,
      }),
  });
  const customerQ = useQuery({
    queryKey: ["customer-by-phone", phone],
    queryFn: () => apiGet<Customer[]>(`/customers?search=${encodeURIComponent(phone.trim())}`),
    enabled: phone.trim().length >= 6, // member IDs are 8 chars (NB######) — don't gate them out
    staleTime: 30_000,
  });
  const staffMatch =
    customerQ.data?.find((c) => c.phone === phone.trim() || (c.member_no ?? "") === phone.trim().toUpperCase()) ?? null;
  // FALLBACK: the staff /customers search is store-scoped; a member registered at
  // another store (or an older backend) would never match. The public lookup resolves
  // by phone OR member number across the whole database — use it when the staff
  // search came up empty and the input looks like a member ID.
  const looksLikeMemberId = /^[A-Za-z]/.test(phone.trim());
  const publicMemberQ = useQuery({
    queryKey: ["public-member-chip", phone.trim().toUpperCase()],
    queryFn: () =>
      apiPost<{ found: boolean; name?: string; is_member?: boolean; points?: number; member_no?: string | null }>(
        "/public/points/lookup",
        { key: phone.trim().toUpperCase() },
      ),
    enabled: !staffMatch && looksLikeMemberId && phone.trim().length >= 6,
    staleTime: 15_000,
    retry: false,
  });
  const matchedCustomer: Customer | null =
    staffMatch ??
    (publicMemberQ.data?.found
      ? ({
          id: `member:${publicMemberQ.data.member_no ?? ""}`,
          store_id: "",
          name: publicMemberQ.data.name ?? "",
          phone: "",
          is_member: publicMemberQ.data.is_member ?? false,
          member_no: publicMemberQ.data.member_no ?? null,
          points: publicMemberQ.data.points ?? 0,
          lifetime_spend: 0,
          order_count: 0,
          marketing_opt_in: false,
        } as Customer)
      : null);
  // member identified by ID → auto-fill name (and phone when the field holds the ID)
  useEffect(() => {
    if (matchedCustomer) {
      if (!name.trim()) setName(matchedCustomer.name);
      if (matchedCustomer.phone && !/^08\d/.test(phone.trim())) setPhone(matchedCustomer.phone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedCustomer?.id]);

  const loyaltyQ = useQuery({
    queryKey: ["loyalty-config", storeId],
    queryFn: () => apiGet<{ redeem_value_per_point: number }>(`/loyalty/config${storeId ? `?store_id=${storeId}` : ""}`),
    staleTime: 300_000,
    retry: false,
  });
  const cap = store?.discount_cap ?? 10;
  // scheduled orders can be paid now or left open for pickup; deferred ones skip the
  // payment UI entirely (the cashier records payment at pickup via the pending list)
  const deferred = scheduled && payAtPickup;
  const dNum = dMode === "none" || dVal === "" ? 0 : Number(dVal);
  const discountError = dMode === "percent" ? dNum > 100 : dMode === "fixed" ? dNum > subtotal : false;
  // Same rounding as the server (nearest Rupiah); the server recalculates and has the final say.
  const discount = discountError ? 0 : dMode === "percent" ? Math.floor((subtotal * dNum + 50) / 100) : dMode === "fixed" ? dNum : 0;
  const total = subtotal - discount;
  // P5 customer programs fold into the amount the customer actually pays
  const couponAmount = couponPreview.data && !couponPreview.isError ? couponPreview.data.amount : 0;
  const redeemPtsNum = Number(redeemPts) || 0;
  const redeemValueAmount = redeemPtsNum * (loyaltyQ.data?.redeem_value_per_point ?? 10); // server config is authoritative
  const effectiveTotal = Math.max(0, total - couponAmount - redeemValueAmount);
  const tendered = cash === "" ? effectiveTotal : Number(cash);
  const change = tendered - effectiveTotal;
  const quick = [...new Set([effectiveTotal, 20000, 50000, 100000, Math.ceil(effectiveTotal / 50000) * 50000].filter((v) => v >= effectiveTotal))].sort((a, b) => a - b).slice(0, 4);

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
    setScheduled(false);
    setSlot(null);
    setPayAtPickup(false);
    setCouponCode("");
    couponPreview.reset();
    setRedeemPts("");
  };

  const mutation = useMutation({
    mutationFn: (body: OrderCreate) => apiPost<Order>("/orders", body),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success(
        order.payment_status === "pending"
          ? `Pesanan ${order.order_no} terjadwal — bayar saat ambil`
          : `Pesanan ${order.order_no} tersimpan`,
      );
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
      // ApiError.message already extracts the server's detail (string or 422 array → first msg)
      const detail = err.message && err.message !== `request failed with ${err.status}` ? err.message : null;
      toast.error(detail ?? "Gagal menyimpan pesanan. Cek koneksi server.");
    },
  });

  const submit = () =>
    mutation.mutate({
      lines,
      payment_method: method,
      cash_tendered: method === "cash" ? tendered : null,
      customer_name: name.trim() || null,
      // an alphabetic value is a MEMBER ID (NB…) — send it in its own field so the
      // flow never depends on phone-field validation
      customer_phone: /^[A-Za-z]/.test(phone.trim()) ? null : phone.trim() || null,
      member_no: /^[A-Za-z]/.test(phone.trim()) ? phone.trim().toUpperCase() : null,
      discount_type: discount > 0 ? (dMode as DiscountType) : null,
      discount_value: discount > 0 ? dNum : 0,
      discount_note: discount > 0 ? dNote.trim() || null : null,
      store_id: storeId,
      client_order_id: clientOrderId,
      approval_pin: approvalPin || null,
      scheduled_for: scheduled ? slot : null,
      pay_at_pickup: scheduled && payAtPickup,
      // only honor the coupon when the server-priced preview succeeded — otherwise the
      // typed text is an unverified string and the server would just reject it
      coupon_code: couponPreview.isSuccess ? couponCode.trim().toUpperCase() : null,
      redeem_points: couponPreview.isSuccess || !couponCode.trim() ? (redeemPtsNum > 0 ? redeemPtsNum : 0) : 0,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md" data-testid="checkout-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">Pembayaran</DialogTitle>
          <DialogDescription>
            {discount > 0 ? `Subtotal ${rupiah(subtotal)} - diskon ${rupiah(discount)}` : "Total tagihan"}
            {couponAmount > 0 ? ` - kupon ${rupiah(couponAmount)}` : ""}
            {redeemValueAmount > 0 ? ` - poin ${rupiah(redeemValueAmount)}` : ""}
          </DialogDescription>
          <div className="font-heading text-4xl font-bold tracking-tight text-teal-deep" data-testid="checkout-total">
            {rupiah(effectiveTotal)}
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

        <div className="space-y-2 rounded-xl border border-dashed border-teal-brand/40 p-3" data-testid="schedule-section">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm font-semibold text-teal-deep">Waktu ambil</Label>
            <div className="flex gap-1 rounded-full bg-mint p-1" role="tablist" aria-label="Waktu ambil">
              {(
                [
                  ["now", "Sekarang"],
                  ["later", "Terjadwal"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={(id === "later") === scheduled}
                  data-testid={`fulfillment-${id}`}
                  onClick={() => {
                    setScheduled(id === "later");
                    if (id === "now") {
                      setSlot(null);
                      setPayAtPickup(false);
                    }
                  }}
                  className={cn("rounded-full px-3 py-1 text-xs font-semibold", (id === "later") === scheduled ? "bg-teal-brand text-white" : "text-teal-deep hover:bg-white/60")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {scheduled && (
            <>
              <SchedulePicker mode="staff" value={slot} onChange={setSlot} />
              {slot && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-teal-deep">Pembayaran</span>
                  <div className="flex gap-1 rounded-full bg-mint p-1" role="tablist" aria-label="Pembayaran terjadwal">
                    {(
                      [
                        ["now", "Bayar sekarang"],
                        ["pickup", "Bayar saat ambil"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={(id === "pickup") === payAtPickup}
                        data-testid={`pay-${id}`}
                        onClick={() => setPayAtPickup(id === "pickup")}
                        className={cn("rounded-full px-3 py-1 text-xs font-semibold", (id === "pickup") === payAtPickup ? "bg-teal-brand text-white" : "text-teal-deep hover:bg-white/60")}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-dashed border-teal-brand/40 p-3" data-testid="coupon-section">
          <Label className="text-sm font-semibold text-teal-deep">Kupon</Label>
          <div className="flex gap-2">
            <Input
              placeholder="Kode kupon"
              value={couponCode}
              onChange={(e) => {
                setCouponCode(e.target.value.toUpperCase());
                couponPreview.reset();
              }}
              maxLength={32}
              data-testid="coupon-code"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-teal-brand text-teal-deep"
              disabled={couponCode.trim().length < 3 || couponPreview.isPending}
              onClick={() => couponPreview.mutate()}
              data-testid="coupon-apply"
            >
              {couponPreview.isPending ? "Cek…" : "Pakai"}
            </Button>
          </div>
          {couponPreview.isSuccess && (
            <p className="text-xs font-semibold text-mint-ink" data-testid="coupon-applied">
              Kupon aktif — hemat {rupiah(couponAmount)}
            </p>
          )}
          {couponPreview.isError && (
            <p className="text-xs text-amber-700" data-testid="coupon-error">
              {couponPreview.error instanceof ApiError ? couponPreview.error.message : "Kupon tidak valid"}
            </p>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-dashed border-teal-brand/40 p-3" data-testid="points-section">
          <Label className="text-sm font-semibold text-teal-deep">Poin</Label>
          {matchedCustomer && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground" data-testid="customer-points">
                {matchedCustomer.name}
                {matchedCustomer.is_member ? (
                  <>
                    {" "}
                    · <span className="font-mono font-semibold text-teal-deep">{matchedCustomer.member_no}</span> — saldo{" "}
                    <span className="font-semibold text-teal-deep">{matchedCustomer.points} poin</span>
                  </>
                ) : (
                  <span className="text-amber-700"> — bukan member (poin khusus member)</span>
                )}
              </p>
              {matchedCustomer.is_member && (
              <div className="flex w-28 items-center gap-1">
                <Input
                  inputMode="numeric"
                  placeholder="poin"
                  value={redeemPts}
                  onChange={(e) => setRedeemPts(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  data-testid="redeem-points"
                />
              </div>
              )}
            </div>
          )}
          {redeemPtsNum > 0 && (
            <p className="text-xs font-semibold text-teal-deep" data-testid="redeem-value">
              Potong {rupiah(redeemValueAmount)} dari {redeemPtsNum} poin
            </p>
          )}
          {!matchedCustomer && (
            <p className="text-[11px] text-muted-foreground">Masukkan No. HP atau ID member di atas untuk melihat &amp; menukar poin.</p>
          )}
        </div>

        {!deferred && (
          <>
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
                placeholder={plain(effectiveTotal)}
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
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="customer-name">Nama pelanggan (opsional)</Label>
          <Input id="customer-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="customer-name-input" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="customer-phone">No. HP / ID member (opsional — member bisa tukar poin)</Label>
          <Input id="customer-phone" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^0-9A-Za-z+-]/g, "").slice(0, 20))} placeholder="08… atau NB…" data-testid="customer-phone-input" />
        </div>

        <Button
          size="lg"
          className="h-12 rounded-full bg-teal-brand text-base font-semibold hover:bg-teal-deep"
          disabled={mutation.isPending || discountError || (method === "cash" && !deferred && change < 0) || (needsApproval && approvalPin.length < 4) || (scheduled && !slot)}
          onClick={submit}
          data-testid="complete-payment-button"
        >
          {mutation.isPending ? "Menyimpan..." : scheduled ? (payAtPickup ? "Simpan Pesanan Terjadwal" : "Selesaikan Pembayaran") : "Selesaikan Pembayaran"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
