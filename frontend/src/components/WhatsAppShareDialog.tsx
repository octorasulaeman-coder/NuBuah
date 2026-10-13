import { useState } from "react";
import { Copy, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { multiReceiptText, toWa, waShareUrl } from "@/lib/receiptText";
import type { Order } from "@/lib/types";
import { cn } from "@/lib/utils";

const LONG = 1800; // WhatsApp links with a very long text can get cut off by the browser or WhatsApp

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea"); // fallback for plain http or older browsers
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast.success("Teks disalin. Tempel di WhatsApp.");
}

/** Send several receipts as ONE WhatsApp message (for example to a group). The owner can edit the text first. */
export default function WhatsAppShareDialog({ orders, onClose }: { orders: Order[]; onClose: () => void }) {
  // Mounted fresh each time it opens (parent renders it conditionally), so the text always starts from the current selection.
  const voided = orders.filter((o) => o.voided).length;
  const [text, setText] = useState(() => multiReceiptText(orders));
  const [phone, setPhone] = useState("");
  const phoneOk = toWa(phone).length >= 9;
  const long = text.length > LONG;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg" data-testid="wa-share-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Kirim {orders.length - voided} struk ke WhatsApp</DialogTitle>
          <DialogDescription>Semua struk digabung jadi satu pesan. Setelah menekan tombol hijau, pilih grup atau kontak di WhatsApp.</DialogDescription>
        </DialogHeader>

        {voided > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="wa-share-void-note">
            {voided} struk VOID tidak ikut dikirim.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="wa-text">Isi pesan (boleh diedit)</Label>
          <textarea
            id="wa-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
            data-testid="wa-share-text"
          />
          {long && (
            <p className="text-xs text-amber-700" data-testid="wa-share-long-note">
              Pesan cukup panjang. Jika WhatsApp memotong teksnya, tekan &ldquo;Salin teks&rdquo; lalu tempel langsung di grup.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wa-phone">Nomor tujuan (opsional)</Label>
          <Input id="wa-phone" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, "").slice(0, 20))} placeholder="Kosongkan untuk memilih grup / kontak sendiri" inputMode="tel" className="h-9" data-testid="wa-share-phone" />
          <p className="text-[11px] text-muted-foreground">WhatsApp tidak bisa membuka grup lewat nomor, jadi untuk grup biarkan kosong dan pilih grupnya setelah WhatsApp terbuka.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <a
            href={text.trim() ? waShareUrl(text, phoneOk ? phone : undefined) : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!text.trim()}
            className={cn("inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-[#25D366] px-5 text-sm font-semibold text-white transition-opacity", !text.trim() && "pointer-events-none opacity-40")}
            data-testid="wa-share-open"
          >
            <Send className="size-4" /> Buka WhatsApp
          </a>
          <Button variant="outline" className="h-10 rounded-full px-5" disabled={!text.trim()} onClick={() => copy(text)} data-testid="wa-share-copy">
            <Copy /> Salin teks
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
