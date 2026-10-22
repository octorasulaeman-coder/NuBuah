import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Layers, Pencil, Plus, RotateCcw, Search, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EDITABLE_GROUPS, GROUPS, type Groups, type MenuOption } from "@/data/menu";
import CategoryManager, { type BuiltinCategory } from "@/components/pos/CategoryManager";
import { defaultGroupsFor } from "@/lib/useMenu";
import type { CustomCategory, CustomGroup } from "@/lib/types";
import CustomGroupDialog from "@/components/pos/CustomGroupDialog";
import BuiltinProductDialog from "@/components/pos/BuiltinProductDialog";
import EditTextDialog from "@/components/pos/EditTextDialog";
import CustomProductForm, { type FormInitial } from "@/components/pos/CustomProductForm";
import CustomOptionForm, { type OptionFormInitial } from "@/components/pos/CustomOptionForm";
import { ApiError, apiDelete, apiPut } from "@/lib/api";
import { plain } from "@/lib/format";
import type { LiveProduct } from "@/lib/useMenu";
import type { MenuOverride, MenuOverrideIn, OptionOverride, OptionOverrideIn } from "@/lib/types";
import { cn } from "@/lib/utils";

const digits = (s: string) => s.replace(/\D/g, "").slice(0, 8);

function Row({ p, qs, isOwner, onEdit, allCodes }: { p: LiveProduct; qs: string; isOwner: boolean; onEdit: (p: LiveProduct) => void; allCodes: { id: string; name: string; code?: string }[] }) {
  const qc = useQueryClient();
  const base = p.base;
  const hasL = p.l !== undefined;
  const [r, setR] = useState(String(p.r));
  const [l, setL] = useState(String(p.l ?? ""));
  const [soldOut, setSoldOut] = useState(p.soldOut);
  const [code, setCode] = useState(p.code ?? "");
  const codeClash = code ? allCodes.find((x) => x.id !== p.id && x.code?.toUpperCase() === code) : undefined;
  const codeDirty = code !== (p.code ?? "");
  const saveCode = useMutation({
    mutationFn: () => apiPut<{ code: string }>(`/menu/codes/${p.id}`, { code }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu-codes"] });
      qc.invalidateQueries({ queryKey: ["custom-products"] });
      toast.success(`Kode ${p.name} disimpan: ${code}`);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.message ? e.message : "Gagal menyimpan kode"),
  });
  const dirty = Number(r) !== p.r || (hasL && Number(l) !== p.l) || soldOut !== p.soldOut;
  const invalid = r === "" || (hasL && l === "");

  const save = useMutation({
    mutationFn: (body: MenuOverrideIn) => apiPut<MenuOverride>(`/menu/overrides/${p.id}${qs}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu-overrides"] });
      toast.success(`${p.name} diperbarui`);
    },
    onError: () => toast.error("Gagal menyimpan perubahan"),
  });
  const reset = useMutation({
    mutationFn: () => apiDelete<void>(`/menu/overrides/${p.id}${qs}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu-overrides"] });
      setR(String(base.r));
      setL(String(base.l ?? ""));
      setSoldOut(false);
      toast.success(`${p.name} kembali ke harga awal`);
    },
  });

  const setHidden = (hidden: boolean) =>
    save.mutate({ r: Number(r) || p.r, l: hasL ? Number(l) || (p.l ?? null) : null, sold_out: soldOut, hidden });
  const remove = useMutation({
    mutationFn: () => apiDelete<void>(`/menu/custom-products/${p.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-products"] });
      qc.invalidateQueries({ queryKey: ["menu-overrides"] });
      toast.success(`${p.name} dihapus dari menu`);
    },
    onError: () => toast.error("Gagal menghapus menu"),
  });
  const confirmRemove = () => {
    if (window.confirm(`Hapus "${p.name}" dari menu? Struk lama tidak berubah.`)) remove.mutate();
  };

  const toggleSoldOut = (v: boolean) => {
    setSoldOut(v);
    // Sold-out is a quick action: persist immediately with current prices.
    save.mutate({ r: Number(r) || p.r, l: hasL ? Number(l) || (p.l ?? null) : null, sold_out: v, hidden: p.hidden });
  };

  return (
    <li className={cn("space-y-2 py-3", (soldOut || p.hidden) && "opacity-70")} data-testid={`menu-editor-row-${p.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold text-teal-deep">
            {p.code && <span className="mr-1 text-teal-brand">{p.code}</span>}
            {p.name}
          </div>
          {isOwner && (
            <div className="mt-1 flex items-center gap-1.5">
              <Input
                value={code}
                maxLength={8}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="KODE"
                aria-label={`Kode ${p.name}`}
                className="h-7 w-24 font-mono text-xs uppercase"
                data-testid={`menu-editor-code-${p.id}`}
              />
              {codeDirty && (
                <Button size="sm" className="h-7 bg-teal-brand px-2 text-xs hover:bg-teal-deep" disabled={!code || !!codeClash || saveCode.isPending} onClick={() => saveCode.mutate()} data-testid={`menu-editor-code-save-${p.id}`}>
                  Simpan kode
                </Button>
              )}
            </div>
          )}
          {codeClash && (
            <div className="text-[11px] font-semibold text-destructive" data-testid={`menu-editor-code-error-${p.id}`}>
              Kode {code} sudah dipakai oleh {codeClash.name}
            </div>
          )}
          {p.hidden && <div className="text-[11px] font-semibold text-amber-600">Disembunyikan dari kasir &amp; halaman depan</div>}
          {p.custom && !p.hidden && <div className="text-[11px] text-teal-brand">Menu tambahan</div>}
          {p.edited && <div className="text-[11px] text-teal-brand" data-testid={`menu-editor-edited-${p.id}`}>Diedit (asli: {p.orig.name})</div>}
          {p.overridden && (
            <div className="text-[11px] text-muted-foreground">
              Harga awal {plain(base.r)}
              {base.l != null && ` / ${plain(base.l)}`}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isOwner && (
            <Button variant="ghost" size="icon-sm" aria-label="Ubah menu" onClick={() => onEdit(p)} data-testid={`menu-editor-edit-${p.id}`}>
              <Pencil />
            </Button>
          )}
          {isOwner && (
            <Button variant="ghost" size="icon-sm" aria-label={p.hidden ? "Tampilkan menu" : "Sembunyikan menu"} onClick={() => setHidden(!p.hidden)} data-testid={`menu-editor-hide-${p.id}`}>
              {p.hidden ? <Eye /> : <EyeOff />}
            </Button>
          )}
          {isOwner && p.custom && (
            <Button variant="ghost" size="icon-sm" aria-label="Hapus menu" onClick={confirmRemove} disabled={remove.isPending} data-testid={`menu-editor-delete-${p.id}`}>
              <Trash2 />
            </Button>
          )}
          <label className="ml-1 flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox checked={soldOut} onCheckedChange={toggleSoldOut} data-testid={`menu-editor-soldout-${p.id}`} />
            Habis
          </label>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <span className="text-[11px] text-muted-foreground">{p.pricing === "potong" ? "≤4 macam" : p.pricing === "custom" ? "Biaya olah" : hasL ? "Regular" : "Harga"}</span>
          <Input inputMode="numeric" value={r} onChange={(e) => setR(digits(e.target.value))} disabled={!isOwner} className="h-9 font-mono" data-testid={`menu-editor-price-r-${p.id}`} />
        </div>
        {hasL && (
          <div className="flex-1">
            <span className="text-[11px] text-muted-foreground">{p.pricing === "potong" ? ">4 macam" : "Large"}</span>
            <Input inputMode="numeric" value={l} onChange={(e) => setL(digits(e.target.value))} disabled={!isOwner} className="h-9 font-mono" data-testid={`menu-editor-price-l-${p.id}`} />
          </div>
        )}
        <Button
          size="sm"
          className="h-9 bg-teal-brand hover:bg-teal-deep"
          disabled={!isOwner || !dirty || invalid || save.isPending}
          onClick={() => save.mutate({ r: Number(r), l: hasL ? Number(l) : null, sold_out: soldOut, hidden: p.hidden })}
          data-testid={`menu-editor-save-${p.id}`}
        >
          Simpan
        </Button>
        {p.overridden && isOwner && (
          <Button variant="ghost" size="icon-sm" aria-label="Kembalikan ke harga awal" onClick={() => reset.mutate()} data-testid={`menu-editor-reset-${p.id}`}>
            <RotateCcw />
          </Button>
        )}
      </div>
    </li>
  );
}

function OptionRow({ groupId, o, base, overridden, qs, isOwner, onEdit }: { groupId: string; o: MenuOption; base: { r: number; l?: number }; overridden: boolean; qs: string; isOwner: boolean; onEdit: (groupId: string, o: MenuOption) => void }) {
  const qc = useQueryClient();
  const hasL = o.l !== undefined;
  const [r, setR] = useState(String(o.r));
  const [l, setL] = useState(String(o.l ?? ""));
  const soldOut = !!o.soldOut;
  const num = (s: string) => Number(s.replace(/[^\d-]/g, ""));
  const valid = /^-?\d+$/.test(r) && (!hasL || /^-?\d+$/.test(l));
  const dirty = num(r) !== o.r || (hasL && num(l) !== o.l);
  const path = `/menu/option-overrides/${groupId}/${o.id}${qs}`;
  const done = () => qc.invalidateQueries({ queryKey: ["menu-option-overrides"] });
  const hidden = !!o.hidden;
  const remove = useMutation({
    mutationFn: () => apiDelete<void>(`/menu/custom-options/${o.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-options"] });
      qc.invalidateQueries({ queryKey: ["menu-option-overrides"] });
      toast.success(`${o.label} dihapus`);
    },
    onError: () => toast.error("Gagal menghapus"),
  });
  const confirmRemove = () => {
    if (window.confirm(`Hapus "${o.label}"? Struk lama tidak berubah.`)) remove.mutate();
  };

  const save = useMutation({
    mutationFn: (body: OptionOverrideIn) => apiPut<OptionOverride>(path, body),
    onSuccess: () => {
      done();
      toast.success(`${o.label} diperbarui`);
    },
    onError: () => toast.error("Gagal menyimpan perubahan"),
  });
  const reset = useMutation({
    mutationFn: () => apiDelete<void>(path),
    onSuccess: () => {
      done();
      toast.success(`${o.label} kembali ke harga awal`);
    },
  });
  const body = (sold: boolean, hide: boolean = hidden): OptionOverrideIn => ({ r: valid ? num(r) : o.r, l: hasL ? (valid ? num(l) : (o.l ?? null)) : null, sold_out: sold, hidden: hide });
  const signed = (s: string) => s.replace(/(?!^-)[^\d]/g, "").slice(0, 8);

  return (
    <li className={cn("space-y-2 py-3", (soldOut || hidden) && "opacity-70")} data-testid={`option-editor-row-${groupId}-${o.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold text-teal-deep">{o.label}</div>
          {hidden && <div className="text-[11px] font-semibold text-amber-600">Disembunyikan dari layar pesanan</div>}
          {o.custom && !hidden && <div className="text-[11px] text-teal-brand">Menu tambahan</div>}
          {o.edited && <div className="text-[11px] text-teal-brand">Diedit (asli: {o.origLabel})</div>}
          {overridden && (
            <div className="text-[11px] text-muted-foreground">
              Harga awal {plain(base.r)}
              {base.l != null && ` / ${plain(base.l)}`}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isOwner && (
            <Button variant="ghost" size="icon-sm" aria-label="Ubah" onClick={() => onEdit(groupId, o)} data-testid={`option-editor-edit-${groupId}-${o.id}`}>
              <Pencil />
            </Button>
          )}
          {isOwner && (
            <Button variant="ghost" size="icon-sm" aria-label={hidden ? "Tampilkan" : "Sembunyikan"} onClick={() => save.mutate(body(soldOut, !hidden))} data-testid={`option-editor-hide-${groupId}-${o.id}`}>
              {hidden ? <Eye /> : <EyeOff />}
            </Button>
          )}
          {isOwner && o.custom && (
            <Button variant="ghost" size="icon-sm" aria-label="Hapus" onClick={confirmRemove} disabled={remove.isPending} data-testid={`option-editor-delete-${groupId}-${o.id}`}>
              <Trash2 />
            </Button>
          )}
          <label className="ml-1 flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox checked={soldOut} onCheckedChange={(v) => save.mutate(body(v))} data-testid={`option-editor-soldout-${groupId}-${o.id}`} />
            Habis
          </label>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <span className="text-[11px] text-muted-foreground">{hasL ? "Regular" : "Harga"}</span>
          <Input value={r} onChange={(e) => setR(signed(e.target.value))} disabled={!isOwner} className="h-9 font-mono" data-testid={`option-editor-price-r-${groupId}-${o.id}`} />
        </div>
        {hasL && (
          <div className="flex-1">
            <span className="text-[11px] text-muted-foreground">Large</span>
            <Input value={l} onChange={(e) => setL(signed(e.target.value))} disabled={!isOwner} className="h-9 font-mono" data-testid={`option-editor-price-l-${groupId}-${o.id}`} />
          </div>
        )}
        <Button
          size="sm"
          className="h-9 bg-teal-brand hover:bg-teal-deep"
          disabled={!isOwner || !dirty || !valid || save.isPending}
          onClick={() => save.mutate(body(soldOut))}
          data-testid={`option-editor-save-${groupId}-${o.id}`}
        >
          Simpan
        </Button>
        {overridden && isOwner && (
          <Button variant="ghost" size="icon-sm" aria-label="Kembalikan ke harga awal" onClick={() => reset.mutate()} data-testid={`option-editor-reset-${groupId}-${o.id}`}>
            <RotateCcw />
          </Button>
        )}
      </div>
    </li>
  );
}

const GROUP_TITLES: Record<string, string> = {
  bowl_topping: "Topping Smoothie Bowl",
  bowl_extra: "Opsi Smoothie Bowl",
  drink_extra: "Opsi Jus & Smoothie (R / L)",
  custom_bowl_extra: "Opsi Custom Bowl",
  potong_extra: "Tambahan Buah Potong",
  ice: "Es (Ice)",
  kuah: "Kuah",
};

export default function MenuEditor({
  open,
  onOpenChange,
  products,
  categories,
  customCategories,
  customGroups,
  groups,
  optionOverridden,
  storeId,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  products: LiveProduct[];
  categories: { id: string; label: string; blurb: string }[];
  customCategories: CustomCategory[];
  customGroups: CustomGroup[];
  groups: Groups;
  optionOverridden: Set<string>;
  storeId: string | null;
  isOwner: boolean;
}) {
  const qs = storeId ? `?store_id=${storeId}` : "";
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"products" | "options">("products");
  const term = q.trim().toLowerCase();
  const list = products.filter((p) => !term || `${p.code ?? ""} ${p.name}`.toLowerCase().includes(term));
  const soldOutCount = products.filter((p) => p.soldOut).length;
  const qc = useQueryClient();
  const [catMgrOpen, setCatMgrOpen] = useState(false);
  const [builtinProd, setBuiltinProd] = useState<LiveProduct | null>(null);
  const [renameOpt, setRenameOpt] = useState<{ gid: string; o: MenuOption } | null>(null);
  const [renameGroup, setRenameGroup] = useState<string | null>(null);
  const [groupDlg, setGroupDlg] = useState<{ key: number; group: CustomGroup | null } | null>(null);
  const delGroup = useMutation({
    mutationFn: (id: string) => apiDelete<void>(`/menu/custom-groups/${id}`),
    onSuccess: () => {
      ["custom-groups", "custom-options", "menu-option-overrides"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success("Grup topping dihapus");
    },
    onError: () => toast.error("Gagal menghapus grup"),
  });
  const [optDefaultGroup, setOptDefaultGroup] = useState<string | undefined>(undefined);
  const allCodes = products.map((x) => ({ id: x.id, name: x.name, code: x.code }));
  const seenCodes = new Map<string, number>();
  allCodes.forEach((x) => x.code && seenCodes.set(x.code.toUpperCase(), (seenCodes.get(x.code.toUpperCase()) ?? 0) + 1));
  const dupCodes = [...seenCodes].filter(([, n]) => n > 1).map(([c]) => c);
  const usedCategoryIds = new Set(products.filter((p) => p.custom).map((p) => p.category));
  const formCategories = categories.filter((c) => c.id !== "potong" && c.id !== "custom");
  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState(0); // new key each time so the form always starts fresh
  const [editing, setEditing] = useState<FormInitial | null>(null);
  const [optFormOpen, setOptFormOpen] = useState(false);
  const [optFormKey, setOptFormKey] = useState(0);
  const [optEditing, setOptEditing] = useState<OptionFormInitial | null>(null);
  const openAddOption = (gid?: string) => {
    setOptDefaultGroup(gid);
    setOptEditing(null);
    setOptFormKey((k) => k + 1);
    setOptFormOpen(true);
  };
  const openEditOption = (groupId: string, o: MenuOption) => {
    setOptEditing({ id: o.id, group_id: groupId, label: o.label, r: o.base?.r ?? o.r, l: o.base?.l });
    setOptFormKey((k) => k + 1);
    setOptFormOpen(true);
  };
  const openAdd = () => {
    setEditing(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };
  const openEdit = (p: LiveProduct) => {
    const isDefault = JSON.stringify(p.base.groups) === JSON.stringify(defaultGroupsFor(p.category));
    setEditing({ id: p.id, code: p.code, name: p.base.name, category: p.category, section: p.base.section, groups: isDefault ? null : p.base.groups, desc: p.base.desc, benefit: p.base.benefit, r: p.base.r, l: p.base.l ?? undefined, color: p.base.color });
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md" data-testid="menu-editor">
        <SheetHeader className="border-b">
          <SheetTitle className="font-heading text-xl font-extrabold italic text-teal-deep">Kelola Menu</SheetTitle>
          <SheetDescription>
            {isOwner ? "Ubah harga atau tandai habis untuk toko ini." : "Tandai menu yang habis. Harga hanya bisa diubah owner."}{soldOutCount > 0 && <b data-testid="menu-editor-soldout-count">{soldOutCount} item habis.</b>}
          </SheetDescription>
          {isOwner && tab === "options" && (
            <Button variant="outline" className="mt-2 h-9 w-full" onClick={() => setGroupDlg({ key: Date.now(), group: null })} data-testid="menu-editor-add-group">
              <Layers /> Tambah grup topping
            </Button>
          )}
          {isOwner && tab === "products" && dupCodes.length > 0 && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="menu-editor-dup-codes">
              Ada kode kembar: <b className="font-mono">{dupCodes.join(", ")}</b>. Ubah salah satunya di kolom kode (smoothie dan bowl dengan nama sama memakai kode yang sama).
            </p>
          )}
          {isOwner && (
            <Button className="mt-2 h-9 w-full bg-teal-brand hover:bg-teal-deep" onClick={tab === "options" ? () => openAddOption() : openAdd} data-testid="menu-editor-add">
              <Plus /> {tab === "options" ? "Tambah topping / opsi baru" : "Tambah menu baru"}
            </Button>
          )}
          {isOwner && tab === "products" && (
            <Button variant="outline" className="mt-2 h-9 w-full" onClick={() => setCatMgrOpen(true)} data-testid="menu-editor-categories">
              <Tags /> Kelola kategori
            </Button>
          )}
          <div className="relative mt-2">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari menu" className="h-9 pl-9" data-testid="menu-editor-search" />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1 rounded-full bg-mint p-1" role="tablist">
            {(
              [
                ["products", "Produk"],
                ["options", "Topping & Opsi"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                data-testid={`menu-editor-tab-${id}`}
                className={cn(
                  "rounded-full py-1.5 text-sm font-semibold transition-colors duration-150",
                  tab === id ? "bg-teal-brand text-white" : "text-teal-deep hover:bg-white/60",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4">
          {tab === "options" &&
            [...EDITABLE_GROUPS, ...customGroups.map((cg) => cg.id)].map((gid) => {
              const g = groups[gid];
              if (!g) return null;
              const cg = customGroups.find((x) => x.id === gid);
              const opts = g.options.filter((o) => !term || o.label.toLowerCase().includes(term));
              if (!opts.length && !(cg && !term)) return null;
              return (
                <section key={gid} className="pt-4" data-testid={`option-group-${gid}`}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-bold tracking-wider text-teal-brand uppercase">
                      {cg ? cg.label : g.edited ? g.label : GROUP_TITLES[gid]}
                      {cg && <span className="ml-2 rounded bg-mint px-1.5 py-0.5 text-[10px] font-semibold tracking-normal normal-case text-teal-deep">{cg.type === "single" ? "pilih satu" : "pilih banyak"} · {cg.product_ids.length} menu</span>}
                    </h3>
                    {isOwner && !cg && (
                      <Button variant="ghost" size="icon-sm" aria-label="Ubah nama grup" onClick={() => setRenameGroup(gid)} data-testid={`group-rename-${gid}`}>
                        <Pencil />
                      </Button>
                    )}
                    {isOwner && cg && (
                      <div className="flex shrink-0 gap-0.5">
                        <Button variant="ghost" size="icon-sm" aria-label="Tambah topping ke grup ini" onClick={() => openAddOption(cg.id)} data-testid={`group-add-option-${cg.id}`}>
                          <Plus />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label="Ubah grup" onClick={() => setGroupDlg({ key: Date.now(), group: cg })} data-testid={`group-edit-${cg.id}`}>
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Hapus grup"
                          onClick={() => window.confirm(`Hapus grup "${cg.label}" beserta semua topping di dalamnya? Struk lama tidak berubah.`) && delGroup.mutate(cg.id)}
                          data-testid={`group-delete-${cg.id}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </div>
                  {cg && !opts.length && <p className="py-3 text-xs text-muted-foreground">Belum ada topping di grup ini. Tekan + untuk menambah.</p>}
                  <ul className="divide-y divide-border">
                    {opts.map((o) => (
                      <OptionRow
                        qs={qs}
                        isOwner={isOwner}
                        key={`${o.id}-${o.r}-${o.l ?? ""}-${!!o.soldOut}-${!!o.hidden}`}
                        groupId={gid}
                        o={o}
                        base={GROUPS[gid]?.options.find((b) => b.id === o.id) ?? o.base ?? o}
                        onEdit={(gid2, o2) => (o2.custom ? openEditOption(gid2, o2) : setRenameOpt({ gid: gid2, o: o2 }))}
                        overridden={optionOverridden.has(`${gid}/${o.id}`)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          {tab === "products" && categories.map((c) => {
            const items = list.filter((p) => p.category === c.id);
            if (!items.length) return null;
            return (
              <section key={c.id} className="pt-4">
                <h3 className="text-xs font-bold tracking-wider text-teal-brand uppercase">{c.label}</h3>
                <ul className="divide-y divide-border">
                  {items.map((p) => (
                    <Row key={`${p.id}-${p.r}-${p.l ?? ""}-${p.soldOut}-${p.hidden}-${p.code ?? ""}`} p={p} qs={qs} isOwner={isOwner} onEdit={(x) => (x.custom ? openEdit(x) : setBuiltinProd(x))} allCodes={allCodes} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <CustomOptionForm key={`o${optFormKey}`} open={optFormOpen} onOpenChange={setOptFormOpen} initial={optEditing} defaultGroup={optDefaultGroup} extraGroups={customGroups.map((cg) => ({ id: cg.id, label: cg.label }))} />
        {builtinProd && <BuiltinProductDialog key={builtinProd.id} product={builtinProd} categories={categories} onClose={() => setBuiltinProd(null)} />}
        {renameOpt && (
          <EditTextDialog
            key={`${renameOpt.gid}/${renameOpt.o.id}`}
            title="Ubah nama topping / opsi"
            description="Nama baru langsung tampil di layar pesanan. Struk lama tidak berubah."
            kind="option"
            itemKey={`${renameOpt.gid}/${renameOpt.o.id}`}
            fields={[{ name: "name", label: "Nama", value: renameOpt.o.label, original: renameOpt.o.origLabel, max: 60, required: true }]}
            edited={!!renameOpt.o.edited}
            onClose={() => setRenameOpt(null)}
          />
        )}
        {renameGroup && groups[renameGroup] && (
          <EditTextDialog
            key={renameGroup}
            title="Ubah nama grup"
            description="Judul grup di layar pesanan (mis. Level Manis)."
            kind="group"
            itemKey={renameGroup}
            fields={[{ name: "name", label: "Nama grup", value: groups[renameGroup].label, original: groups[renameGroup].origLabel, max: 60, required: true }]}
            edited={!!groups[renameGroup].edited}
            onClose={() => setRenameGroup(null)}
          />
        )}
        {groupDlg && <CustomGroupDialog key={groupDlg.key} initial={groupDlg.group} items={products.map((x) => ({ id: x.id, name: x.name, category: x.category }))} categories={categories} onClose={() => setGroupDlg(null)} />}
        <CustomProductForm key={formKey} open={formOpen} onOpenChange={setFormOpen} initial={editing} categories={formCategories} existingCodes={allCodes} />
        <CategoryManager open={catMgrOpen} onOpenChange={setCatMgrOpen} categories={customCategories} builtIn={categories.filter((c) => (c as { builtin?: boolean }).builtin) as BuiltinCategory[]} usedIds={usedCategoryIds} />
      </SheetContent>
    </Sheet>
  );
}
