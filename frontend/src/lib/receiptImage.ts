// Shared canvas receipt renderer — turns an order into a downloadable PNG without any
// libraries (works offline). Used by the customer page and the POS pickup dialog.

export interface ReceiptImageData {
  order_no: string;
  payment_status?: string; // undefined treated as "paid" (legacy POS orders)
  total: number;
  lines: {
    qty: number;
    name: string;
    unit_price: number;
    line_total?: number | null;
    options?: { label: string }[];
  }[];
  store_name: string;
  created_at: string;
}

export type ImgLookup = (pid: string) => { img?: string } | undefined;

export async function drawReceiptImage(st: ReceiptImageData, imgFor?: ImgLookup): Promise<HTMLCanvasElement> {
  const loadImg = (src: string) =>
    new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
  // preload product photos (same-origin, so no CORS taint); thumbnails are optional
  const thumbs = imgFor
    ? await Promise.all(
        st.lines.map(async (ln) => {
          const p = (ln as unknown as { product_id?: string }).product_id ? imgFor((ln as unknown as { product_id: string }).product_id) : undefined;
          if (!p?.img) return null;
          try {
            return await loadImg(p.img);
          } catch {
            return null;
          }
        }),
      )
    : st.lines.map(() => null);

  const scale = 2;
  const W = 640;
  const pad = 40;
  const lineH = 34;
  const optLineH = 22;
  const thumbPad = 12;
  const rup = (n: number) => "Rp " + n.toLocaleString("id-ID");
  const DARK = "#134e4a";
  const GRAY = "#6b7280";

  // word-wrap helper (canvas fillText never wraps): measure with a scratch context
  const scratch = document.createElement("canvas").getContext("2d")!;
  const wrapText = (text: string, font: string, maxW: number): string[] => {
    scratch.font = font;
    const out: string[] = [];
    let cur = "";
    for (const word of text.split(" ")) {
      const t = cur ? `${cur} ${word}` : word;
      if (cur && scratch.measureText(t).width > maxW) {
        out.push(cur);
        cur = word;
      } else {
        cur = t;
      }
    }
    if (cur) out.push(cur);
    return out;
  };

  // precompute wrapped layout so the canvas height is exact and nothing overflows
  const layout = st.lines.map((ln, idx) => {
    const img = thumbs[idx];
    const tx = 20 + pad + (img ? 56 : 0);
    const maxTextW = W - 20 - pad - tx;
    const name = `${ln.qty}× ${ln.name}`;
    const nameLines = wrapText(name, "500 20px sans-serif", maxTextW - 110); // keep room for the amount
    const optionLines = ln.options?.length ? wrapText(ln.options.map((o) => o.label).join(", "), "16px sans-serif", maxTextW - 14) : [];
    return { img, tx, nameLines, optionLines };
  });
  const rowsH = layout.reduce((s, r) => s + r.nameLines.length * lineH + r.optionLines.length * optLineH, 0);
  // the draw loop adds thumbPad after every line and removes one at the end — account exactly,
  // or multi-line orders would overflow the canvas and clip the footer
  const rowPad = Math.max(0, layout.length - 1) * thumbPad;
  const H = pad * 2 + 360 + rowsH + rowPad + 80;

  const c = document.createElement("canvas");
  c.width = W * scale;
  c.height = H * scale;
  const g = c.getContext("2d")!;
  g.scale(scale, scale);

  const rr = (x: number, y2: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.moveTo(x + r, y2);
    g.arcTo(x + w, y2, x + w, y2 + h, r);
    g.arcTo(x + w, y2 + h, x, y2 + h, r);
    g.arcTo(x, y2 + h, x, y2, r);
    g.arcTo(x, y2, x + w, y2, r);
    g.closePath();
  };

  g.fillStyle = "#eef4f2";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#ffffff";
  rr(20, 20, W - 40, H - 40, 18);
  g.fill();

  let y = 20 + pad;
  const cx = W / 2;
  g.textAlign = "center";
  g.fillStyle = GRAY;
  g.font = "20px sans-serif";
  g.fillText("Nomor antrian", cx, y);
  y += 44;
  g.fillStyle = DARK;
  g.font = "italic 800 40px sans-serif";
  g.fillText(st.order_no, cx, y);
  y += 36;
  const paid = (st.payment_status ?? "paid") === "paid";
  g.fillStyle = paid ? "#d1fae5" : "#fef3c7";
  const pill = paid ? "LUNAS — ambil di kasir" : "MENUNGGU PEMBAYARAN DI KASIR";
  rr(cx - 210, y - 22, 420, 40, 20);
  g.fill();
  g.fillStyle = paid ? DARK : "#92400e";
  g.font = "600 18px sans-serif";
  g.fillText(pill, cx, y + 4);

  y += 46;
  g.strokeStyle = "#e5e7eb";
  g.setLineDash([6, 5]);
  g.beginPath();
  g.moveTo(20 + pad, y);
  g.lineTo(W - 20 - pad, y);
  g.stroke();
  g.setLineDash([]);
  y += 30;

  g.textAlign = "left";
  layout.forEach(({ img, tx, nameLines, optionLines }, idx) => {
    const ln = st.lines[idx];
    if (img) {
      g.save();
      rr(20 + pad, y - 22, 44, 44, 10);
      g.clip();
      g.drawImage(img, 20 + pad, y - 22, 44, 44);
      g.restore();
    }
    g.fillStyle = "#111827";
    g.font = "500 20px sans-serif";
    const amount = rup(ln.line_total ?? ln.unit_price * ln.qty);
    const firstRowY = y; // amount aligns with the first name line
    nameLines.forEach((nl) => {
      g.fillText(nl, tx, y);
      y += lineH;
    });
    g.textAlign = "right";
    g.font = "600 20px sans-serif";
    g.fillText(amount, W - 20 - pad, firstRowY);
    g.textAlign = "left";
    if (optionLines.length) {
      g.fillStyle = GRAY;
      g.font = "16px sans-serif";
      for (const ol of optionLines) {
        g.fillText(ol, tx + 14, y - 6);
        y += optLineH;
      }
    }
    y += thumbPad;
  });
  y -= thumbPad;
  g.strokeStyle = "#e5e7eb";
  g.beginPath();
  g.moveTo(20 + pad, y - 8);
  g.lineTo(W - 20 - pad, y - 8);
  g.stroke();
  y += 26;
  g.fillStyle = "#111827";
  g.font = "800 24px sans-serif";
  g.fillText("Total", 20 + pad, y);
  g.textAlign = "right";
  g.fillText(rup(st.total), W - 20 - pad, y);
  g.textAlign = "center";
  y += 46;
  g.fillStyle = GRAY;
  g.font = "16px sans-serif";
  g.fillText(`${st.store_name} · ${new Date(st.created_at).toLocaleString("id-ID")}`, cx, y);
  y += 26;
  g.fillText("Terima kasih! Sehat itu mudah", cx, y);
  return c;
}

/** Draw and trigger a PNG download named struk-<order_no>.png */
export async function downloadReceiptImage(st: ReceiptImageData, imgFor?: ImgLookup): Promise<void> {
  const c = await drawReceiptImage(st, imgFor);
  await new Promise<void>((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) return reject(new Error("no blob"));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `struk-${st.order_no}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      resolve();
    }, "image/png");
  });
}
