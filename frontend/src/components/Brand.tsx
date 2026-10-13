import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

export function BrandMark({ className, light = true }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)} data-testid="brand-mark">
      <img src="/logo-256.png" alt="Logo NuBuah" className="size-10 shrink-0 rounded-full shadow-sm" data-testid="brand-logo" />
      <span className="leading-none">
        <span className={cn("block font-heading text-xl font-extrabold italic tracking-tight", light ? "text-white" : "text-[#145853]")}>NuBuah</span>
        <span className={cn("block text-[10px] font-medium uppercase tracking-[0.18em]", light ? "text-white/70" : "text-[#145853]/70")}>Sehat itu mudah</span>
      </span>
    </span>
  );
}

const LINKS = [
  { to: "/", label: "Beranda", id: "home" },
  { to: "/pos", label: "Kasir", id: "pos" },
  { to: "/history", label: "Riwayat & Cetak", id: "history" },
];

export function AppNav({ className }: { className?: string }) {
  return (
    <nav className={cn("flex items-center gap-1", className)} aria-label="Navigasi utama">
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end
          data-testid={`nav-link-${l.id}`}
          className={({ isActive }) =>
            cn(
              "rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors duration-200",
              isActive ? "bg-[#FFE81A] text-[#0F3F3B]" : "text-white/85 hover:bg-white/10 hover:text-white",
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
