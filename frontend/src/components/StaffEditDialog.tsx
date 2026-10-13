import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPut } from "@/lib/api";
import type { Staff, StaffUpdate, Store } from "@/lib/types";

/** Owner: change a cashier's name, email, store, or set a new password. Mounted fresh per cashier. */
export default function StaffEditDialog({ staff, stores, onClose }: { staff: Staff; stores: Store[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(staff.name);
  const [email, setEmail] = useState(staff.email);
  const [storeId, setStoreId] = useState(staff.store_id ?? stores[0]?.id ?? "");
  const [password, setPassword] = useState("");

  const save = useMutation({
    mutationFn: () => {
      const body: StaffUpdate = {};
      if (name.trim() !== staff.name) body.name = name.trim();
      if (email.trim().toLowerCase() !== staff.email) body.email = email.trim();
      if (storeId !== staff.store_id) body.store_id = storeId;
      if (password) body.password = password;
      return apiPut<Staff>(`/staff/${staff.id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff"] });
      toast.success("Data kasir disimpan");
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.message ? e.message : "Gagal menyimpan"),
  });
  const changed = name.trim() !== staff.name || email.trim().toLowerCase() !== staff.email || storeId !== staff.store_id || password !== "";
  const valid = name.trim().length >= 2 && email.includes("@") && (password === "" || password.length >= 6);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid="staff-edit-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Ubah {staff.name}</DialogTitle>
          <DialogDescription>Jika email, toko, atau password diganti, kasir ini harus masuk ulang.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="se-name">Nama</Label>
            <Input id="se-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="staff-edit-name" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="se-email">Email</Label>
            <Input id="se-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="staff-edit-email" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="se-store">Toko</Label>
            <select id="se-store" value={storeId} onChange={(e) => setStoreId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="staff-edit-store">
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="se-pw">Password baru (kosongkan jika tidak diganti)</Label>
            <Input id="se-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 6 karakter" data-testid="staff-edit-password" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button className="bg-teal-brand hover:bg-teal-deep" disabled={!changed || !valid || save.isPending} onClick={() => save.mutate()} data-testid="staff-edit-save">
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
