import { STORE } from "@/data/store";
import { METHOD_LABEL, fmtDateTime, fmtLongDate, plain } from "@/lib/format";
import type { ClosingReport, PaymentMethod } from "@/lib/types";

/** 80mm closing (tutup kasir) report slip. */
export default function ClosingSlip({ report }: { report: ClosingReport }) {
  const sameDay = report.start === report.end;
  return (
    <article className="receipt" data-testid="closing-report-slip">
      <header className="text-center">
        <img src="/logo-256.png" alt="NuBuah" className="receipt-logo" />
        <div className="receipt-brand">{STORE.name}</div>
        <div>LAPORAN TUTUP KASIR</div>
        {report.store_name && <div data-testid="closing-store-name">{report.store_name}</div>}
        <div>{sameDay ? fmtLongDate(report.start) : `${fmtLongDate(report.start)} - ${fmtLongDate(report.end)}`}</div>
      </header>
      <div className="receipt-rule" />
      <div className="receipt-row">
        <span>Dicetak</span>
        <span>{fmtDateTime(report.generated_at)}</span>
      </div>
      {report.first_order_no && (
        <div className="receipt-row">
          <span>No. pesanan</span>
          <span>
            {report.first_order_no.slice(-3)} - {report.last_order_no?.slice(-3)}
          </span>
        </div>
      )}
      {!!report.by_store?.length && (
        <>
          <div className="receipt-rule" />
          <div className="receipt-sub" data-testid="closing-by-store">PER TOKO</div>
          {report.by_store.map((b) => (
            <div key={b.store_name} className="receipt-row" data-testid={`closing-store-${b.store_name}`}>
              <span>
                {b.store_name} ({b.count}x)
              </span>
              <span>{plain(b.revenue)}</span>
            </div>
          ))}
        </>
      )}
      <div className="receipt-rule" />
      <div className="receipt-row">
        <span>Transaksi</span>
        <span data-testid="closing-count">{report.count}</span>
      </div>
      <div className="receipt-row">
        <span>Item terjual</span>
        <span>{report.items}</span>
      </div>
      <div className="receipt-row">
        <span>Rata-rata</span>
        <span>{plain(report.average)}</span>
      </div>
      <div className="receipt-rule" />
      <div className="receipt-item">PEMBAYARAN</div>
      {report.methods.map((m) => (
        <div key={m.method} className="receipt-row" data-testid={`closing-method-${m.method}`}>
          <span>
            {METHOD_LABEL[m.method as PaymentMethod] ?? m.method} ({m.count}x)
          </span>
          <span>{plain(m.total)}</span>
        </div>
      ))}
      <div className="receipt-row receipt-sub">
        <span>Uang tunai di laci</span>
        <span>{plain(report.cash_in_drawer)}</span>
      </div>
      <div className="receipt-rule" />
      {!!report.discount_total && (
        <>
          <div className="receipt-row" data-testid="closing-gross">
            <span>Penjualan kotor</span>
            <span>{plain(report.gross ?? report.revenue + report.discount_total)}</span>
          </div>
          <div className="receipt-row" data-testid="closing-discount">
            <span>Diskon</span>
            <span>-{plain(report.discount_total)}</span>
          </div>
        </>
      )}
      <div className="receipt-row receipt-total">
        <span>TOTAL</span>
        <span data-testid="closing-revenue">Rp {plain(report.revenue)}</span>
      </div>
      {!!report.voided_count && (
        <div className="receipt-row receipt-sub" data-testid="closing-voided">
          <span>Void tidak dihitung ({report.voided_count}x)</span>
          <span>{plain(report.voided_total ?? 0)}</span>
        </div>
      )}
      <div className="receipt-rule" />
      <div className="receipt-item">TERLARIS</div>
      {report.top_items.length === 0 && <div className="receipt-sub">Belum ada penjualan</div>}
      {report.top_items.map((t, i) => (
        <div key={t.name} className="receipt-row" data-testid="closing-top-item">
          <span>
            {i + 1}. {t.name} x{t.qty}
          </span>
          <span>{plain(t.revenue)}</span>
        </div>
      ))}
      <div className="receipt-rule" />
      <footer className="text-center">
        <div>Paraf kasir: ______________</div>
      </footer>
    </article>
  );
}
