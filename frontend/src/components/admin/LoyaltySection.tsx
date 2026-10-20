// P5 loyalty rules UI (owner): how points are EARNED (per rupiah of the paid total)
// and what they're WORTH when redeemed. One global rule set per store — points are
// never per-product, by design.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiGet, apiPut } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { rupiah } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface LoyaltyConfig {
  points_per: number;
  min_spend_to_earn: number;
  redeem_value_per_point: number;
  redeem_min_points: number;
  redeem_max_fraction: number;
}

const FIELDS: [keyof LoyaltyConfig, string, string][] = [
  ["points_per", "Poin per belanja (Rp)", "1 poin untuk setiap Rp berapa belanja? mis. 1000"],
  ["min_spend_to_earn", "Minimal belanja untuk dapat poin (Rp)", "di bawah ini tidak dapat poin; 0 = selalu dapat"],
  ["redeem_value_per_point", "Nilai 1 poin saat ditukar (Rp)", "inilah '1 poin = Rp 10' — ubah sesukanya"],
  ["redeem_min_points", "Minimal poin sekali tukar", "mis. 100"],
];
const FRACTION_OPTIONS = [0.25, 0.5, 0.75, 1.0];

export default function LoyaltySection() {
  const { isOwner, storeId } = useActiveStore();
  const qc = useQueryClient();
  const [form, setForm] = useState<LoyaltyConfig>({
    points_per: 1000, min_spend_to_earn: 5000, redeem_value_per_point: 10, redeem_min_points: 100, redeem_max_fraction: 0.5,
  });

  const info = useQuery({
    queryKey: ["loyalty-admin", storeId],
    queryFn: () => apiGet<LoyaltyConfig>(`/loyalty/config${storeId ? `?store_id=${storeId}` : ""}`),
  });
  useEffect(() => {
    if (info.data) setForm(info.data);
  }, [info.data]);

  const save = useMutation({
    mutationFn: () => apiPut<LoyaltyConfig>(`/store/loyalty${storeId ? `?store_id=${storeId}` : ""}`, form),
    onSuccess: () => {
      toast.success("Aturan poin tersimpan");
      qc.invalidateQueries({ queryKey: ["loyalty-admin", storeId] });
      qc.invalidateQueries({ queryKey: ["loyalty-config"] });
      qc.invalidateQueries({ queryKey: ["public-loyalty-config"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal menyimpan aturan poin"),
  });

  const previewEarn = Math.floor(50000 / Math.max(1, form.points_per));
  const previewRedeem = form.redeem_min_points * form.redeem_value_per_point;

  return (
    <section className="space-y-4 lg:col-span-5" data-testid="loyalty-section">
      <h2 className="font-heading text-3xl font-extrabold italic tracking-tight text-teal-deep">Poin loyalitas</h2>
      <p className="text-sm text-muted-foreground">
        Aturan berlaku <b>global untuk semua produk</b>: poin dihitung dari total akhir pesanan yang lunas — bukan per produk.
      </p>
      <div className="space-y-3 rounded-2xl border border-border bg-white p-4 shadow-sm">
        {FIELDS.map(([key, label, hint]) => (
          <div key={key} className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground">{label}</label>
            <Input
              inputMode="numeric"
              value={String(form[key])}
              disabled={!isOwner}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value.replace(/\D/g, "")) || 0 })}
              data-testid={`loyalty-${key}`}
            />
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          </div>
        ))}
        <div className="space-y-1">
          <label className="text-xs font-semibold text-muted-foreground">Maksimal poin menutup tagihan</label>
          <div className="flex gap-2">
            {FRACTION_OPTIONS.map((f) => (
              <button
                key={f}
                type="button"
                disabled={!isOwner}
                onClick={() => setForm({ ...form, redeem_max_fraction: f })}
                data-testid={`loyalty-fraction-${f}`}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${form.redeem_max_fraction === f ? "bg-teal-brand text-white" : "bg-mint text-teal-deep"}`}
              >
                {Math.round(f * 100)}%
              </button>
            ))}
          </div>
        </div>
        <p className="rounded-lg bg-mint px-3 py-2 text-xs text-teal-deep" data-testid="loyalty-preview">
          Contoh: belanja {rupiah(50000)} ≈ <b>{previewEarn} poin</b> · menukar {form.redeem_min_points} poin ≈ potongan{" "}
          <b>{rupiah(previewRedeem)}</b>
        </p>
        {isOwner && (
          <Button className="rounded-full bg-teal-brand font-semibold text-white hover:bg-teal-deep" disabled={save.isPending} onClick={() => save.mutate()} data-testid="loyalty-save">
            {save.isPending ? "Menyimpan…" : "Simpan aturan poin"}
          </Button>
        )}
      </div>
    </section>
  );
}
