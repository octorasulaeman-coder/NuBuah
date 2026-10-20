# NuBuah POS

Point-of-sale untuk kedai jus buah: kasir POS, menu publik online, pesanan terjadwal,
fondasi pembayaran QRIS (provider-independent), laporan bisnis, dan loyalitas pelanggan.

Stack: FastAPI + MongoDB (backend), Vite + React 19 + TypeScript + Tailwind (frontend).

## Fitur

- **Kasir POS** — keranjang, diskon (dengan PIN pemilik di atas batas), tunai/kartu/QRIS,
  struk, antrian pesanan online, panel pesanan terjadwal dengan alur status
  (diterima → dikonfirmasi → dibuat → siap → selesai).
- **Menu publik** — pelanggan pesan dari HP, pilih jadwal ambil, kode kupon, bayar di
  kasir atau QRIS (bila provider dikonfigurasi), cek status pesanan.
- **Pemesanan terjadwal** — slot 15 menit sesuai jam buka toko, lead time, kuota per
  slot (atomik), reschedule/pembatalan dengan aturan izin.
- **Pembayaran** — fondasi provider-independent: percobaan pembayaran tercatat, webhook
  terverifikasi tanda tangan, duplikat/out-of-order aman, mock provider untuk dev
  (**ditolak di production**). Lihat `docs/PAYMENTS.md`.
- **Laporan** — dashboard (gross/net/refund/AOV), performa produk & kategori, closing
  report, ekspor CSV. Definisi metrik menyertai setiap respons; gross profit dilaporkan
  *tidak tersedia* (tidak ada data biaya — tidak direkayasa).
- **Pelanggan & loyalitas** — profil per toko berdasarkan nomor HP, poin (idempotent,
  dibalik saat void/refund), kupon (kuota atomik, cakupan produk/kategori), consent flag.
- **Keandalan** — checkout idempotent (kunci per toko + sidik jari payload), antrian
  offline dengan backoff + parkir, backup harian ber-checksum dengan verifikasi restore.

## Menjalankan

Backend (butuh MongoDB):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # lalu sesuaikan
uvicorn server:app --reload --port 8001
```

Frontend:

```bash
cd frontend
yarn
yarn dev      # atau: yarn build && ../backend melayani dist/ (SERVE_FRONTEND=1)
```

Script cepat: `start-windows.bat` / `start-mac-linux.sh`.

## Tes

```bash
cd backend
python -m pytest                    # butuh MongoDB lokal untuk tes integrasi
python -m pytest tests/test_pricemath.py tests/test_idempotency.py \
       tests/test_scheduling.py tests/test_payments.py tests/test_loyalty.py
```

Frontend: `yarn lint`, `yarn build`. E2E: `cd tests && npx playwright test` (butuh build + backend berjalan).

## Migrasi

Semua migrasi idempotent dan aman dijalankan ulang:

- Boot aplikasi menerapkan index baru secara otomatis (non-blocking).
- `scripts/migrate_idempotency_index.py` — mengganti index unik global `client_order_id`
  menjadi `(store_id, client_order_id)` (aman: index lama lebih kuat, tidak ada data
  yang diubah/dihapus).
- `bootstrap` juga menambahkan config jadwal ke toko lama dan backfill status order lama.

## Rollback

- Kode: branch/tag git `original` / `v0-original`, atau zip snapshot pristine.
- Data: backup harian di `BACKUP_DIR` (`.json.gz` ber-checksum); restore:
  `python restore_backup.py backups/<nama>.json.gz` (menolak file yang gagal verifikasi,
  menyimpan salinan keselamatan dulu, memverifikasi jumlah koleksi setelahnya).
- Pembayaran online: set `PAYMENT_ENABLED=0` — kasir langsung kembali ke pencatatan
  QRIS manual.

## Prioritas yang sengaja ditunda

Inventory (P7), shift kasir & akuntabilitas kas (P8), Kitchen Display System (P9) —
belum diimplementasikan sesuai roadmap; tidak ada dependensi padanya.

## Dokumentasi

- `docs/PAYMENTS.md` — panduan integrasi provider pembayaran masa depan + prosedur seleksi.
- `NETWORK_SETUP.md`, `OFFLINE_SETUP.md` — pengoperasian multi-perangkat & offline.
- `memory/SPEC.md` — catatan arsitektur.
