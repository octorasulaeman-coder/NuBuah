import { cn } from "@/lib/utils";
import type { CategoryId } from "@/data/menu";

/** Little product glyph tinted with the drink colour: a cup for drinks, a bowl for bowls, a fruit cup for buah potong. */
export default function Swatch({ color, category, className }: { color: string; category: CategoryId; className?: string }) {
  if (category === "bowl" || category === "potong") {
    return (
      <svg viewBox="0 0 64 64" className={cn("size-14", className)} aria-hidden="true">
        <ellipse cx="32" cy="27" rx="25" ry="7" fill={color} />
        <circle cx="20" cy="25" r="4" fill="#fff" opacity=".85" />
        <circle cx="29" cy="23" r="3.5" fill="#E8424F" />
        <rect x="35" y="21" width="12" height="7" rx="3" fill="#E9D9B5" />
        <path d="M7 28 C9 46 20 54 32 54 C44 54 55 46 57 28 Z" fill="#fff" />
        <path d="M7 28 C9 46 20 54 32 54 C44 54 55 46 57 28 Z" fill={color} opacity=".35" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" className={cn("size-14", className)} aria-hidden="true">
      <path d="M40 4 L35 18" stroke="#0f3f3b" strokeWidth="3" strokeLinecap="round" />
      <path d="M15 16 H49 L45 58 H19 Z" fill="#fff" />
      <path d="M17 24 H47 L44 56 H20 Z" fill={color} />
      <path d="M32 33 C29 30 25 31.5 25 35 C25 38.5 32 43 32 43 C32 43 39 38.5 39 35 C39 31.5 35 30 32 33 Z" fill="#fff" opacity=".9" />
      <rect x="13" y="13" width="38" height="5" rx="2.5" fill="#0f3f3b" opacity=".15" />
    </svg>
  );
}
