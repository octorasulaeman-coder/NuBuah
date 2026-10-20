// P5 customers UI (staff read / owner adjust): search by name or phone, view profile,
// points ledger and recent orders; owner can correct points with a mandatory reason.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiGet, apiPost, apiPut } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { rupiah } from "@/lib/format";
import type { Customer, CustomerDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const REASON_LABEL: Record<string, string> = {
  order_paid: "Pesanan lunas",
  redeem: "Tukar poin",
  reversal_void: "Dibatalkan (void)",
  reversal_refund: "Refund",
  adjust: "Penyesuaian",
};

export default function CustomersSection() {
  const { isOwner, storeId, stores, setStore } = useActiveStore();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");

  const list = useQuery({
    queryKey: ["customers", storeId, search],
    queryFn: () => apiGet<Customer[]>(`/customers?search=${encodeURIComponent(search.trim())}${storeId ? `&store_id=${storeId}` : ""}`),
  });
  const detail = useQuery({
    queryKey: ["customer", selectedId],
    queryFn: () => apiGet<CustomerDetail>(`/customers/${selectedId}`),
    enabled: !!selectedId,
  });
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editConsent, setEditConsent] = useState(false);
  const [editMember, setEditMember] = useState(false);
  const [editMemberNo, setEditMemberNo] = useState("");
  const randomMemberNo = () => `NB${Math.floor(100000 + Math.random() * 900000)}`;
  const saveEdit = useMutation({
    mutationFn: (v: { id: string; name: string; phone: string; marketing_opt_in: boolean; is_member: boolean; member_no: string }) =>
      apiPut<Customer>(`/customers/${v.id}`, {
        name: v.name,
        phone: v.phone,
        marketing_opt_in: v.marketing_opt_in,
        is_member: v.is_member,
        member_no: v.member_no || null, // kosong + is_member → server generate
      }),
    onSuccess: (c) => {
      toast.success("Profil pelanggan diperbarui");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["customer", c.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal memperbarui profil"),
  });
  const adjust = useMutation({
    mutationFn: (v: { id: string; delta: number; reason: string }) =>
      apiPost<Customer>(`/customers/${v.id}/adjust`, { delta: v.delta, reason: v.reason }),
    onSuccess: (c) => {
      toast.success(`Poin ${c.name} sekarang ${c.points}`);
      setDelta("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["customer", selectedId] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal menyesuaikan poin"),
  });

  const sel = detail.data?.customer;
  const deltaNum = Number(delta) || 0;

  return (
    <section className="space-y-4 lg:col-span-7" data-testid="customers-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-3xl font-extrabold italic tracking-tight text-teal-deep">Pelanggan</h2>
        {isOwner && stores.length > 1 && (
          <select
            className="rounded-full border border-border bg-white px-3 py-1.5 text-sm"
            value={storeId ?? ""}
            onChange={(e) => setStore(e.target.value)}
            data-testid="customers-store-select"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <Input
        placeholder="Cari nama atau no. HP…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-md rounded-full bg-white"
        data-testid="customers-search"
      />
      <ul className="space-y-2">
        {(list.data ?? []).map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
              data-testid={`customer-row-${c.phone}`}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-xl border bg-white px-4 py-3 text-left shadow-sm",
                selectedId === c.id ? "border-teal-brand" : "border-border",
              )}
            >
              <div>
                <p className="font-semibold text-teal-deep">{c.name || "(tanpa nama)"}</p>
                <p className="font-mono text-xs text-muted-foreground">{c.phone}</p>
              </div>
              <div className="text-right">
                <p className="font-heading text-lg font-bold text-teal-deep">
                  {c.is_member ? `${c.points} poin` : <span className="text-sm font-medium text-muted-foreground">bukan member</span>}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {c.is_member && c.member_no ? <span className="font-mono font-semibold text-teal-deep">{c.member_no}</span> : null}
                  {c.is_member && c.member_no ? " · " : ""}
                  {c.order_count} pesanan · {rupiah(c.lifetime_spend)}
                </p>
              </div>
            </button>
            {selectedId === c.id && detail.data && (
              <div className="mt-2 space-y-3 rounded-xl border border-border bg-white p-4 shadow-sm" data-testid="customer-detail">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    Terakhir pesan: {sel?.last_order_at ? new Date(sel.last_order_at).toLocaleString("id-ID") : "-"} · consent marketing: {sel?.marketing_opt_in ? "ya" : "tidak"}
                  </p>
                  {isOwner && !editing && (
                    <button
                      type="button"
                      className="shrink-0 text-xs font-semibold text-teal-deep underline"
                      onClick={() => {
                        setEditName(sel?.name ?? "");
                        setEditPhone(sel?.phone ?? "");
                        setEditConsent(sel?.marketing_opt_in ?? false);
                        setEditMember(sel?.is_member ?? false);
                        setEditMemberNo(sel?.member_no ?? "");
                        setEditing(true);
                      }}
                      data-testid="customer-edit-open"
                    >
                      Edit profil
                    </button>
                  )}
                </div>
                {editing && sel && (
                  <form
                    className="space-y-2 rounded-lg bg-mint p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editName.trim() && editPhone.trim().length >= 9)
                        saveEdit.mutate({
                          id: sel.id,
                          name: editName.trim(),
                          phone: editPhone.trim(),
                          marketing_opt_in: editConsent,
                          is_member: editMember,
                          member_no: editMemberNo.trim().toUpperCase(),
                        });
                    }}
                    data-testid="customer-edit-form"
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input placeholder="Nama" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} data-testid="customer-edit-name" />
                      <Input inputMode="tel" placeholder="No. HP" value={editPhone} onChange={(e) => setEditPhone(e.target.value.replace(/[^\d+]/g, "").slice(0, 16))} data-testid="customer-edit-phone" />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={editConsent} onChange={(e) => setEditConsent(e.target.checked)} data-testid="customer-edit-consent" />
                      Setuju terima info/promo (marketing)
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2 text-sm font-semibold text-teal-deep">
                        <input type="checkbox" checked={editMember} onChange={(e) => setEditMember(e.target.checked)} data-testid="customer-edit-member" />
                        Member (bisa kumpul & tukar poin)
                      </label>
                      {editMember && (
                        <div className="flex items-center gap-1.5">
                          <Input
                            placeholder="ID member — kosongkan utk auto"
                            value={editMemberNo}
                            onChange={(e) => setEditMemberNo(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
                            className="h-8 w-48 font-mono"
                            data-testid="customer-edit-member-no"
                          />
                          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setEditMemberNo(randomMemberNo())} data-testid="customer-edit-member-random">
                            Acak
                          </Button>
                        </div>
                      )}
                    </div>
                    {editMember && !editMemberNo && (
                      <p className="text-[11px] text-muted-foreground">ID dikosongkan → server membuatkan nomor unik otomatis saat disimpan.</p>
                    )}
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" className="bg-teal-brand text-white" disabled={saveEdit.isPending} data-testid="customer-edit-save">
                        Simpan
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                        Batal
                      </Button>
                    </div>
                  </form>
                )}
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Riwayat poin</p>
                  <ul className="space-y-1">
                    {detail.data.ledger.slice(0, 10).map((l) => (
                      <li key={l.id} className="flex items-center justify-between text-sm" data-testid="ledger-row">
                        <span className="text-muted-foreground">
                          {new Date(l.created_at).toLocaleDateString("id-ID")} · {REASON_LABEL[l.reason] ?? l.reason}
                          {l.note ? ` — ${l.note}` : ""}
                        </span>
                        <span className={cn("font-mono font-semibold", l.delta >= 0 ? "text-teal-deep" : "text-red-600")}>
                          {l.delta >= 0 ? "+" : ""}
                          {l.delta}
                        </span>
                      </li>
                    ))}
                    {detail.data.ledger.length === 0 && <li className="text-sm text-muted-foreground">Belum ada pergerakan poin.</li>}
                  </ul>
                </div>
                {isOwner && (
                  <form
                    className="flex flex-wrap items-center gap-2 border-t pt-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (deltaNum !== 0 && reason.trim().length >= 3 && sel) adjust.mutate({ id: sel.id, delta: deltaNum, reason: reason.trim() });
                    }}
                  >
                    <Input
                      inputMode="numeric"
                      placeholder="+/- poin"
                      value={delta}
                      onChange={(e) => setDelta(e.target.value.replace(/[^0-9+-]/g, "").slice(0, 6))}
                      className="w-28"
                      data-testid="adjust-delta"
                    />
                    <Input placeholder="Alasan (wajib)" value={reason} onChange={(e) => setReason(e.target.value)} className="flex-1" data-testid="adjust-reason" />
                    <Button type="submit" variant="outline" className="border-teal-brand text-teal-deep" disabled={adjust.isPending || deltaNum === 0 || reason.trim().length < 3} data-testid="adjust-submit">
                      Sesuaikan
                    </Button>
                  </form>
                )}
              </div>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="rounded-xl bg-mint px-4 py-4 text-sm text-teal-deep">Belum ada pelanggan tercatat.</li>}
      </ul>
    </section>
  );
}
