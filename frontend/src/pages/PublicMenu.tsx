import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clock, Minus, Plus, ShoppingBag, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { apiGet, ApiError, apiPost } from "@/lib/api";
import { useMenu } from "@/lib/useMenu";
import { rupiah } from "@/lib/format";
import { downloadReceiptImage } from "@/lib/receiptImage";
import type { OrderLine, OrderLineIn, PublicOrderStatus, PublicStoreInfo } from "@/lib/types";
import ItemDialog from "@/components/pos/ItemDialog";
import MenuPhoto from "@/components/MenuPhoto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface PublicMenuBundle {
  store: PublicStoreInfo;
}

const newOrderId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Small product thumbnail with an emoji fallback when the photo is missing. */
function LineThumb({ pid }: { pid: string }) {
  const [err, setErr] = useState(false);
  if (err) {
    return <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-mint text-lg">🥤</span>;
  }
  return <img src={`/img/menu/${pid}.webp`} alt="" onError={() => setErr(true)} className="h-10 w-10 shrink-0 rounded-lg object-cover" />;
}

// Receipt PNG rendering lives in @/lib/receiptImage (shared with the POS pickup dialog).

const lineKey = (ln: OrderLineIn) => `${ln.product_id}|${ln.size ?? ""}|${JSON.stringify(ln.options)}`;

