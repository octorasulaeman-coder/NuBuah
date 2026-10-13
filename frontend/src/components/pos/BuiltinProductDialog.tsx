import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiDelete, apiPut } from "@/lib/api";
import type { LiveProduct } from "@/lib/useMenu";
import type { MenuEdit } from "@/lib/types";

const SPECIAL = ["bp-buah-potong", "cu-jus", "cu-bowl"]; // builders with their own pricing: category is fixed

/** Owner: change the name, description, category, sub-heading or colour of a built-in menu item. Prices, codes and sold-out stay in the row. */
export default function BuiltinProductDialog({ product, categories, onClose }: { product: LiveProduct; categories: { id: string; label: string }[]; onClose: () => void }) {
  // Mounted fresh per item, so the form starts from the item's current values.
  const qc = useQueryClient();
  const b = product.base;
  const [name, setName] = useState(b.name);
  const [desc, setDesc] = useState(b.desc);
  const [benefit, setBenefit] = useState(b.benefit ?? "");
  const [section, setSection] = useState(b.section ?? "");
  const [category, setCategory] = useState(b.category);
  const [color, setColor] = useState(b.color);
  const special = SPECIAL.includes(product.id);
  const choices = categories.filter((c) => c.id !== "potong" && c.id !== "custom");
  const refresh = () => qc.invalidateQueries({ queryKey: ["menu-edits"] });
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.message ? e.message : "Gagal menyimpan");

  const save = useMutation({
    mutationFn: () => apiPut<MenuEdit>("/menu/edits", { kind: "product", key: product.id, name: name.trim(), desc: desc.trim(), benefit: benefit.trim(), section: section.trim(), color, ...(special ? {} : { category }) }),
    onSuccess: () => {
      refresh();
      toast.success(`${name.trim()} diperbarui`);
      onClose();
    },
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: () => apiDelete<void>(`/menu/edits?kind=product&key=${product.id}`),
    onSuccess: () => {
      refresh();
      toast.success("Dikembalikan ke aslinya");
      onClose();
    },
    onError: fail,
  });
  const changed = name.trim() !== b.name || desc.trim() !== b.desc || benefit.trim() !== (b.benefit ?? "") || section.trim() !== (b.section ?? "") || category !== b.category || color !== b.color;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md" data-testid="builtin-product-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">Ubah {product.orig.name}</DialogTitle>
          <DialogDescription>Perubahan langsung terlihat di kasir dan halaman depan. Harga, kode, dan &ldquo;habis&rdquo; diatur di baris menu.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bp-name">Nama</Label>
            <Input id="bp-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="builtin-product-name" />
            {product.edited && name.trim() !== product.orig.name && <p className="text-[11px] text-muted-foreground">Aslinya: {product.orig.name}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="bp-desc">Deskripsi / isi</Label>
            <Input id="bp-desc" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} data-testid="builtin-product-desc" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bp-benefit">Manfaat (opsional)</Label>
            <Input id="bp-benefit" value={benefit} maxLength={120} onChange={(e) => setBenefit(e.target.value)} data-testid="builtin-product-benefit" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bp-cat">Kategori</Label>
            <select id="bp-cat" value={category} disabled={special} onChange={(e) => setCategory(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60" data-testid="builtin-product-category">
              {special && <option value={category}>{categories.find((c) => c.id === category)?.label ?? category}</option>}
              {!special &&
                choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
            {special && <p className="text-[11px] text-muted-foreground">Menu khusus ini punya harga sendiri, jadi kategorinya tetap.</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="bp-section">Sub-judul (opsional)</Label>
            <Input id="bp-section" value={section} maxLength={40} onChange={(e) => setSection(e.target.value)} data-testid="builtin-product-section" />
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="bp-color">Warna kartu</Label>
            <input id="bp-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 cursor-pointer rounded-md border border-input bg-background p-1" data-testid="builtin-product-color" />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          {product.edited ? (
            <Button variant="ghost" className="text-muted-foreground" disabled={reset.isPending} onClick={() => reset.mutate()} data-testid="builtin-product-reset">
              <RotateCcw /> Kembalikan ke asli
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Batal
            </Button>
            <Button className="bg-teal-brand hover:bg-teal-deep" disabled={!changed || !name.trim() || save.isPending} onClick={() => save.mutate()} data-testid="builtin-product-save">
              Simpan
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
