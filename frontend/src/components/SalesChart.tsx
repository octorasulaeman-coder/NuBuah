import { useMemo } from "react";
import { eachDayOfInterval, format, parseISO } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STORE_TZ, kShort, rupiah } from "@/lib/format";
import type { Order } from "@/lib/types";

const hourOf = (iso: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: STORE_TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso)));

interface Point {
  label: string;
  revenue: number;
  orders: number;
}

/** Revenue bars: per hour for a single day, per day for a range. */
export default function SalesChart({ orders, start, end }: { orders: Order[]; start: string; end: string }) {
  const single = start === end;
  const data = useMemo<Point[]>(() => {
    if (single) {
      const hours = orders.map((o) => hourOf(o.created_at));
      const from = Math.min(7, ...hours);
      const to = Math.max(21, ...hours);
      const pts: Point[] = [];
      for (let h = from; h <= to; h++) pts.push({ label: `${String(h).padStart(2, "0")}:00`, revenue: 0, orders: 0 });
      orders.forEach((o, i) => {
        const p = pts[hours[i] - from];
        p.revenue += o.total;
        p.orders += 1;
      });
      return pts;
    }
    const days = eachDayOfInterval({ start: parseISO(start), end: parseISO(end) }).slice(-62);
    const map = new Map<string, Point>(days.map((d) => [format(d, "yyyy-MM-dd"), { label: format(d, "dd/MM"), revenue: 0, orders: 0 }]));
    for (const o of orders) {
      const p = map.get(o.business_date);
      if (p) {
        p.revenue += o.total;
        p.orders += 1;
      }
    }
    return [...map.values()];
  }, [orders, start, end, single]);

  const best = data.reduce<Point | null>((b, p) => (p.revenue > (b?.revenue ?? 0) ? p : b), null);

  return (
    <div className="rounded-2xl border border-border bg-white p-5 shadow-sm" data-testid="sales-chart">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-lg font-extrabold italic text-teal-deep">{single ? "Penjualan per jam" : "Penjualan harian"}</h2>
        {best && (
          <span className="text-sm text-muted-foreground" data-testid="sales-chart-best">
            {single ? "Jam tersibuk" : "Hari terbaik"}: <b className="text-teal-deep">{best.label}</b> · {rupiah(best.revenue)}
          </span>
        )}
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#e3eeec" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#4d6b68" }} interval="preserveStartEnd" />
            <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#4d6b68" }} tickFormatter={(v: number) => kShort(Math.round(v / 1000) * 1000)} width={52} />
            <Tooltip
              cursor={{ fill: "rgba(29,107,102,0.08)" }}
              formatter={(value: number) => [rupiah(value), "Pendapatan"]}
              labelFormatter={(label: string) => {
                const p = data.find((d) => d.label === label);
                return `${label} · ${p?.orders ?? 0} transaksi`;
              }}
              contentStyle={{ borderRadius: 12, border: "1px solid #d5e4e1", fontSize: 12 }}
            />
            <Bar dataKey="revenue" fill="#1d6b66" radius={[6, 6, 0, 0]} activeBar={{ fill: "#ffe81a" }} maxBarSize={44} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
