import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import { processImageFile } from "@/lib/imageUpload";
import { plain, rupiah } from "@/lib/format";
import type {
  MenuBundle, MenuCategoryRow, MenuGroupRow, MenuOptionRow, MenuOverride, MenuProductRow,
  ProductImageResponse, Store,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import MenuPhoto from "@/components/MenuPhoto";

interface AdminSnapshot {
  products: MenuProductRow[];
  groups: MenuGroupRow[];
  options: MenuOptionRow[];
  categories: MenuCategoryRow[];
  codes: Record<string, string>;
}

const errDetail = (e: unknown) =>
  e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in e.body ? String((e.body as { detail: unknown }).detail) : null;

const num = (s: string) => Number(s.replace(/\D/g, "")) || 0;

export default function MenuManager({ open, onOpenChange, storeId }: { open: boolean; onOpenChange: (o: boolean) => void; storeId: string | null }) {
  const qc = useQueryClient();
  const { isOwner, stores } = useActiveStore();
  const [tab, setTab] = useState<"products" | "groups" | "categories">("products");
  const [search, setSearch] = useState("");

  const snapQ = useQuery({
    queryKey: ["menu-admin"],
    queryFn: () => apiGet<AdminSnapshot>("/menu/admin/all"),
    enabled: open && isOwner,
  });
  const bundleQ = useQuery({
    queryKey: ["menu-bundle", storeId],
    queryFn: () => apiGet<MenuBundle>(`/menu/bundle${storeId ? `?store_id=${storeId}` : ""}`),
    enabled: open && !!storeId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["menu-admin"] });
    qc.invalidateQueries({ queryKey: ["menu-bundle"] });
  };

  const admin = snapQ.data;
  const overrides = bundleQ.data?.menu_overrides ?? [];

  if (!open) return null;

  const products = (admin?.products ?? []).filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.id.includes(search));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => onOpenChange(false)} data-testid="menu-manager">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="font-heading text-lg font-extrabold italic text-teal-deep">Kelola Menu</h3>
          <button onClick={() => onOpenChange(false)} aria-label="tutup" className="rounded-full p-1 hover:bg-muted"><X size={18} /></button>
        </div>

        <div className="flex gap-1 border-b px-4 pt-2">
          {(["products", "groups", "categories"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-t-lg px-3 py-1.5 text-sm font-semibold ${tab === t ? "bg-teal-deep text-white" : "text-muted-foreground hover:bg-muted"}`} data-testid={`tab-${t}`}>
              {t === "products" ? "Produk" : t === "groups" ? "Grup & Opsi" : "Kategori"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {snapQ.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Memuat…</p>}

          {tab === "products" && admin && (
            <ProductsTab
              products={products}
              groups={admin.groups}
              categories={admin.categories}
              stores={stores}
              overrides={overrides}
              onChanged={invalidate}
              onSearch={setSearch}
            />
          )}
          {tab === "groups" && admin && (
            <GroupsTab groups={admin.groups} options={admin.options} products={admin.products} onChanged={invalidate} />
          )}
          {tab === "categories" && admin && <CategoriesTab categories={admin.categories} products={admin.products} onChanged={invalidate} />}
        </div>
      </div>
    </div>
  );
}

/* ================= products ================= */

function ProductsTab({ products, groups, categories, stores, overrides, onChanged, onSearch }: {
  products: MenuProductRow[];
  groups: MenuGroupRow[];
  categories: MenuCategoryRow[];
  stores: Store[];
  overrides: MenuOverride[];
  onChanged: () => void;
  onSearch: (s: string) => void;
}) {
  const [editing, setEditing] = useState<MenuProductRow | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/menu/products/${id}`),
    onSuccess: () => { toast.success("Item dihapus"); setConfirmDelete(null); onChanged(); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menghapus"),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input placeholder="Cari item…" onChange={(e) => onSearch(e.target.value)} className="h-9" data-testid="product-search" />
        <Button className="rounded-full bg-teal-brand hover:bg-teal-deep" onClick={() => setEditing("new")} data-testid="add-product">
          <Plus size={15} className="mr-1" /> Item baru
        </Button>
      </div>
      <ul className="divide-y rounded-xl border">
        {products.map((p) => {
          const ov = overrides.find((o) => o.product_id === p.id);
          return (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2" data-testid={`row-${p.id}`}>
              <MenuPhoto id={p.id} name={p.name} color={p.color} category={p.category} photo={p.img_id ? `/api/media/${p.img_id}` : p.img} className="size-10 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {categories.find((c) => c.id === p.category)?.label ?? p.category} · {rupiah(p.r)}{p.sizes && p.l != null ? ` / ${rupiah(p.l)}` : ""}
                  {ov && (ov.r != null || ov.l != null) && <span className="text-amber-700"> · override {rupiah(ov.r ?? p.r)}</span>}
                </p>
              </div>
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setEditing(p)} data-testid={`edit-${p.id}`}><Pencil size={13} /></Button>
              {confirmDelete === p.id ? (
                <span className="flex items-center gap-1">
                  <Button size="sm" variant="destructive" className="rounded-full" disabled={del.isPending} onClick={() => del.mutate(p.id)} data-testid={`confirm-del-${p.id}`}>Ya, hapus</Button>
                  <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmDelete(null)}>Batal</Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => setConfirmDelete(p.id)} data-testid={`del-${p.id}`}><Trash2 size={13} /></Button>
              )}
            </li>
          );
        })}
        {products.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Tidak ada item.</li>}
      </ul>

      {editing && (
        <ProductForm
          initial={editing === "new" ? null : editing}
          groups={groups}
          categories={categories}
          stores={stores}
          overrides={overrides}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </div>
  );
}

