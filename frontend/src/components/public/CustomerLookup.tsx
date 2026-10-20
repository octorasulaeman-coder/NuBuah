// Public self-service panel: customers check their order status (order_no + phone —
// the identifying key pair, rate-limited server-side) and their loyalty points balance
// (phone only). Also explains the earn/redeem rules so points are never a mystery.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import { rupiah } from "@/lib/format";
import type { PublicOrderStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Tab = "order" | "points";

const STATUS_LABEL: Record<string, string> = {
  received: "Diterima",
  confirmed: "Dikonfirmasi",
  preparing: "Sedang dibuat",
  ready: "✅ Siap diambil!",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

interface PointsResult {
  found: boolean;
  name?: string;
  is_member?: boolean;
  member_no?: string | null;
  points?: number;
  points_value?: number;
  order_count?: number;
  last_order_at?: string | null;
}

export default function CustomerLookup({ storeCode }: { storeCode?: string }) {
  const [tab, setTab] = useState<Tab>("order");
  const [orderNo, setOrderNo] = useState("");
  const [pointsPhone, setPointsPhone] = useState("");

  const rules = useQuery({
    queryKey: ["public-loyalty-config", storeCode],
    queryFn: () =>
      apiGet<{
        points_per: number;
        min_spend_to_earn: number;
        redeem_value_per_point: number;
        redeem_min_points: number;
      }>(`/public/stores/${encodeURIComponent(storeCode ?? "")}/loyalty`),
    staleTime: 300_000,
    retry: false,
  });

  const orderQ = useQuery({
    queryKey: ["public-lookup-order", orderNo],
    // receipt number alone is the key (phone optional server-side) — owner's choice
    queryFn: () => apiGet<PublicOrderStatus>(`/public/orders/${encodeURIComponent(orderNo.trim().toUpperCase())}`),
    enabled: tab === "order" && orderNo.trim().length >= 4,
    refetchInterval: 15_000,
    retry: false,
  });
  const pointsQ = useQuery({
    queryKey: ["public-lookup-points", pointsPhone],
    queryFn: () => apiPost<PointsResult>("/public/points/lookup", { key: pointsPhone.trim() }),
    enabled: tab === "points" && pointsPhone.trim().length >= 9,
    retry: false,
  });

  const r = rules.data;

  return (
    <section className="rounded-2xl border border-border bg-white p-4 shadow-sm" data-testid="customer-lookup">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-extrabold text-teal-deep">Cek pesanan &amp; poin</h2>
        <div className="flex gap-1 rounded-full bg-mint p-1" role="tablist">
          {(
            [
              ["order", "Cek pesanan"],
              ["points", "Cek poin"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              data-testid={`lookup-tab-${id}`}
              className={cn("rounded-full px-3 py-1 text-xs font-semibold", tab === id ? "bg-teal-brand text-white" : "text-teal-deep")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "order" && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input placeholder="No. pesanan (mis. CMH-261021-001)" value={orderNo} onChange={(e) => setOrderNo(e.target.value.toUpperCase())} data-testid="lookup-order-no" />
            <Button variant="outline" className="border-teal-brand text-teal-deep" disabled={orderQ.isFetching} onClick={() => orderQ.refetch()} data-testid="lookup-order-go">
              {orderQ.isFetching ? "…" : "Cek"}
            </Button>
          </div>
          {orderQ.isError && <p className="text-xs text-amber-700">Pesanan tidak ditemukan — periksa no. pesanan &amp; HP.</p>}
          {orderQ.data && (
            <div className="rounded-xl bg-mint p-3" data-testid="lookup-order-result">
              <div className="flex items-center justify-between">
                <p className="font-mono font-bold text-teal-deep">{orderQ.data.order_no}</p>
                <p className="text-sm font-semibold text-teal-deep">{rupiah(orderQ.data.total)}</p>
              </div>
              <p className="mt-1 text-sm">
                <b>{STATUS_LABEL[orderQ.data.status ?? "received"] ?? orderQ.data.status}</b>
                {orderQ.data.payment_status === "paid" ? " · Lunas" : " · Bayar di kasir"}
                {orderQ.data.fulfillment === "scheduled" && orderQ.data.scheduled_for && (
                  <> · Ambil: {new Date(orderQ.data.scheduled_for).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</>
                )}
              </p>
              {orderQ.data.points_earned ? <p className="mt-1 text-xs text-teal-deep">Poin dari pesanan ini: +{orderQ.data.points_earned}</p> : null}
            </div>
          )}
        </div>
      )}

      {tab === "points" && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input placeholder="ID member (NB…)" value={pointsPhone} onChange={(e) => setPointsPhone(e.target.value)} data-testid="lookup-points-phone" />
            <Button variant="outline" className="border-teal-brand text-teal-deep" disabled={pointsQ.isFetching} onClick={() => pointsQ.refetch()} data-testid="lookup-points-go">
              {pointsQ.isFetching ? "…" : "Cek"}
            </Button>
          </div>
          {pointsQ.data?.found && (
            <div className="rounded-xl bg-mint p-3" data-testid="lookup-points-result">
              <p className="font-semibold text-teal-deep">
                {pointsQ.data.name} —{" "}
                {pointsQ.data.is_member ? (
                  <>
                    <b className="font-heading text-lg">{pointsQ.data.points} poin</b>
                    <span className="ml-1 text-xs font-normal">(≈ {rupiah(pointsQ.data.points_value ?? 0)})</span>
                  </>
                ) : (
                  <span className="text-sm font-medium text-amber-700">bukan member — poin khusus member</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {pointsQ.data.order_count} pesanan · terakhir {pointsQ.data.last_order_at ? new Date(pointsQ.data.last_order_at).toLocaleDateString("id-ID") : "-"}
              </p>
            </div>
          )}
          {pointsQ.isError || (pointsQ.data && !pointsQ.data.found) ? (
            <p className="text-xs text-amber-700">Nomor belum terdaftar — poin terbentuk otomatis dari pesanan pertama yang lunas.</p>
          ) : null}
          {r && (
            <p className="rounded-lg bg-white px-3 py-2 text-xs text-muted-foreground" data-testid="loyalty-rules">
              Cara dapat poin: <b>1 poin tiap {rupiah(r.points_per)}</b> belanja (minimal {rupiah(r.min_spend_to_earn)}), masuk otomatis setelah pesanan lunas.{" "}
              <b>1 poin = {rupiah(r.redeem_value_per_point)}</b> saat ditukar di kasir (minimal {r.redeem_min_points} poin, maks. 50% tagihan).
            </p>
          )}
        </div>
      )}
    </section>
  );
}
