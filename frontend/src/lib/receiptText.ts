import { METHOD_LABEL, fmtDateTime, plain } from "@/lib/format";
import type { Order } from "@/lib/types";

export function receiptText(o: Order): string {
  const rows = [
    `*${o.store_name}*`,
    `Struk ${o.order_no}`,
    `${fmtDateTime(o.created_at)} WIB`,
    "",
    ...o.lines.flatMap((l) => [
      `${l.qty}x ${l.code ? `${l.code} ` : ""}${l.name}${l.size ? ` (${l.size})` : ""} = ${plain(l.line_total)}`,
      ...l.options.filter((x) => x.price !== 0).map((x) => `   + ${x.label} ${plain(x.price)}`),
    ]),
    "",
    ...(o.discount_amount ? [`Subtotal: ${plain(o.subtotal ?? o.total + o.discount_amount)}`, `Diskon${o.discount_type === "percent" ? ` ${o.discount_value}%` : ""}: -${plain(o.discount_amount)}`] : []),
    `*TOTAL Rp ${plain(o.total)}*`,
    `Bayar ${METHOD_LABEL[o.payment_method]}: ${plain(o.cash_tendered ?? o.total)}`,
    ...(o.change !== null ? [`Kembali: ${plain(o.change)}`] : []),
    "",
    "Terima kasih! Sehat itu mudah",
  ];
  return rows.join("\n");
}

export const toWa = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  if (d.startsWith("0")) return `62${d.slice(1)}`;
  if (d.startsWith("8")) return `62${d}`;
  return d;
};

/** WhatsApp link: to a specific number when given, otherwise WhatsApp lets the person pick a chat or group. */
export function waShareUrl(text: string, phone?: string): string {
  const wa = phone ? toWa(phone) : "";
  return `https://wa.me/${wa.length >= 9 ? wa : ""}?text=${encodeURIComponent(text)}`;
}

const dayLabel = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** One WhatsApp message with several receipts, e.g. to post the orders of many people in a group. Voided orders are skipped. */
export function multiReceiptText(orders: Order[]): string {
  const list = orders.filter((o) => !o.voided).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (list.length === 0) return "";
  const first = list[0];
  const dates = [...new Set(list.map((o) => o.business_date))].sort();
  const when = dates.length === 1 ? dayLabel(dates[0]) : `${dayLabel(dates[0])} - ${dayLabel(dates[dates.length - 1])}`;
  const blocks = list.map((o, i) => {
    const who = o.customer_name ? ` | ${o.customer_name}` : "";
    return [
      `*${i + 1}) ${o.order_no}*${who}`,
      fmtDateTime(o.created_at) + " WIB",
      ...o.lines.flatMap((l) => [
        `${l.qty}x ${l.code ? `${l.code} ` : ""}${l.name}${l.size ? ` (${l.size})` : ""} = ${plain(l.line_total)}`,
        ...l.options.filter((x) => x.price !== 0).map((x) => `   + ${x.label} ${plain(x.price)}`),
      ]),
      ...(o.discount_amount
        ? [`Diskon${o.discount_type === "percent" ? ` ${o.discount_value}%` : ""}${o.discount_note ? ` (${o.discount_note})` : ""}: -${plain(o.discount_amount)}`]
        : []),
      `*Total Rp ${plain(o.total)}* (${METHOD_LABEL[o.payment_method]})`,
    ].join("\n");
  });
  const grand = list.reduce((a, o) => a + o.total, 0);
  const items = list.reduce((a, o) => a + o.item_count, 0);
  return [
    `*${first.store_name}*`,
    `Rekap ${list.length} pesanan, ${when}`,
    "",
    blocks.join("\n\n"),
    "",
    `*TOTAL ${list.length} pesanan: Rp ${plain(grand)}* (${items} item)`,
    "",
    "Terima kasih! Sehat itu mudah",
  ].join("\n");
}
