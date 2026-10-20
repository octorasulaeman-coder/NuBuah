import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import AccountCard from "@/components/AccountCard";
import BackupCard from "@/components/BackupCard";
import StaffEditDialog from "@/components/StaffEditDialog";
import StaffBar from "@/components/StaffBar";
import CouponsSection from "@/components/admin/CouponsSection";
import CustomersSection from "@/components/admin/CustomersSection";
import ScheduleSection from "@/components/admin/ScheduleSection";
import LoyaltySection from "@/components/admin/LoyaltySection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import type { Staff, StaffIn, Store, StoreIn } from "@/lib/types";

const errText = (e: unknown, fallback: string) => {
  if (e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in e.body) {
    const d = (e.body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return "Cek isian: " + d.map((x: { loc?: string[] }) => x.loc?.slice(-1)[0]).join(", ");
  }
  return fallback;
};

function StoreDialog({ store, onClose }: { store: Store | null | "new"; onClose: () => void }) {
  const qc = useQueryClient();
  const s = store === "new" || store === null ? null : store;
  const [name, setName] = useState(s?.name ?? "");
  const [code, setCode] = useState(s?.code ?? "");
  const [address, setAddress] = useState((s?.address_lines ?? []).join("\n"));
  const [phone, setPhone] = useState(s?.phone ?? "");
  const [pin, setPin] = useState("");
  const [approvalPin, setApprovalPin] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body: StoreIn = {
        name,
        code,
        address_lines: address.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 4),
        phone,
        pin: pin || null,
        approval_pin: approvalPin || null,
      };
      return s ? apiPut<Store>(`/stores/${s.id}`, body) : apiPost<Store>("/stores", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["public-stores"] });
      toast.success(s ? "Toko diperbarui" : "Toko ditambahkan");
      onClose();
    },
    onError: (e) => toast.error(errText(e, "Gagal menyimpan toko")),
  });
  return (
    <Dialog open={store !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="store-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-extrabold text-teal-deep italic">{s ? `Edit ${s.name}` : "Tambah toko"}</DialogTitle>
          <DialogDescription>Kode dipakai di nomor struk, mis. BDG-261011-001.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="st-name">Nama toko</Label>
              <Input id="st-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="NuBuah Bandung" data-testid="store-name-input" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="st-code">Kode</Label>
              <Input id="st-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))} placeholder="BDG" data-testid="store-code-input" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="st-addr">Alamat (per baris, maks 4)</Label>
            <Textarea id="st-addr" rows={3} value={address} onChange={(e) => setAddress(e.target.value)} data-testid="store-address-input" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="st-phone">Telp / WA</Label>
              <Input id="st-phone" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="store-phone-input" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="st-pin">{s ? "PIN baru (opsional)" : "PIN kasir (4–6 angka)"}</Label>
              <Input id="st-pin" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} data-testid="store-pin-input" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="st-approval-pin">{s ? "PIN approval baru (opsional)" : "PIN approval owner (4–6 angka)"}</Label>
              <Input
                id="st-approval-pin"
                inputMode="numeric"
                value={approvalPin}
                onChange={(e) => setApprovalPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder={s?.has_approval_pin ? "Sudah diatur — kosongkan jika tetap" : "Untuk diskon besar kasir"}
                data-testid="store-approval-pin-input"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Diskon kasir di atas {s?.discount_cap ?? 10}% perlu PIN approval owner. Ubah batasnya dengan env <code>DISCOUNT_CAP_PCT</code>.
          </p>
        </div>
        <DialogFooter>
          <Button className="rounded-full bg-teal-brand hover:bg-teal-deep" disabled={save.isPending || name.trim().length < 2 || code.length < 2} onClick={() => save.mutate()} data-testid="store-save-button">
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Admin() {
  const active = useActiveStore();
  const qc = useQueryClient();
  const stores = active.stores;
  const staffQ = useQuery({ queryKey: ["staff"], queryFn: () => apiGet<Staff[]>("/staff") });
  const [editing, setEditing] = useState<Store | null | "new">(null);
  const [deleting, setDeleting] = useState<Store | null>(null);
  const [editStaff, setEditStaff] = useState<Staff | null>(null);
  const delStore = useMutation({
    mutationFn: (id: string) => apiDelete<void>(`/stores/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["public-stores"] });
      qc.invalidateQueries({ queryKey: ["staff"] });
      toast.success(`${deleting?.name ?? "Toko"} dihapus`);
      setDeleting(null);
    },
    onError: (e) => toast.error(errText(e, "Gagal menghapus toko")),
  });
  const [form, setForm] = useState<StaffIn>({ name: "", email: "", password: "", store_id: "" });
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "Semua toko";

  const addStaff = useMutation({
    mutationFn: () => apiPost<Staff>("/staff", { ...form, store_id: form.store_id || stores[0]?.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      setForm({ name: "", email: "", password: "", store_id: form.store_id });
      toast.success("Staf ditambahkan");
    },
    onError: (e) => toast.error(errText(e, "Gagal menambah staf")),
  });
  const delStaff = useMutation({
    mutationFn: (id: string) => apiDelete<void>(`/staff/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      toast.success("Staf dihapus");
    },
    onError: (e) => toast.error(errText(e, "Gagal menghapus staf")),
  });

  return (
    <div className="min-h-screen bg-[#eef4f3]" data-testid="admin-page">
      <StaffBar active={active} />
      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-12">
        <section className="space-y-4 lg:col-span-7">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-teal-brand uppercase">Owner</p>
              <h1 className="font-heading text-3xl font-extrabold tracking-tight text-teal-deep italic">Toko</h1>
            </div>
            <Button className="rounded-full bg-teal-brand hover:bg-teal-deep" onClick={() => setEditing("new")} data-testid="add-store-button">
              <Plus /> Tambah toko
            </Button>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {stores.map((s) => (
              <li key={s.id} className="rounded-2xl border border-border bg-white p-4 shadow-sm" data-testid={`store-card-${s.code}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-heading font-bold text-teal-deep">{s.name}</div>
                    <span className="rounded bg-mint px-1.5 font-mono text-xs text-teal-deep">{s.code}</span>
                  </div>
                  <div className="flex gap-0.5">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)} data-testid={`edit-store-${s.code}`}>
                      <Pencil />
                    </Button>
                    {stores.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Hapus ${s.name}`}
                        onClick={() => setDeleting(s)}
                        data-testid={`delete-store-${s.code}`}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.address_lines.join(", ") || "Alamat belum diisi"}</p>
                <p className="mt-1 flex items-center gap-3 text-xs text-teal-deep">
                  <span>{s.phone || "-"}</span>
                  <span className="inline-flex items-center gap-1">
                    <KeyRound className="size-3" /> {s.has_pin ? "PIN aktif" : "Tanpa PIN"}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4 lg:col-span-5">
          <h2 className="font-heading text-3xl font-extrabold tracking-tight text-teal-deep italic">Staf</h2>
          <form
            className="grid gap-2 rounded-2xl border border-border bg-white p-4 shadow-sm"
            onSubmit={(e) => {
              e.preventDefault();
              addStaff.mutate();
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Nama" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="staff-name-input" />
              <select
                value={form.store_id || stores[0]?.id || ""}
                onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                className="h-8 rounded-lg border border-input bg-white px-2 text-sm"
                aria-label="Toko"
                data-testid="staff-store-select"
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required data-testid="staff-email-input" />
            <Input type="password" placeholder="Password (min 6)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} data-testid="staff-password-input" />
            <Button type="submit" className="rounded-full bg-teal-brand hover:bg-teal-deep" disabled={addStaff.isPending} data-testid="add-staff-button">
              <UserPlus /> Tambah kasir
            </Button>
          </form>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-white shadow-sm">
            {staffQ.isError && <li className="p-4 text-sm text-muted-foreground">Daftar staf tidak bisa dimuat.</li>}
            {(staffQ.data ?? []).map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 px-4 py-3" data-testid={`staff-row-${u.email}`}>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-teal-deep">
                    {u.name} {u.role === "owner" && <span className="ml-1 rounded bg-zest px-1.5 text-[10px] font-bold">OWNER</span>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {u.email} · {storeName(u.store_id)}
                  </div>
                </div>
                {u.role !== "owner" && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Ubah ${u.name}`} onClick={() => setEditStaff(u)} data-testid={`edit-staff-${u.email}`}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Hapus ${u.name}`}
                      onClick={() => window.confirm(`Hapus kasir "${u.name}"?`) && delStaff.mutate(u.id)}
                      data-testid={`delete-staff-${u.email}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Kasir juga bisa masuk tanpa akun memakai PIN toko di halaman login.</p>
        </section>
        {active.me && <AccountCard key={`${active.me.id}-${active.me.name}-${active.me.email}`} me={active.me} />}
        <BackupCard />
      </main>
      {editStaff && <StaffEditDialog key={editStaff.id} staff={editStaff} stores={stores} onClose={() => setEditStaff(null)} />}
      {editing !== null && <StoreDialog key={editing === "new" ? "new" : editing.id} store={editing} onClose={() => setEditing(null)} />}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md" data-testid="delete-store-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-extrabold text-teal-deep italic">Hapus {deleting?.name}?</DialogTitle>
            <DialogDescription>
              Toko, login kasir & PIN toko ini, serta harga khususnya akan dihapus. Riwayat penjualan tetap tersimpan di Riwayat (pilih "Semua toko") dan laporan.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setDeleting(null)} data-testid="delete-store-cancel-button">
              Batal
            </Button>
            <Button
              variant="destructive"
              className="rounded-full"
              disabled={delStore.isPending}
              onClick={() => deleting && delStore.mutate(deleting.id)}
              data-testid="delete-store-confirm-button"
            >
              <Trash2 /> Hapus toko
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CouponsSection />
      <div className="lg:col-span-12 border-t border-dashed my-2" />
      <CustomersSection />
      <ScheduleSection />
      <LoyaltySection />
    </div>
  );
}