/** Customer menu page: /m/<store-code>. Order on phone, pay at the counter. */
export default function PublicMenu() {
  const { code = "" } = useParams();
  const storeQ = useQuery({
    queryKey: ["public-menu", code.toUpperCase()],
    queryFn: () => apiGet<PublicMenuBundle>(`/public/menu/${encodeURIComponent(code.toUpperCase())}`),
    retry: false,
  });
  const store = storeQ.data?.store;
  const menu = useMenu(store?.id ?? null);

  const [cart, setCart] = useState<OrderLineIn[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [clientOrderId, setClientOrderId] = useState(() => newOrderId());
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitted, setSubmitted] = useState<PublicOrderStatus | null>(null);

  const downloadReceipt = () => {
    downloadReceiptImage(live!, imgFor).catch(() => toast.error("Gagal membuat gambar struk"));
  };

  const total = cart.reduce((s, l) => s + l.unit_price * l.qty, 0);
  const itemCount = cart.reduce((s, l) => s + l.qty, 0);

  const addLine = (ln: OrderLineIn) => {
    setCart((prev) => {
      const i = prev.findIndex((x) => lineKey(x) === lineKey(ln));
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + ln.qty };
        return next;
      }
      return [...prev, ln];
    });
    toast.success(`${ln.name} ditambahkan`);
  };

  const place = useMutation({
    mutationFn: (body: { store_code: string; lines: OrderLineIn[]; customer_name: string | null; customer_phone: string; client_order_id: string }) =>
      apiPost<PublicOrderStatus>("/public/orders", body),
    onSuccess: (st) => {
      setSubmitted(st);
      setCart([]);
      setCartOpen(false);
      setClientOrderId(newOrderId());
      window.scrollTo(0, 0);
    },
    onError: (e) => {
      const detail = e instanceof ApiError && e.body && typeof e.body === "object" && "detail" in e.body ? String((e.body as { detail: unknown }).detail) : null;
      toast.error(detail ?? "Gagal memesan. Coba lagi.");
    },
  });

  // live status of the just-placed order
  const statusQ = useQuery({
    queryKey: ["public-status", submitted?.order_no, phone],
    queryFn: () => apiGet<PublicOrderStatus>(`/public/orders/${submitted!.order_no}?phone=${encodeURIComponent(phone)}`),
    enabled: !!submitted,
    refetchInterval: 15_000,
  });
  const live = statusQ.data ?? submitted;

  const products = useMemo(() => menu.products, [menu.products]);
  // product photos live at /img/menu/<id>.webp (same convention as MenuPhoto); missing
  // files fall back gracefully (the image renderer skips failed loads)
  const imgFor = (pid: string) => ({ img: `/img/menu/${pid}.webp` });

  if (storeQ.isError) {
    return (
      <div className="grid min-h-screen place-items-center bg-teal-deep px-4 text-white" data-testid="public-menu-notfound">
        <div className="text-center">
          <p className="font-heading text-2xl font-extrabold italic">Toko tidak ditemukan</p>
          <p className="mt-2 text-sm text-white/70">Periksa kembali alamat / kode QR-nya.</p>
        </div>
      </div>
    );
  }

  // ------- success / status screen -------
  if (submitted && live) {
    const paid = live.payment_status === "paid";
    return (
      <div className="min-h-screen bg-mint" data-testid="public-order-success">
        <div className="mx-auto max-w-md px-4 py-8">
          <div className="rounded-2xl bg-white p-6 text-center shadow-lg">
            <p className="text-sm text-muted-foreground">Nomor antrian kamu</p>
            <p className="mt-1 font-heading text-4xl font-extrabold italic tracking-wide text-teal-deep" data-testid="public-order-no">{live.order_no}</p>
            <div className={`mt-4 rounded-full px-4 py-2 text-sm font-semibold ${paid ? "bg-mint text-teal-deep" : "bg-amber-100 text-amber-800"}`} data-testid="public-order-status">
              {paid ? "Lunas — silakan ambil di kasir" : "Menunggu pembayaran di kasir"}
            </div>
            <div className="mt-5 space-y-1.5 border-t border-dashed pt-4 text-left text-sm">
              {live.lines.map((ln: OrderLine, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <LineThumb pid={ln.product_id} />
                    <div className="min-w-0">
                      <span>{ln.qty}× {ln.name}</span>
                    {ln.options && ln.options.length > 0 && (
                      <p className="text-xs text-muted-foreground">{ln.options.map((o) => o.label).join(", ")}</p>
                    )}
                    </div>
                  </div>
                  <span className="whitespace-nowrap font-medium">{rupiah(ln.line_total ?? ln.unit_price * ln.qty)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t pt-2 font-bold">
                <span>Total</span>
                <span data-testid="public-order-total">{rupiah(live.total)}</span>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Sebutkan nomor antrian saat membayar di kasir ({live.store_name}).
            </p>
            <div className="mt-4 flex items-center justify-center gap-4">
              <button
                onClick={downloadReceipt}
                className="rounded-full border border-teal-brand px-4 py-2 text-sm font-semibold text-teal-deep hover:bg-mint"
                data-testid="public-download-receipt"
              >
                Unduh struk (gambar)
              </button>
              <button onClick={() => setSubmitted(null)} className="text-sm font-semibold text-teal-deep underline">
                Pesan lagi
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ------- menu screen -------
  return (
    <div className="min-h-screen bg-mint pb-28" data-testid="public-menu">
      {/* header */}
      <header className="sticky top-0 z-20 bg-teal-deep text-white shadow">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-heading text-lg font-extrabold italic leading-tight" data-testid="public-store-name">
              {store?.name ?? "NuBuah"}
            </p>
            {store && (
              <p className="truncate text-xs text-white/70">
                {store.address_lines.join(" · ")}
              </p>
            )}
          </div>
          {store?.phone && (
            <a
              href={`https://wa.me/${(() => { const d = store.phone.replace(/\D/g, ""); return d.startsWith("62") ? d : "62" + d.replace(/^0/, ""); })()}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/25"
              data-testid="public-wa-link"
            >
              WhatsApp
            </a>
          )}
        </div>
        {/* category nav */}
        <nav className="mx-auto flex max-w-3xl gap-2 overflow-x-auto px-4 pb-2" data-testid="public-categories">
          {menu.categories.map((c) => (
            <a
              key={c.id}
              href={`#cat-${c.id}`}
              className="whitespace-nowrap rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/90 hover:bg-white/25"
            >
              {c.label}
            </a>
          ))}
        </nav>
      </header>

      {/* sections */}
      <main className="mx-auto max-w-3xl px-4 pt-4">
        {menu.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">Memuat menu…</p>}
        {menu.categories.map((cat) => {
          const items = products.filter((p) => p.category === cat.id);
          if (items.length === 0) return null;
          return (
            <section key={cat.id} id={`cat-${cat.id}`} className="pt-4">
              <h2 className="font-heading text-xl font-extrabold italic text-teal-deep">{cat.label}</h2>
              {cat.blurb && <p className="text-xs text-muted-foreground">{cat.blurb}</p>}
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {items.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => (p.soldOut ? toast.info(`${p.name} sedang habis`) : setActive(p.id))}
                    className={`relative overflow-hidden rounded-2xl bg-white text-left shadow-sm transition ${p.soldOut ? "opacity-50" : "hover:shadow-md"}`}
                    data-testid={`public-product-${p.id}`}
                  >
                    <MenuPhoto id={p.id} name={p.name} color={p.color} category={p.category} className="aspect-square w-full" />
                    {p.soldOut && (
                      <span className="absolute left-2 top-2 rounded-full bg-destructive/90 px-2 py-0.5 text-[10px] font-bold text-white">HABIS</span>
                    )}
                    <div className="p-2.5">
                      <p className="line-clamp-2 text-sm font-semibold leading-tight">{p.name}</p>
                      <p className="mt-1 text-xs font-bold text-teal-deep">
                        {rupiah(p.r)}
                        {p.sizes && p.l ? <span className="font-normal text-muted-foreground"> / {rupiah(p.l)}</span> : null}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        <p className="py-8 text-center text-xs text-muted-foreground">
          Pesan di kasir · harga terbaru selalu sesuai di toko
        </p>
      </main>

      {/* cart bar */}
      {itemCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 p-3 backdrop-blur" data-testid="public-cart-bar">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <button onClick={() => setCartOpen(true)} className="flex flex-1 items-center gap-2 rounded-full bg-teal-brand px-4 py-2.5 font-semibold text-white">
              <ShoppingBag size={18} />
              {itemCount} item · {rupiah(total)}
            </button>
          </div>
        </div>
      )}

      {/* picker */}
      {active && products.find((p) => p.id === active) && (
        <ItemDialog
          product={products.find((p) => p.id === active)!}
          groups={menu.groups}
          onClose={() => setActive(null)}
          onAdd={(ln) => {
            addLine(ln);
            setActive(null);
          }}
        />
      )}

      {/* cart sheet */}
      {cartOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={() => setCartOpen(false)} data-testid="public-cart-sheet">
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-heading text-lg font-extrabold italic text-teal-deep">Pesanan</h3>
              <button onClick={() => setCartOpen(false)} aria-label="tutup"><X size={20} /></button>
            </div>
            <ul className="space-y-2">
              {cart.map((ln) => (
                <li key={lineKey(ln)} className="flex items-center gap-2 rounded-xl bg-muted/50 p-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{ln.name}</p>
                    {ln.options?.length > 0 && <p className="truncate text-xs text-muted-foreground">{ln.options.map((o) => o.label).join(", ")}</p>}
                    <p className="text-xs font-bold text-teal-deep">{rupiah(ln.unit_price * ln.qty)}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="rounded-full border p-1" onClick={() => setCart((prev) => prev.map((x) => (lineKey(x) === lineKey(ln) ? { ...x, qty: Math.max(0, x.qty - 1) } : x)).filter((x) => x.qty > 0))} aria-label="kurangi"><Minus size={13} /></button>
                    <span className="w-5 text-center text-sm font-bold">{ln.qty}</span>
                    <button className="rounded-full border p-1" onClick={() => setCart((prev) => prev.map((x) => (lineKey(x) === lineKey(ln) ? { ...x, qty: x.qty + 1 } : x)))} aria-label="tambah"><Plus size={13} /></button>
                  </div>
                  <button className="p-1 text-destructive" onClick={() => setCart((prev) => prev.filter((x) => lineKey(x) !== lineKey(ln)))} aria-label="hapus"><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
            <div className="mt-3 space-y-2">
              <Input placeholder="Nama (wajib)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="public-customer-name" />
              <Input inputMode="tel" placeholder="No. HP aktif (wajib) — untuk cek status pesanan" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, "").slice(0, 16))} data-testid="public-customer-phone" />
            </div>
            <div className="mt-3 flex items-center justify-between border-t pt-3">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="font-heading text-lg font-extrabold text-teal-deep">{rupiah(total)}</span>
            </div>
            <Button
              className="mt-3 w-full rounded-full bg-teal-brand py-5 font-bold hover:bg-teal-deep"
              disabled={!store || name.trim().length < 2 || phone.length < 9 || cart.length === 0 || place.isPending}
              onClick={() =>
                place.mutate({ store_code: store!.code, lines: cart, customer_name: name.trim(), customer_phone: phone, client_order_id: clientOrderId })
              }
              data-testid="public-place-order"
            >
              {place.isPending ? "Mengirim…" : "Pesan — bayar di kasir"}
            </Button>
            <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-muted-foreground">
              <Clock size={11} /> Kamu akan mendapat nomor antrian. Pembayaran tunai/QRIS di kasir.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
