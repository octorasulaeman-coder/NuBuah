# NuBuah — Landing page + POS

## What it is
Juice store "NuBuah" (Sehat itu mudah), Indonesia. Currency IDR, no tax, store timezone Asia/Jakarta (WIB).
Menu taken from the store's Instagram menu boards (user screenshots); lives in `frontend/src/data/menu.ts` (static, frontend-owned).

## Routes
- `/` landing page (hero, tabbed menu: Smoothie, Smoothie Bowl, Jus, Buah Potong, Custom; story; footer)
- `/pos` cashier (no login): search, category filters, product grid -> ItemDialog (size R/L, groups like Level Manis, Es, Opsi Lainnya, toppings, fruit pickers, qty, note) -> cart -> Bayar -> CheckoutDialog (Tunai/QRIS/Kartu, cash tendered + change, customer name) -> receipt modal with print
- `/history` date range (start/end + presets), stats, order table with checkboxes, select all, batch print preview -> prints selected receipts on 80mm (one receipt per page break, chronological)

## Pricing rules (frontend/src/lib/pricing.ts)
- Size L uses product.l and option.l prices.
- Buah Potong: 1–4 fruits = 11K, >4 = 16K (name Single / Mix / Mix Spesial).
- Custom Jus (R +3K / L +6K) and Custom Smoothie Bowl (+9K): fruit tiers 3K/4K/5K; 1 fruit x3, 2 fruits = first picked x2 + second, 3 fruits = sum. (2-fruit rule is an assumption.)

