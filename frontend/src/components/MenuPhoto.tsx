import { useState } from "react";
import Swatch from "@/components/Swatch";
import { cn } from "@/lib/utils";

/** Product photo from public/img/menu/<product id>.webp; falls back to the tinted glyph when no photo exists. */
export default function MenuPhoto({ id, name, color, category, photo, className }: { id: string; name: string; color: string; category: string; photo?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  // never hand a local-file or otherwise unserveable URL to <img> — the browser blocks
  // file:// from http(s) pages (Security Error) and broken data-uris just error
  const serveable = !!photo && !/^(file|javascript|vbscript):/i.test(photo);
  if (failed || !serveable) return <Swatch color={color} category={category} className={className} />;
  return (
    <img
      src={photo}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("object-cover", className)}
      data-testid={`menu-photo-${id}`}
    />
  );
}