/* ================= product form (fields + photo + per-store pricing) ================= */

function ProductForm({ initial, groups, categories, stores, overrides, onClose, onSaved }: {
  initial: MenuProductRow | null;
  groups: MenuGroupRow[];
  categories: MenuCategoryRow[];
  stores: Store[];
  overrides: MenuOverride[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [category, setCategory] = useState(initial?.category ?? categories[0]?.id ?? "");
  const [section, setSection] = useState(initial?.section ?? "");
  const [desc, setDesc] = useState(initial?.desc ?? "");
  const [benefit, setBenefit] = useState(initial?.benefit ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [color, setColor] = useState(initial?.color ?? "#F5B83D");
  const [sizes, setSizes] = useState(initial?.sizes ?? false);
  const [pricing, setPricing] = useState(initial?.pricing ?? "fixed");
  const [r, setR] = useState(String(initial?.r ?? ""));
  const [l, setL] = useState(initial?.l != null ? String(initial.l) : "");
  const [selGroups, setSelGroups] = useState<string[]>(initial?.groups ?? []);
  const [priceStore, setPriceStore] = useState<string>("");

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      initial ? apiPut<MenuProductRow>(`/menu/products/${initial.id}`, body) : apiPost<MenuProductRow>("/menu/products", body),
    onSuccess: async (row: MenuProductRow) => {
      if (!initial && pendingImg) {
        // new item: the queued photo uploads now that we have an id
        try {
          await apiPost<ProductImageResponse>(`/menu/products/${row.id}/image`, { data: pendingImg.base64, content_type: pendingImg.contentType });
        } catch {
          toast.error("Item tersimpan, tapi fotonya gagal — buka item lagi lalu unggah foto");
        }
      }
      toast.success("Tersimpan");
      onSaved();
    },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menyimpan"),
  });

  const upload = useMutation({
    mutationFn: (img: { base64: string; contentType: "image/webp" | "image/jpeg" }) =>
      apiPost<ProductImageResponse>(`/menu/products/${initial!.id}/image`, { data: img.base64, content_type: img.contentType }),
    onSuccess: () => { toast.success("Foto diperbarui"); qc.invalidateQueries({ queryKey: ["menu-admin"] }); qc.invalidateQueries({ queryKey: ["menu-bundle"] }); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal mengunggah foto"),
  });

  const removeImg = useMutation({
    mutationFn: () => apiDelete(`/menu/products/${initial!.id}/image`),
    onSuccess: () => { toast.success("Foto dihapus"); qc.invalidateQueries({ queryKey: ["menu-admin"] }); qc.invalidateQueries({ queryKey: ["menu-bundle"] }); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menghapus foto"),
  });

  const ovMut = useMutation({
    mutationFn: (body: { product_id: string; store_id: string; r: number | null; l: number | null; hidden: boolean; sold_out: boolean }) =>
      apiPut("/menu/overrides", body),
    onSuccess: () => { toast.success("Harga toko tersimpan"); qc.invalidateQueries({ queryKey: ["menu-bundle"] }); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menyimpan harga toko"),
  });
  const ovReset = useMutation({
    mutationFn: () => apiDelete(`/menu/overrides/${initial!.id}${priceStore ? `?store_id=${priceStore}` : ""}`),
    onSuccess: () => { toast.success("Kembali ke harga dasar"); qc.invalidateQueries({ queryKey: ["menu-bundle"] }); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal reset"),
  });

  const [pendingImg, setPendingImg] = useState<{ base64: string; contentType: "image/webp" | "image/jpeg"; preview: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickPhoto = async (file: File) => {
    try {
      const img = await processImageFile(file);
      const preview = `data:${img.contentType};base64,${img.base64}`;
      if (initial) {
        upload.mutate({ base64: img.base64, contentType: img.contentType }); // existing item: upload now
      } else {
        setPendingImg({ base64: img.base64, contentType: img.contentType, preview }); // new item: upload after save
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal memproses foto");
    }
  };
  const ov = overrides.find((o) => o.store_id === priceStore && o.product_id === initial?.id);
  const baseR = initial?.r ?? 0;
  const baseL = initial?.l ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="product-form">
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h4 className="font-heading text-base font-extrabold italic text-teal-deep">{initial ? "Edit item" : "Item baru"}</h4>
          <button onClick={onClose} aria-label="tutup"><X size={18} /></button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2"><Label className="text-xs">Nama</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="pf-name" /></div>
          <div><Label className="text-xs">Kode singkat</Label><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="auto" data-testid="pf-code" /></div>
          <div>
            <Label className="text-xs">Kategori</Label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 w-full rounded-md border bg-white px-2 text-sm" data-testid="pf-category">
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div><Label className="text-xs">Sub-bagian (opsional)</Label><Input value={section} onChange={(e) => setSection(e.target.value)} maxLength={40} data-testid="pf-section" /></div>
          <div><Label className="text-xs">Emoji (opsional)</Label><Input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={8} className="w-full" data-testid="pf-emoji" /></div>
          <div className="col-span-2"><Label className="text-xs">Deskripsi</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} data-testid="pf-desc" /></div>
          <div><Label className="text-xs">Benefit</Label><Input value={benefit} onChange={(e) => setBenefit(e.target.value)} maxLength={120} /></div>
          <div>
            <Label className="text-xs">Warna kartu</Label>
            <div className="flex h-9 items-center gap-2">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 cursor-pointer rounded-md border border-input bg-white p-1" data-testid="pf-color" />
              <span className="text-xs text-muted-foreground">Dipakai jika belum ada foto.</span>
            </div>
          </div>
          <div><Label className="text-xs">Harga dasar (Rp)</Label><Input inputMode="numeric" value={r} onChange={(e) => setR(e.target.value.replace(/\D/g, "").slice(0, 9))} data-testid="pf-r" /></div>
          <div>
            <Label className="text-xs">Ukuran</Label>
            <div className="flex h-9 items-center gap-2">
              <input type="checkbox" checked={sizes} onChange={(e) => setSizes(e.target.checked)} className="accent-teal-brand" data-testid="pf-sizes" />
              <span className="text-sm">Ada R / L</span>
              {sizes && <Input inputMode="numeric" value={l} onChange={(e) => setL(e.target.value.replace(/\D/g, "").slice(0, 9))} placeholder="harga L" className="h-8" data-testid="pf-l" />}
            </div>
          </div>
          <div>
            <Label className="text-xs">Perhitungan harga</Label>
            <select value={pricing} onChange={(e) => setPricing(e.target.value as "fixed" | "potong" | "custom")} className="h-9 w-full rounded-md border bg-white px-2 text-sm">
              <option value="fixed">Tetap</option>
              <option value="potong">Potong (harga by jumlah buah)</option>
              <option value="custom">Custom (buah + tambahan)</option>
            </select>
          </div>
        </div>

        <div className="mt-3">
          <Label className="text-xs">Grup opsi yang ditawarkan item ini</Label>
          <div className="mt-1 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border p-2">
            {groups.map((g) => (
              <label key={g.id} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${selGroups.includes(g.id) ? "border-teal-brand bg-mint text-teal-deep" : "text-muted-foreground"}`}>
                <input type="checkbox" className="hidden" checked={selGroups.includes(g.id)} onChange={() => setSelGroups((s) => (s.includes(g.id) ? s.filter((x) => x !== g.id) : [...s, g.id]))} />
                {g.label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Kosongkan semua untuk memakai default kategori.</p>
        </div>

        <div className="mt-3 rounded-xl border p-3">
          <Label className="text-xs">Foto produk</Label>
          <div className="mt-2 flex items-center gap-3">
            <MenuPhoto id={initial?.id ?? "new"} name={name || "?"} color={color} category={category}
              photo={pendingImg?.preview ?? (initial?.img_id ? `/api/media/${initial.img_id}` : initial?.img)} className="size-16 rounded-xl" />
            <div className="flex flex-col gap-1">
              <Button size="sm" variant="outline" className="rounded-full" disabled={upload.isPending} onClick={() => fileRef.current?.click()} data-testid="pf-photo-upload">
                <Camera size={13} className="mr-1" /> {upload.isPending ? "Memproses…" : pendingImg ? "Ganti foto" : initial?.img_id || initial?.img ? "Ganti foto" : "Pilih foto"}
              </Button>
              {(initial?.img_id || pendingImg) && !pendingImg && (
                <Button size="sm" variant="ghost" className="rounded-full text-destructive" disabled={removeImg.isPending} onClick={() => removeImg.mutate()} data-testid="pf-photo-remove">
                  Hapus foto
                </Button>
              )}
              {pendingImg && <p className="text-[11px] text-muted-foreground">Foto terpilih — ikut terunggah saat item disimpan.</p>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" data-testid="pf-photo-input"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickPhoto(f); e.target.value = ""; }} />
          </div>
        </div>

        {initial && stores.length > 0 && (
          <div className="mt-3 rounded-xl border p-3">
            <Label className="text-xs">Harga per toko (override harga dasar)</Label>
            <div className="mt-2 flex items-end gap-2">
              <select value={priceStore} onChange={(e) => setPriceStore(e.target.value)} className="h-9 rounded-md border bg-white px-2 text-sm" data-testid="pf-store">
                <option value="">Pilih toko…</option>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {priceStore && (
              <div className="mt-2 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Input inputMode="numeric" defaultValue={ov?.r ?? baseR} key={`r-${priceStore}-${ov?.r ?? baseR}`}
                    onBlur={(e) => { const v = num(e.target.value); if (v !== (ov?.r ?? baseR)) ovMut.mutate({ product_id: initial.id, store_id: priceStore, r: v, l: ov?.l ?? null, hidden: ov?.hidden ?? false, sold_out: ov?.sold_out ?? false }); }}
                    className="h-8 w-28" data-testid="pf-ov-r" />
                  {sizes && baseL != null && (
                    <Input inputMode="numeric" defaultValue={ov?.l ?? baseL} key={`l-${priceStore}-${ov?.l ?? baseL}`}
                      onBlur={(e) => { const v = num(e.target.value); if (v !== (ov?.l ?? baseL)) ovMut.mutate({ product_id: initial.id, store_id: priceStore, r: ov?.r ?? null, l: v, hidden: ov?.hidden ?? false, sold_out: ov?.sold_out ?? false }); }}
                      className="h-8 w-28" placeholder="harga L" data-testid="pf-ov-l" />
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>Harga dasar: {rupiah(baseR)}{sizes && baseL != null ? ` / ${rupiah(baseL)}` : ""}</span>
                  {ov && (ov.r != null || ov.l != null) && (
                    <button className="font-semibold text-destructive underline" onClick={() => ovReset.mutate()} data-testid="pf-ov-reset">Kembalikan ke harga dasar</button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Button className="flex-1 rounded-full bg-teal-brand hover:bg-teal-deep" disabled={save.isPending || !name.trim() || !r}
            onClick={() =>
              save.mutate({
                name: name.trim(), code: code.trim(), category, section: section.trim(), desc: desc.trim(), benefit: benefit.trim(),
                emoji: emoji || null, color, sizes, pricing, r: num(r), l: sizes && l ? num(l) : null,
                groups: selGroups.length ? selGroups : null,
              })
            }
            data-testid="pf-save">
            {save.isPending ? "Menyimpan…" : "Simpan item"}
          </Button>
          <Button variant="outline" className="rounded-full" onClick={onClose}>Batal</Button>
        </div>
      </div>
    </div>
  );
}

/* ================= groups & options ================= */

function GroupsTab({ groups, options, products, onChanged }: { groups: MenuGroupRow[]; options: MenuOptionRow[]; products: MenuProductRow[]; onChanged: () => void }) {
  const [editingGroup, setEditingGroup] = useState<MenuGroupRow | "new" | null>(null);
  const [editingOpt, setEditingOpt] = useState<{ opt: MenuOptionRow | null; groupId: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const qc = useQueryClient();
  const inv = () => { onChanged(); qc.invalidateQueries({ queryKey: ["menu-bundle"] }); };

  const delGroup = useMutation({
    mutationFn: (id: string) => apiDelete(`/menu/groups/${id}`),
    onSuccess: () => { toast.success("Grup dihapus"); setConfirmDel(null); inv(); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menghapus grup"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button className="rounded-full bg-teal-brand hover:bg-teal-deep" onClick={() => setEditingGroup("new")} data-testid="add-group"><Plus size={15} className="mr-1" /> Grup baru</Button>
      </div>
      {groups.map((g) => {
        const opts = options.filter((o) => o.group_id === g.id);
        return (
          <div key={g.id} className="rounded-xl border p-3" data-testid={`group-${g.id}`}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold">{g.label} <span className="ml-1 text-xs font-normal text-muted-foreground">{g.id}{g.builtin ? " · bawaan" : ""}</span></p>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => setEditingGroup(g)}><Pencil size={12} /></Button>
                {confirmDel === g.id ? (
                  <>
                    <Button size="sm" variant="destructive" className="rounded-full" disabled={delGroup.isPending} onClick={() => delGroup.mutate(g.id)}>Ya, hapus</Button>
                    <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmDel(null)}>Batal</Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => setConfirmDel(g.id)}><Trash2 size={12} /></Button>
                )}
              </div>
            </div>
            <ul className="mt-2 space-y-1">
              {opts.map((o) => (
                <li key={o.id} className="flex items-center justify-between rounded-lg bg-muted/50 px-2 py-1 text-sm" data-testid={`opt-${o.id}`}>
                  <span>{o.label}{o.tier ? <span className="text-xs text-muted-foreground"> · {o.tier}</span> : null}{o.default ? " · default" : ""}</span>
                  <span className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">{rupiah(o.r)}{o.l != null ? ` / ${rupiah(o.l)}` : ""}</span>
                    <Button size="sm" variant="ghost" className="h-6 w-6 rounded-full p-0" onClick={() => setEditingOpt({ opt: o, groupId: g.id })}><Pencil size={11} /></Button>
                  </span>
                </li>
              ))}
              <li>
                <button className="text-xs font-semibold text-teal-deep underline" onClick={() => setEditingOpt({ opt: null, groupId: g.id })} data-testid={`add-opt-${g.id}`}>+ Tambah opsi</button>
              </li>
            </ul>
          </div>
        );
      })}
      {editingGroup && <GroupForm initial={editingGroup === "new" ? null : editingGroup} products={products} onClose={() => setEditingGroup(null)} onSaved={() => { setEditingGroup(null); inv(); }} />}
      {editingOpt && <OptionForm groupId={editingOpt.groupId} initial={editingOpt.opt} onClose={() => setEditingOpt(null)} onSaved={() => { setEditingOpt(null); inv(); }} />}
    </div>
  );
}

function GroupForm({ initial, products, onClose, onSaved }: { initial: MenuGroupRow | null; products: MenuProductRow[]; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState(initial?.type ?? "multi");
  const [min, setMin] = useState(String(initial?.min ?? 0));
  const [max, setMax] = useState(initial?.max != null ? String(initial.max) : "");
  const [hint, setHint] = useState(initial?.hint ?? "");
  const [pids, setPids] = useState<string[]>(initial?.product_ids ?? []);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (initial ? apiPut(`/menu/groups/${initial.id}`, body) : apiPost("/menu/groups", body)),
    onSuccess: () => { toast.success("Tersimpan"); onSaved(); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menyimpan"),
  });
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <h4 className="mb-3 font-heading text-base font-extrabold italic text-teal-deep">{initial ? "Edit grup" : "Grup baru"}</h4>
        <div className="space-y-2">
          <div><Label className="text-xs">Nama grup</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="gf-label" /></div>
          <div className="flex gap-2">
            <div>
              <Label className="text-xs">Tipe</Label>
              <select value={type} onChange={(e) => setType(e.target.value as "single" | "multi")} className="h-9 w-full rounded-md border bg-white px-2 text-sm">
                <option value="single">Pilih satu</option>
                <option value="multi">Bisa banyak</option>
              </select>
            </div>
            <div><Label className="text-xs">Min</Label><Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} className="w-16" /></div>
            <div><Label className="text-xs">Max</Label><Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} className="w-16" placeholder="∞" /></div>
          </div>
          <div><Label className="text-xs">Petunjuk (opsional)</Label><Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="mis. Maks 12 buah" /></div>
          <div>
            <Label className="text-xs">Ditawarkan di item (opsional — item juga bisa memilih grup ini sendiri)</Label>
            <div className="mt-1 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border p-2">
              {products.map((p) => (
                <label key={p.id} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${pids.includes(p.id) ? "border-teal-brand bg-mint text-teal-deep" : "text-muted-foreground"}`}>
                  <input type="checkbox" className="hidden" checked={pids.includes(p.id)} onChange={() => setPids((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))} />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button className="flex-1 rounded-full bg-teal-brand hover:bg-teal-deep" disabled={save.isPending || !label.trim()}
            onClick={() => save.mutate({ label: label.trim(), type, min: num(min), max: max ? num(max) : null, hint: hint.trim(), product_ids: pids })} data-testid="gf-save">
            Simpan grup
          </Button>
          <Button variant="outline" className="rounded-full" onClick={onClose}>Batal</Button>
        </div>
      </div>
    </div>
  );
}

function OptionForm({ groupId, initial, onClose, onSaved }: { groupId: string; initial: MenuOptionRow | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [r, setR] = useState(String(initial?.r ?? ""));
  const [l, setL] = useState(initial?.l != null ? String(initial.l) : "");
  const [tier, setTier] = useState(initial?.tier ?? "");
  const [isDefault, setIsDefault] = useState(initial?.default ?? false);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (initial ? apiPut(`/menu/options/${initial.id}`, body) : apiPost("/menu/options", body)),
    onSuccess: () => { toast.success("Tersimpan"); onSaved(); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menyimpan"),
  });
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <h4 className="mb-3 font-heading text-base font-extrabold italic text-teal-deep">{initial ? "Edit opsi" : "Opsi baru"}</h4>
        <div className="space-y-2">
          <div><Label className="text-xs">Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="of-label" /></div>
          <div className="flex gap-2">
            <div className="flex-1"><Label className="text-xs">Harga (Rp)</Label><Input inputMode="numeric" value={r} onChange={(e) => setR(e.target.value.replace(/[^\d-]/g, "").slice(0, 9))} data-testid="of-r" /></div>
            <div className="flex-1"><Label className="text-xs">Harga L (opsional)</Label><Input inputMode="numeric" value={l} onChange={(e) => setL(e.target.value.replace(/[^\d-]/g, "").slice(0, 9))} data-testid="of-l" /></div>
          </div>
          <div><Label className="text-xs">Gelar tier (opsional, mis. Buah Pilihan · 4K)</Label><Input value={tier} onChange={(e) => setTier(e.target.value)} maxLength={40} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="accent-teal-brand" /> Terpilih otomatis</label>
        </div>
        <div className="mt-4 flex gap-2">
          <Button className="flex-1 rounded-full bg-teal-brand hover:bg-teal-deep" disabled={save.isPending || !label.trim()}
            onClick={() => save.mutate({ group_id: groupId, label: label.trim(), r: num(r), l: l ? num(l) : null, tier: tier || null, default: isDefault })} data-testid="of-save">
            Simpan opsi
          </Button>
          <Button variant="outline" className="rounded-full" onClick={onClose}>Batal</Button>
        </div>
      </div>
    </div>
  );
}

/* ================= categories ================= */

function CategoriesTab({ categories, products, onChanged }: { categories: MenuCategoryRow[]; products: MenuProductRow[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<MenuCategoryRow | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [blurb, setBlurb] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const inv = () => onChanged();

  const save = useMutation({
    mutationFn: () => (editing && editing !== "new" ? apiPut(`/menu/categories/${editing.id}`, { label: label.trim(), blurb: blurb.trim(), color: editing.color }) : apiPost("/menu/categories", { label: label.trim(), blurb: blurb.trim(), color: "#0d9489" })),
    onSuccess: () => { toast.success("Tersimpan"); setEditing(null); inv(); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menyimpan"),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/menu/categories/${id}`),
    onSuccess: () => { toast.success("Kategori dihapus"); setConfirmDel(null); inv(); },
    onError: (e) => toast.error(errDetail(e) ?? "Gagal menghapus — mungkin masih dipakai item"),
  });

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button className="rounded-full bg-teal-brand hover:bg-teal-deep" onClick={() => { setLabel(""); setBlurb(""); setEditing("new"); }} data-testid="add-category"><Plus size={15} className="mr-1" /> Kategori baru</Button>
      </div>
      {categories.map((c) => (
        <div key={c.id} className="flex items-center justify-between rounded-xl border px-3 py-2" data-testid={`cat-${c.id}`}>
          <div>
            <p className="text-sm font-semibold">{c.label} <span className="ml-1 text-xs font-normal text-muted-foreground">{c.id}{c.builtin ? " · bawaan" : ""}</span></p>
            {c.blurb && <p className="text-xs text-muted-foreground">{c.blurb}</p>}
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="rounded-full" onClick={() => { setLabel(c.label); setBlurb(c.blurb); setEditing(c); }}><Pencil size={12} /></Button>
            {confirmDel === c.id ? (
              <>
                <Button size="sm" variant="destructive" className="rounded-full" disabled={del.isPending} onClick={() => del.mutate(c.id)}>Ya</Button>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmDel(null)}>Batal</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => setConfirmDel(c.id)}><Trash2 size={12} /></Button>
            )}
          </div>
        </div>
      ))}
      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setEditing(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3 font-heading text-base font-extrabold italic text-teal-deep">{editing === "new" ? "Kategori baru" : "Edit kategori"}</h4>
            <div className="space-y-2">
              <div><Label className="text-xs">Nama</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="cf-label" /></div>
              <div><Label className="text-xs">Deskripsi singkat</Label><Input value={blurb} onChange={(e) => setBlurb(e.target.value)} maxLength={200} /></div>
            </div>
            <div className="mt-4 flex gap-2">
              <Button className="flex-1 rounded-full bg-teal-brand hover:bg-teal-deep" disabled={save.isPending || !label.trim()} onClick={() => save.mutate()} data-testid="cf-save">Simpan</Button>
              <Button variant="outline" className="rounded-full" onClick={() => setEditing(null)}>Batal</Button>
            </div>
          </div>
        </div>
      )}
      <p className="pt-2 text-[11px] text-muted-foreground">Kategori yang masih dipakai item tidak bisa dihapus — pindahkan itemnya dulu.</p>
    </div>
  );
}
