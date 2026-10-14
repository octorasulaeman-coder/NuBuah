import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import Receipt from "@/components/Receipt";
import { PrintFormatToggle, ReceiptActions, usePrintFormat } from "@/lib/receiptTools";
import { receiptsNode, usePrint } from "@/lib/print";
import type { Order } from "@/lib/types";

/** Post-payment receipt dialog — the same "Pembayaran berhasil" flow for normal checkout
 * and for online orders paid at pickup. Never auto-prints; the cashier picks the format. */
export default function ReceiptSuccessDialog({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const { print, printArea } = usePrint();
  const [printFormat, setPrintFormat] = usePrintFormat();
  return (
    <>
      {printArea}
      <Dialog open={!!order} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-sm" data-testid="receipt-modal">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Pembayaran berhasil</DialogTitle>
            <DialogDescription>Struk {order?.order_no}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-center rounded-xl bg-muted p-3">{order && <Receipt order={order} />}</div>
          <PrintFormatToggle format={printFormat} onChange={setPrintFormat} />
          {order && <ReceiptActions order={order} onPrint={() => print(receiptsNode([order]), printFormat)} />}
          <Button variant="outline" className="rounded-full" onClick={onClose} data-testid="new-order-button">
            Pesanan baru
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
