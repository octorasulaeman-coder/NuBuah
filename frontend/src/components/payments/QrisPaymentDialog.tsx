// Reusable QRIS checkout dialog (P3). Shows the provider QR, counts down to expiry,
// polls the BACKEND for authoritative status, and never trusts local state to decide
// "paid" — a visible QR, a returning customer, or a zeroed countdown proves nothing.
//
// States: pending (QR + countdown) / paid (hands off to onPaid) / failed / expired.
// Connection errors keep the dialog open and keep polling; retry starts a NEW attempt
// through the parent (the old attempt stays in history on the server).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, Clock3, TriangleAlert, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { rupiah } from "@/lib/format";
import type { PaymentAttemptPublic } from "@/lib/types";

/** pollBase: "/payments" (staff, cookie auth) or "/public/payments" (customer, uuid-only) */
export default function QrisPaymentDialog({
  attempt,
  pollBase,
  onPaid,
  onRetry,
  onClose,
}: {
  attempt: PaymentAttemptPublic;
  pollBase: string;
  onPaid: (attempt: PaymentAttemptPublic) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const terminal = attempt.status === "paid" || attempt.status === "failed" || attempt.status === "expired";

  const statusQ = useQuery({
    queryKey: ["payment-attempt", attempt.id],
    queryFn: () => apiGet<PaymentAttemptPublic>(`${pollBase}/${attempt.id}`),
    enabled: attempt.status === "pending",
    refetchInterval: 3000,
    retry: true,
  });
  const live = statusQ.data ?? attempt;

  useEffect(() => {
    if (live.status === "paid") {
      const t = setTimeout(() => onPaid(live), 1200); // let the success state read
      return () => clearTimeout(t);
    }
  }, [live.status, live, onPaid]);

  const secondsLeft = useMemo(
    () => Math.max(0, Math.floor((new Date(live.expires_at).getTime() - now) / 1000)),
    [live.expires_at, now],
  );
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid="qris-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl text-teal-deep">Bayar dengan QRIS</DialogTitle>
          <DialogDescription>
            Order {live.order_no} — <span className="font-semibold">{rupiah(live.amount)}</span>
          </DialogDescription>
        </DialogHeader>

        {live.status === "pending" && (
          <div className="flex flex-col items-center gap-3 py-2">
            {live.qr_image_url ? (
              <img src={live.qr_image_url} alt="QRIS" className="h-56 w-56 rounded-xl border" data-testid="qris-image" />
            ) : live.qr_payload ? (
              <div className="rounded-xl border bg-white p-3" data-testid="qris-qr">
                <QRCodeSVG value={live.qr_payload} size={200} level="M" />
              </div>
            ) : (
              <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Provider tidak mengirim kode QR — minta pelanggan cek aplikasi pembayaran.</p>
            )}
            <p className="flex items-center gap-1 text-sm font-semibold text-teal-deep">
              <Clock3 size={14} /> Berlaku {mm}:{ss}
            </p>
            <p className="text-center text-xs text-muted-foreground">
              Scan dengan aplikasi apa pun (GoPay, OVO, DANA, BCA, …). Status terkonfirmasi otomatis setelah pembayaran.
            </p>
            {statusQ.isError && (
              <p className="rounded-lg bg-amber-50 px-3 py-1 text-xs text-amber-800">Koneksi terganggu — memeriksa ulang status…</p>
            )}
          </div>
        )}

        {live.status === "paid" && (
          <div className="flex flex-col items-center gap-2 py-6" data-testid="qris-paid">
            <CheckCircle2 className="text-mint-ink" size={44} />
            <p className="text-lg font-bold text-teal-deep">Pembayaran diterima</p>
          </div>
        )}

        {live.status === "failed" && (
          <div className="flex flex-col items-center gap-2 py-6" data-testid="qris-failed">
            <XCircle className="text-red-500" size={44} />
            <p className="text-lg font-bold text-teal-deep">Pembayaran gagal</p>
            <p className="text-sm text-muted-foreground">Silakan coba lagi.</p>
            <Button className="mt-2 bg-teal-brand text-white hover:bg-teal-deep" onClick={onRetry} data-testid="qris-retry">
              Buat kode QR baru
            </Button>
          </div>
        )}

        {live.status === "expired" && (
          <div className="flex flex-col items-center gap-2 py-6" data-testid="qris-expired">
            <TriangleAlert className="text-amber-500" size={44} />
            <p className="text-lg font-bold text-teal-deep">Kode QR kedaluwarsa</p>
            <p className="text-sm text-muted-foreground">Buat kode baru untuk melanjutkan.</p>
            <Button className="mt-2 bg-teal-brand text-white hover:bg-teal-deep" onClick={onRetry} data-testid="qris-retry">
              Buat kode QR baru
            </Button>
          </div>
        )}

        {live.status === "pending" && secondsLeft === 0 && !terminal && (
          <p className="flex items-center justify-center gap-1 text-xs text-amber-700">
            <TriangleAlert size={12} /> Waktu habis — konfirmasi status sedang diperiksa…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
