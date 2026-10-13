import { NavLink } from "react-router-dom";
import { LogOut, Store as StoreIcon } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { endSession } from "@/lib/session";
import type { useActiveStore } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Active = ReturnType<typeof useActiveStore>;

/** Header for staff pages: brand, store switcher (owner) / store name (cashier), nav, user + logout. */
export default function StaffBar({ active, extra, allowAll = false, value, onChange }: {
  active: Active;
  extra?: React.ReactNode;
  allowAll?: boolean;
  value?: string;
  onChange?: (id: string) => void;
}) {
  const { me, isOwner, stores, storeId, store, setStore } = active;
  const current = value ?? storeId ?? "";
  const links = [
    { to: "/pos", label: "Kasir", id: "pos" },
    { to: "/history", label: "Riwayat", id: "history" },
    ...(isOwner ? [{ to: "/admin", label: "Toko & Staf", id: "admin" }] : []),
  ];
  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-3 bg-teal-deep px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <NavLink to="/" data-testid="staffbar-home-link">
          <BrandMark />
        </NavLink>
        {isOwner ? (
          <label className="flex items-center gap-1.5 rounded-full bg-white/10 py-1 pr-1 pl-3 text-sm text-white">
            <StoreIcon className="size-4 text-zest" />
            <select
              value={current}
              onChange={(e) => (onChange ? onChange(e.target.value) : setStore(e.target.value))}
              className="max-w-40 cursor-pointer rounded-full bg-transparent py-0.5 font-semibold outline-none [&>option]:text-teal-deep"
              aria-label="Pilih toko"
              data-testid="store-switcher"
            >
              {allowAll && <option value="all">Semua toko</option>}
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="hidden truncate rounded-full bg-white/10 px-3 py-1 text-sm font-semibold text-zest sm:inline" data-testid="current-store-name">
            {store?.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {extra}
        <nav className="flex items-center gap-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              data-testid={`nav-link-${l.id}`}
              className={({ isActive }) =>
                cn(
                  "rounded-full px-3 py-1.5 text-sm font-semibold transition-colors duration-200",
                  isActive ? "bg-zest text-teal-deep" : "text-white/85 hover:bg-white/10 hover:text-white",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <span className="ml-2 hidden text-xs text-white/60 lg:inline" data-testid="current-user-name">
          {me?.name}
        </span>
        <Button variant="ghost" size="icon-sm" className="text-white/80 hover:bg-white/10 hover:text-white" aria-label="Keluar" onClick={() => endSession()} data-testid="logout-button">
          <LogOut />
        </Button>
      </div>
    </header>
  );
}