## API (backend/routers/orders.py)
- GET /api/today -> {date, timezone}
- POST /api/orders {lines[], payment_method cash|card|qris, cash_tendered?, customer_name?} -> Order (server computes line_total, total, change, order_no NB-YYMMDD-###, business_date WIB). 400 if cash < total; 422 on empty lines.
- GET /api/orders?start=YYYY-MM-DD&end=YYYY-MM-DD -> {orders (newest first), summary{count,revenue,items,by_method}}; 400 if start > end or bad date.
- GET /api/orders/{id} -> Order or 404

- GET /api/menu/overrides -> [{product_id, r, l, sold_out, updated_at}]; PUT /api/menu/overrides/{product_id} {r?, l?, sold_out} (400 bad id, 422 negative price); DELETE resets to the static price (204)
- GET /api/menu/option-overrides; PUT/DELETE /api/menu/option-overrides/{group_id}/{option_id} {r?, l?, sold_out} (negative prices allowed for "Tanpa susu"-type options)
- GET /api/reports/closing?start=&end= -> closing report (count, revenue, items, average, methods[], cash_in_drawer, top_items[10]); 400 if start > end

## Store info
`frontend/src/data/store.ts`: Jl. Babakan No.10, RT.001/RW.003, Cimahi, Kecamatan C, Kota Cimahi, Jawa Barat 40525 · 0896-5607-5653 (WA link). Shown on the landing page (Visit section + footer) and the header of every receipt. Instagram https://www.instagram.com/nubuah_/ (@nubuah_) on landing Visit section, footer, and receipts.
Landing price pills are WhatsApp order links (wa.me with prefilled "Halo NuBuah, saya mau pesan: 1x <item>"); disabled when sold out.
History page has a SalesChart (per hour for a single day, per day for a range).
Menu editor "Topping & Opsi" tab edits option prices/sold-out for bowl_topping, bowl_extra, drink_extra, custom_bowl_extra, potong_extra; sold-out options are disabled in the POS item dialog and show "habis" on the landing page.

## Menu editor (POS → "Kelola Menu" sheet)
Edits base price R/L (or ≤4 / >4 for Buah Potong) and a "Habis" (sold-out) checkbox that saves immediately. `lib/useMenu.ts` merges overrides into the static menu. Sold-out cards are greyed out and can't be clicked in the POS, and show a HABIS badge on the landing page. Option/topping prices aren't editable.

## Closing report
History → "Laporan tutup kasir" for the selected date range, with preview and an 80mm print (`components/ClosingSlip.tsx`, printed via `usePrint`).

## Data
Mongo `orders` collection. Seed: `cd /app/backend && python seed.py` -> ~58 orders over the 7 days before today (flag seeded:true, re-run replaces them). Today has no seeded orders.

## Printing
`lib/print.tsx` portals receipts into body `.print-area`; `@media print` hides everything else, `@page size 80mm auto`.

## Auth
None.

## Multi-store + auth (latest)
- Collections: stores {id, name, code, address_lines, phone, pin_hash, pin_version}, users {id, name, email, password_hash, role owner|cashier, store_id}.
- Auth: httpOnly JWT cookie `nb_session` (lib/auth.py). POST /api/auth/login (email), POST /api/auth/pin (store_id + PIN), POST /api/auth/logout, GET /api/auth/me.
- Roles: owner = all stores (must pass store_id; "all" allowed for GET /orders and /reports/closing); cashier (email or PIN) is pinned to its store (403 for other stores).
- Owner-only: POST/PUT /api/stores, GET/POST/DELETE /api/staff, DELETE menu overrides. Cashiers can PUT overrides but only sold_out is saved (prices are kept).
- Public: GET /api/public/stores, GET /api/menu/overrides?store_id=, GET /api/menu/option-overrides?store_id= (landing shows the selected store's prices).
- Orders carry store snapshot (store_name, store_address_lines, store_phone), cashier_name, customer_phone; order_no = {store.code}-YYMMDD-###.
- Bootstrap (lib/bootstrap.py) at startup creates the default store + owner and migrates legacy data. seed.py adds the Bandung demo store, kasir@nubuah.id and demo orders.
- Frontend: /login (PIN tab + Email tab), RequireAuth on /pos, /history, /admin (owner only). StaffBar = store switcher (owner) + logout via endSession().
- Printing: per-device format toggle (A4 several per page / PDF vs thermal 80mm) via named @page rules; ReceiptActions has "Kirim WA" (wa.me with plain-text receipt).

## Update: logo, menu photos, store rename/delete
- Logo: /frontend/public/logo.png (+ logo-256.png, favicons). Used in BrandMark (all headers, login), receipts and closing slip. To swap in the original logo file, overwrite these PNGs.
- Menu photos: /frontend/public/img/menu/<product id>.webp (smoothie, bowl, jus). MenuPhoto component falls back to the Swatch glyph when no photo exists. Used on Landing, POS product cards, ItemDialog.
- PUT /api/stores/{id}: editing name/address/phone/code also updates past orders' receipt snapshot (store_name, store_address_lines, store_phone) and rewrites order_no prefix (e.g. BDG-... -> JKT-...).
- DELETE /api/stores/{id} (owner): removes store, its cashier users, menu/option overrides. Orders stay (visible under "Semua toko"). The last remaining store cannot be deleted (400). Admin page: trash button per store card + confirm dialog.

## Update: add / hide / delete menu items inside the app
- Owner-only "Tambah menu baru" button in POS -> Kelola Menu. Creates Smoothie / Smoothie Bowl / Jus items stored in Mongo collection `custom_products` (shared by all stores), ids start with `cx-`.
- API (backend/routers/menu.py): GET /api/menu/custom-products (public), POST / PUT /{id} / DELETE /{id} (owner only). Deleting also removes that item's price/sold-out overrides; past orders keep their own snapshot.
- Built-in menu items (data/menu.ts) can be hidden / shown per store with the eye button (`hidden` flag on menu_overrides). Cashiers cannot change hidden or prices.
- `useMenu` returns `products` (visible only) and `allProducts` (includes hidden, used by the editor). Custom items have no photo unless /frontend/public/img/menu/<id>.webp exists; they fall back to the color swatch.

## Update: void orders and CSV export
- Owner-only "Batalkan" (Ban icon) per order in /history; a reason of 3+ characters is required. POST /api/orders/{id}/void. The order stays on record as VOID (shown struck through, receipt shows a VOID banner) and is excluded from revenue, counts, payment totals, the chart and the closing report (closing slip shows "Void tidak dihitung").
- Owner-only "Unduh Excel (CSV)" in /history uses the same date range and store selector as the page. GET /api/reports/export.csv?start&end&store_id. One row per sold item; UTF-8 with BOM so Excel opens it directly; sum the "Total Dihitung" column for real revenue (voided orders are 0). Text cells that start with = + - @ are neutralised against spreadsheet formula injection.

## Update: discounts, daily backup, custom toppings
- Discounts: checkout has a "Diskon / promo" box (Tanpa, %, Rp, plus optional note). Percent max 100, fixed amount cannot exceed the subtotal; the server recalculates. Saved on the order (subtotal, discount_type, discount_value, discount_amount, discount_note); total is the amount paid. Receipt, WhatsApp text, History, closing slip and CSV (columns Subtotal Pesanan, Diskon, Ket. Diskon) all show it. Revenue is net of discounts; voided orders are excluded from discount totals. Cashiers can apply discounts (it is recorded with the cashier name); restrict in CheckoutDialog if needed.
- Daily backup: lib/backup.py makes one gzip JSON backup per day while the app runs (checked at start and every 30 minutes) in <project>/backups (BACKUP_DIR), keeping BACKUP_KEEP_DAYS (default 14) days. Owner-only Admin card "Backup data" (backup now, download). Restore: restore-backup.bat backups\<file> (asks for YES, saves a safety copy of current data first). Backups contain password hashes, keep them private.
- Toppings / options: Kelola Menu > Opsi tab > "Tambah topping / opsi baru" (owner). Stored in Mongo collection custom_options (ids cx-...), added to one of the editable groups. Custom ones can be edited and deleted; built-in ones (and custom ones) can be hidden per store with the eye button. Menu items work the same way (Menu tab).

## Sample data for testing
- `seed-sample-data.bat` (or `python backend/seed_sample_data.py`) adds ~45 sample orders over the last 10 days (cash / QRIS / card, percent and fixed discounts, customers, 2 voided), 2 sample menu items and 2 sample toppings, all marked `sample_data: true`. `--remove` deletes only those records; real data is never touched. `--store CODE` picks a store (default: the first).

## Update: send several receipts to WhatsApp at once
- History: tick several orders, then the green "Kirim WA N struk" button. Voided orders are skipped. The receipts are merged into ONE text message (store, date, each order with the customer name, items, discount, total and payment method, then a grand total), editable before sending. "Buka WhatsApp" opens wa.me with the text (pick the group or contact inside WhatsApp, or fill a number to send to one person); "Salin teks" copies it for pasting into a group. Logic is in frontend/src/lib/receiptText.ts (multiReceiptText) and components/WhatsAppShareDialog.tsx. Single receipts still use ReceiptActions (to the customer's number).

## Update: categories, snack and sop buah menu, extra ice, sorting, customer names, all-stores view
- New built-in categories: Snack (Es Kul Kul 10 flavours 2K-4K, Es Loli 7 flavours 2K-3K, Yogurt Cimory 7 flavours 3K, one product per flavour with a `section` sub-heading) and Sop & Salad Buah (Sop Buah 17K with a Kuah choice: Jeruk +0, Susu +0, Jus +3K). Salad Buah has no price yet: add it with "Tambah menu baru" in that category.
- Ice group now has "Extra Ice" +1K. The `ice` and `kuah` groups are editable in Kelola Menu (Opsi tab), so prices can change without code.
- Owner-made categories: Kelola Menu > Menu tab > "Kelola kategori" (collection `custom_categories`, ids cx-...). They become tabs in the POS and on the landing page. A category with items cannot be deleted. In-app items can go into any category (not potong/custom) and the owner picks which option groups they offer (default by category), plus an optional sub-heading.
- POS: sort dropdown next to the search box (Urutan menu, A-Z, Z-A, termurah, termahal), remembered per device.
- History: Pelanggan column (name + phone) and a search box (name, phone, order number). Owners now open History on "Semua toko"; the closing report has a PER TOKO section when viewing all stores; CSV export and the report both follow the store selector.

## Update: sorting, unique codes, topping groups, accounts, Wi-Fi
- History table: click a column header (No. pesanan, Tanggal, Pelanggan, Item, Bayar, Total) to sort; click again to reverse. Default newest first. Orders without a customer name sort last when sorting by customer.
- Item codes: every built-in item now has a code (47 were generated into frontend/src/data/codes.ts as word initials, e.g. EKKPP, JS; existing codes untouched). The owner can change any code in Kelola Menu; items added in the app take a typed code or get one made automatically. No duplicates are allowed (409 from PUT /api/menu/codes/{id} and POST/PUT custom-products; the form also warns live). Changed codes live in Mongo `product_codes`; backend/lib/builtin_codes.py holds the built-in defaults used for the duplicate check, so update it when built-in items change in menu.ts. Three legacy duplicates (BDB, SBB, MBP shared by a smoothie and its bowl) were kept as requested and are flagged in Kelola Menu.
- Topping groups: Kelola Menu > Opsi tab > "Tambah grup topping". Name, pick-one (required, first option auto-selected) or pick-many, and tick the menu items that show it (collection `custom_groups`, ids cx-...). Toppings are added with "Tambah topping / opsi baru" or the + on the group; they can be edited, hidden or deleted. Deleting a group deletes its toppings. A group only shows on an item when it has an available option.
- Accounts (Admin page): "Akun saya" card (owner edits own name, email, password; other devices are signed out on a password change) and a pencil on each cashier (name, email, store, new password; changing email, store or password signs that cashier out). Store PINs are edited in the store dialog as before. Backend: PUT /api/staff/{id}, PUT /api/auth/me, POST /api/auth/me/password; users have `token_version` checked on every request.
- Wi-Fi use: start-windows-network.bat + NETWORK_SETUP.md.

## Update: owner can edit built-in items, toppings, groups and categories; closing report download
- Edits live in Mongo `menu_edits` ({kind, key, fields}) and sit on top of the built-in menu (menu.ts stays untouched, "Kembalikan ke asli" deletes the edit). API: GET /api/menu/edits (public), PUT /api/menu/edits and DELETE /api/menu/edits?kind=&key= (owner). Kinds: product (name, desc, benefit, category, section, color; the builders Buah Potong / Custom Jus / Custom Bowl cannot change category), option (label, key "group/option"), category (label, blurb), group (title). Items, toppings, groups and categories made in the app keep using their own edit forms.
- Kelola Menu: pencil on every item (built-in items open BuiltinProductDialog), pencil on every topping/option (built-in = rename dialog), pencil on built-in group headings, and "Kelola kategori" now lists built-in categories (rename + blurb) above your own. POS tabs, order dialog and landing page (tab labels) follow the changes; past receipts keep the names they were printed with.
- History (owner): "Unduh closing" and "Unduh laporan (store)" in the closing dialog download GET /api/reports/closing.csv for the store selected on the page, or all stores (adds a PER TOKO section). Includes summary, payments, discounts, voids, cash in, and all items sold.
