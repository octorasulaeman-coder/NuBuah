import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiDelete, apiPut } from "@/lib/api";
import type { MenuEdit } from "@/lib/types";

export interface EditField {
  name: "name" | "desc"; // which edit field this input writes
  label: string;
  value: string;
  original?: string; // the built-in value, shown as a hint when the owner already changed it
  max: number;
  required?: boolean;
}

/** Owner: rename a built-in topping, option group or category (and its short description). "Restore" brings back the built-in text. */
export default function EditTextDialog({ title, description, kind, itemKey, fields, edited, onClose }: { title: string; description?: string; kind: MenuEdit["kind"]; itemKey: string; fields: EditField[]; edited: boolean; onClose: () => void }) {
  // Mounted fresh each time it opens, so the inputs always start from the current text.
  const qc = useQueryClient();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, f.value])));
  const refresh = () => qc.invalidateQueries({ queryKey: ["menu-edits"] });
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.message ? e.message : "Gagal menyimpan");

  const save = useMutation({
    mutationFn: () => apiPut<MenuEdit>("/menu/edits", { kind, key: itemKey, ...Object.fromEntries(fields.map((f) => [f.name, vals[f.name].trim()])) }),
    onSuccess: () => {
      refresh();
      toast.success("Perubahan disimpan");
      onClose();
    },
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: () => apiDelete<void>(`/menu/edits?kind=${kind}&key=${encodeURIComponent(itemKey)}`),
    onSuccess: () => {
      refresh();
      toast.success("Dikembalikan ke aslinya");
      onClose();
    },
    onError: fail,
  });
  const changed = fields.some((f) => vals[f.name].trim() !== f.value);
  const valid = fields.every((f) => !f.required || vals[f.name].trim().length > 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid="edit-text-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.name} className="space-y-1">
              <Label htmlFor={`et-${f.name}`}>{f.label}</Label>
              <Input id={`et-${f.name}`} value={vals[f.name]} maxLength={f.max} onChange={(e) => setVals((v) => ({ ...v, [f.name]: e.target.value }))} data-testid={`edit-text-${f.name}`} />
              {edited && f.original !== undefined && f.original !== vals[f.name] && <p className="text-[11px] text-muted-foreground">Aslinya: {f.original || "(kosong)"}</p>}
            </div>
          ))}
        </div>
        <DialogFooter className="sm:justify-between">
          {edited ? (
            <Button variant="ghost" className="text-muted-foreground" disabled={reset.isPending} onClick={() => reset.mutate()} data-testid="edit-text-reset">
              <RotateCcw /> Kembalikan ke asli
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Batal
            </Button>
            <Button className="bg-teal-brand hover:bg-teal-deep" disabled={!changed || !valid || save.isPending} onClick={() => save.mutate()} data-testid="edit-text-save">
              Simpan
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
