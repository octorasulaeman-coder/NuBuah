import { AUTO_CODES } from "@/data/codes";
// NuBuah menu (from the store's Instagram menu boards). Prices in full Rupiah.
// Built-in ids: smoothie, bowl, jus, potong, custom, snack, sopsalad. The owner can also add more categories in the app (ids start with "cx-").
export type CategoryId = string;

export interface MenuOption {
  id: string;
  label: string;
  r: number; // price for Regular (or the only price)
  l?: number; // price for Large when it differs
  default?: boolean;
  tier?: string; // sub-heading inside a group (custom fruit tiers)
  soldOut?: boolean;
  hidden?: boolean; // hidden from the order screen (shown dimmed in Kelola Menu)
  custom?: boolean; // added from inside the app (stored in MongoDB), not from this file
  base?: { r: number; l?: number }; // original price of a custom option, before any store override
  edited?: boolean; // the owner renamed this built-in option
  origLabel?: string; // the built-in name, for "restore"
}

export interface OptionGroup {
  id: string;
  label: string;
  type: "single" | "multi";
  min: number;
  max?: number;
  hint?: string;
  options: MenuOption[];
  edited?: boolean; // the owner renamed this built-in group
  origLabel?: string;
}

export interface Product {
  id: string;
  code?: string;
  name: string;
  category: CategoryId;
  section?: string; // optional sub-heading inside a category (e.g. "Es Kul Kul")
  desc: string;
  benefit?: string;
  color: string;
  sizes: boolean;
  r: number;
  l?: number;
  pricing: "fixed" | "potong" | "custom";
  groups: string[];
}

export const K = (n: number) => n * 1000;

export const CATEGORIES: { id: CategoryId; label: string; blurb: string }[] = [
  { id: "smoothie", label: "Smoothie", blurb: "Blend buah segar, Regular 400ml / Large 600ml" },
  { id: "bowl", label: "Smoothie Bowl", blurb: "Topping buah slice, oats & sunflower seed" },
  { id: "jus", label: "Jus", blurb: "Single jus satu buah, Regular / Large" },
  { id: "potong", label: "Buah Potong", blurb: "Custom dadakan, 11K max 4 macam" },
  { id: "custom", label: "Custom", blurb: "Pilih 1–3 buah favoritmu" },
  { id: "snack", label: "Snack", blurb: "Es kul kul, es loli, yogurt cimory" },
  { id: "sopsalad", label: "Sop & Salad Buah", blurb: "Sop buah segar, pilih kuah jeruk / susu / jus" },
];

const opt = (id: string, label: string, r = 0, l?: number, extra: Partial<MenuOption> = {}): MenuOption => ({
  id,
  label,
  r,
  l,
  ...extra,
});

