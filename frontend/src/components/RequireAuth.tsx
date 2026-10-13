import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useMe } from "@/lib/auth";

export default function RequireAuth({ children, ownerOnly = false }: { children: ReactNode; ownerOnly?: boolean }) {
  const { data: me, isLoading, isError } = useMe();
  const loc = useLocation();
  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-teal-deep text-white/80" data-testid="auth-loading">
        Memuat...
      </div>
    );
  }
  if (isError || !me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (ownerOnly && me.role !== "owner") return <Navigate to="/pos" replace />;
  if (me.must_change_password && !loc.pathname.startsWith("/admin")) {
    // The backend rejects every API except profile/password until the default password is
    // replaced — say so plainly instead of letting pages fail with cryptic 403s.
    // /admin stays reachable because that's where the password change form lives.
    return (
      <div className="grid min-h-screen place-items-center bg-teal-deep px-4 text-white" data-testid="must-change-password">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 text-center text-foreground shadow-xl">
          <h1 className="font-heading text-xl font-extrabold italic text-teal-deep">Ganti password dulu</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Akun <b>{me.email}</b> masih memakai password bawaan dari instalasi, jadi semua fitur dikunci sampai password diganti.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Buka <b>Admin → Akun → Ganti Password</b>, lalu login ulang.
          </p>
          <Link
            to="/admin"
            className="mt-5 inline-block rounded-full bg-teal-brand px-6 py-2 font-semibold text-white hover:bg-teal-deep"
          >
            Ke Admin → Ganti Password
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
