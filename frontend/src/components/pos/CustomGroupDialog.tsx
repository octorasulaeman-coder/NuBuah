import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPost, apiPut } from "@/lib/api";
import type { CustomGroup, CustomGroupIn } from "@/lib/types";

interface Item {
  id: string;
  name: string;
  category: string;
}

/** Owner: create or edit a topping category (group): a name, pick-one or pick-many, and which menu items show it. */
export default function CustomGroupDialog({ initial, items, categories, onClose }: { initial: CustomGroup | null; items: Item[]; categories: { id: string; label: string }[]; onClose: () => void }) {
  // Mounted fresh each time it opens, so the form always starts from the group being edited.
  const qc = useQueryClient();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [type, setType] = useState<"single" | "multi">(initial?.type ?? "multi");
  const [picked, setPicked] = useState<Set<string>>(new Set(initial?.product_ids ?? []));
  const [q, setQ] = useState("");

  const save = useMutation({
    mutationFn: (body: CustomGroupIn) => (initial ? apiPut<CustomGroup>(`/menu/custom-groups/${initial.id}`, body) : apiPost<CustomGroup>("/menu/custom-groups", body)),
    onSuccess: (g) => {
      qc.invalidateQueries({ queryKey: ["custom-groups"] });
      toast.success(initial ? `${g.label} diperbarui` : `Grup ${g.label} dibuat. Tambahkan topping di dalamnya.`);
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.message ? e.message : "Gagal menyimpan grup"),
  });

  const toggle = (ids: string[], on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });
  const term = q.trim().toLowerCase();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg" data-testid="custom-group-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">{initial ? "Ubah grup topping" : "Tambah grup topping"}</DialogTitle>
          <DialogDescription>Grup baru muncul di layar pesanan untuk menu yang kamu centang. Isi toppingnya lewat tombol &ldquo;Tambah topping / opsi baru&rdquo;.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cg-label">Nama grup</Label>
            <Input id="cg-label" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="mis. Saus, Taburan, Ukuran Gelas" data-testid="custom-group-label" />
          </div>

          <div className="space-y-1.5">
            <Label>Cara memilih</Label>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              {(
                [
                  ["multi", "Pilih banyak", "Pelanggan boleh memilih beberapa, boleh juga tidak memilih"],
                  ["single", "Pilih satu", "Wajib memilih satu (pilihan pertama otomatis terpilih)"],
                ] as const
              ).map(([v, title, hint]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={type === v}
                  onClick={() => setType(v)}
                  className={`rounded-xl border p-3 text-left text-sm transition-colors ${type === v ? "border-teal-brand bg-mint" : "border-border hover:bg-mint/50"}`}
                  data-testid={`custom-group-type-${v}`}
                >
                  <div className="font-semibold text-teal-deep">{title}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Tampil di menu ({picked.size})</Label>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => toggle(items.map((i) => i.id), true)}>
                  Semua
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPicked(new Set())}>
                  Kosongkan
                </Button>
              </div>
            </div>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari menu" className="h-9" data-testid="custom-group-search" />
            <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border p-3" data-testid="custom-group-items">
              {categories.map((c) => {
                const list = items.filter((i) => i.category === c.id && (!term || i.name.toLowerCase().includes(term)));
                if (!list.length) return null;
                const all = list.every((i) => picked.has(i.id));
                return (
                  <div key={c.id}>
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-bold tracking-wider text-teal-brand uppercase">
                      <input type="checkbox" checked={all} onChange={(e) => toggle(list.map((i) => i.id), e.target.checked)} data-testid={`custom-group-cat-${c.id}`} />
                      {c.label}
                    </label>
                    <div className="mt-1 grid gap-1 pl-5 sm:grid-cols-2">
                      {list.map((i) => (
                        <label key={i.id} className="flex cursor-pointer items-center gap-2 text-sm">
                          <input type="checkbox" checked={picked.has(i.id)} onChange={(e) => toggle([i.id], e.target.checked)} data-testid={`custom-group-item-${i.id}`} />
                          <span className="truncate">{i.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button className="bg-teal-brand hover:bg-teal-deep" disabled={!label.trim() || save.isPending} onClick={() => save.mutate({ label: label.trim(), type, product_ids: [...picked] })} data-testid="custom-group-save">
            {initial ? "Simpan perubahan" : "Buat grup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
