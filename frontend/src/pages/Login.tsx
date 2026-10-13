import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Delete, Store as StoreIcon } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiPost } from "@/lib/api";
import { useMe, usePublicStores } from "@/lib/auth";
import { beginSession } from "@/lib/session";
import type { Me } from "@/lib/types";
import { cn } from "@/lib/utils";

const errText = (e: unknown) =>
  e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in e.body && typeof (e.body as { detail: unknown }).detail === "string"
    ? (e.body as { detail: string }).detail
    : "Tidak bisa masuk. Cek koneksi server.";

export default function Login() {
  const me = useMe();
  const stores = usePublicStores();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/pos";
  const [tab, setTab] = useState<"pin" | "email">("pin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [storeId, setStoreId] = useState<string | null>(null);
  const [pin, setPin] = useState("");

  const done = () => {
    beginSession();
    nav(next, { replace: true });
  };
  const emailLogin = useMutation({ mutationFn: () => apiPost<Me>("/auth/login", { email, password }), onSuccess: done });
  const pinLogin = useMutation({
    mutationFn: (p: string) => apiPost<Me>("/auth/pin", { store_id: activeStore, pin: p }),
    onSuccess: done,
    onError: () => setPin(""),
  });

  if (me.data) return <Navigate to={next} replace />;

  const press = (d: string) => {
    if (pinLogin.isPending) return;
    const p = (pin + d).slice(0, 6);
    setPin(p);
  };
  const storeList = stores.data ?? [];
  const activeStore = storeId ?? (storeList.length === 1 ? storeList[0].id : null);

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-teal-brand px-4 py-10" data-testid="login-page">
      <div className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full bg-teal-pill/40 blur-3xl" />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <BrandMark />
        </div>
        <div className="rounded-3xl bg-white p-6 shadow-2xl shadow-black/20">
          <h1 className="font-heading text-2xl font-extrabold text-teal-deep italic">Masuk kasir</h1>
          <div className="mt-4 grid grid-cols-2 gap-1 rounded-full bg-mint p-1" role="tablist">
            {(
              [
                ["pin", "PIN Toko"],
                ["email", "Email"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                data-testid={`login-tab-${id}`}
                className={cn("rounded-full py-1.5 text-sm font-semibold transition-colors duration-150", tab === id ? "bg-teal-brand text-white" : "text-teal-deep")}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "pin" ? (
            <div className="mt-5 space-y-4">
              <div className="space-y-2">
                <Label>Pilih toko</Label>
                {stores.isError && <p className="text-sm text-destructive">Daftar toko tidak bisa dimuat.</p>}
                <div className="grid gap-2">
                  {storeList.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setStoreId(s.id);
                        setPin("");
                      }}
                      data-testid={`login-store-${s.code}`}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition-[border-color,background-color] duration-150",
                        activeStore === s.id ? "border-teal-brand bg-mint" : "border-border hover:border-teal-brand/50",
                      )}
                    >
                      <StoreIcon className="size-5 text-teal-brand" />
                      <span>
                        <span className="block font-semibold text-teal-deep">{s.name}</span>
                        <span className="block text-xs text-muted-foreground">{s.address_lines[0]}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-center gap-2" data-testid="pin-dots" aria-label={`${pin.length} digit`}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <span key={i} className={cn("size-3.5 rounded-full border-2 border-teal-brand transition-colors duration-100", i < pin.length && "bg-teal-brand")} />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                  <Button key={d} variant="outline" className="h-12 text-lg font-semibold" onClick={() => press(d)} disabled={!activeStore} data-testid={`pin-key-${d}`}>
                    {d}
                  </Button>
                ))}
                <Button variant="ghost" className="h-12" onClick={() => setPin(pin.slice(0, -1))} aria-label="Hapus" data-testid="pin-key-back">
                  <Delete />
                </Button>
                <Button variant="outline" className="h-12 text-lg font-semibold" onClick={() => press("0")} disabled={!activeStore} data-testid="pin-key-0">
                  0
                </Button>
                <Button
                  className="h-12 bg-teal-brand font-semibold hover:bg-teal-deep"
                  disabled={!activeStore || pin.length < 4 || pinLogin.isPending}
                  onClick={() => pinLogin.mutate(pin)}
                  data-testid="pin-submit-button"
                >
                  Masuk
                </Button>
              </div>
              {pinLogin.isError && (
                <p className="text-center text-sm text-destructive" data-testid="login-error">
                  {errText(pinLogin.error)}
                </p>
              )}
            </div>
          ) : (
            <form
              className="mt-5 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                emailLogin.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="login-email-input" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password-input" />
              </div>
              {emailLogin.isError && (
                <p className="text-sm text-destructive" data-testid="login-error">
                  {errText(emailLogin.error)}
                </p>
              )}
              <Button type="submit" className="h-11 w-full rounded-full bg-teal-brand font-semibold hover:bg-teal-deep" disabled={emailLogin.isPending} data-testid="login-submit-button">
                {emailLogin.isPending ? "Masuk..." : "Masuk"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">Owner dan staf dengan akun email.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
