import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CloudOff, Minus, Plus, Printer, Search, Settings2, ShoppingBag, Trash2, X } from "lucide-react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import StaffBar from "@/components/StaffBar";
import { useActiveStore } from "@/lib/auth";
import ReceiptSuccessDialog from "@/components/ReceiptSuccessDialog";
import Swatch from "@/components/Swatch";
import MenuPhoto from "@/components/MenuPhoto";
import ItemDialog from "@/components/pos/ItemDialog";
import CheckoutDialog from "@/components/pos/CheckoutDialog";
import { CustomerOrdersDialog } from "@/components/pos/CustomerOrdersDialog";
import MenuManager from "@/components/pos/MenuManager";
import { type Product } from "@/lib/useMenu";
import { kShort, plain, rupiah } from "@/lib/format";
// receipt printing for completed sales lives in ReceiptSuccessDialog
import { useMenu } from "@/lib/useMenu";
import { onQueueChange, queuedOrders, syncOfflineQueue } from "@/lib/offlineQueue";
import { apiGet } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { CashierQueue, Order, OrderLineIn } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CartLine extends OrderLineIn {
  key: string;
}

const lineKey = (l: OrderLineIn) => JSON.stringify([l.product_id, l.name, l.size, l.options, l.note]);

type SortMode = "default" | "az" | "za" | "cheap" | "pricey";
const SORT_KEY = "nb-pos-sort";
const SORT_LABEL: Record<SortMode, string> = { default: "Urutan menu", az: "Nama A-Z", za: "Nama Z-A", cheap: "Harga termurah", pricey: "Harga termahal" };

