import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api";
import type { BackupInfo } from "@/lib/types";

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Owner-only: shows the automatic daily backups, lets the owner back up right now or download a copy. */
export default function BackupCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["backups"], queryFn: () => apiGet<BackupInfo>("/backup") });
  const run = useMutation({
    mutationFn: () => apiPost<{ name: string }>("/backup/run", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups"] });
      toast.success("Backup selesai");
    },
    onError: () => toast.error("Backup gagal"),
  });
  const info = q.data;
  const latest = info?.backups[0];

  return (
    <section className="rounded-2xl border bg-white p-5 shadow-sm lg:col-span-12" data-testid="backup-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-heading text-2xl font-extrabold tracking-tight text-teal-deep italic">
            <DatabaseBackup className="size-6" /> Backup data
          </h2>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="backup-status">
            {q.isLoading
              ? "Memuat..."
              : latest
                ? `Backup terakhir: ${latest.date} ${latest.time}${info?.has_today ? "" : " (belum ada backup hari ini, akan dibuat otomatis saat aplikasi berjalan)"}`
                : "Belum ada backup. Backup otomatis dibuat sekali sehari saat aplikasi berjalan."}
          </p>
          {info && (
            <p className="text-xs text-muted-foreground">
              Disimpan di <span className="font-mono">{info.folder}</span>, {info.keep_days} hari terakhir disimpan. Salin folder ini ke flashdisk atau cloud secara berkala.
            </p>
          )}
        </div>
        <Button className="rounded-full bg-teal-brand hover:bg-teal-deep" disabled={run.isPending} onClick={() => run.mutate()} data-testid="backup-run-button">
          {run.isPending ? "Membuat backup..." : "Backup sekarang"}
        </Button>
      </div>
      {!!info?.backups.length && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {info.backups.slice(0, 7).map((b) => (
            <li key={b.name} className="flex items-center justify-between py-2" data-testid={`backup-row-${b.name}`}>
              <span className="font-mono">
                {b.date} {b.time} <span className="text-muted-foreground">({kb(b.size)})</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  window.location.href = `/api/backup/download/${b.name}`; // server replies with a file download
                }}
                data-testid={`backup-download-${b.name}`}
              >
                <Download /> Unduh
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
