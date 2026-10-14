import { useState } from "react";
import { ImageDown, Printer, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { receiptText, toWa } from "@/lib/receiptText";
import { downloadReceiptImage } from "@/lib/receiptImage";
import type { Order } from "@/lib/types";

export { receiptText };
import { cn } from "@/lib/utils";

export type PrintFormat = "thermal" | "a4";
const KEY = "nb-print-format";

export function usePrintFormat() {
  const [format, setFormat] = useState<PrintFormat>(() => (localStorage.getItem(KEY) === "thermal" ? "thermal" : "a4"));
  const set = (f: PrintFormat) => {
    localStorage.setItem(KEY, f);
    setFormat(f);
  };
  return [format, set] as const;
}

/** Thermal 80mm vs normal printer (A4, several receipts per page, also used for "Save as PDF"). */
export function PrintFormatToggle({ format, onChange }: { format: PrintFormat; onChange: (f: PrintFormat) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1 rounded-full bg-mint p-1" role="radiogroup" aria-label="Format cetak">
        {(
          [
            ["a4", "Printer biasa / PDF"],
            ["thermal", "Thermal 80mm"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={format === id}
            onClick={() => onChange(id)}
            data-testid={`print-format-${id}`}
            className={cn("rounded-full py-1.5 text-xs font-semibold transition-colors duration-150", format === id ? "bg-teal-brand text-white" : "text-teal-deep hover:bg-white/60")}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground" data-testid="print-format-hint">
        {format === "a4"
          ? "A4, beberapa struk per halaman. Untuk PDF pilih \u201cSimpan sebagai PDF\u201d di jendela cetak."
          : "Untuk printer thermal 80mm: kertas 80mm, margin None."}
      </p>
    </div>
  );
}

/** Print + send-to-WhatsApp actions for one receipt (no thermal printer needed). */
export function ReceiptActions({ order, onPrint }: { order: Order; onPrint: () => void }) {
  const [phone, setPhone] = useState(order.customer_phone ?? "");
  const wa = toWa(phone);
  return (
    <div className="space-y-3">
      <Button className="w-full rounded-full bg-teal-brand hover:bg-teal-deep" onClick={onPrint} data-testid="print-receipt-single-button">
        <Printer /> Cetak / simpan PDF
      </Button>
      <Button variant="outline" className="w-full rounded-full" onClick={() => downloadReceiptImage(order).catch(() => {})} data-testid="receipt-download-image-button">
        <ImageDown /> Unduh struk (gambar)
      </Button>
      <div className="flex gap-2">
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, "").slice(0, 20))}
          placeholder="No. WA pelanggan (08...)"
          inputMode="tel"
          className="h-9"
          data-testid="receipt-wa-phone-input"
        />
        <a
          href={wa.length >= 9 ? `https://wa.me/${wa}?text=${encodeURIComponent(receiptText(order))}` : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={wa.length < 9}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[#25D366] px-4 text-sm font-semibold text-white transition-opacity duration-150",
            wa.length < 9 && "pointer-events-none opacity-40",
          )}
          data-testid="receipt-wa-send-button"
        >
          <Send className="size-4" /> Kirim WA
        </a>
      </div>
    </div>
  );
}