export default function Pos() {
  const [cat, setCat] = useState<string | "all">("all");
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [configuring, setConfiguring] = useState<Product | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [incomingOpen, setIncomingOpen] = useState(false);

  // Offline queue: badge count + background sync (on load, on 'online', every 30s).
  const [queueCount, setQueueCount] = useState(() => queuedOrders().length);
  useEffect(() => onQueueChange(() => setQueueCount(queuedOrders().length)), []);
  useEffect(() => {
    const trySync = () => {
      void syncOfflineQueue().then(({ sent, failed }) => {
        if (sent > 0) toast.success(`${sent} pesanan offline terkirim`);
        if (failed > 0) toast.warning(`${failed} pesanan offline perlu dicek ulang (harga berubah?)`);
      });
    };
    window.addEventListener("online", trySync);
    const timer = setInterval(trySync, 30_000);
    trySync();
    return () => {
      window.removeEventListener("online", trySync);
      clearInterval(timer);
    };
  }, []);
  const active = useActiveStore();
  const { storeId, isOwner } = active;

  // Unified customer/scheduled queue used by the Pesanan button and dialog.
  const customerQueueQ = useQuery({
    queryKey: ["orders", "cashier-queue", "count", storeId],
    queryFn: () => apiGet<CashierQueue>(`/orders/cashier-queue?store_id=${storeId}&include_completed=false`),
    enabled: !!storeId,
    refetchInterval: 15_000,
  });
  const customerActionCount =
    (customerQueueQ.data?.unpaid.length ?? 0) + (customerQueueQ.data?.ready.length ?? 0);
  const { products: menu, allProducts, categories, customCategories, customGroups, groups, allGroups, optionOverridden } = useMenu(storeId);

  const [sort, setSort] = useState<SortMode>(() => (localStorage.getItem(SORT_KEY) as SortMode) || "default");
  const changeSort = (v: SortMode) => {
    localStorage.setItem(SORT_KEY, v);
    setSort(v);
  };

  const products = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = menu.filter(
      (p) =>
        (cat === "all" || p.category === cat) &&
        (!term || `${p.code ?? ""} ${p.name} ${p.desc}`.toLowerCase().includes(term)),
    );
    if (sort === "az") return [...list].sort((a, b) => a.name.localeCompare(b.name, "id"));
    if (sort === "za") return [...list].sort((a, b) => b.name.localeCompare(a.name, "id"));
    if (sort === "cheap") return [...list].sort((a, b) => a.r - b.r || a.name.localeCompare(b.name, "id"));
    if (sort === "pricey") return [...list].sort((a, b) => b.r - a.r || a.name.localeCompare(b.name, "id"));
    return list;
  }, [cat, q, menu, sort]);

  const total = cart.reduce((s, l) => s + l.unit_price * l.qty, 0);
  const count = cart.reduce((s, l) => s + l.qty, 0);

  const addLine = (line: OrderLineIn) =>
    setCart((c) => {
      const key = lineKey(line);
      const hit = c.find((x) => x.key === key);
      if (hit) return c.map((x) => (x.key === key ? { ...x, qty: Math.min(99, x.qty + line.qty) } : x));
      return [...c, { ...line, key }];
    });

  const bump = (key: string, d: number) =>
    setCart((c) => c.flatMap((x) => (x.key !== key ? [x] : x.qty + d <= 0 ? [] : [{ ...x, qty: Math.min(99, x.qty + d) }])));

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#eef4f3]" data-testid="pos-page">
      <StaffBar
        active={active}
        extra={
          <>
            <button
              onClick={() => setIncomingOpen(true)}
              className="relative inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-white/30"
              title="Pesanan pelanggan yang butuh tindakan"
              data-testid="customer-queue-button"
            >
              <Bell size={14} />
              <span className="hidden xl:inline">Pesanan</span>
              {customerActionCount > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white" data-testid="customer-queue-badge">
                  {customerActionCount}
                </span>
              )}
            </button>
            {queueCount > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold text-white"
                title="Pesanan tersimpan di perangkat ini dan terkirim otomatis saat koneksi kembali"
                data-testid="offline-queue-badge"
              >
                <CloudOff size={13} />
                {queueCount} menunggu kirim
              </span>
            )}
            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-white/85 hover:bg-white/10 hover:text-white"
                onClick={() => setEditorOpen(true)}
                disabled={!storeId}
                data-testid="pos-menu-editor-button"
              >
                <Settings2 /> <span className="hidden xl:inline">Kelola Menu</span>
              </Button>
            )}
          </>
        }
      />

      <div className="grid flex-1 grid-cols-12 overflow-hidden">
        {/* Catalog */}
        <section className="col-span-12 flex h-full flex-col overflow-hidden lg:col-span-8">
          <div className="shrink-0 space-y-3 border-b border-border bg-white px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Cari menu atau kode (mis. BDB, alpukat)"
                  className="h-10 rounded-full pl-9"
                  data-testid="pos-search-input"
                />
              </div>
              <select
                value={sort}
                onChange={(e) => changeSort(e.target.value as SortMode)}
                aria-label="Urutkan menu"
                className="h-10 shrink-0 rounded-full border border-input bg-background px-3 text-sm font-medium text-teal-deep"
                data-testid="pos-sort-select"
              >
                {(Object.keys(SORT_LABEL) as SortMode[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {[{ id: "all" as const, label: "Semua" }, ...categories].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCat(c.id)}
                  data-testid={`category-filter-${c.id}`}
                  aria-pressed={cat === c.id}
                  className={cn(
                    "shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition-[background-color,color] duration-150",
                    cat === c.id ? "bg-teal-brand text-white" : "bg-mint text-teal-deep hover:bg-teal-pill/25",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {products.length === 0 ? (
              <p className="py-16 text-center text-muted-foreground" data-testid="pos-empty-results">
                Menu tidak ditemukan.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {products.map((p) => (
                  <motion.button
                    key={p.id}
                    type="button"
                    layout
                    disabled={p.soldOut}
                    whileHover={p.soldOut ? undefined : { y: -3 }}
                    whileTap={p.soldOut ? undefined : { scale: 0.97 }}
                    onClick={() => setConfiguring(p)}
                    data-testid={`product-card-${p.id}`}
                    className={cn(
                      "group relative flex flex-col items-start gap-2 overflow-hidden rounded-2xl border border-border bg-white p-3 text-left shadow-sm transition-shadow duration-200 hover:shadow-md",
                      p.soldOut && "cursor-not-allowed opacity-50 grayscale hover:shadow-sm",
                    )}
                  >
                    {p.soldOut && (
                      <span className="absolute top-2 left-1/2 z-10 -translate-x-1/2 -rotate-6 rounded-md bg-destructive px-2 py-0.5 text-xs font-bold text-white" data-testid={`product-soldout-${p.id}`}>
                        HABIS
                      </span>
                    )}
                    <span className="absolute -top-8 -right-8 size-24 rounded-full opacity-20" style={{ background: p.color }} />
                    <div className="flex w-full items-start justify-between">
                      <MenuPhoto id={p.id} name={p.name} color={p.color} category={p.category} photo={p.photo} className="size-12 rounded-xl" />
                      {p.code && <span className="rounded-md bg-teal-brand px-1.5 py-0.5 font-heading text-[11px] font-extrabold italic text-white">{p.code}</span>}
                    </div>
                    <div className="min-h-10 font-heading text-sm leading-tight font-bold text-teal-deep">{p.name}</div>
                    <div className="line-clamp-1 text-[11px] text-muted-foreground">{p.desc}</div>
                    <div className="flex gap-1.5 font-mono text-xs font-semibold" data-testid={`product-price-${p.id}`}>
                      {p.pricing === "custom" ? (
                        <span className="rounded-full bg-zest/60 px-2 py-0.5 text-teal-deep">buah + {kShort(p.r)}</span>
                      ) : p.sizes ? (
                        <>
                          <span className="rounded-full bg-mint px-2 py-0.5 text-teal-deep">R {kShort(p.r)}</span>
                          <span className="rounded-full bg-mint px-2 py-0.5 text-teal-deep">L {kShort(p.l ?? p.r)}</span>
                        </>
                      ) : (
                        <span className="rounded-full bg-mint px-2 py-0.5 text-teal-deep">
                          {kShort(p.r)}
                          {p.pricing === "potong" && ` / ${kShort(p.l ?? p.r)}`}
                        </span>
                      )}
                    </div>
                  </motion.button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Cart */}
        <aside className="col-span-12 flex h-full flex-col overflow-hidden border-l border-border bg-white lg:col-span-4" data-testid="cart-panel">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
            <h2 className="flex items-center gap-2 font-heading text-lg font-extrabold italic text-teal-deep">
              <ShoppingBag className="size-5" /> Pesanan
              <motion.span
                key={count}
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                className="grid min-w-6 place-items-center rounded-full bg-zest px-1.5 text-xs not-italic text-teal-deep"
                data-testid="cart-count"
              >
                {count}
              </motion.span>
            </h2>
            {cart.length > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCart([])} data-testid="cart-clear-button">
                <X /> Kosongkan
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-5">
            {cart.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground" data-testid="cart-empty">
                <Swatch color="#cfe3e0" category="smoothie" className="size-16 opacity-70" />
                <p className="text-sm">Belum ada item. Pilih menu di kiri.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                <AnimatePresence initial={false}>
                  {cart.map((l) => (
                    <motion.li
                      key={l.key}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -16 }}
                      className="py-3"
                      data-testid="cart-item-row"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-teal-deep" data-testid="cart-item-name">
                            {l.code ? `${l.code} · ` : ""}
                            {l.name}
                            {l.size && <span className="ml-1.5 rounded bg-mint px-1.5 text-xs">{l.size}</span>}
                          </div>
                          {l.options.length > 0 && (
                            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
                              {l.options.map((o) => (o.price ? `${o.label} (${o.price > 0 ? "+" : ""}${kShort(o.price)})` : o.label)).join(" · ")}
                            </div>
                          )}
                          {l.note && <div className="text-xs text-teal-brand italic">“{l.note}”</div>}
                        </div>
                        <Button variant="ghost" size="icon-xs" aria-label="Hapus item" onClick={() => bump(l.key, -l.qty)} data-testid="cart-item-remove">
                          <Trash2 />
                        </Button>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-1 rounded-full border p-0.5">
                          <Button variant="ghost" size="icon-xs" aria-label="Kurangi" onClick={() => bump(l.key, -1)} data-testid="cart-item-decrement">
                            <Minus />
                          </Button>
                          <span className="w-5 text-center font-mono text-sm font-semibold" data-testid="cart-item-qty">
                            {l.qty}
                          </span>
                          <Button variant="ghost" size="icon-xs" aria-label="Tambah" onClick={() => bump(l.key, 1)} data-testid="cart-item-increment">
                            <Plus />
                          </Button>
                        </div>
                        <span className="font-mono text-sm font-semibold text-teal-deep" data-testid="cart-item-total">
                          {plain(l.unit_price * l.qty)}
                        </span>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>

          <div className="shrink-0 space-y-3 border-t border-border bg-[#f6faf9] p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Total ({count} item)</span>
              <span className="font-heading text-3xl font-bold tracking-tight text-teal-deep" aria-live="polite" data-testid="cart-subtotal-amount">
                {rupiah(total)}
              </span>
            </div>
            <Button
              size="lg"
              className="h-12 w-full rounded-full bg-teal-brand text-base font-semibold hover:bg-teal-deep"
              disabled={cart.length === 0}
              onClick={() => setCheckoutOpen(true)}
              data-testid="cart-checkout-button"
            >
              Bayar
            </Button>
          </div>
        </aside>
      </div>

      {configuring && <ItemDialog key={configuring.id} product={configuring} groups={groups} onClose={() => setConfiguring(null)} onAdd={addLine} />}

      <CheckoutDialog
        storeId={isOwner ? storeId : null}
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        lines={cart.map(({ key: _key, ...l }) => l)}
        total={total}
        onDone={(order) => {
          setCheckoutOpen(false);
          setCart([]);
          // pay-at-pickup orders have no payment yet — the toast already confirmed the
          // schedule; the receipt prints when payment is recorded at pickup
          if (order.payment_status === "pending") return;
          setReceipt(order);
        }}
      />

      <ReceiptSuccessDialog order={receipt} onClose={() => setReceipt(null)} />
      <CustomerOrdersDialog
        open={incomingOpen}
        onClose={() => setIncomingOpen(false)}
        storeId={storeId}
        onPaid={(order) => {
          setReceipt(order);
          setIncomingOpen(false);
        }}
      />
      <MenuManager open={editorOpen} onOpenChange={setEditorOpen} storeId={storeId} />
    </div>
  );
}