const BOWL_TOPPINGS = ["Buah Slice", "Sunflower Seed", "Raisin (Kismis)", "Kacang Mede", "Oats", "Pumkin Seed"];
const POTONG_FRUITS = ["Buah Naga", "Semangka", "Melon", "Nanas", "Pepaya", "Strawberry", "Anggur", "Kiwi", "Pisang", "Apel", "Pir", "Mangga"];
const FRUIT_TIERS: { tier: string; price: number; fruits: string[] }[] = [
  { tier: "Buah Harian · 3K", price: K(3), fruits: ["Pisang", "Semangka", "Pepaya", "Nanas", "Jambu", "Jeruk", "Belimbing"] },
  { tier: "Buah Pilihan · 4K", price: K(4), fruits: ["Melon", "Buah Naga", "Strawberry", "Mangga", "Rasberry", "Alpukat", "Sirsak"] },
  { tier: "Buah Sultan · 5K", price: K(5), fruits: ["Kiwi", "Pir", "Ceri", "Apel Hijau", "Apel Merah", "Mulberry", "Blueberry"] },
];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export const GROUPS: Record<string, OptionGroup> = {
  sweet: {
    id: "sweet",
    label: "Level Manis",
    type: "single",
    min: 1,
    max: 1,
    options: [
      opt("no-sugar", "No Sugar"),
      opt("less-sugar", "Less Sugar"),
      opt("normal-sugar", "Normal Sugar", 0, undefined, { default: true }),
      opt("extra-sugar", "Extra Sugar"),
    ],
  },
  ice: {
    id: "ice",
    label: "Es",
    type: "single",
    min: 1,
    max: 1,
    options: [
      opt("no-ice", "No Ice"),
      opt("less-ice", "Less Ice"),
      opt("normal-ice", "Normal Ice", 0, undefined, { default: true }),
      opt("extra-ice", "Extra Ice", K(1)),
    ],
  },
  kuah: {
    id: "kuah",
    label: "Kuah",
    type: "single",
    min: 1,
    max: 1,
    options: [opt("kuah-jeruk", "Kuah Jeruk", 0, undefined, { default: true }), opt("kuah-susu", "Kuah Susu", 0), opt("kuah-jus", "Kuah Jus", K(3))],
  },
  drink_extra: {
    id: "drink_extra",
    label: "Opsi Lainnya",
    type: "multi",
    min: 0,
    hint: "Harga R / L",
    options: [
      opt("yogurt", "Tambah yogurt", K(3), K(5)),
      opt("yakult", "Tambah yakult", K(3), K(6)),
      opt("madu", "Ganti gula jadi madu", K(3), K(5)),
      opt("stevia", "Ganti gula jadi stevia", K(2), K(4)),
      opt("susu-uht", "Ganti air jadi susu UHT", K(4), K(6)),
      opt("air-kelapa", "Ganti air jadi air kelapa", K(7), K(9)),
    ],
  },
  bowl_topping: {
    id: "bowl_topping",
    label: "Add Topping",
    type: "multi",
    min: 0,
    hint: "+1K / item",
    options: BOWL_TOPPINGS.map((t) => opt(`top-${slug(t)}`, t, K(1))),
  },
  bowl_extra: {
    id: "bowl_extra",
    label: "Opsi Lainnya",
    type: "multi",
    min: 0,
    options: [
      opt("tanpa-susu", "Tanpa susu", -K(4)),
      opt("tanpa-yogurt", "Tanpa yogurt", -K(3)),
      opt("yakult", "Tambah yakult", K(3)),
      opt("madu", "Ganti gula dengan madu", K(3)),
      opt("stevia", "Ganti gula dengan stevia", K(2)),
    ],
  },
  custom_bowl_extra: {
    id: "custom_bowl_extra",
    label: "Opsi Lainnya",
    type: "multi",
    min: 0,
    options: [
      opt("yogurt", "Tambah yogurt", K(3)),
      opt("yakult", "Tambah yakult", K(3)),
      opt("oats", "Tambah oats di smoothie", K(1)),
      opt("madu", "Ganti gula dengan madu", K(3)),
      opt("stevia", "Ganti gula dengan stevia", K(2)),
      opt("susu-uht", "Ganti air dengan susu UHT", K(4)),
      opt("air-kelapa", "Ganti air dengan air kelapa", K(7)),
    ],
  },
  eko_fruit: {
    id: "eko_fruit",
    label: "Pilih Satu Buah",
    type: "single",
    min: 1,
    max: 1,
    options: ["Strawberry", "Alpukat", "Mangga", "Buah Naga", "Jeruk", "Nanas", "Semangka", "Melon", "Pisang", "Apel", "Jambu", "Belimbing", "Sirsak"].map((f) =>
      opt(`eko-${slug(f)}`, f),
    ),
  },
  potong_fruit: {
    id: "potong_fruit",
    label: "Opsi Buah Potong",
    type: "multi",
    min: 1,
    hint: "1–4 macam = 11K · >4 macam = 16K",
    options: POTONG_FRUITS.map((f) => opt(`bp-${slug(f)}`, f)),
  },
  potong_extra: {
    id: "potong_extra",
    label: "Tambahan",
    type: "multi",
    min: 0,
    options: [
      opt("bumbu-rujak", "Bumbu Rujak", K(2)),
      opt("cokelat-cair", "Cokelat Cair", K(3)),
      ...["Original", "Strawberry", "Blueberry", "Mango", "Peach"].map((v) => opt(`yogurt-${slug(v)}`, `Yogurt ${v}`, K(3))),
    ],
  },
  custom_fruit: {
    id: "custom_fruit",
    label: "Step 1 · Pilih 1–3 Buah",
    type: "multi",
    min: 1,
    max: 3,
    hint: "1 buah = harga ×3 · 2 buah = buah pertama ×2",
    options: FRUIT_TIERS.flatMap((t) => t.fruits.map((f) => opt(`cf-${slug(f)}`, f, t.price, undefined, { tier: t.tier }))),
  },
};

const BOWL_DESC_TAIL = " · Topping: slice of fruit, oats, sunflower seed";

