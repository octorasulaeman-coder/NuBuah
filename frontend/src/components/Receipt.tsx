import { STORE } from "@/data/store";
import { METHOD_LABEL, fmtDateTime, plain } from "@/lib/format";
import type { Order } from "@/lib/types";

/** 80mm thermal-style receipt. Used for on-screen preview and for printing. */
export default function Receipt({ order }: { order: Order }) {
  return (
    <article className="receipt" data-testid={`receipt-${order.order_no}`}>
      <header className="text-center">
        <img src="/logo-256.png" alt="NuBuah" className="receipt-logo" data-testid="receipt-logo" />
        <div className="receipt-brand">NuBuah</div>
        {order.store_name !== "NuBuah" && <div data-testid="receipt-store-name">{order.store_name}</div>}
        <div>Sehat itu mudah</div>
        {(order.store_address_lines.length ? order.store_address_lines : STORE.addressLines).map((a) => (
          <div key={a} className="receipt-addr">
            {a}
          </div>
        ))}
        <div data-testid="receipt-phone">Telp/WA {order.store_phone || STORE.phone}</div>
        <div data-testid="receipt-instagram">IG {STORE.instagramHandle}</div>
      </header>
      {order.voided && (
        <>
          <div className="receipt-rule" />
          <div className="receipt-total text-center" data-testid="receipt-void-banner">*** VOID / DIBATALKAN ***</div>
          {order.void_reason && <div className="receipt-sub text-center">Alasan: {order.void_reason}</div>}
        </>
      )}
      <div className="receipt-rule" />
      <div className="receipt-row">
        <span>No</span>
        <span data-testid="receipt-order-no">{order.order_no}</span>
      </div>
      <div className="receipt-row">
        <span>Waktu</span>
        <span>{fmtDateTime(order.created_at)} WIB</span>
      </div>
      {order.customer_name && (
        <div className="receipt-row">
          <span>Nama</span>
          <span>{order.customer_name}</span>
        </div>
      )}
      <div className="receipt-rule" />
      {order.lines.map((ln, i) => (
        <div key={i} className="receipt-line">
          <div className="receipt-row">
            <span className="receipt-item">
              {ln.qty}x {ln.code ? `${ln.code} ` : ""}
              {ln.name}
              {ln.size ? ` (${ln.size})` : ""}
            </span>
            <span>{plain(ln.line_total)}</span>
          </div>
          <div className="receipt-sub">@ {plain(ln.unit_price)}</div>
          {ln.options.map((o, j) => (
            <div key={j} className="receipt-row receipt-sub">
              <span>- {o.label}</span>
              {o.price !== 0 && <span>{o.price > 0 ? "+" : ""}{plain(o.price)}</span>}
            </div>
          ))}
          {ln.note && <div className="receipt-sub">* {ln.note}</div>}
        </div>
      ))}
      <div className="receipt-rule" />
      {(!!order.discount_amount || !!order.coupon_amount || !!order.redeem_value_amount) && (
        <div className="receipt-row">
          <span>Subtotal</span>
          <span data-testid="receipt-subtotal">{plain(order.subtotal ?? order.total + (order.discount_amount ?? 0) + (order.coupon_amount ?? 0) + (order.redeem_value_amount ?? 0))}</span>
        </div>
      )}
      {!!order.discount_amount && (
        <div className="receipt-row" data-testid="receipt-discount">
          <span>
            Diskon{order.discount_type === "percent" ? ` ${order.discount_value}%` : ""}
            {order.discount_note ? ` (${order.discount_note})` : ""}
          </span>
          <span>-{plain(order.discount_amount)}</span>
        </div>
      )}
      {!!order.coupon_amount && (
        <div className="receipt-row" data-testid="receipt-coupon">
          <span>Kupon {order.coupon_code}</span>
          <span>-{plain(order.coupon_amount)}</span>
        </div>
      )}
      {!!order.redeem_value_amount && (
        <div className="receipt-row" data-testid="receipt-points">
          <span>Poin ({order.points_redeemed} poin)</span>
          <span>-{plain(order.redeem_value_amount)}</span>
        </div>
      )}
      <div className="receipt-row receipt-total">
        <span>TOTAL</span>
        <span data-testid="receipt-total">Rp {plain(order.total)}</span>
      </div>
      <div className="receipt-row">
        <span>Bayar ({METHOD_LABEL[order.payment_method]})</span>
        <span>{plain(order.cash_tendered ?? order.total)}</span>
      </div>
      {order.change !== null && (
        <div className="receipt-row">
          <span>Kembali</span>
          <span>{plain(order.change)}</span>
        </div>
      )}
      <div className="receipt-row receipt-sub">
        <span>Item</span>
        <span>{order.item_count}</span>
      </div>
      <div className="receipt-rule" />
      <footer className="text-center">
        {!!order.discount_amount && <div className="receipt-sub">Diskon % dibulatkan ke Rp terdekat</div>}
        <div>Terima kasih!</div>
        <div>Sehat itu mudah</div>
      </footer>
    </article>
  );
}
