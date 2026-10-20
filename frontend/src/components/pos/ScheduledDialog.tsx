// P6 order-workflow panel: scheduled pickups with filters + keterangan.
// Status transitions are validated server-side; this UI offers the legal next step.
// "Semua" was dropped as redundant — the union of the other tabs covers it.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Phone } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { rupiah } from "@/lib/format";
import type { Order } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "due" | "overdue" | "unpaid" | "done";

const NEXT: Record<string, string> = {
  received: "confirmed",
  confirmed: "preparing",
  preparing: "ready",
  ready: "completed",
};
const LABEL: Record<string, string> = {
  received: "Diterima",
  confirmed: "Dikonfirmasi",
  preparing: "Dibuat",
  ready: "Siap diambil",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

const TABS: [Filter, string, string][] = [
  ["due", "Jatuh tempo", "Dalam 30 menit ke depan — yang harus disiapkan sekarang"],
  ["overdue", "Terlambat", "Jam ambil sudah lewat tapi belum selesai — perlu dicek"],
  ["unpaid", "Belum bayar", "Pembayaran masih pending (bayar saat ambil), jam berapa pun"],
  ["done", "Sudah diambil", "Sudah selesai diambil dalam 4 jam terakhir"],
];

const pickupFmt = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function ScheduledDialog({ onClose }: { onClose: () => void }) {
  const { storeId } = useActiveStore();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("due");
  const q = useQuery({
    queryKey: ["scheduled-orders", storeId],
    // one fetch covers active + completed; tabs filter client-side
    queryFn: () => apiGet<Order[]>(`/orders/scheduled?include_completed=true${storeId ? `&store_id=${storeId}` : ""}`),
    refetchInterval: 30_000,
  });
  const advance = useMutation({
    mutationFn: (o: Order) => apiPost<Order>(`/orders/${o.id}/status`, { status: NEXT[o.status ?? "received"] }),
    onSuccess: (o) => {
      toast.success(`${o.order_no} → ${LABEL[o.status ?? ""]}`);
      qc.invalidateQueries({ queryKey: ["scheduled-orders"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal mengubah status"),
  });

  const now = Date.now();
  const all = q.data ?? [];
  const rows = all.filter((o) => {
    const t = o.scheduled_for ? new Date(o.scheduled_for).getTime() : now;
    if (filter === "due") return t - now <= 30 * 60_000 && t >= now - 60_000 && o.status !== "completed";
    if (filter === "overdue") return t < now - 60_000 && o.status !== "completed";
    if (filter === "unpaid") return o.payment_status !== "paid";
    return o.status === "completed";
  });
  const keterangan = TABS.find(([id]) => id === filter)?.[2] ?? "";

  return (
    <div className="flex flex-col gap-3" data-testid="scheduled-dialog">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-xl font-bold text-teal-deep">Pesanan terjadwal</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted-foreground">Tutup ✕</button>
      </div>
      <div className="flex gap-1 rounded-full bg-mint p-1" role="tablist" aria-label="Filter">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            data-testid={`sched-filter-${id}`}
            onClick={() => setFilter(id)}
            className={cn("rounded-full px-3 py-1 text-xs font-semibold", filter === id ? "bg-teal-brand text-white" : "text-teal-deep")}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="rounded-lg bg-mint px-3 py-1.5 text-xs text-teal-deep" data-testid="sched-keterangan">{keterangan}</p>
      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Memuat…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl bg-mint px-4 py-6 text-center text-sm text-teal-deep">Tidak ada pesanan untuk filter ini.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((o) => {
            const next = NEXT[o.status ?? "received"];
            return (
              <li key={o.id} className="rounded-xl border border-border bg-white p-3" data-testid={`sched-${o.order_no}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-teal-deep">{o.order_no}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    o.payment_status === "paid" ? "bg-mint text-teal-deep" : "bg-amber-100 text-amber-800")}>
                    {o.payment_status === "paid" ? "Lunas" : "Belum bayar"}
                  </span>
                </div>
                <p className="mt-1 flex items-center gap-1 text-sm font-semibold text-teal-deep">
                  <CalendarClock size={13} /> {o.scheduled_for ? pickupFmt(o.scheduled_for) : "-"}
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px]">{LABEL[o.status ?? "received"]}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {o.customer_name} {o.customer_phone && <span className="inline-flex items-center gap-0.5"><Phone size={10} /> {o.customer_phone}</span>} — {o.item_count} item · {rupiah(o.total)}
                </p>
                {next && (
                  <button
                    type="button"
                    disabled={advance.isPending}
                    onClick={() => advance.mutate(o)}
                    data-testid={`advance-${o.order_no}`}
                    className="mt-2 inline-flex items-center gap-1 rounded-full bg-teal-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    <Check size={12} /> → {LABEL[next]}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