type Seed = [code: string, name: string, desc: string, benefit: string, r: number, l: number, color: string];
const SMOOTHIES: Seed[] = [
  ["BDB", "Berry Dragon Boost", "Pisang · Strawberry · Buah Naga", "Antioksidan tinggi & bantu jaga stamina", 14, 17, "#E2457A"],
  ["DP", "Dragon Papayana", "Pisang · Pepaya · Buah Naga", "Melancarkan pencernaan & lembut di perut", 13, 16, "#EF5F80"],
  ["GB", "Green Breeze", "Kiwi · Melon · Apel", "Detoks ringan & segarkan tubuh", 16, 19, "#93C13E"],
  ["WUB", "Wake Up Booster", "Nanas · Melon · Jeruk", "Segarkan tubuh dan bantu pencernaan", 13, 16, "#EFCF33"],
  ["WPC", "Watermelon Pineapple Cooler", "Semangka · Melon · Nanas", "Melembapkan tubuh & cegah dehidrasi", 13, 16, "#F1B9A4"],
  ["HBS", "Happy Berry Summer", "Semangka · Jeruk · Strawberry", "Tinggi vitamin C & segarkan badan", 13, 16, "#EE5C55"],
  ["SBB", "Strawberry Banana Blend", "Mangga · Pisang · Strawberry", "Baik untuk kulit & bikin mood happy", 14, 17, "#EF7470"],
  ["MBP", "Mango Banana Punch", "Nanas · Pisang · Mangga", "Menambah energi & segarkan tubuh", 13, 16, "#F2CF3E"],
  ["BG", "Berry Glow", "Strawberry · Rasberry · Mulberry", "Tinggi antioksidan & baik untuk imun", 16, 19, "#D52E50"],
  ["CP", "Creamy Power", "Alpukat · Pisang", "Baik untuk jantung & mengenyangkan", 15, 18, "#A6C743"],
  ["IB", "Immunity Boost", "Mangga · Strawberry", "Menjaga kulit & segarkan tubuh", 15, 18, "#F0685A"],
  ["VCP", "Vitamin C Punch", "Kiwi · Strawberry · Nanas", "Tinggi vitamin C & segarkan badan", 15, 18, "#EA4C63"],
];

const BOWLS: [code: string | undefined, name: string, desc: string, price: number, color: string][] = [
  ["MBS", "Mix Berry Smooth", "Banana · Strawberry · Rasberry · Mulberry · Blueberry · Milk · Yoghurt · Sugar", 34, "#A9739F"],
  ["BDB", "Berry Dragon Boost", "Banana · Strawberry · Dragonfruit · Milk · Yoghurt · Sugar", 30, "#D23477"],
  ["SBB", "Strawberry Banana Blend", "Banana · Strawberry · Mango · Milk · Yoghurt · Sugar", 30, "#EE9580"],
  ["MBP", "Mango Banana Punch", "Banana · Mango · Milk · Yoghurt · Sugar", 29, "#F2C23A"],
  [undefined, "Strawnana", "Banana · Strawberry · Milk · Yoghurt · Sugar", 29, "#F1B2B8"],
  [undefined, "Mangobana", "Banana · Mango · Milk · Yoghurt · Sugar", 29, "#F2BC45"],
  [undefined, "Dragon Papayana", "Banana · Dragonfruit · Papaya · Milk · Yoghurt · Sugar", 29, "#BE3579"],
  [undefined, "Avomango Smooth", "Banana · Mango · Avocado · Milk · Yoghurt · Sugar", 30, "#C3D184"],
];

const JUS: [name: string, r: number, l: number, color: string][] = [
  ["Strawberry", 15, 18, "#E8424F"],
  ["Alpukat", 15, 18, "#A3C152"],
  ["Mangga Kaweni", 15, 18, "#F0B83A"],
  ["Mangga Harum Manis", 15, 18, "#F3C443"],
  ["Buah Naga", 15, 18, "#D0347A"],
  ["Jeruk Peras", 12, 15, "#F39A2C"],
  ["Nanas", 12, 15, "#F2D04A"],
  ["Semangka", 12, 15, "#EE5F5B"],
  ["Melon", 15, 18, "#B9D77A"],
  ["Pisang", 12, 15, "#F2E3A0"],
  ["Apel", 18, 21, "#D6E07A"],
  ["Jambu Batu / Merah", 12, 15, "#EC6F80"],
  ["Belimbing", 12, 15, "#EBD34E"],
  ["Sirsak", 15, 18, "#EDEBDC"],
];

const DRINK_GROUPS = ["sweet", "ice", "drink_extra"];

// Snack: one product per flavour so each can be priced, sold out and reported on its own.
const ES_KUL_KUL: [flavour: string, price: number][] = [
  ["Pisang Polos", 2000], ["Melon", 2000], ["Semangka", 2000], ["Pepaya", 2000], ["Nanas", 2000],
  ["Pisang Kacang", 2500],
  ["Strawberry", 3000], ["Apel", 3000], ["Buah Naga", 3000],
  ["Anggur", 4000],
];
const ES_LOLI: [flavour: string, price: number][] = [
  ["Strawberry", 2000], ["Melon", 2000], ["Semangka", 2000], ["Mangga", 2000], ["Nanas", 2000], ["Buah Naga", 2000],
  ["Mix Berry", 3000],
];
const YOGURT_CIMORY = ["Strawberry", "Original", "Anggur", "Mangga", "Blueberry", "Peach", "Brown Sugar"];

