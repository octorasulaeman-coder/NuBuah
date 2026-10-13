import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPost, apiPut } from "@/lib/api";
import { defaultGroupsFor } from "@/lib/useMenu";
import type { CustomProduct, CustomProductIn } from "@/lib/types";

const digits = (s: string) => s.replace(/\D/g, "").slice(0, 8);

const GROUP_CHOICES = [
  { id: "sweet", label: "Level manis" },
  { id: "ice", label: "Es (No / Less / Normal / Extra Ice)" },
  { id: "drink_extra", label: "Opsi lainnya minuman (yogurt, madu, dll.)" },
  { id: "kuah", label: "Pilihan kuah (jeruk / susu / jus)" },
  { id: "bowl_topping", label: "Topping smoothie bowl" },
  { id: "bowl_extra", label: "Opsi smoothie bowl" },
];

export interface FormInitial {
  id: string;
  code?: string;
  name: string;
  category: string;
  section?: string;
  groups?: string[] | null;
  desc: string;
  benefit?: string;
  r: number;
  l?: number;
  color: string;
}

/** Add a new menu item (or edit one added earlier). Owner only. Items are saved in MongoDB, no code editing needed. */
export default function CustomProductForm({ open, onOpenChange, initial, categories, existingCodes }: { open: boolean; onOpenChange: (o: boolean) => void; initial: FormInitial | null; categories: { id: string; label: string }[]; existingCodes: { id: string; name: string; code?: string }[] }) {
  // The parent gives this component a new `key` per item, so state starts fresh each time it opens.
  const qc = useQueryClient();
  const [category, setCategory] = useState<string>(initial?.category ?? "jus");
  const [section, setSection] = useState(initial?.section ?? "");
  const [groups, setGroups] = useState<string[] | null>(initial?.groups ?? null); // null = default for the category
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [desc, setDesc] = useState(initial?.desc ?? "");
  const [benefit, setBenefit] = useState(initial?.benefit ?? "");
  const [r, setR] = useState(initial ? String(initial.r) : "");
  const [l, setL] = useState(initial?.l !== undefined ? String(initial.l) : "");
  const [color, setColor] = useState(initial?.color ?? "#F5B83D");

  const hasSizes = category !== "bowl";
  const effGroups = groups ?? defaultGroupsFor(category);
  const toggleGroup = (id: string, on: boolean) => setGroups(on ? [...effGroups, id] : effGroups.filter((g) => g !== id));
  const clash = code ? existingCodes.find((x) => x.id !== initial?.id && x.code?.toUpperCase() === code) : undefined;
  const valid = name.trim().length > 0 && r !== "" && !clash;

  const save = useMutation({
    mutationFn: (body: CustomProductIn) =>
      initial ? apiPut<CustomProduct>(`/menu/custom-products/${initial.id}`, body) : apiPost<CustomProduct>("/menu/custom-products", body),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ["custom-products"] });
      qc.invalidateQueries({ queryKey: ["menu-codes"] });
      toast.success(initial ? `${item.name} diperbarui` : `${item.name} ditambahkan ke menu`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.message ? e.message : "Gagal menyimpan menu. Hanya owner yang bisa menambah menu."),
  });

  const submit = () =>
    save.mutate({
      name: name.trim(),
      code,
      category,
      section: section.trim(),
      groups,
      desc: desc.trim(),
      benefit: category === "smoothie" ? benefit.trim() : "",
      r: Number(r),
      l: hasSizes && l !== "" ? Number(l) : null,
      color,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md" data-testid="custom-product-form">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">{initial ? "Ubah menu" : "Tambah menu baru"}</DialogTitle>
          <DialogDescription>Menu baru langsung muncul di kasir dan halaman depan, tanpa edit kode.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cp-category">Kategori</Label>
            <select
              id="cp-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              data-testid="custom-product-category"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="cp-code">Kode menu (unik)</Label>
            <Input
              id="cp-code"
              value={code}
              maxLength={8}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="Kosongkan untuk dibuat otomatis, mis. JJK"
              className="font-mono uppercase"
              data-testid="custom-product-code"
            />
            {clash ? (
              <p className="text-xs text-destructive" data-testid="custom-product-code-error">
                Kode {code} sudah dipakai oleh {clash.name}.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">1-8 huruf atau angka. Dipakai di kasir, struk, dan pencarian.</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="cp-name">Nama menu</Label>
            <Input id="cp-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="mis. Jus Jambu Kristal" data-testid="custom-product-name" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="cp-desc">Deskripsi / isi (opsional)</Label>
            <Input id="cp-desc" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} placeholder="mis. Pisang · Mangga · Yoghurt" data-testid="custom-product-desc" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="cp-section">Sub-judul (opsional)</Label>
            <Input id="cp-section" value={section} maxLength={40} onChange={(e) => setSection(e.target.value)} placeholder="mis. Es Kul Kul, untuk mengelompokkan di halaman depan" data-testid="custom-product-section" />
          </div>

          {category === "smoothie" && (
            <div className="space-y-1">
              <Label htmlFor="cp-benefit">Manfaat (opsional)</Label>
              <Input id="cp-benefit" value={benefit} maxLength={120} onChange={(e) => setBenefit(e.target.value)} placeholder="mis. Tinggi vitamin C" data-testid="custom-product-benefit" />
            </div>
          )}

          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="cp-r">{hasSizes ? "Harga Regular (Rp)" : "Harga (Rp)"}</Label>
              <Input id="cp-r" inputMode="numeric" value={r} onChange={(e) => setR(digits(e.target.value))} placeholder="15000" className="font-mono" data-testid="custom-product-price-r" />
            </div>
            {hasSizes && (
              <div className="flex-1 space-y-1">
                <Label htmlFor="cp-l">Harga Large (Rp)</Label>
                <Input id="cp-l" inputMode="numeric" value={l} onChange={(e) => setL(digits(e.target.value))} placeholder="kosong = 1 ukuran" className="font-mono" data-testid="custom-product-price-l" />
              </div>
            )}
          </div>

          <div className="space-y-1.5" data-testid="custom-product-groups">
            <Label>Pilihan yang muncul saat memesan</Label>
            <div className="grid gap-1.5">
              {GROUP_CHOICES.map((g) => (
                <label key={g.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={effGroups.includes(g.id)} onChange={(e) => toggleGroup(g.id, e.target.checked)} data-testid={`custom-product-group-${g.id}`} />
                  {g.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Label htmlFor="cp-color">Warna kartu</Label>
            <input id="cp-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 cursor-pointer rounded-md border border-input bg-background p-1" data-testid="custom-product-color" />
            <span className="text-xs text-muted-foreground">Dipakai jika belum ada foto menu.</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button className="bg-teal-brand hover:bg-teal-deep" disabled={!valid || save.isPending} onClick={submit} data-testid="custom-product-save">
            {initial ? "Simpan perubahan" : "Tambah ke menu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
