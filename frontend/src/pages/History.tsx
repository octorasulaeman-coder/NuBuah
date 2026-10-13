import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO, startOfMonth, subDays } from "date-fns";
import { ArrowDown, ArrowUp, ArrowUpDown, Ban, Download, Eye, FileText, Printer, Receipt as ReceiptIcon, Send } from "lucide-react";
import { toast } from "sonner";
import StaffBar from "@/components/StaffBar";
import DrawerPanel from "@/components/DrawerPanel";
import { useActiveStore } from "@/lib/auth";
import { PrintFormatToggle, ReceiptActions, usePrintFormat } from "@/lib/receiptTools";
import ClosingSlip from "@/components/ClosingSlip";
import Receipt from "@/components/Receipt";
import SalesChart from "@/components/SalesChart";
import WhatsAppShareDialog from "@/components/WhatsAppShareDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet, apiPost } from "@/lib/api";
import { METHOD_LABEL, fmtLongDate, fmtTime, localToday, rupiah } from "@/lib/format";
import { receiptsNode, usePrint } from "@/lib/print";
import type { ClosingReport, Order, OrderList, TodayInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

type SortKey = "time" | "no" | "customer" | "items" | "method" | "total";
const compare = (a: Order, b: Order, key: SortKey): number => {
  switch (key) {
    case "time":
      return a.created_at.localeCompare(b.created_at);
    case "no":
      return a.order_no.localeCompare(b.order_no, "id", { numeric: true });
    case "customer":
      return (a.customer_name ?? "").toLowerCase().localeCompare((b.customer_name ?? "").toLowerCase(), "id");
    case "items":
      return a.item_count - b.item_count;
    case "method":
      return METHOD_LABEL[a.payment_method].localeCompare(METHOD_LABEL[b.payment_method], "id");
    case "total":
      return a.total - b.total;
  }
};

export default function History() {
  const active = useActiveStore();
  const [scope, setScope] = useState<string | null>(null); // owner: a store id or "all"
  const storeScope = active.isOwner ? (scope ?? "all") : (active.storeId ?? ""); // owners start with all stores
  const [printFormat, setPrintFormat] = usePrintFormat();
  const todayQ = useQuery({ queryKey: ["today"], queryFn: () => apiGet<TodayInfo>("/today") });
  const today = todayQ.data?.date ?? localToday();
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const start = range?.start ?? today;
  const end = range?.end ?? today;
  const validRange = start <= end;

  const ordersQ = useQuery({
    queryKey: ["orders", storeScope, start, end],
    queryFn: () => apiGet<OrderList>(`/orders?start=${start}&end=${end}&store_id=${storeScope}`),
    enabled: validRange && !!storeScope,
  });
  const [hq, setHq] = useState("");
  const allOrders = !ordersQ.isError && validRange ? (ordersQ.data?.orders ?? []) : [];
  const term = hq.trim().toLowerCase();
  const filtered = term ? allOrders.filter((o) => `${o.customer_name ?? ""} ${o.customer_phone ?? ""} ${o.order_no}`.toLowerCase().includes(term)) : allOrders;
  // Click a column header to sort; click again to reverse. Default is newest first.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "time", dir: "desc" });
  const orders = [...filtered].sort((a, b) => {
    if (sort.key === "customer") {
      // orders without a customer name always go last
      if (!a.customer_name !== !b.customer_name) return a.customer_name ? -1 : 1;
    }
    const r = compare(a, b, sort.key) || a.created_at.localeCompare(b.created_at);
    return sort.dir === "asc" ? r : -r;
  });
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "customer" || key === "no" || key === "method" ? "asc" : "desc" }));
  const sortHead = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className={cn("inline-flex items-center gap-1 font-medium hover:text-teal-deep", sort.key === key && "text-teal-deep", className?.includes("text-right") && "flex-row-reverse")}
        data-testid={`history-sort-${key}`}
      >
        {label}
        {sort.key === key ? sort.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" /> : <ArrowUpDown className="size-3.5 opacity-40" />}
      </button>
    </TableHead>
  );
  const summary = !ordersQ.isError && validRange ? ordersQ.data?.summary : undefined;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedOrders = orders.filter((o) => selected.has(o.id));
  const allSelected = orders.length > 0 && selectedOrders.length === orders.length;
  const [preview, setPreview] = useState(false);
  const [single, setSingle] = useState<Order | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const { print, printArea } = usePrint();
  const qc = useQueryClient();
  const [waOpen, setWaOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Order | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const voidMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) => apiPost<Order>(`/orders/${v.id}/void`, { reason: v.reason }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success(`${o.order_no} dibatalkan`);
      setVoidTarget(null);
      setVoidReason("");
    },
    onError: () => toast.error("Gagal membatalkan pesanan. Hanya owner yang bisa."),
  });
  const exportHref = `/api/reports/export.csv?start=${start}&end=${end}&store_id=${storeScope}`;
  // Owner: the closing report as a file for the selected store, or for all stores together (with a per-store section).
  const closingHref = `/api/reports/closing.csv?start=${start}&end=${end}&store_id=${storeScope}`;
  const scopeName = storeScope === "all" ? "Semua toko" : (active.stores.find((x) => x.id === storeScope)?.name ?? "toko ini");
  const reportQ = useQuery({
    queryKey: ["orders", "closing", storeScope, start, end],
    queryFn: () => apiGet<ClosingReport>(`/reports/closing?start=${start}&end=${end}&store_id=${storeScope}`),
    enabled: reportOpen && validRange && !!storeScope,
  });

  const t = parseISO(today);
  const presets = [
    { id: "today", label: "Hari ini", start: today, end: today },
    { id: "yesterday", label: "Kemarin", start: ymd(subDays(t, 1)), end: ymd(subDays(t, 1)) },
    { id: "7d", label: "7 hari", start: ymd(subDays(t, 6)), end: today },
    { id: "month", label: "Bulan ini", start: ymd(startOfMonth(t)), end: today },
  ];

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const chronological = (list: Order[]) => [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const stats = [
    { id: "revenue", label: "Pendapatan", value: summary ? rupiah(summary.revenue) : "–" },
    { id: "orders", label: "Transaksi", value: summary ? String(summary.count) : "–" },
    { id: "items", label: "Item terjual", value: summary ? String(summary.items) : "–" },
    { id: "avg", label: "Rata-rata", value: summary && summary.count ? rupiah(Math.round(summary.revenue / summary.count)) : "–" },
  ];

  return (
    <div className="min-h-screen bg-[#eef4f3]" data-testid="history-page">
      <StaffBar
        active={active}
        allowAll
        value={storeScope}
        onChange={(id) => {
          setScope(id);
          setSelected(new Set());
          if (id !== "all") active.setStore(id);
        }}
      />

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-brand">Riwayat penjualan</p>
            <h1 className="font-heading text-3xl font-extrabold italic tracking-tight text-teal-deep sm:text-4xl">Cetak struk per tanggal</h1>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="history-range-label">
              {fmtLongDate(start)}
              {start !== end && ` – ${fmtLongDate(end)}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {active.isOwner && (
              <Button
                size="lg"
                variant="outline"
                className="h-11 rounded-full border-teal-brand px-5 font-semibold text-teal-deep"
                disabled={!validRange || !storeScope}
                onClick={() => {
                  window.location.href = exportHref; // the server replies with a file download, so the page stays put
                }}
                data-testid="history-export-button"
              >
                <Download /> Unduh Excel (CSV)
              </Button>
            )}
            <Button
              size="lg"
              variant="outline"
              className="h-11 rounded-full border-teal-brand px-5 font-semibold text-teal-deep"
              disabled={!validRange}
              onClick={() => setReportOpen(true)}
              data-testid="history-closing-report-button"
            >
              <FileText /> Laporan tutup kasir
            </Button>
            <Button
              size="lg"
              className="h-11 rounded-full bg-[#25D366] px-5 font-semibold text-white hover:bg-[#1fb355]"
              disabled={selectedOrders.filter((o) => !o.voided).length === 0}
              onClick={() => setWaOpen(true)}
              data-testid="history-batch-wa-button"
            >
              <Send /> Kirim WA {selectedOrders.filter((o) => !o.voided).length || ""} struk
            </Button>
            <Button
              size="lg"
              className="h-11 rounded-full bg-teal-brand px-6 font-semibold hover:bg-teal-deep"
              disabled={selectedOrders.length === 0}
              onClick={() => setPreview(true)}
              data-testid="history-batch-print-button"
            >
              <Printer /> Cetak {selectedOrders.length || ""} struk
            </Button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-white p-4 shadow-sm">
          <div className="space-y-1.5">
            <Label htmlFor="start-date">Dari tanggal</Label>
            <Input
              id="start-date"
              type="date"
              value={start}
              max={today}
              onChange={(e) => e.target.value && setRange({ start: e.target.value, end })}
              className="w-44"
              data-testid="history-date-start-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="end-date">Sampai tanggal</Label>
            <Input
              id="end-date"
              type="date"
              value={end}
              max={today}
              onChange={(e) => e.target.value && setRange({ start, end: e.target.value })}
              className="w-44"
              data-testid="history-date-end-input"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <Button
                key={p.id}
                variant="outline"
                size="sm"
                className={cn("rounded-full", start === p.start && end === p.end && "border-teal-brand bg-mint text-teal-deep")}
                onClick={() => setRange({ start: p.start, end: p.end })}
                data-testid={`history-preset-${p.id}`}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {!validRange && (
            <p className="w-full text-sm text-destructive" data-testid="history-range-error">
              Tanggal awal harus sebelum atau sama dengan tanggal akhir.
            </p>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stats.map((s, i) => (
            <div
              key={s.id}
              className={cn("rounded-2xl p-5 shadow-sm", i === 0 ? "bg-teal-brand text-white" : "border border-border bg-white text-teal-deep")}
              data-testid={`history-stat-${s.id}`}
            >
              <div className={cn("text-xs font-semibold uppercase tracking-wider", i === 0 ? "text-zest" : "text-muted-foreground")}>{s.label}</div>
              <div className="mt-1 font-heading text-2xl font-bold tracking-tight" data-testid={i === 0 ? "history-total-revenue" : undefined}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
        <Input value={hq} onChange={(e) => setHq(e.target.value)} placeholder="Cari nama pelanggan, no. HP, atau no. pesanan" className="h-10 max-w-md rounded-full bg-white" data-testid="history-search-input" />
        {!!summary?.discount_total && (
          <p className="text-sm text-teal-deep" data-testid="history-discount-note">
            Diskon diberikan: <b className="font-mono">{rupiah(summary.discount_total)}</b> (sudah dikurangi dari pendapatan).
          </p>
        )}
        {!!summary?.voided_count && (
          <p className="text-sm text-amber-700" data-testid="history-voided-note">
            {summary.voided_count} pesanan dibatalkan (void) senilai {rupiah(summary.voided_total ?? 0)} tidak dihitung dalam pendapatan.
          </p>
        )}
        {summary && (
          <div className="flex flex-wrap gap-2 text-sm" data-testid="history-method-breakdown">
            {(["cash", "qris", "card"] as const).map((m) => (
              <span key={m} className="rounded-full bg-white px-3 py-1 text-teal-deep shadow-sm">
                {METHOD_LABEL[m]}: <b className="font-mono">{rupiah(summary.by_method[m])}</b>
              </span>
            ))}
          </div>
        )}

        {/* Orders */}
        {!ordersQ.isError && validRange && ordersQ.data && <SalesChart orders={orders.filter((o) => !o.voided)} start={start} end={end} />}
        <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="bg-mint/60">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={selectedOrders.length > 0 && !allSelected}
                    onCheckedChange={(c) => setSelected(c ? new Set(orders.map((o) => o.id)) : new Set())}
                    aria-label="Pilih semua"
                    data-testid="history-select-all-checkbox"
                    disabled={orders.length === 0}
                  />
                </TableHead>
                {sortHead("no", "No. pesanan")}
                {sortHead("time", "Tanggal")}
                {sortHead("customer", "Pelanggan")}
                {sortHead("items", "Item", "hidden md:table-cell")}
                {sortHead("method", "Bayar")}
                {sortHead("total", "Total", "text-right")}
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordersQ.isLoading && validRange && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    Memuat...
                  </TableCell>
                </TableRow>
              )}
              {ordersQ.isError && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground" data-testid="history-error">
                    Data penjualan tidak bisa dimuat saat ini.
                  </TableCell>
                </TableRow>
              )}
              {!ordersQ.isLoading && !ordersQ.isError && orders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center text-muted-foreground" data-testid="history-empty">
                    <ReceiptIcon className="mx-auto mb-2 size-6 opacity-50" />
                    Tidak ada transaksi di rentang tanggal ini.
                  </TableCell>
                </TableRow>
              )}
              {orders.map((o) => (
                <TableRow key={o.id} data-state={selected.has(o.id) ? "selected" : undefined} className={cn(o.voided && "bg-red-50/60 text-muted-foreground")} data-testid={`history-order-row-${o.order_no}`}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(o.id)}
                      onCheckedChange={(c) => toggle(o.id, c)}
                      aria-label={`Pilih ${o.order_no}`}
                      data-testid="history-order-checkbox"
                    />
                  </TableCell>
                  <TableCell className="font-mono text-sm font-semibold text-teal-deep">
                    <span className={cn(o.voided && "line-through")}>{o.order_no}</span>
                    {o.voided && (
                      <div className="font-sans text-[11px] font-semibold text-red-600" data-testid={`history-void-badge-${o.order_no}`}>
                        VOID{o.void_reason ? `: ${o.void_reason}` : ""}
                      </div>
                    )}
                    {storeScope === "all" && <div className="font-sans text-[11px] font-normal text-muted-foreground">{o.store_name}</div>}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    {fmtLongDate(o.business_date)} · {fmtTime(o.created_at)}
                  </TableCell>
                  <TableCell className="text-sm" data-testid={`history-customer-${o.order_no}`}>
                    {o.customer_name ? (
                      <>
                        <div className="font-semibold text-teal-deep">{o.customer_name}</div>
                        {o.customer_phone && <div className="font-mono text-[11px] text-muted-foreground">{o.customer_phone}</div>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-xs truncate text-sm text-muted-foreground md:table-cell">
                    {o.lines.map((l) => `${l.qty}x ${l.code ?? l.name}`).join(", ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{METHOD_LABEL[o.payment_method]}</Badge>
                  </TableCell>
                  <TableCell className={cn("text-right font-mono font-semibold text-teal-deep", o.voided && "text-muted-foreground line-through")}>{rupiah(o.total)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Button variant="ghost" size="icon-sm" aria-label={`Lihat struk ${o.order_no}`} onClick={() => setSingle(o)} data-testid={`history-view-receipt-${o.order_no}`}>
                      <Eye />
                    </Button>
                    {active.isOwner && !o.voided && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Batalkan ${o.order_no}`} onClick={() => setVoidTarget(o)} data-testid={`history-void-${o.order_no}`}>
                        <Ban className="text-red-600" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </main>

      {waOpen && <WhatsAppShareDialog orders={selectedOrders} onClose={() => setWaOpen(false)} />}

      {/* Batch preview */}
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="max-h-[92vh] overflow-hidden sm:max-w-md" data-testid="batch-print-preview">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Pratinjau {selectedOrders.length} struk</DialogTitle>
            <DialogDescription>Urut dari yang paling awal.</DialogDescription>
          </DialogHeader>
          <PrintFormatToggle format={printFormat} onChange={setPrintFormat} />
          <div className="max-h-[60vh] space-y-3 overflow-y-auto rounded-xl bg-muted p-3">
            {chronological(selectedOrders).map((o) => (
              <div key={o.id} className="mx-auto w-fit shadow-sm">
                <Receipt order={o} />
              </div>
            ))}
          </div>
          <Button
            size="lg"
            className="rounded-full bg-teal-brand font-semibold hover:bg-teal-deep"
            onClick={() => print(receiptsNode(chronological(selectedOrders)), printFormat)}
            data-testid="batch-print-confirm-button"
          >
            <Printer /> Cetak sekarang
          </Button>
        </DialogContent>
      </Dialog>

      {/* Single receipt */}
      <Dialog open={!!single} onOpenChange={(o) => !o && setSingle(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-sm" data-testid="receipt-modal">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Struk {single?.order_no}</DialogTitle>
            <DialogDescription>{single && fmtLongDate(single.business_date)}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-center rounded-xl bg-muted p-3">{single && <Receipt order={single} />}</div>
          <PrintFormatToggle format={printFormat} onChange={setPrintFormat} />
          {single && <ReceiptActions order={single} onPrint={() => print(receiptsNode([single]), printFormat)} />}
        </DialogContent>
      </Dialog>

      {/* Void order */}
      <Dialog
        open={!!voidTarget}
        onOpenChange={(o) => {
          if (!o) {
            setVoidTarget(null);
            setVoidReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm" data-testid="void-dialog">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Batalkan {voidTarget?.order_no}?</DialogTitle>
            <DialogDescription>
              Pesanan tetap tersimpan sebagai VOID, tetapi tidak dihitung di pendapatan dan laporan. Tindakan ini tidak bisa dibatalkan.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="void-reason">Alasan (wajib)</Label>
            <Input id="void-reason" value={voidReason} maxLength={200} onChange={(e) => setVoidReason(e.target.value)} placeholder="mis. salah input, pelanggan batal, refund" data-testid="void-reason-input" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setVoidTarget(null)}>
              Kembali
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={voidReason.trim().length < 3 || voidMut.isPending}
              onClick={() => voidTarget && voidMut.mutate({ id: voidTarget.id, reason: voidReason.trim() })}
              data-testid="void-confirm-button"
            >
              Ya, batalkan
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Closing report */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-sm" data-testid="closing-report-modal">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep">Laporan tutup kasir</DialogTitle>
            <DialogDescription>
              {scopeName} · {fmtLongDate(start)}
              {start !== end && ` – ${fmtLongDate(end)}`} · kertas 80mm
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center rounded-xl bg-muted p-3">
            {reportQ.isLoading && <p className="py-10 text-sm text-muted-foreground">Memuat laporan...</p>}
            {reportQ.isError && (
              <p className="py-10 text-sm text-muted-foreground" data-testid="closing-report-error">
                Laporan tidak bisa dimuat saat ini.
              </p>
            )}
            {reportQ.data && !reportQ.isError && <ClosingSlip report={reportQ.data} />}
            {reportQ.data && !reportQ.isError && (
              <div className="mt-3">
                <DrawerPanel storeId={storeScope === "all" ? null : storeScope} />
              </div>
            )}
          </div>
          <Button
            className="rounded-full bg-teal-brand hover:bg-teal-deep"
            disabled={!reportQ.data || reportQ.isError}
            onClick={() => reportQ.data && print(<ClosingSlip report={reportQ.data} />, printFormat)}
            data-testid="closing-report-print-button"
          >
            <Printer /> Cetak laporan
          </Button>
          {active.isOwner && (
            <Button
              variant="outline"
              className="rounded-full border-teal-brand text-teal-deep"
              disabled={!reportQ.data || reportQ.isError}
              onClick={() => {
                window.location.href = closingHref;
              }}
              data-testid="closing-report-download-button"
            >
              <Download /> Unduh laporan ({scopeName})
            </Button>
          )}
        </DialogContent>
      </Dialog>
      {printArea}
    </div>
  );
}
