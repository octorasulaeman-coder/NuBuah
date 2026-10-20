import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { PublicScheduleInfo, ScheduleInfo, SlotsDay } from "@/lib/types";
import { cn } from "@/lib/utils";

const hm = (iso: string) => iso.slice(11, 16);
const WEEKDAY = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
// labels are computed from the ISO date itself (UTC parse) so they stay correct even
// when the customer's device timezone differs from the store's
const dayChip = (iso: string) =>
  `${WEEKDAY[new Date(iso + "T00:00:00Z").getUTCDay()]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const REASON_LABEL: Record<string, string> = {
  past: "sudah lewat",
  lead_time: "terlalu dekat",
  full: "slot penuh",
  closed: "toko tutup",
};

/** Pickup-slot picker shared by the POS checkout and the public menu.
 * mode "staff" hits /store/* (auth cookie); mode "public" hits /public/stores/:code/*. */
export default function SchedulePicker({
  mode,
  storeCode,
  value,
  onChange,
}: {
  mode: "staff" | "public";
  storeCode?: string;
  value: string | null; // selected slot start, UTC ISO
  onChange: (slotUtcIso: string | null) => void;
}) {
  const infoQ = useQuery<ScheduleInfo | PublicScheduleInfo>({
    queryKey: ["schedule-info", mode, storeCode ?? ""],
    queryFn: () =>
      mode === "public"
        ? apiGet<PublicScheduleInfo>(`/public/stores/${encodeURIComponent(storeCode!)}/schedule`)
        : apiGet<ScheduleInfo>("/store/schedule"),
    enabled: mode === "staff" || !!storeCode,
    staleTime: 60_000,
    retry: false,
  });
  const [date, setDate] = useState<string | null>(null);
  const info = infoQ.data;
  const days = (info?.days ?? []).filter((d) => d.open);
  const activeDate = date && days.some((d) => d.date === date) ? date : (days[0]?.date ?? null);

  const slotsQ = useQuery({
    queryKey: ["schedule-slots", mode, storeCode ?? "", activeDate],
    queryFn: () =>
      mode === "public"
        ? apiGet<SlotsDay>(`/public/stores/${encodeURIComponent(storeCode!)}/slots?date=${activeDate}`)
        : apiGet<SlotsDay>(`/store/slots?date=${activeDate}`),
    enabled: !!activeDate,
    staleTime: 30_000,
    refetchInterval: 60_000, // availability moves as slots fill up
  });

  if (infoQ.isLoading) return <p className="text-sm text-muted-foreground">Memuat jadwal…</p>;
  if (!info?.enabled)
    return <p className="rounded-xl bg-mint px-4 py-3 text-sm text-teal-deep">Pemesanan jadwal belum aktif di toko ini — semua pesanan diambil langsung.</p>;
  if (days.length === 0)
    return <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Toko sedang tutup untuk beberapa hari ke depan.</p>;

  return (
    <div className="space-y-2" data-testid="schedule-picker">
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Tanggal ambil">
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            role="tab"
            aria-selected={activeDate === d.date}
            onClick={() => setDate(d.date)}
            data-testid={`day-${d.date}`}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold",
              activeDate === d.date ? "bg-teal-brand text-white" : "bg-mint text-teal-deep hover:bg-teal-pill/30",
            )}
          >
            {dayChip(d.date)}
          </button>
        ))}
      </div>
      {slotsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Memuat jam…</p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5" data-testid="slot-grid">
          {(slotsQ.data?.slots ?? []).map((s) => (
            <button
              key={s.start_utc}
              type="button"
              disabled={!s.available}
              onClick={() => onChange(value === s.start_utc ? null : s.start_utc)}
              title={s.available ? undefined : REASON_LABEL[s.reason ?? ""] ?? s.reason}
              data-testid={`slot-${s.start_local.slice(11, 16)}`}
              className={cn(
                "rounded-lg border py-2 text-xs font-semibold transition-colors",
                value === s.start_utc
                  ? "border-teal-brand bg-teal-brand text-white"
                  : s.available
                    ? "border-border bg-white text-teal-deep hover:border-teal-brand"
                    : "cursor-not-allowed border-border bg-muted text-muted-foreground line-through",
              )}
            >
              {hm(s.start_local)}
              {s.capacity ? <span className="block text-[9px] font-normal">{s.taken}/{s.capacity}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