const snackItem = (prefix: string, family: string, color: string, flavour: string, price: number): Product => ({
  id: `${prefix}-${slug(flavour)}`,
  name: `${family} ${flavour}`,
  category: "snack",
  section: family,
  desc: `Rasa ${flavour}`,
  color,
  sizes: false,
  r: price,
  pricing: "fixed",
  groups: [],
});

const SNACK_PRODUCTS: Product[] = [
  ...ES_KUL_KUL.map(([f, price]) => snackItem("ek", "Es Kul Kul", "#7FD0E8", f, price)),
  ...ES_LOLI.map(([f, price]) => snackItem("el", "Es Loli", "#F6A5C0", f, price)),
  ...YOGURT_CIMORY.map((f) => snackItem("yc", "Yogurt Cimory", "#F4E3B8", f, 3000)),
];

const SOP_PRODUCTS: Product[] = [
  {
    id: "sp-sop-buah",
    name: "Sop Buah",
    category: "sopsalad",
    section: "Sop Buah",
    desc: "Sop buah segar · pilih kuah jeruk, susu atau jus",
    color: "#9BD77A",
    sizes: false,
    r: K(17),
    pricing: "fixed",
    groups: ["kuah"],
  },
];

const RAW_PRODUCTS: Product[] = [
  ...SMOOTHIES.map(([code, name, desc, benefit, r, l, color]): Product => ({
    id: `sm-${code.toLowerCase()}`,
    code,
    name,
    category: "smoothie",
    desc,
    benefit,
    color,
    sizes: true,
    r: K(r),
    l: K(l),
    pricing: "fixed",
    groups: DRINK_GROUPS,
  })),
  ...BOWLS.map(([code, name, desc, price, color]): Product => ({
    id: `bw-${slug(name)}`,
    code,
    name,
    category: "bowl",
    desc: desc + BOWL_DESC_TAIL,
    color,
    sizes: false,
    r: K(price),
    pricing: "fixed",
    groups: ["bowl_topping", "bowl_extra"],
  })),
  ...JUS.map(([name, r, l, color]): Product => ({
    id: `js-${slug(name)}`,
    name: `Jus ${name}`,
    category: "jus",
    desc: "Single jus",
    color,
    sizes: true,
    r: K(r),
    l: K(l),
    pricing: "fixed",
    groups: DRINK_GROUPS,
  })),
  {
    id: "js-ekonomis",
    name: "Jus Ekonomis",
    category: "jus",
    desc: "Bebas pilih satu buah (porsi buah lebih dikit)",
    color: "#FFE81A",
    sizes: true,
    r: K(10),
    l: K(13),
    pricing: "fixed",
    groups: ["eko_fruit", ...DRINK_GROUPS],
  },
  {
    id: "bp-buah-potong",
    name: "Buah Potong",
    category: "potong",
    desc: "Single / Mix 11K (max 4 macam) · Mix Spesial 16K (>4 macam)",
    color: "#F6A03A",
    sizes: false,
    r: K(11),
    l: K(16),
    pricing: "potong",
    groups: ["potong_fruit", "potong_extra"],
  },
  {
    id: "cu-jus",
    name: "Custom Jus",
    category: "custom",
    desc: "Pilih 1–3 buah · Reguler 400ml +3K · Large 600ml +6K",
    color: "#F08FA4",
    sizes: true,
    r: K(3),
    l: K(6),
    pricing: "custom",
    groups: ["custom_fruit", "ice", "sweet", "drink_extra"],
  },
  {
    id: "cu-bowl",
    name: "Custom Smoothie Bowl",
    category: "custom",
    desc: "Pilih 1–3 buah · Bowl Reguler +9K · topping 1K",
    color: "#F5C842",
    sizes: false,
    r: K(9),
    pricing: "custom",
    groups: ["custom_fruit", "sweet", "bowl_topping", "custom_bowl_extra"],
  },
  ...SNACK_PRODUCTS,
  ...SOP_PRODUCTS,
];

// Every item has a code. Codes written in this file win; otherwise the generated one (data/codes.ts) is used.
export const PRODUCTS: Product[] = RAW_PRODUCTS.map((p) => (p.code ? p : { ...p, code: AUTO_CODES[p.id] }));

export const FRUIT_TIER_LIST = FRUIT_TIERS;
export const POTONG_FRUIT_LIST = POTONG_FRUITS;
export const BOWL_TOPPING_LIST = BOWL_TOPPINGS;

/** Groups whose option prices / availability staff can edit in Kelola Menu. */
export const EDITABLE_GROUPS = ["bowl_topping", "bowl_extra", "drink_extra", "custom_bowl_extra", "potong_extra", "ice", "kuah"] as const;

export type Groups = Record<string, OptionGroup>;
