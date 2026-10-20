// P4 dashboard UI: KPI cards, payment breakdown, daily-sales chart, and product
// performance tables with PER-TABLE sort + category/group filters, scrollable full
// lists, donuts, and CSV export of exactly what each table shows.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { apiGet } from "@/lib/api";
import { rupiah } from "@/lib/format";
import SalesChart from "@/components/SalesChart";
import type { Dashboard, Order, ProductPerformance } from "@/lib/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const METHOD_LABEL: Record<string, string> = { cash: "Tunai", qris: "QRIS", card: "Kartu" };
const PALETTE = ["#0f766e", "#f59e0b", "#e11d48", "#3b82f6", "#8b5cf6", "#10b981", "#f97316", "#64748b", "#84cc16", "#14b8a6"];
const kShortish = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}jt` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** SVG donut with per-slice hover (slice + legend highlight, values in the center). */
function Donut({ slices, size = 190 }: { slices: { label: string; value: number }[]; size?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 6;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -90;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s, i) => {
      const sweep = (s.value / total) * 360;
      const a0 = (angle * Math.PI) / 180;
      angle += sweep;
      const a1 = (angle * Math.PI) / 180;
      const large = sweep > 180 ? 1 : 0;
      const path =
        sweep >= 359.99
          ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`
          : `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`;
      return { i, path, color: PALETTE[i % PALETTE.length], slice: s, pct: (s.value / total) * 100 };
    });
  const shown = active !== null ? arcs.find((a) => a.i === active) : null;
  return (
    <div className="flex items-center gap-4" data-testid="donut">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="size-full">
          {arcs.map((a) => (
            <path
              key={a.i}
              d={a.path}
              fill={a.color}
              opacity={active === null || active === a.i ? 1 : 0.35}
              className="cursor-pointer transition-opacity duration-150"
              onMouseEnter={() => setActive(a.i)}
              onMouseLeave={() => setActive(null)}
            >
              <title>{`${a.slice.label}: ${rupiah(a.slice.value)} (${a.pct.toFixed(1)}%)`}</title>
            </path>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-[26%] flex flex-col items-center justify-center rounded-full bg-white text-center">
          {shown ? (
            <>
              <div className="max-w-full truncate px-1 text-[10px] font-semibold text-teal-deep" title={shown.slice.label}>{shown.slice.label}</div>
              <div className="font-heading text-sm font-extrabold text-teal-deep">{rupiah(shown.slice.value)}</div>
              <div className="text-[10px] text-muted-foreground">{shown.pct.toFixed(1)}%</div>
            </>
          ) : (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total</div>
              <div className="font-heading text-base font-extrabold text-teal-deep">{kShortish(total)}</div>
            </>
          )}
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1">
        {arcs.map((a) => (
          <li
            key={a.i}
            onMouseEnter={() => setActive(a.i)}
            onMouseLeave={() => setActive(null)}
            className={cn("flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-colors", active === a.i && "bg-mint")}
          >
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: a.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={a.slice.label}>{a.slice.label}</span>
            <span className="font-mono font-semibold text-teal-deep">{a.pct.toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Row = { key: string; qty: number; revenue: number; extra?: string | null };
type SortKey = "label" | "qty" | "revenue";
type SortState = { key: SortKey; dir: "asc" | "desc" };

function useTableSort(initial: SortState = { key: "revenue", dir: "desc" }) {
  const [state, setState] = useState<SortState>(initial);
  const toggle = (key: SortKey) => setState((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const sorted = (rows: Row[]) =>
    [...rows].sort((a, b) => {
      const r = state.key === "label" ? a.key.localeCompare(b.key, "id") : a[state.key] - b[state.key];
      return state.dir === "asc" ? r : -r;
    });
  const head = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => toggle(key)}
        className={cn("inline-flex items-center gap-1 hover:text-teal-deep", state.key === key && "text-teal-deep", className?.includes("text-right") && "flex-row-reverse")}
        data-testid={`dash-sort-${key}`}
      >
        {label}
        {state.key === key ? (state.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
      </button>
    </TableHead>
  );
  return { state, toggle, sorted, head };
}

function ChipFilter({ options, active, onToggle, testIdPrefix }: { options: string[]; active: string[]; onToggle: (v: string) => void; testIdPrefix: string }) {
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3" data-testid={`${testIdPrefix}-filter`}>
      {options.map((c) => {
        const on = active.includes(c);
        return (
          <label key={c} className={cn("flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors", on ? "border-teal-brand bg-mint text-teal-deep" : "border-border bg-white text-muted-foreground")}>
            <input type="checkbox" checked={on} onChange={() => onToggle(c)} className="hidden" data-testid={`${testIdPrefix}-${c}`} />
            {c}
          </label>
        );
      })}
    </div>
  );
}

export default function DashboardSection({ start, end, storeId, orders }: { start: string; end: string; storeId: string; orders?: Order[] }) {
  const sid = !storeId || storeId === "all" ? "all" : storeId;
  const dash = useQuery({
    queryKey: ["dashboard", sid, start, end],
    queryFn: () => apiGet<Dashboard>(`/reports/dashboard?start=${start}&end=${end}&store_id=${sid}`),
    enabled: start <= end,
  });
  const products = useQuery({
    queryKey: ["products-report", sid, start, end],
    queryFn: () => apiGet<ProductPerformance>(`/reports/products?start=${start}&end=${end}&store_id=${sid}`),
    enabled: start <= end,
  });
  const terlarisSort = useTableSort();
  const kategoriSort = useTableSort();
  const rendahSort = useTableSort();

  // PER-TABLE filters: each table has its own selection and is unaffected by the others.
  // Options come from the FULL menu taxonomy (all_categories / all_option_groups) so a
  // newly created category/group shows up immediately, sales or no sales.
  const allCats = products.data?.all_categories?.length ? products.data.all_categories : (products.data?.categories ?? []).map((c) => c.category);
  const [terlarisCats, setTerlarisCats] = useState<string[] | null>(null);
  const [rendahCats, setRendahCats] = useState<string[] | null>(null);
  const [opsiGroups, setOpsiGroups] = useState<string[] | null>(null);
  const toggleIn = (list: string[], set: (v: string[] | null) => void, c: string) => set(list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  const catFilter = (rows: Row[], active: string[]) => rows.filter((r) => !r.extra || active.includes(r.extra) || !active.length);

  const downloadCsv = (filename: string, headers: string[], rows: (string | number)[][]) => {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  };
  const CsvButton = ({ onClick, testId }: { onClick: () => void; testId: string }) => (
    <button type="button" onClick={onClick} className="rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-teal-deep hover:border-teal-brand" data-testid={testId}>
      Unduh CSV
    </button>
  );

  if (dash.isLoading) return <p className="text-sm text-muted-foreground">Memuat dashboard…</p>;
  if (dash.isError || !dash.data)
    return (
      <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="dashboard-error">
        Dashboard tidak bisa dimuat{dash.error instanceof Error && dash.error.message !== "request failed with undefined" ? `: ${dash.error.message}` : " saat ini"}.
      </div>
    );
  const d = dash.data;

  const cards = [
    { label: "Omzet bersih", value: rupiah(d.net_sales), hint: "setelah diskon" },
    { label: "Omzet kotor", value: rupiah(d.gross_sales), hint: "sebelum diskon" },
    { label: "Bersih setelah refund", value: rupiah(d.net_after_refunds), hint: `${d.refunds_count} refund` },
    { label: "Rata-rata / pesanan", value: rupiah(d.average_order_value), hint: `${d.qualifying_orders} pesanan` },
    { label: "Diskon diberikan", value: rupiah(d.discounts_total), hint: "sudah dipotong dari omzet" },
    { label: "Dibatalkan (void)", value: String(d.voided_count), hint: "tidak dihitung" },
  ];

  return (
    <section className="space-y-6" data-testid="dashboard-section">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-heading text-3xl font-extrabold italic tracking-tight text-teal-deep">Dashboard</h2>
        <p className="text-xs text-muted-foreground">
          Dihitung: pesanan <b>lunas &amp; tidak batal</b> · refund dikurangkan sekali
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-border bg-white p-4 shadow-sm" data-testid={`dash-${c.label}`}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{c.label}</div>
            <div className="mt-1 font-heading text-xl font-bold text-teal-deep">{c.value}</div>
            <div className="text-[11px] text-muted-foreground">{c.hint}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-sm" data-testid="dash-methods">
        {d.methods.map((m) => (
          <span key={m.method} className="rounded-full bg-white px-3 py-1 text-teal-deep shadow-sm">
            {METHOD_LABEL[m.method] ?? m.method}: <b className="font-mono">{rupiah(m.total)}</b>
            <span className="text-muted-foreground"> ({m.count}x)</span>
          </span>
        ))}
      </div>

      {orders && <SalesChart orders={orders} start={start} end={end} />}

      <p className="rounded-xl bg-mint px-4 py-2 text-xs text-teal-deep" data-testid="dash-gross-profit-note">
        <b>Laba kotor: tidak tersedia</b> — sistem belum mencatat biaya/harga pokok produk. Tidak ada angka karangan.
      </p>

      {products.data &&
        (() => {
          const pd = products.data!;
          const terlarisRows = catFilter(pd.by_revenue.map((p) => ({ key: p.key, qty: p.qty, revenue: p.revenue, extra: p.category ?? "(tanpa kategori)" })), terlarisCats ?? allCats);
          const rendahRows = catFilter(pd.low_performers.map((p) => ({ key: p.key, qty: p.qty, revenue: p.revenue, extra: p.category ?? "(tanpa kategori)" })), rendahCats ?? allCats);
          const allGroups = pd.all_option_groups?.length ? pd.all_option_groups : [...new Set(pd.top_options.map((o) => o.group))];
          const opsiRows = pd.top_options.filter((o) => (opsiGroups ?? allGroups).includes(o.group));
          const scroll = "max-h-80 overflow-y-auto";
          return (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="text-sm font-semibold text-teal-deep">Terlaris (omzet)</span>
                  <CsvButton testId="csv-terlaris" onClick={() => downloadCsv(`terlaris-${start}-${end}.csv`, ["Produk", "Kategori", "Qty", "Omzet"], terlarisSort.sorted(terlarisRows).map((p) => [p.key, p.extra ?? "", p.qty, p.revenue]))} />
                </div>
                <ChipFilter options={allCats} active={terlarisCats ?? allCats} onToggle={(c) => toggleIn(terlarisCats ?? allCats, setTerlarisCats, c)} testIdPrefix="terlaris-cat" />
                <div className="space-y-3 p-3">
                  {terlarisRows.length > 0 && <Donut slices={terlarisRows.slice(0, 8).map((r) => ({ label: r.key, value: r.revenue }))} />}
                  <div className={cn("w-full", scroll)}>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {terlarisSort.head("label", "Produk")}
                          {terlarisSort.head("qty", "Qty", "text-right")}
                          {terlarisSort.head("revenue", "Omzet", "text-right")}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {terlarisSort.sorted(terlarisRows).map((p) => (
                          <TableRow key={p.key}>
                            <TableCell className="max-w-44 truncate text-sm" title={p.key}>{p.key}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{p.qty}</TableCell>
                            <TableCell className="text-right font-mono text-sm font-semibold text-teal-deep">{rupiah(p.revenue)}</TableCell>
                          </TableRow>
                        ))}
                        {terlarisRows.length === 0 && (
                          <TableRow><TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">Tidak ada produk pada kategori terpilih.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="text-sm font-semibold text-teal-deep">Per kategori</span>
                  <CsvButton testId="csv-kategori" onClick={() => downloadCsv(`per-kategori-${start}-${end}.csv`, ["Kategori", "Qty", "Omzet"], kategoriSort.sorted(pd.categories.map((c) => ({ key: c.category, qty: c.qty, revenue: c.revenue }))).map((c) => [c.key, c.qty, c.revenue]))} />
                </div>
                <div className="space-y-3 p-3">
                  <Donut slices={pd.categories.map((c) => ({ label: c.category, value: c.revenue }))} />
                  <div className={cn("w-full", scroll)}>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {kategoriSort.head("label", "Kategori")}
                          {kategoriSort.head("qty", "Qty", "text-right")}
                          {kategoriSort.head("revenue", "Omzet", "text-right")}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {kategoriSort.sorted(pd.categories.map((c) => ({ key: c.category, qty: c.qty, revenue: c.revenue }))).map((c) => (
                          <TableRow key={c.key}>
                            <TableCell className="max-w-44 truncate text-sm" title={c.key}>{c.key}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{c.qty}</TableCell>
                            <TableCell className="text-right font-mono text-sm font-semibold text-teal-deep">{rupiah(c.revenue)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="text-sm font-semibold text-teal-deep">Opsi terpopuler</span>
                  <CsvButton testId="csv-opsi" onClick={() => downloadCsv(`opsi-terpopuler-${start}-${end}.csv`, ["Grup", "Opsi", "Jumlah"], opsiRows.map((o) => [o.group, o.label, o.count]))} />
                </div>
                <ChipFilter options={allGroups} active={opsiGroups ?? allGroups} onToggle={(g) => toggleIn(opsiGroups ?? allGroups, setOpsiGroups, g)} testIdPrefix="opsi-grp" />
                <div className={cn("p-3", scroll)}>
                  {pd.top_options.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">Belum ada opsi tercatat.</p>
                  ) : opsiRows.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">Tidak ada opsi pada grup terpilih.</p>
                  ) : (
                    <div className="space-y-3" data-testid="dash-top-options">
                      {(() => {
                        const max = opsiRows[0]?.count || 1;
                        return [...new Set(opsiRows.map((o) => o.group))].map((g) => (
                          <div key={g}>
                            <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-teal-brand">{g}</p>
                            <ul className="space-y-1">
                              {opsiRows.filter((o) => o.group === g).map((o) => (
                                <li key={o.label} className="flex items-center gap-2 text-sm">
                                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={o.label}>{o.label}</span>
                                  <div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-mint">
                                    <div className="h-full rounded-full bg-teal-brand" style={{ width: `${(o.count / max) * 100}%` }} />
                                  </div>
                                  <span className="w-8 shrink-0 text-right font-mono text-xs font-semibold text-teal-deep">{o.count}x</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ));
                      })()}
                    </div>
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="text-sm font-semibold text-teal-deep">Paling rendah</span>
                  <CsvButton testId="csv-rendah" onClick={() => downloadCsv(`paling-rendah-${start}-${end}.csv`, ["Produk", "Kategori", "Qty", "Omzet"], rendahSort.sorted(rendahRows).map((p) => [p.key, p.extra ?? "", p.qty, p.revenue]))} />
                </div>
                <ChipFilter options={allCats} active={rendahCats ?? allCats} onToggle={(c) => toggleIn(rendahCats ?? allCats, setRendahCats, c)} testIdPrefix="rendah-cat" />
                <div className={cn("p-3", scroll)}>
                  <div className="w-full">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {rendahSort.head("label", "Produk")}
                          {rendahSort.head("qty", "Qty", "text-right")}
                          {rendahSort.head("revenue", "Omzet", "text-right")}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rendahSort.sorted(rendahRows).map((p) => (
                          <TableRow key={p.key}>
                            <TableCell className="max-w-44 truncate text-sm" title={p.key}>{p.key}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{p.qty}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{rupiah(p.revenue)}</TableCell>
                          </TableRow>
                        ))}
                        {rendahRows.length === 0 && (
                          <TableRow><TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">Tidak ada produk pada kategori terpilih.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </section>
  );
}
