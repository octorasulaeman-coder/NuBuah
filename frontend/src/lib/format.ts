import type { PaymentMethod } from "@/lib/types";

export const STORE_TZ = "Asia/Jakarta";

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

export const rupiah = (n: number) => idr.format(n);
export const plain = (n: number) => num.format(n);
/** 14000 -> "14K" (menu-board style) */
export const kShort = (n: number) => `${n < 0 ? "-" : ""}${Math.abs(n) / 1000}K`;

export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone: STORE_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

export const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", { timeZone: STORE_TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export const fmtLongDateTimeWIB = (iso: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone: STORE_TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

export const fmtLongDate = (ymd: string) =>
  new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${ymd}T00:00:00Z`),
  );

export const METHOD_LABEL: Record<PaymentMethod, string> = { cash: "Tunai", card: "Kartu", qris: "QRIS" };

/** Local (store-timezone) date fallback when the server is unreachable. */
export const localToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
