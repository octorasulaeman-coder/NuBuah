// P5 coupon management (owner). Compact CRUD: list, create, activate/deactivate.
// Usage limits and eligibility are always enforced server-side at order time.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { rupiah } from "@/lib/format";
import type { Coupon } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function CouponsSection() {
  const { storeId } = useActiveStore();
  const qc = useQueryClient();
  const [form, setForm] = useState({ code: "", type: "fixed" as "fixed" | "percent", value: "", min_spend: "", max_redemptions: "", per_customer_limit: "", description: "" });

  const list = useQuery({
    queryKey: ["coupons", storeId],
    queryFn: () => apiGet<Coupon[]>(`/coupons${storeId ? `?store_id=${storeId}` : ""}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["coupons", storeId] });

  const create = useMutation({
    mutationFn: () =>
      apiPost<Coupon>(`/coupons${storeId ? `?store_id=${storeId}` : ""}`, {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        value: Number(form.value) || 0,
        min_spend: Number(form.min_spend) || 0,
        max_redemptions: Number(form.max_redemptions) || 0,
        per_customer_limit: Number(form.per_customer_limit) || 0,
        description: form.description.trim(),
      }),
    onSuccess: () => {
      toast.success("Kupon dibuat");
      setForm({ code: "", type: "fixed", value: "", min_spend: "", max_redemptions: "", per_customer_limit: "", description: "" });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal membuat kupon"),
  });
  const toggle = useMutation({
    mutationFn: (c: Coupon) => apiPut<Coupon>(`/coupons/${c.id}`, { active: !c.active }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal mengubah kupon"),
  });
  const remove = useMutation({
    mutationFn: (c: Coupon) => apiDelete(`/coupons/${c.id}`),
    onSuccess: () => {
      toast.success("Kupon dihapus");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal menghapus kupon"),
  });
  // inline editor
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ type: "fixed" as "fixed" | "percent", value: "", min_spend: "", max_redemptions: "", per_customer_limit: "", description: "" });
  const save = useMutation({
    mutationFn: (c: Coupon) =>
      apiPut<Coupon>(`/coupons/${c.id}`, {
        type: editForm.type,
        value: Number(editForm.value) || c.value,
        min_spend: Number(editForm.min_spend) || 0,
        max_redemptions: Number(editForm.max_redemptions) || 0,
        per_customer_limit: Number(editForm.per_customer_limit) || 0,
        description: editForm.description.trim(),
      }),
    onSuccess: () => {
      toast.success("Kupon diperbarui");
      setEditingId(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal memperbarui kupon"),
  });

  return (
    <section className="space-y-4 lg:col-span-12" data-testid="coupons-section">
      <h2 className="font-heading text-3xl font-extrabold tracking-tight text-teal-deep italic">Kupon</h2>
      <form
        className="grid gap-2 rounded-2xl border border-border bg-white p-4 shadow-sm md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.code.trim().length >= 3 && Number(form.value) > 0) create.mutate();
        }}
      >
        <Input placeholder="Kode (mis. HEMAT10)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} required data-testid="coupon-new-code" />
        <div className="flex gap-2">
          <select
            className="rounded-md border border-input bg-white px-2 text-sm"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as "fixed" | "percent" })}
            data-testid="coupon-new-type"
          >
            <option value="fixed">Rp (tetap)</option>
            <option value="percent">% (persen)</option>
          </select>
          <Input inputMode="numeric" placeholder="Nilai" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value.replace(/\D/g, "") })} required data-testid="coupon-new-value" />
        </div>
        <Input inputMode="numeric" placeholder="Min. belanja (Rp, 0 = bebas)" value={form.min_spend} onChange={(e) => setForm({ ...form, min_spend: e.target.value.replace(/\D/g, "") })} data-testid="coupon-new-minspend" />
        <Input inputMode="numeric" placeholder="Kuota total (0 = tak terbatas)" value={form.max_redemptions} onChange={(e) => setForm({ ...form, max_redemptions: e.target.value.replace(/\D/g, "") })} />
        <Input inputMode="numeric" placeholder="Limit per pelanggan (0 = bebas)" value={form.per_customer_limit} onChange={(e) => setForm({ ...form, per_customer_limit: e.target.value.replace(/\D/g, "") })} />
        <div className="flex gap-2">
          <Input placeholder="Deskripsi (opsional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Button type="submit" className="shrink-0 bg-teal-brand text-white hover:bg-teal-deep" disabled={create.isPending} data-testid="coupon-create">
            Buat
          </Button>
        </div>
      </form>
      <ul className="space-y-2">
        {(list.data ?? []).map((c) => (
          <li key={c.id} className={cn("rounded-xl border bg-white px-4 py-3", c.active ? "border-border" : "border-border opacity-60")} data-testid={`coupon-row-${c.code}`}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-mono font-bold text-teal-deep">
                  {c.code}
                  <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                    {c.type === "percent" ? `${c.value}%` : rupiah(c.value)} · dipakai {c.used_count}
                    {c.max_redemptions ? `/${c.max_redemptions}` : ""} kali
                  </span>
                </p>
                {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => {
                    if (editingId === c.id) {
                      setEditingId(null);
                    } else {
                      setEditForm({
                        type: c.type,
                        value: String(c.value),
                        min_spend: String(c.min_spend),
                        max_redemptions: String(c.max_redemptions),
                        per_customer_limit: String(c.per_customer_limit),
                        description: c.description ?? "",
                      });
                      setEditingId(c.id);
                    }
                  }}
                  data-testid={`coupon-edit-${c.code}`}
                >
                  {editingId === c.id ? "Tutup" : "Edit"}
                </Button>
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => toggle.mutate(c)} data-testid={`coupon-toggle-${c.code}`}>
                  {c.active ? "Nonaktifkan" : "Aktifkan"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full text-red-600 hover:bg-red-50"
                  disabled={remove.isPending}
                  onClick={() => {
                    const note =
                      c.used_count > 0
                        ? `\n\nKupon ini sudah dipakai ${c.used_count}x. Pesanan lama TIDAK terpengaruh (nilai kupon tersimpan di masing-masing pesanan).`
                        : "";
                    if (window.confirm(`Hapus kupon ${c.code} secara permanen?${note}`)) remove.mutate(c);
                  }}
                  data-testid={`coupon-delete-${c.code}`}
                >
                  Hapus
                </Button>
              </div>
            </div>
            {editingId === c.id && (
              <form
                className="mt-3 grid gap-2 border-t border-dashed pt-3 md:grid-cols-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate(c);
                }}
                data-testid="coupon-edit-form"
              >
                <div className="flex gap-2">
                  <select
                    className="rounded-md border border-input bg-white px-2 text-sm"
                    value={editForm.type}
                    onChange={(e) => setEditForm({ ...editForm, type: e.target.value as "fixed" | "percent" })}
                    data-testid="coupon-edit-type"
                  >
                    <option value="fixed">Rp (tetap)</option>
                    <option value="percent">% (persen)</option>
                  </select>
                  <Input inputMode="numeric" placeholder="Nilai" value={editForm.value} onChange={(e) => setEditForm({ ...editForm, value: e.target.value.replace(/\D/g, "") })} required data-testid="coupon-edit-value" />
                </div>
                <Input inputMode="numeric" placeholder="Min. belanja (Rp, 0 = bebas)" value={editForm.min_spend} onChange={(e) => setEditForm({ ...editForm, min_spend: e.target.value.replace(/\D/g, "") })} />
                <Input inputMode="numeric" placeholder="Kuota total (0 = tak terbatas)" value={editForm.max_redemptions} onChange={(e) => setEditForm({ ...editForm, max_redemptions: e.target.value.replace(/\D/g, "") })} />
                <Input inputMode="numeric" placeholder="Limit per pelanggan (0 = bebas)" value={editForm.per_customer_limit} onChange={(e) => setEditForm({ ...editForm, per_customer_limit: e.target.value.replace(/\D/g, "") })} />
                <div className="flex gap-2 md:col-span-2">
                  <Input placeholder="Deskripsi" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                  <Button type="submit" className="shrink-0 bg-teal-brand text-white hover:bg-teal-deep" disabled={save.isPending} data-testid="coupon-edit-save">
                    Simpan
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground md:col-span-3">
                  Kode tidak bisa diubah (sudah tercetak di pesanan). Nilai/min-belanja/kuota berlaku untuk pemakaian berikutnya — pesanan lama tetap memakai snapshot saat dibuat.
                </p>
              </form>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="rounded-xl bg-mint px-4 py-4 text-sm text-teal-deep">Belum ada kupon. Buat yang pertama di atas.</li>}
      </ul>
    </section>
  );
}
