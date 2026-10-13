import { useCallback, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import Receipt from "@/components/Receipt";
import type { PrintFormat } from "@/lib/receiptTools";
import type { Order } from "@/lib/types";

/** Renders printable content into a body-level .print-area (hidden on screen) and opens the print dialog. */
export function usePrint() {
  const [content, setContent] = useState<{ node: ReactNode; format: PrintFormat }>({ node: null, format: "a4" });

  const print = useCallback((node: ReactNode, format: PrintFormat = "a4") => {
    flushSync(() => setContent({ node, format }));
    window.print();
  }, []);

  const printArea = createPortal(
    <div className={`print-area print-${content.format}`} data-testid="print-area" data-format={content.format} aria-hidden="true">
      {content.node}
    </div>,
    document.body,
  );

  return { print, printArea };
}

export const receiptsNode = (orders: Order[]) => orders.map((o) => <Receipt key={o.id} order={o} />);
