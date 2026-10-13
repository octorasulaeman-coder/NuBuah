import { useState } from "react";
import Swatch from "@/components/Swatch";
import type { CategoryId } from "@/data/menu";
import { cn } from "@/lib/utils";

/** Product photo from public/img/menu/<product id>.webp; falls back to the tinted glyph when no photo exists. */
export default function MenuPhoto({ id, name, color, category, className }: { id: string; name: string; color: string; category: CategoryId; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Swatch color={color} category={category} className={className} />;
  return (
    <img
      src={`/img/menu/${id}.webp`}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("object-cover", className)}
      data-testid={`menu-photo-${id}`}
    />
  );
}
