// P5 customers UI (staff read / owner adjust): compact searchable list, scalable
// desktop detail panel, and mobile bottom-sheet detail so the admin page stays short.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
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
  const [visibleCount, setVisibleCount] = useState(50);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editConsent, setEditConsent] = useState(false);
  const [editMember, setEditMember] = useState(false);
  const [editMemberNo, setEditMemberNo] = useState("");

  const list = useQuery({
    queryKey: ["customers", storeId, search, visibleCount],
    queryFn: () =>
      apiGet<Customer[]>(
        `/customers?search=${encodeURIComponent(search.trim())}&limit=${Math.min(visibleCount, 500)}&offset=0${storeId ? `&store_id=${storeId}` : ""}`,
      ),
  });
  const detail = useQuery({
    queryKey: ["customer", selectedId],
    queryFn: () => apiGet<CustomerDetail>(`/customers/${selectedId}`),
    enabled: !!selectedId,
  });

  const customers = list.data ?? [];
  const visibleCustomers = customers;
  const memberCount = customers.filter((c) => c.is_member).length;
  const totalOutstandingPoints = customers.reduce((sum, c) => sum + (c.is_member ? c.points : 0), 0);
  const sel = detail.data?.customer;
  const deltaNum = Number(delta) || 0;
  const randomMemberNo = () => `NB${Math.floor(100000 + Math.random() * 900000)}`;

  const saveEdit = useMutation({
    mutationFn: (v: { id: string; name: string; phone: string; marketing_opt_in: boolean; is_member: boolean; member_no: string }) =>
      apiPut<Customer>(`/customers/${v.id}`, {
        name: v.name,
        phone: v.phone,
        marketing_opt_in: v.marketing_opt_in,
        is_member: v.is_member,
        member_no: v.member_no || null,
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

  const removeCustomer = useMutation({
    mutationFn: async ({ id, mode, confirmPhone }: { id: string; mode: "anonymize" | "purge"; confirmPhone?: string }) =>
      apiDelete<{ deleted: boolean; anonymized: boolean; safety_backup?: string | null; counts: Record<string, number> }>(
        `/customers/${id}?mode=${mode}${confirmPhone ? `&confirm_phone=${encodeURIComponent(confirmPhone)}` : ""}`,
      ),
    onSuccess: (result) => {
      const total = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
      toast.success(
        result.anonymized
          ? `Pelanggan dianonimkan. ${total} data terkait diperbarui.`
          : `Pelanggan dihapus. ${total} data terkait dihapus.${result.safety_backup ? ` Backup: ${result.safety_backup}` : ""}`,
      );
      if (result.deleted) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal menghapus pelanggan"),
  });

  const closeDetail = () => {
    setSelectedId(null);
    setEditing(false);
  };

  const renderDetail = () => {
    if (!selectedId) {
      return (
        <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          Pilih pelanggan untuk melihat detail, riwayat poin, dan aksi owner.
        </div>
      );
    }
    if (detail.isLoading || !sel || !detail.data) {
      return <div className="rounded-2xl border border-border bg-white p-6 text-sm text-slate-500">Memuat detail pelanggan…</div>;
    }
    return (
      <div className="space-y-4 rounded-2xl border border-border bg-white p-4 shadow-sm" data-testid="customer-detail">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-extrabold text-teal-deep">{sel.name || "(tanpa nama)"}</h3>
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-bold", sel.is_member ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-500")}>
                {sel.is_member ? "Member" : "Bukan member"}
              </span>
            </div>
            <p className="mt-1 font-mono text-sm text-slate-500">{sel.phone}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Terakhir pesan: {sel.last_order_at ? new Date(sel.last_order_at).toLocaleString("id-ID") : "-"} · consent marketing: {sel.marketing_opt_in ? "ya" : "tidak"}
            </p>
          </div>
          {isOwner && !editing && (
            <div className="flex shrink-0 flex-col items-end gap-1 text-xs font-semibold">
              <button
                type="button"
                className="text-teal-deep underline"
                onClick={() => {
                  setEditName(sel.name ?? "");
                  setEditPhone(sel.phone ?? "");
                  setEditConsent(sel.marketing_opt_in ?? false);
                  setEditMember(sel.is_member ?? false);
                  setEditMemberNo(sel.member_no ?? "");
                  setEditing(true);
                }}
                data-testid="customer-edit-open"
              >
                Edit profil
              </button>
              <button
                type="button"
                className="text-amber-700 underline"
                disabled={removeCustomer.isPending}
                onClick={() => {
                  if (window.confirm("Anonimkan pelanggan ini? Nama, nomor HP, member, dan poin akan dihapus, tetapi riwayat transaksi tetap tersimpan anonim.")) {
                    removeCustomer.mutate({ id: sel.id, mode: "anonymize" });
                  }
                }}
                data-testid="customer-anonymize"
              >
                Anonimkan
              </button>
              <button
                type="button"
                className="text-red-600 underline"
                disabled={removeCustomer.isPending}
                onClick={() => {
                  const typed = window.prompt(`Ketik nomor HP pelanggan untuk menghapus total: ${sel.phone ?? "-"}`);
                  if (typed !== null && typed.trim() === (sel.phone ?? "").trim()) {
                    if (window.confirm("PERINGATAN: Pesanan, riwayat poin, kupon, dan data terkait pelanggan akan dihapus permanen. Lanjutkan?")) {
                      removeCustomer.mutate({ id: sel.id, mode: "purge", confirmPhone: typed.trim() });
                    }
                  } else if (typed !== null) {
                    toast.error("Konfirmasi nomor HP tidak cocok");
                  }
                }}
                data-testid="customer-purge"
              >
                Hapus total
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-mint px-2 py-3">
            <div className="text-lg font-extrabold text-teal-deep">{sel.order_count}</div>
            <div className="text-[11px] font-semibold text-slate-500">Pesanan</div>
          </div>
          <div className="rounded-xl bg-mint px-2 py-3">
            <div className="text-lg font-extrabold text-teal-deep">{rupiah(sel.lifetime_spend)}</div>
            <div className="text-[11px] font-semibold text-slate-500">Total belanja</div>
          </div>
          <div className="rounded-xl bg-mint px-2 py-3">
            <div className="text-lg font-extrabold text-teal-deep">{sel.is_member ? sel.points : "-"}</div>
            <div className="text-[11px] font-semibold text-slate-500">Poin</div>
          </div>
        </div>

        {isOwner && editing && (
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
          <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
            {detail.data.ledger.slice(0, 12).map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 text-sm" data-testid="ledger-row">
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
    );
  };

  return (
    <section className="space-y-4" data-testid="customers-section">
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

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-2xl border border-border bg-white px-3 py-2 text-center">
          <div className="text-lg font-extrabold text-teal-deep">{customers.length}</div>
          <div className="text-[11px] font-semibold text-slate-500">Pelanggan</div>
        </div>
        <div className="rounded-2xl border border-border bg-white px-3 py-2 text-center">
          <div className="text-lg font-extrabold text-teal-deep">{memberCount}</div>
          <div className="text-[11px] font-semibold text-slate-500">Member</div>
        </div>
        <div className="rounded-2xl border border-border bg-white px-3 py-2 text-center">
          <div className="text-lg font-extrabold text-teal-deep">{totalOutstandingPoints}</div>
          <div className="text-[11px] font-semibold text-slate-500">Poin beredar</div>
        </div>
      </div>

      <Input
        placeholder="Cari nama, no. HP, atau ID member…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setVisibleCount(50);
        }}
        className="max-w-md rounded-full bg-white"
        data-testid="customers-search"
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(340px,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-2 lg:max-h-[72vh] lg:overflow-y-auto lg:pr-1">
          {visibleCustomers.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setSelectedId(c.id);
                setEditing(false);
              }}
              data-testid={`customer-row-${c.phone}`}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-xl border bg-white px-4 py-2.5 text-left shadow-sm",
                selectedId === c.id ? "border-teal-brand" : "border-border hover:border-teal-brand/40",
              )}
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-teal-deep">{c.name || "(tanpa nama)"}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {c.phone}
                  {c.is_member && c.member_no ? ` · ${c.member_no}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-heading text-base font-bold text-teal-deep">
                  {c.is_member ? `${c.points} poin` : <span className="text-xs font-medium text-muted-foreground">bukan member</span>}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {c.order_count} pesanan · {rupiah(c.lifetime_spend)}
                </p>
              </div>
            </button>
          ))}
          {customers.length === 0 && <div className="rounded-xl bg-mint px-4 py-4 text-sm text-teal-deep">Belum ada pelanggan tercatat.</div>}
          {visibleCount < 500 && customers.length >= visibleCount && (
            <Button type="button" variant="outline" className="w-full" onClick={() => setVisibleCount((v) => Math.min(v + 50, 500))} data-testid="customers-load-more">
              Muat lebih banyak
            </Button>
          )}
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-4">{renderDetail()}</div>
        </aside>
      </div>

      {selectedId && (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="customer-mobile-sheet">
          <div className="absolute inset-0 bg-slate-900/40" onClick={closeDetail} />
          <div className="absolute inset-x-0 bottom-0 max-h-[86vh] overflow-y-auto rounded-t-3xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex justify-end">
              <Button type="button" size="sm" variant="outline" onClick={closeDetail} data-testid="customer-mobile-close">
                Tutup
              </Button>
            </div>
            {renderDetail()}
          </div>
        </div>
      )}
    </section>
  );
}
