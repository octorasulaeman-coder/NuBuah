import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { plain, rupiah } from "@/lib/format";
import type { DrawerEventIn, DrawerSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const KIND_LABEL: Record<string, string> = { open: "Modal awal", cash_out: "Pengambilan uang", expense: "Pengeluaran", close: "Tutup kasir" };

/** Cash drawer card: opening float, cash-outs, expenses, and counted-cash closing with variance. */
export default function DrawerPanel({ storeId = null, onClosed }: { storeId?: string | null; onClosed?: () => void }) {
  const qc = useQueryClient();
  const { me, isOwner, storeId: activeStoreId } = useActiveStore();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"cash_out" | "expense">("cash_out");
  const [counted, setCounted] = useState("");

  const scope = storeId ?? (isOwner ? null : me?.store_id ?? null);
  const q = useQuery({
    queryKey: ["drawer", "summary", scope],
    queryFn: () => apiGet<DrawerSummary>(`/drawer/summary?store_id=${scope}`),
    // drawer is per-store: no scope (owner viewing "semua toko") means no drawer card
    enabled: !!scope,
    refetchInterval: 60_000,
  });
  const summary = q.data;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["drawer"] });
    qc.invalidateQueries({ queryKey: ["reports"] });
  };

  const eventMut = useMutation({
    mutationFn: (body: DrawerEventIn) => apiPost("/drawer/events", body),
    onSuccess: () => {
      toast.success("Tersimpan");
      setAmount("");
      setNote("");
      invalidate();
    },
    onError: () => toast.error("Gagal menyimpan. Coba lagi."),
  });

  const openMut = useMutation({
    mutationFn: (body: DrawerEventIn) => apiPost("/drawer/events", body),
    onSuccess: () => {
      toast.success("Modal awal tersimpan");
      setAmount("");
      invalidate();
    },
    onError: () => toast.error("Gagal menyimpan. Coba lagi."),
  });

  const closeMut = useMutation({
    mutationFn: (body: { counted: number; store_id: string | null }) => apiPost("/drawer/close", body),
    onSuccess: (ev) => {
      toast.success(ev.variance === 0 ? "Kasir ditutup — pas!" : `Kasir ditutup — selisih ${rupiah(ev.variance ?? 0)}`);
      setCounted("");
      invalidate();
      onClosed?.();
    },
    onError: () => toast.error("Gagal menutup kasir. Coba lagi."),
  });

  if (!scope || !summary) return null;

  return (
    <div className="w-full space-y-3 rounded-xl border border-teal-brand/25 bg-white p-3 text-left" data-testid="drawer-panel">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-base font-extrabold italic text-teal-deep">Kas / laci</h3>
        <span className="text-xs text-muted-foreground">{KIND_LABEL.open}: {rupiah(summary.opening)}</span>
      </div>

      {summary.opening === 0 && (
        <div className="flex items-end gap-2" data-testid="drawer-open-form">
          <div className="flex-1">
            <Label className="text-xs">Modal awal (uang di laci saat buka)</Label>
            <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 9))} placeholder="mis. 200000" className="h-9" data-testid="drawer-open-input" />
          </div>
          <Button
            className="bg-teal-brand hover:bg-teal-deep"
            disabled={!amount || openMut.isPending}
            onClick={() => openMut.mutate({ store_id: scope, kind: "open", amount: Number(amount), note: null })}
            data-testid="drawer-open-button"
          >
            Simpan
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg bg-mint p-2"><div className="text-xs text-muted-foreground">Penjualan tunai</div><div className="font-semibold text-teal-deep">{rupiah(summary.cash_sales)}</div></div>
        <div className="rounded-lg bg-mint p-2"><div className="text-xs text-muted-foreground">Seharusnya di laci</div><div className="font-semibold text-teal-deep" data-testid="drawer-expected">{rupiah(summary.expected_cash)}</div></div>
      </div>

      <div className="flex items-end gap-2">
        <div className="w-36">
          <Label className="text-xs">Jenis</Label>
          <select value={kind} onChange={(e) => setKind(e.target.value as "cash_out" | "expense")} className="h-9 w-full rounded-md border bg-white px-2 text-sm" data-testid="drawer-kind-select">
            <option value="cash_out">Pengambilan uang</option>
            <option value="expense">Pengeluaran</option>
          </select>
        </div>
        <div className="flex-1">
          <Label className="text-xs">Nominal</Label>
          <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 9))} placeholder="0" className="h-9" data-testid="drawer-amount-input" />
        </div>
        <Button variant="outline" className="border-teal-brand text-teal-deep" disabled={!amount || eventMut.isPending} onClick={() => eventMut.mutate({ store_id: scope, kind, amount: Number(amount), note: note.trim() || null })} data-testid="drawer-event-button">
          Catat
        </Button>
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Keterangan (opsional)" className="h-8" data-testid="drawer-note-input" />

      {summary.events.length > 0 && (
        <ul className="max-h-32 space-y-1 overflow-y-auto text-xs" data-testid="drawer-events">
          {summary.events.map((ev) => (
            <li key={ev.id} className="flex items-center justify-between gap-2 rounded bg-muted/60 px-2 py-1">
              <span>
                {KIND_LABEL[ev.kind] ?? ev.kind}
                {ev.note ? ` · ${ev.note}` : ""}
                <span className="text-muted-foreground"> · {ev.actor}</span>
              </span>
              <span className={ev.kind === "close" && ev.variance !== 0 ? "font-semibold text-amber-700" : "font-medium"}>
                {ev.kind === "close" && ev.variance !== null ? `${rupiah(ev.amount)} (selisih ${rupiah(ev.variance)})` : `${ev.kind === "cash_out" || ev.kind === "expense" ? "−" : "+"}${rupiah(ev.amount)}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!summary.closing && (
        <div className="flex items-end gap-2 border-t border-dashed pt-2" data-testid="drawer-close-form">
          <div className="flex-1">
            <Label className="text-xs">Hitung uang di laci (tutup kasir)</Label>
            <Input inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value.replace(/\D/g, "").slice(0, 9))} placeholder={plain(summary.expected_cash)} className="h-9" data-testid="drawer-counted-input" />
          </div>
          <Button className="bg-teal-brand hover:bg-teal-deep" disabled={!counted || closeMut.isPending} onClick={() => closeMut.mutate({ counted: Number(counted), store_id: scope })} data-testid="drawer-close-button">
            Tutup
          </Button>
        </div>
      )}
    </div>
  );
}
