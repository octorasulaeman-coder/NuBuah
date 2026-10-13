import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserCog } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPost, apiPut } from "@/lib/api";
import type { Me } from "@/lib/types";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError && e.message ? e.message : fallback);

/** Owner: edit my own name / email and change my password. */
export default function AccountCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? "");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");

  const profile = useMutation({
    mutationFn: () => apiPut<Me>("/auth/me", { name: name.trim(), email: email.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["staff"] });
      toast.success("Data akun disimpan");
    },
    onError: (e) => toast.error(errText(e, "Gagal menyimpan akun")),
  });
  const password = useMutation({
    mutationFn: () => apiPost<void>("/auth/me/password", { current_password: cur, new_password: next }),
    onSuccess: () => {
      setCur("");
      setNext("");
      setAgain("");
      toast.success("Password diganti. Perangkat lain harus masuk ulang.");
    },
    onError: (e) => toast.error(errText(e, "Gagal mengganti password")),
  });

  const profileChanged = name.trim() !== me.name || email.trim().toLowerCase() !== (me.email ?? "").toLowerCase();
  const pwMismatch = again !== "" && again !== next;

  return (
    <section className="space-y-3 lg:col-span-12" data-testid="account-card">
      <h2 className="flex items-center gap-2 font-heading text-2xl font-extrabold tracking-tight text-teal-deep italic">
        <UserCog className="size-6" /> Akun saya
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <form
          className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            profile.mutate();
          }}
        >
          <div className="text-sm font-semibold text-teal-deep">Data owner</div>
          <div className="space-y-1">
            <Label htmlFor="me-name">Nama</Label>
            <Input id="me-name" value={name} minLength={2} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="account-name-input" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="me-email">Email (untuk login)</Label>
            <Input id="me-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="account-email-input" />
          </div>
          <Button type="submit" className="rounded-full bg-teal-brand hover:bg-teal-deep" disabled={!profileChanged || name.trim().length < 2 || !email.includes("@") || profile.isPending} data-testid="account-save-button">
            Simpan data
          </Button>
        </form>

        <form
          className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            password.mutate();
          }}
        >
          <div className="text-sm font-semibold text-teal-deep">Ganti password</div>
          <Input type="password" autoComplete="current-password" placeholder="Password saat ini" value={cur} onChange={(e) => setCur(e.target.value)} data-testid="account-current-password" />
          <Input type="password" autoComplete="new-password" placeholder="Password baru (min 8 karakter)" value={next} onChange={(e) => setNext(e.target.value)} data-testid="account-new-password" />
          <Input type="password" autoComplete="new-password" placeholder="Ulangi password baru" value={again} onChange={(e) => setAgain(e.target.value)} data-testid="account-confirm-password" />
          {pwMismatch && <p className="text-xs text-destructive">Password baru tidak sama.</p>}
          <Button type="submit" className="rounded-full bg-teal-brand hover:bg-teal-deep" disabled={!cur || next.length < 8 || next !== again || password.isPending} data-testid="account-password-button">
            Ganti password
          </Button>
        </form>
      </div>
    </section>
  );
}
