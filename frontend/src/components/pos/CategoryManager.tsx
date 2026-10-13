import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiDelete, apiPost, apiPut } from "@/lib/api";
import EditTextDialog from "@/components/pos/EditTextDialog";
import type { CustomCategory, CustomCategoryIn } from "@/lib/types";

export interface BuiltinCategory {
  id: string;
  label: string;
  blurb: string;
  edited: boolean;
  origLabel: string;
  origBlurb: string;
}

/** Owner: add, rename or delete your own menu categories (the built-in ones stay). */
export default function CategoryManager({ open, onOpenChange, categories, builtIn, usedIds }: { open: boolean; onOpenChange: (o: boolean) => void; categories: CustomCategory[]; builtIn: BuiltinCategory[]; usedIds: Set<string> }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CustomCategory | null>(null);
  const [renaming, setRenaming] = useState<BuiltinCategory | null>(null);
  const [label, setLabel] = useState("");
  const [blurb, setBlurb] = useState("");

  const reset = () => {
    setEditing(null);
    setLabel("");
    setBlurb("");
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ["custom-categories"] });

  const save = useMutation({
    mutationFn: (body: CustomCategoryIn) => (editing ? apiPut<CustomCategory>(`/menu/custom-categories/${editing.id}`, body) : apiPost<CustomCategory>("/menu/custom-categories", body)),
    onSuccess: (c) => {
      refresh();
      toast.success(editing ? `${c.label} diperbarui` : `Kategori ${c.label} ditambahkan`);
      reset();
    },
    onError: () => toast.error("Gagal menyimpan kategori"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete<void>(`/menu/custom-categories/${id}`),
    onSuccess: () => {
      refresh();
      toast.success("Kategori dihapus");
    },
    onError: () => toast.error("Kategori masih punya menu. Hapus atau pindahkan menunya dulu."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md" data-testid="category-manager">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl font-extrabold italic text-teal-deep">Kategori menu</DialogTitle>
          <DialogDescription>Kategori baru muncul sebagai tab di kasir dan halaman depan. Kategori bawaan bisa diganti namanya tetapi tidak bisa dihapus.</DialogDescription>
        </DialogHeader>

        <div className="text-xs font-bold tracking-wider text-teal-brand uppercase">Kategori bawaan (bisa diganti nama)</div>
        <ul className="divide-y divide-border text-sm" data-testid="builtin-category-list">
          {builtIn.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2" data-testid={`builtin-category-row-${c.id}`}>
              <div className="min-w-0">
                <div className="truncate font-semibold text-teal-deep">
                  {c.label} {c.edited && <span className="ml-1 text-[11px] font-normal text-muted-foreground">(asli: {c.origLabel})</span>}
                </div>
                {c.blurb && <div className="truncate text-xs text-muted-foreground">{c.blurb}</div>}
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Ubah ${c.label}`} onClick={() => setRenaming(c)} data-testid={`builtin-category-edit-${c.id}`}>
                <Pencil />
              </Button>
            </li>
          ))}
        </ul>

        <div className="mt-2 text-xs font-bold tracking-wider text-teal-brand uppercase">Kategori buatan sendiri</div>
        <ul className="divide-y divide-border text-sm" data-testid="category-list">
          {categories.length === 0 && <li className="py-3 text-muted-foreground">Belum ada kategori tambahan.</li>}
          {categories.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2" data-testid={`category-row-${c.id}`}>
              <div className="min-w-0">
                <div className="truncate font-semibold text-teal-deep">{c.label}</div>
                {c.blurb && <div className="truncate text-xs text-muted-foreground">{c.blurb}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Ubah kategori"
                  onClick={() => {
                    setEditing(c);
                    setLabel(c.label);
                    setBlurb(c.blurb);
                  }}
                  data-testid={`category-edit-${c.id}`}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Hapus kategori"
                  disabled={usedIds.has(c.id) || remove.isPending}
                  title={usedIds.has(c.id) ? "Masih ada menu di kategori ini" : undefined}
                  onClick={() => window.confirm(`Hapus kategori "${c.label}"?`) && remove.mutate(c.id)}
                  data-testid={`category-delete-${c.id}`}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>

        <div className="space-y-2 rounded-xl border border-dashed border-teal-brand/40 p-3">
          <div className="text-sm font-semibold text-teal-deep">{editing ? "Ubah kategori" : "Tambah kategori"}</div>
          <Input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="Nama kategori, mis. Kopi" data-testid="category-label-input" />
          <Input value={blurb} maxLength={120} onChange={(e) => setBlurb(e.target.value)} placeholder="Keterangan singkat (opsional)" data-testid="category-blurb-input" />
          <div className="flex gap-2">
            <Button className="flex-1 bg-teal-brand hover:bg-teal-deep" disabled={!label.trim() || save.isPending} onClick={() => save.mutate({ label: label.trim(), blurb: blurb.trim() })} data-testid="category-save">
              {editing ? "Simpan" : (<><Plus /> Tambah kategori</>)}
            </Button>
            {editing && (
              <Button variant="outline" onClick={reset}>
                Batal
              </Button>
            )}
          </div>
        </div>
        {renaming && (
          <EditTextDialog
            key={renaming.id}
            title={`Ubah kategori ${renaming.origLabel}`}
            description="Nama dan keterangan baru tampil di kasir dan halaman depan."
            kind="category"
            itemKey={renaming.id}
            fields={[
              { name: "name", label: "Nama kategori", value: renaming.label, original: renaming.origLabel, max: 60, required: true },
              { name: "desc", label: "Keterangan singkat", value: renaming.blurb, original: renaming.origBlurb, max: 200 },
            ]}
            edited={renaming.edited}
            onClose={() => setRenaming(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
