// P2 schedule settings UI (owner): slot length, lead time, booking window, per-slot
// capacity, weekly opening hours (per day, local store time), and holidays.
// Saves via PUT /store/schedule — validated by the backend before anything persists.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiGet, apiPut } from "@/lib/api";
import { useActiveStore } from "@/lib/auth";
import type { ScheduleConfig, ScheduleInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DOW: [string, string][] = [
  ["0", "Minggu"],
  ["1", "Senin"],
  ["2", "Selasa"],
  ["3", "Rabu"],
  ["4", "Kamis"],
  ["5", "Jumat"],
  ["6", "Sabtu"],
];

const DEFAULTS: ScheduleConfig = {
  enabled: true,
  slot_minutes: 15,
  lead_time_minutes: 30,
  max_days_ahead: 7,
  capacity_per_slot: 0,
  hours: Object.fromEntries(DOW.map(([d]) => [d, ["09:00", "21:00"]])),
  holidays: [],
};

export default function ScheduleSection() {
  const { isOwner, storeId } = useActiveStore();
  const qc = useQueryClient();
  const [form, setForm] = useState<ScheduleConfig>(DEFAULTS);
  const [holidaysText, setHolidaysText] = useState("");

  const info = useQuery({
    queryKey: ["schedule-admin", storeId],
    queryFn: () => apiGet<ScheduleInfo>(`/store/schedule${storeId ? `?store_id=${storeId}` : ""}`),
  });
  useEffect(() => {
    if (info.data) {
      const { enabled, slot_minutes, lead_time_minutes, max_days_ahead, capacity_per_slot, hours, holidays } = info.data;
      setForm({
        enabled,
        slot_minutes,
        lead_time_minutes,
        max_days_ahead,
        capacity_per_slot,
        hours: hours && Object.keys(hours).length ? hours : DEFAULTS.hours,
        holidays: holidays ?? [],
      });
      setHolidaysText((holidays ?? []).join("\n"));
    }
  }, [info.data]);

  const save = useMutation({
    mutationFn: () =>
      apiPut<ScheduleInfo>(`/store/schedule${storeId ? `?store_id=${storeId}` : ""}`, {
        ...form,
        holidays: holidaysText
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
      }),
    onSuccess: () => {
      toast.success("Pengaturan jadwal tersimpan");
      qc.invalidateQueries({ queryKey: ["schedule-admin", storeId] });
      qc.invalidateQueries({ queryKey: ["schedule-info"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Gagal menyimpan jadwal"),
  });

  const setHour = (dow: string, idx: 0 | 1, value: string) =>
    setForm((f) => ({ ...f, hours: { ...f.hours, [dow]: [idx === 0 ? value : f.hours[dow]?.[0] ?? "09:00", idx === 1 ? value : f.hours[dow]?.[1] ?? "21:00"] } }));

  return (
    <section className="space-y-4 lg:col-span-5" data-testid="schedule-section">
      <h2 className="font-heading text-3xl font-extrabold italic tracking-tight text-teal-deep">Jadwal ambil</h2>
      <p className="text-sm text-muted-foreground">
        Atur slot pemesanan terjadwal. Waktu jam buka memakai <b>zona waktu toko</b> ({info.data?.timezone ?? "Asia/Jakarta"}).
      </p>
      <div className="space-y-3 rounded-2xl border border-border bg-white p-4 shadow-sm">
        <label className="flex items-center gap-2 text-sm font-semibold text-teal-deep">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            disabled={!isOwner}
            data-testid="schedule-enabled"
          />
          Aktifkan pemesanan terjadwal
        </label>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["slot_minutes", "Panjang slot (menit)"],
              ["lead_time_minutes", "Minimal sebelum ambil (menit)"],
              ["max_days_ahead", "Maks. hari ke depan"],
              ["capacity_per_slot", "Kuota per slot (0 = tak terbatas)"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground">{label}</label>
              <Input
                inputMode="numeric"
                value={String(form[key])}
                disabled={!isOwner}
                onChange={(e) => setForm({ ...form, [key]: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                data-testid={`schedule-${key}`}
              />
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground">Jam buka per hari (kosongkan = tutup)</p>
          {DOW.map(([dow, label]) => {
            const window = form.hours[dow];
            const open = !!window;
            return (
              <div key={dow} className="flex items-center gap-2" data-testid={`schedule-day-${dow}`}>
                <label className="flex w-24 items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={open}
                    disabled={!isOwner}
                    onChange={(e) =>
                      setForm((f) => {
                        const hours = { ...f.hours };
                        if (e.target.checked) hours[dow] = ["09:00", "21:00"];
                        else delete hours[dow];
                        return { ...f, hours };
                      })
                    }
                  />
                  {label}
                </label>
                {open && (
                  <div className="flex items-center gap-1.5">
                    <Input type="time" value={window[0]} disabled={!isOwner} onChange={(e) => setHour(dow, 0, e.target.value)} className="w-28" data-testid={`schedule-open-${dow}`} />
                    <span className="text-xs text-muted-foreground">–</span>
                    <Input type="time" value={window[1]} disabled={!isOwner} onChange={(e) => setHour(dow, 1, e.target.value)} className="w-28" data-testid={`schedule-close-${dow}`} />
                  </div>
                )}
                {!open && <span className={cn("text-xs", "text-muted-foreground")}>Tutup</span>}
              </div>
            );
          })}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-muted-foreground">Hari libur (satu tanggal per baris, format 2026-12-25)</label>
          <textarea
            className="min-h-16 w-full rounded-md border border-input bg-white px-3 py-2 text-sm"
            value={holidaysText}
            disabled={!isOwner}
            onChange={(e) => setHolidaysText(e.target.value)}
            data-testid="schedule-holidays"
          />
        </div>
        {isOwner && (
          <Button className="rounded-full bg-teal-brand font-semibold text-white hover:bg-teal-deep" disabled={save.isPending} onClick={() => save.mutate()} data-testid="schedule-save">
            {save.isPending ? "Menyimpan…" : "Simpan jadwal"}
          </Button>
        )}
      </div>
    </section>
  );
}
