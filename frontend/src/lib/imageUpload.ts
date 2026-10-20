// Phone-photo downscaler: draws the picked image onto a canvas, resizes to <=800px,
// re-encodes as WebP (~80% quality) and returns base64 for the upload endpoint.
// A 2–5 MB phone photo becomes ~40–150 KB — that is the whole "file size" answer.

export interface ProcessedImage {
  base64: string;
  contentType: "image/webp" | "image/jpeg";
  width: number;
  height: number;
}

export async function processImageFile(file: File, maxSize = 800, quality = 0.82): Promise<ProcessedImage> {
  // read via a data: URL — object/blob URLs depend on CSP img-src and are blocked in some setups
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("File tidak bisa dibaca dari perangkat"));
    r.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("File bukan gambar yang bisa dibaca (coba JPG/PNG, bukan HEIC)"));
      i.src = dataUrl;
    });
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("Canvas tidak tersedia di browser ini");
    g.drawImage(img, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/webp", quality));
    const finalBlob = blob ?? (await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/jpeg", quality)));
    if (!finalBlob) throw new Error("Browser tidak mendukung konversi gambar");
    if (finalBlob.size > 1_500_000) throw new Error("Gambar tetap terlalu besar setelah dikompresi — coba foto lebih dekat/pencahayaan lebih terang");

    const outDataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error("Gagal membaca gambar"));
      r.readAsDataURL(finalBlob);
    });
    const base64 = outDataUrl.split(",")[1] ?? "";
    if (base64.length < 100) throw new Error("Gambar kosong/rusak");
    return { base64, contentType: finalBlob.type === "image/webp" ? "image/webp" : "image/jpeg", width: w, height: h };
  } finally {
    // nothing to clean up — we never created an object URL
  }
}
