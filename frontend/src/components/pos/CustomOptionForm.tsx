import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost, apiPut } from "@/lib/api";
import type { CustomOption, CustomOptionIn } from "@/lib/types";

const signed = (s: string) => s.replace(/(?!^-)[^\d]/g, "").slice(0, 8);

export const GROUP_CHOICES: { id: string; label: string; hasLarge: boolean }[] = [
  { id: "bowl_topping", label: "Topping Smoothie Bowl", hasLarge: false },
  { id: "bowl_extra", label: "Opsi Smoothie Bowl", hasLarge: false },
  { id: "drink_extra", label: "Opsi Jus & Smoothie (R / L)", hasLarge: true },
  { id: "custom_bowl_extra", label: "Opsi Custom Bowl", hasLarge: false },
  { id: "potong_extra", label: "Tambahan Buah Potong", hasLarge: false },
];

export interface OptionFormInitial {
  id: string;
  group_id: string;
  label: string;
  r: number;
  l?: number;
}

/** Add a new topping / extra option (or edit one added earlier). Owner only. Saved in MongoDB, no code editing. */
export default function CustomOptionForm({ open, onOpenChange, initial, defaultGroup, extraGroups = [] }: { open: boolean; onOpenChange: (o: boolean) => void; initial: OptionFormInitial | null; defaultGroup?: string; extraGroups?: { id: string; label: string }[] }) {
  // The parent gives this component a new `key` each time it opens, so state starts fresh.
  const qc = useQueryClient();
  const [group, setGroup] = useState(initial?.group_id ?? defaultGroup ?? "bowl_topping");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [r, setR] = useState(initial ? String(initial.r) : "");
  const [l, setL] = useState(initial?.l !== undefined ? String(initial.l) : "");
  const choices = [...GROUP_CHOICES, ...extraGroups.map((g) => ({ id: g.id, label: `${g.label} (grup buatan sendiri)`, hasLarge: false }))];
  const hasLarge = choices.find((g) => g.id === group)?.hasLarge ?? false;
  const valid = label.trim().length > 0 && /^-?\d+$/.test(r) && (l === "" || /^-?\d+$/.test(l));

  const save = useMutation({
    mutationFn: (body: CustomOptionIn) => (initial ? apiPut<CustomOption>(`/menu/custom-options/${initial.id}`, body) : apiPost<CustomOption>("/menu/custom-options", body)),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ["custom-options"] });
      qc.invalidateQueries({ queryKey: ["menu-option-overrides"] });
      toast.success(initial ? `${item.label} diperbarui` : `${item.label} ditambahkan`);
      onOpenChange(false);
    },
    onError: () => toast.error("Gagal menyimpan. Hanya owner yang bisa menambah topping."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="custom-option-form">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">{initial ? "Ubah topping / opsi" : "Tambah topping / opsi"}</DialogTitle>
          <DialogDescription>Langsung muncul di layar pesanan. Harga boleh minus untuk potongan (mis. tanpa susu).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="co-group">Masuk ke grup</Label>
            <select id="co-group" value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="custom-option-group">
              {choices.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="co-label">Nama</Label>
            <Input id="co-label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="mis. Granola" data-testid="custom-option-label" />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="co-r">{hasLarge ? "Harga Regular (Rp)" : "Harga (Rp)"}</Label>
              <Input id="co-r" inputMode="numeric" value={r} onChange={(e) => setR(signed(e.target.value))} placeholder="2000" className="font-mono" data-testid="custom-option-price-r" />
            </div>
            {hasLarge && (
              <div className="flex-1 space-y-1">
                <Label htmlFor="co-l">Harga Large (Rp)</Label>
                <Input id="co-l" inputMode="numeric" value={l} onChange={(e) => setL(signed(e.target.value))} placeholder="kosong = sama" className="font-mono" data-testid="custom-option-price-l" />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button
            className="bg-teal-brand hover:bg-teal-deep"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate({ group_id: group, label: label.trim(), r: Number(r), l: hasLarge && l !== "" ? Number(l) : null })}
            data-testid="custom-option-save"
          >
            {initial ? "Simpan perubahan" : "Tambah"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
