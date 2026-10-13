export const STORE = {
  name: "NuBuah",
  tagline: "Sehat itu mudah",
  addressLines: ["Jl. Babakan No.10, RT.001/RW.003", "Cimahi, Kecamatan C, Kota Cimahi", "Jawa Barat 40525"],
  phone: "0896-5607-5653",
  phoneRaw: "089656075653",
  instagram: "https://www.instagram.com/nubuah_/",
  instagramHandle: "@nubuah_",
  whatsapp: "https://wa.me/6289656075653",
  mapsUrl:
    "https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent("Jl. Babakan No.10, RT.001/RW.003, Cimahi, Kota Cimahi, Jawa Barat 40525"),
};

/** WhatsApp deep link with a ready-made order message. */
export const waNumber = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return d.startsWith("0") ? `62${d.slice(1)}` : d;
};

export const mapsLink = (lines: string[]) => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(lines.join(", "));

export const waOrderLink = (item: string, phone: string = STORE.phoneRaw) =>
  `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(`Halo NuBuah, saya mau pesan:\n1x ${item}\n\nNama: \nAmbil / antar: `)}`;
