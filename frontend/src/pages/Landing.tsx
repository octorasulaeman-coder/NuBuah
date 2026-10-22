import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, Leaf, MapPin, MessageCircle, Sparkles } from "lucide-react";
import { BrandMark } from "@/components/Brand";
import MenuPhoto from "@/components/MenuPhoto";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buttonVariants } from "@/components/ui/button";
import { STORE, mapsLink, waNumber } from "@/data/store";
import { createContext, useContext, useState } from "react";
import { usePublicStores } from "@/lib/auth";
import { SiInstagram } from "@icons-pack/react-simple-icons";
import { kShort } from "@/lib/format";
import { useMenu } from "@/lib/useMenu";
import { cn } from "@/lib/utils";

// Bundled locally in public/img so the site works fully offline.
const IMG = {
  hero: "/img/hero.jpeg",
  bowls: "/img/bowls.jpeg",
  cups: "/img/cups.jpeg",
  potong: "/img/potong.jpeg",
};

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.5, ease: "easeOut" as const },
};

function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full bg-teal-pill/70 px-2.5 py-0.5 font-heading text-sm font-bold text-white", className)}>{children}</span>;
}

function OptionsBoard({ title, rows, testId }: { title: string; rows: { label: string; price: string }[]; testId: string }) {
  return (
    <div className="rounded-3xl border border-white/15 bg-white/10 p-5 backdrop-blur" data-testid={testId}>
      <div className="mb-3 inline-block rounded-full bg-white/20 px-4 py-1 font-heading font-bold text-white">{title}</div>
      <ul className="space-y-1.5 text-sm text-white/90">
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-4">
            <span>{r.label}</span>
            <span className="font-mono font-semibold text-zest">{r.price}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SoldOut() {
  return <span className="ml-1.5 rounded bg-destructive px-1.5 py-0.5 align-middle text-[10px] font-bold text-white not-italic">HABIS</span>;
}

const StoreCode = createContext<string>("");

/** Price pill that directs customers to self-checkout for the selected store. */
function WaPill({ item, disabled, children, className, testId }: { item: string; disabled?: boolean; children: React.ReactNode; className?: string; testId: string }) {
  const code = useContext(StoreCode);
  if (disabled || !code) return <Pill className={cn("opacity-50", className)}>{children}</Pill>;
  return (
    <Link
      to={`/m/${code}`}
      title={`Pesan ${item} via self-checkout`}
      data-testid={testId}
      className={cn(
        "inline-flex items-center rounded-full bg-teal-pill/70 px-2.5 py-0.5 font-heading text-sm font-bold text-white transition-[background-color,color,transform] duration-150 hover:bg-zest hover:text-teal-deep active:scale-95",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export default function Landing() {
  const pub = usePublicStores();
  const storeList = pub.isError ? [] : (pub.data ?? []);
  const [storeSel, setStoreSel] = useState<string | null>(null);
  const cur = storeList.find((x) => x.id === storeSel) ?? storeList[0];
  const { products, groups: rawGroups, categories } = useMenu(cur?.id);
  // Landing previews hardcode group ids (bowl_topping, ice, kuah, …); when a group is
  // absent from the DB (fresh install, demo seed), EVERY `groups.<id>.options` access
  // must degrade to an empty list instead of crashing the page.
  const groups = new Proxy(
    (rawGroups ?? {}) as Record<
      string,
      { options: { label: string; r: number; l?: number | null; soldOut?: boolean; tier?: string | null; default?: boolean }[] }
    >,
    { get: (t, k: string) => t[k] ?? { options: [] } },
  );
  // decorative fruit lists now derive from the live menu data (custom_fruit / potong_fruit groups)
  const potongFruits = (groups["potong_fruit"]?.options ?? []).map((o) => o.label);
  const cfOpts = groups["custom_fruit"]?.options ?? [];
  const fruitTiers = [...new Set(cfOpts.map((o) => o.tier).filter(Boolean) as string[])].map((tier) => ({
    tier,
    fruits: cfOpts.filter((o) => o.tier === tier).map((o) => o.label),
    price: cfOpts.find((o) => o.tier === tier)?.r ?? 0,
  }));
  const smoothies = products.filter((p) => p.category === "smoothie");
  const bowls = products.filter((p) => p.category === "bowl");
  const juices = products.filter((p) => p.category === "jus" && p.id !== "js-ekonomis");
  // Categories with no special layout (snack, sop & salad buah, and any category the owner added) get a simple price list.
  const BUILT_IN_TABS = ["smoothie", "bowl", "jus", "potong", "custom"];
  const catLabel = (id: string, fallback: string) => categories.find((c) => c.id === id)?.label ?? fallback; // follows renames made by the owner
  const extraTabs = categories.filter((c) => !BUILT_IN_TABS.includes(c.id) && products.some((p) => p.category === c.id));
  return (
    <StoreCode.Provider value={cur?.code ?? ""}>
    <div className="min-h-screen bg-teal-brand text-white" data-testid="landing-page">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-teal-deep/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <BrandMark />
          <div className="flex items-center gap-3">
            <a href="#menu" className="hidden text-sm font-semibold text-white/85 hover:text-white md:inline" data-testid="nav-link-menu">
              Menu
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 -left-32 size-[520px] rounded-full bg-teal-pill/40 blur-3xl" />
        <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8 lg:py-20">
          <motion.div className="lg:col-span-6" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <span className="inline-flex items-center gap-2 rounded-full bg-zest px-4 py-1.5 text-sm font-bold text-teal-deep">
              <Leaf className="size-4" /> Sehat itu mudah
            </span>
            <h1 className="mt-6 font-heading text-5xl leading-[0.95] font-black tracking-tight italic sm:text-6xl lg:text-7xl" data-testid="hero-title">
              Jus, smoothie
              <br />& buah potong
              <br />
              <span className="text-zest">segar tiap hari.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-white/85">
              Buah asli diblender di depan kamu: 12 smoothie, 8 smoothie bowl, 15 pilihan jus, buah potong custom, dan racikan buah favoritmu sendiri. Mulai dari{" "}
              <b className="text-zest">10K</b>.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#menu" className={cn(buttonVariants({ size: "lg" }), "h-12 rounded-full bg-zest px-7 text-base font-bold text-teal-deep hover:bg-white")} data-testid="hero-menu-cta">
                Lihat menu <ArrowRight />
              </a>
              <Link
                to={cur?.code ? `/m/${cur.code}` : "#menu"}
                className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-12 rounded-full border-white/40 bg-transparent px-7 text-base font-semibold text-white hover:bg-white/10 hover:text-white")}
                data-testid="hero-order-cta"
              >
                Pesan sekarang <ArrowRight />
              </Link>
            </div>
            <dl className="mt-10 grid max-w-md grid-cols-3 gap-4">
              {[
                ["12", "Smoothie"],
                ["8", "Smoothie bowl"],
                ["21", "Jenis buah"],
              ].map(([n, l]) => (
                <div key={l} className="border-l-2 border-zest/70 pl-3">
                  <dt className="font-heading text-3xl font-black italic">{n}</dt>
                  <dd className="text-xs tracking-wider text-white/70 uppercase">{l}</dd>
                </div>
              ))}
            </dl>
          </motion.div>

          <motion.div
            className="relative lg:col-span-6"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.1 }}
          >
            <div className="overflow-hidden rounded-[2.5rem] border-4 border-white/15 shadow-2xl shadow-black/30">
              <img src={IMG.hero} alt="Smoothie bowl buah naga dan smoothie NuBuah" className="aspect-[4/3] w-full object-cover" data-testid="hero-image" />
            </div>
            <div className="absolute -bottom-6 -left-4 animate-float-slow rounded-2xl bg-white px-4 py-3 text-teal-deep shadow-xl sm:-left-8">
              <div className="text-[11px] font-semibold tracking-wider uppercase opacity-70">Smoothie bowl</div>
              <div className="font-heading text-2xl font-black italic">mulai 29K</div>
            </div>
            <div className="absolute -top-5 right-4 rotate-6 rounded-full bg-zest px-4 py-2 font-heading font-black text-teal-deep italic shadow-lg">BDB · 14K</div>
          </motion.div>
        </div>
      </section>

      {/* Menu */}
      <section id="menu" className="scroll-mt-16 bg-teal-deep/40 py-16 lg:py-24" data-testid="menu-section">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <motion.div {...fadeUp} className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="text-sm font-semibold tracking-[0.2em] text-zest uppercase">Menu NuBuah</p>
              <h2 className="mt-2 font-heading text-4xl font-black tracking-tight italic sm:text-5xl">Pilih segarmu.</h2>
            </div>
            <p className="max-w-sm text-white/75">
              Harga dalam ribu Rupiah. R = Reguler 400 ml, L = Large 600 ml.{" "}
              <span className="font-semibold text-zest" data-testid="selfcheckout-order-hint">Ketuk harga untuk pesan online.</span>
              {storeList.length > 1 && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  Harga di
                  <select
                    value={cur?.id}
                    onChange={(e) => setStoreSel(e.target.value)}
                    className="rounded-full bg-white/15 px-3 py-1 font-semibold text-white outline-none [&>option]:text-teal-deep"
                    data-testid="landing-store-select"
                  >
                    {storeList.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </p>
          </motion.div>

          <Tabs defaultValue="smoothie" className="mt-10">
            <TabsList className="h-auto flex-wrap gap-1 rounded-full bg-white/10 p-1">
              {[
                ["smoothie", catLabel("smoothie", "Smoothie")],
                ["bowl", catLabel("bowl", "Smoothie Bowl")],
                ["jus", catLabel("jus", "Jus")],
                ["potong", catLabel("potong", "Buah Potong")],
                ["custom", catLabel("custom", "Custom")],
                ...extraTabs.map((c) => [c.id, c.label]),
              ].map(([v, l]) => (
                <TabsTrigger
                  key={v}
                  value={v}
                  className="rounded-full px-4 py-1.5 font-semibold text-white/80 data-[active]:bg-zest data-[active]:text-teal-deep data-[selected]:bg-zest data-[selected]:text-teal-deep"
                  data-testid={`menu-tab-${v}`}
                >
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Smoothie */}
            <TabsContent value="smoothie" className="mt-8">
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
                <div className="hidden overflow-hidden rounded-[2rem] lg:col-span-4 lg:block">
                  <img src={IMG.cups} alt="Deretan smoothie NuBuah" className="h-full w-full object-cover" />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-8">
                  {smoothies.map((p) => (
                    <div key={p.id} className="group flex gap-4 rounded-2xl bg-white/10 p-3 transition-colors duration-200 hover:bg-white/15" data-testid={`menu-item-${p.id}`}>
                      <div className="size-24 shrink-0 overflow-hidden rounded-xl ring-2 ring-white/15">
                        <MenuPhoto id={p.id} name={p.name} color={p.color} category="smoothie" photo={p.photo} className="size-full transition-transform duration-500 group-hover:scale-110" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-heading leading-tight font-bold italic">
                            <span className="mr-1 text-zest">{p.code}</span> {p.name}
                            {p.soldOut && <SoldOut />}
                          </div>
                        </div>
                        <div className="text-xs text-white/65">{p.desc}</div>
                        <div className="mt-1 text-xs font-semibold text-white/90">{p.benefit}</div>
                        <div className="mt-2 flex gap-1.5">
                          <WaPill item={`${p.code ? `${p.code} ` : ""}${p.name} (Regular)`} disabled={p.soldOut} testId={`wa-order-${p.id}-r`}>
                            R {kShort(p.r)}
                          </WaPill>
                          <WaPill item={`${p.code ? `${p.code} ` : ""}${p.name} (Large)`} disabled={p.soldOut} testId={`wa-order-${p.id}-l`}>
                            L {kShort(p.l ?? p.r)}
                          </WaPill>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            {/* Bowls */}
            <TabsContent value="bowl" className="mt-8">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {bowls.map((p, i) => (
                  <div
                    key={p.id}
                    className={cn("group flex items-center gap-4 rounded-3xl bg-white/10 p-4", i % 2 === 1 && "md:flex-row-reverse md:text-right")}
                    data-testid={`menu-item-${p.id}`}
                  >
                    <div className="size-28 shrink-0 overflow-hidden rounded-full ring-4 ring-white/20">
                      <MenuPhoto id={p.id} name={p.name} color={p.color} category="bowl" photo={p.photo} className="size-full transition-transform duration-500 group-hover:scale-110" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-heading text-xl leading-tight font-black italic">
                        {p.name} {p.code && <span className="text-base text-zest">({p.code})</span>}
                        {p.soldOut && <SoldOut />}
                      </div>
                      <div className="mt-1 text-xs text-white/70">{p.desc}</div>
                    </div>
                    <WaPill item={`Smoothie Bowl ${p.name}`} disabled={p.soldOut} className="shrink-0 px-3 py-1 text-lg" testId={`wa-order-${p.id}`}>
                      {kShort(p.r)}
                    </WaPill>
                  </div>
                ))}
              </div>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <OptionsBoard
                  title="Add Topping"
                  testId="bowl-topping-board"
                  rows={groups.bowl_topping.options.map((o) => ({ label: o.label, price: o.soldOut ? "habis" : `+${kShort(o.r)}` }))}
                />
                <OptionsBoard
                  title="Opsi Lainnya"
                  testId="bowl-options-board"
                  rows={groups.bowl_extra.options.map((o) => ({ label: o.label, price: o.soldOut ? "habis" : `${o.r > 0 ? "+" : ""}${kShort(o.r)}` }))}
                />
              </div>
            </TabsContent>

            {/* Jus */}
            <TabsContent value="jus" className="mt-8">
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
                <div className="lg:col-span-7" data-testid="jus-price-list">
                  <div className="mb-3 flex justify-between font-heading text-lg font-black italic">
                    <span>Single Jus</span>
                    <span>R / L</span>
                  </div>
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {juices.map((p) => (
                      <li key={p.id} className="group overflow-hidden rounded-2xl bg-white/10 transition-colors duration-200 hover:bg-white/15" data-testid={`menu-item-${p.id}`}>
                        <div className="relative aspect-square overflow-hidden">
                          <MenuPhoto id={p.id} name={p.name} color={p.color} category="jus" photo={p.photo} className="size-full transition-transform duration-500 group-hover:scale-110" />
                          <span className="absolute bottom-2 left-2 size-3 rounded-full ring-2 ring-white" style={{ background: p.color }} />
                        </div>
                        <div className="p-2.5">
                          <div className="font-heading text-sm leading-tight font-bold">
                            {p.name.replace(/^Jus /, "")}
                            {p.soldOut && <SoldOut />}
                          </div>
                          <div className="mt-1.5 flex gap-1.5">
                            <WaPill item={`${p.name} (Regular)`} disabled={p.soldOut} className="font-mono text-xs" testId={`wa-order-${p.id}-r`}>
                              {kShort(p.r)}
                            </WaPill>
                            <WaPill item={`${p.name} (Large)`} disabled={p.soldOut} className="font-mono text-xs" testId={`wa-order-${p.id}-l`}>
                              {kShort(p.l ?? p.r)}
                            </WaPill>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex items-center gap-4 rounded-2xl bg-zest/15 px-4 py-3 font-semibold text-zest italic">
                    <img src="/img/menu/js-ekonomis.webp" alt="Jus Ekonomis" loading="lazy" className="size-14 shrink-0 rounded-xl object-cover" data-testid="menu-photo-js-ekonomis" />
                    <span className="flex-1">
                      Jus Ekonomis bebas pilih satu buah
                      <span className="block text-xs font-normal text-zest/80 not-italic">porsi buah lebih dikit</span>
                    </span>
                    <span className="font-heading text-xl font-black">10K / 13K</span>
                  </div>
                </div>
                <div className="space-y-4 lg:col-span-5">
                  <OptionsBoard
                    title="Level Manis"
                    testId="sweet-board"
                    rows={groups.sweet.options.map((o) => ({ label: o.label, price: "0K" }))}
                  />
                  <OptionsBoard
                    title="Es"
                    testId="ice-board"
                    rows={groups.ice.options.map((o) => ({ label: o.label, price: o.soldOut ? "habis" : o.r > 0 ? `+${kShort(o.r)}` : "0K" }))}
                  />
                  <OptionsBoard
                    title="Opsi Lainnya · R / L"
                    testId="drink-options-board"
                    rows={groups.drink_extra.options.map((o) => ({ label: o.label, price: o.soldOut ? "habis" : `+${kShort(o.r)} / ${kShort(o.l ?? o.r)}` }))}
                  />
                </div>
              </div>
            </TabsContent>

            {/* Buah potong */}
            <TabsContent value="potong" className="mt-8">
              <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
                <div>
                  <h3 className="font-heading text-4xl font-black italic">Buah Potong</h3>
                  <p className="mt-2 text-xl font-semibold">
                    Bisa custom dadakan.
                    <br />
                    <span className="text-zest">11K</span> = max 4 macam · <span className="text-zest">16K</span> = lebih dari 4 macam
                  </p>
                  <div className="mt-6 flex flex-wrap gap-2" data-testid="potong-fruit-list">
                    {potongFruits.map((f) => (
                      <span key={f} className="rounded-full bg-white/15 px-3 py-1 text-sm font-medium">
                        {f}
                      </span>
                    ))}
                  </div>
                  <div className="mt-6">
                    <OptionsBoard
                      title="Tambahan"
                      testId="potong-extra-board"
                      rows={groups.potong_extra.options.map((o) => ({ label: o.label, price: o.soldOut ? "habis" : `+${kShort(o.r)}` }))}
                    />
                    <WaPill item="Buah Potong (sebutkan buahnya)" className="mt-4 px-4 py-1.5" testId="wa-order-buah-potong">
                      Pesan buah potong online
                    </WaPill>
                  </div>
                </div>
                <div className="overflow-hidden rounded-[2rem] border-4 border-white/10">
                  <img src={IMG.potong} alt="Buah potong NuBuah" className="aspect-square w-full object-cover" />
                </div>
              </div>
            </TabsContent>

            {/* Custom */}
            <TabsContent value="custom" className="mt-8">
              <h3 className="font-heading text-3xl font-black italic">Cara Custom Jus / Smoothie</h3>
              <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="rounded-3xl bg-white/10 p-5 lg:col-span-3" data-testid="custom-step-1">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <Pill className="bg-white text-teal-deep">Step 1</Pill>
                    <span className="font-semibold">Pilih 1–3 buah favoritmu untuk satu porsi</span>
                    <span className="text-sm text-white/70">Satu buah aja? Bisa, harga buah dikali 3.</span>
                  </div>
                  <div className="mt-4 space-y-2">
                    {fruitTiers.map((t) => (
                      <div key={t.tier} className="flex flex-wrap items-center gap-3 rounded-full bg-white/10 px-5 py-2.5">
                        <span className="w-32 font-heading font-bold">{t.tier.split(" · ")[0]}</span>
                        <span className="flex-1 text-sm text-white/85">{t.fruits.join(" · ")}</span>
                        <span className="font-heading text-lg font-black text-zest">{kShort(t.price)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-3xl bg-white/10 p-5" data-testid="custom-step-2">
                  <Pill className="bg-white text-teal-deep">Step 2</Pill>
                  <p className="mt-2 font-semibold">Mau diolah jadi apa?</p>
                  <ul className="mt-3 space-y-1.5 text-sm">
                    <li className="flex justify-between">
                      <span>Jus Reguler 400 ml</span>
                      <b className="text-zest">+3K</b>
                    </li>
                    <li className="flex justify-between">
                      <span>Jus Large 600 ml</span>
                      <b className="text-zest">+6K</b>
                    </li>
                    <li className="flex justify-between">
                      <span>Smoothie Bowl Reguler</span>
                      <b className="text-zest">+9K</b>
                    </li>
                    <li className="flex justify-between">
                      <span>Topping bowl / item</span>
                      <b className="text-zest">1K</b>
                    </li>
                  </ul>
                  <p className="mt-3 text-xs text-white/65">Es: no ice, less ice, normal ice</p>
                </div>
                <div className="rounded-3xl bg-white/10 p-5" data-testid="custom-step-3">
                  <Pill className="bg-white text-teal-deep">Step 3</Pill>
                  <p className="mt-2 font-semibold">Atur rasanya</p>
                  <p className="mt-3 text-sm text-white/80">Level manis: no / less / normal / extra sugar (0K). Plus yogurt, yakult, madu, stevia, susu UHT, atau air kelapa.</p>
                </div>
                <div className="rounded-3xl bg-zest p-5 text-teal-deep" data-testid="custom-example">
                  <div className="flex items-center gap-2 font-heading text-lg font-black italic">
                    <Sparkles className="size-5" /> Contoh
                  </div>
                  <p className="mt-2 text-sm">Pisang 3K + Strawberry 4K + Naga 4K + Jus [R] 3K = <b>14K</b></p>
                  <p className="mt-2 text-sm">Pisang 3K + Strawberry 4K + Naga 4K + Smoothie Bowl 9K + 6 topping 6K = <b>26K</b></p>
                </div>
              </div>
            </TabsContent>

            {/* Other categories: snack, sop & salad buah, owner-made ones */}
            {extraTabs.map((c) => {
              const items = products.filter((p) => p.category === c.id);
              const sections = [...new Set(items.map((p) => p.section ?? ""))];
              return (
                <TabsContent key={c.id} value={c.id} className="mt-8" data-testid={`menu-tab-content-${c.id}`}>
                  <h3 className="font-heading text-3xl font-black italic">{c.label}</h3>
                  {c.blurb && <p className="mt-1 text-white/75">{c.blurb}</p>}
                  <div className="mt-6 space-y-8">
                    {sections.map((sec) => (
                      <div key={sec || "_"}>
                        {sec && <div className="mb-3 font-heading text-lg font-black italic text-zest">{sec}</div>}
                        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                          {items
                            .filter((p) => (p.section ?? "") === sec)
                            .map((p) => (
                              <li key={p.id} className="overflow-hidden rounded-2xl bg-white/10 p-3 transition-colors duration-200 hover:bg-white/15" data-testid={`menu-item-${p.id}`}>
                                <div className="flex items-center gap-2">
                                  <span className="size-3 shrink-0 rounded-full ring-2 ring-white" style={{ background: p.color }} />
                                  <div className="font-heading text-sm leading-tight font-bold">
                                    {sec && p.name.startsWith(sec) ? p.name.slice(sec.length).trim() || p.name : p.name}
                                    {p.soldOut && <SoldOut />}
                                  </div>
                                </div>
                                {p.desc && !p.desc.startsWith("Rasa ") && <div className="mt-1 text-xs text-white/70">{p.desc}</div>}
                                <div className="mt-2 flex gap-1.5">
                                  <WaPill item={`${p.name}${p.sizes ? " (Regular)" : ""}`} disabled={p.soldOut} className="font-mono text-xs" testId={`wa-order-${p.id}${p.sizes ? "-r" : ""}`}>
                                    {kShort(p.r)}
                                  </WaPill>
                                  {p.sizes && (
                                    <WaPill item={`${p.name} (Large)`} disabled={p.soldOut} className="font-mono text-xs" testId={`wa-order-${p.id}-l`}>
                                      {kShort(p.l ?? p.r)}
                                    </WaPill>
                                  )}
                                </div>
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                  {c.id === "sopsalad" && groups.kuah && (
                    <div className="mt-6 max-w-sm">
                      <OptionsBoard title="Pilihan Kuah" testId="kuah-board" rows={groups.kuah.options.map((o) => ({ label: o.label, price: o.soldOut ? "habis" : o.r > 0 ? `+${kShort(o.r)}` : "0K" }))} />
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </div>
      </section>

      {/* Story strip */}
      <section className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-12 lg:px-8 lg:py-24">
        <motion.div {...fadeUp} className="overflow-hidden rounded-[2rem] lg:col-span-5">
          <img src={IMG.bowls} alt="Empat smoothie bowl NuBuah" className="aspect-square w-full object-cover" />
        </motion.div>
        <motion.div {...fadeUp} className="lg:col-span-6 lg:col-start-7">
          <p className="text-sm font-semibold tracking-[0.2em] text-zest uppercase">Kenapa NuBuah</p>
          <h2 className="mt-2 font-heading text-4xl font-black tracking-tight italic">Sehat itu mudah, kalau buahnya enak.</h2>
          <ul className="mt-6 space-y-4 text-white/85">
            <li>
              <b className="text-white">Buah asli, porsi jujur.</b> Setiap gelas dan bowl dibuat dari buah segar, tanpa sirup perasa.
            </li>
            <li>
              <b className="text-white">Atur sesukamu.</b> Level manis, es, ganti gula ke madu atau stevia, ganti air ke susu atau air kelapa.
            </li>
            <li>
              <b className="text-white">Harga bersahabat.</b> Jus mulai 10K, smoothie mulai 13K, bowl mulai 29K.
            </li>
          </ul>
          <Link to={cur?.code ? `/m/${cur.code}` : "#menu"} className={cn(buttonVariants({ size: "lg" }), "mt-8 h-12 rounded-full bg-zest px-7 font-bold text-teal-deep hover:bg-white")} data-testid="story-order-cta">
            Pesan online <ArrowRight />
          </Link>
        </motion.div>
      </section>

      {/* Visit */}
      <section className="border-t border-white/10 bg-teal-deep/40" data-testid="visit-section">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-4 py-14 sm:px-6 lg:grid-cols-12 lg:px-8">
          <div className="lg:col-span-5">
            <p className="text-sm font-semibold tracking-[0.2em] text-zest uppercase">Mampir ke NuBuah</p>
            <h2 className="mt-2 font-heading text-4xl font-black tracking-tight italic">{storeList.length > 1 ? `${storeList.length} toko, satu rasa.` : "Cimahi, Jawa Barat."}</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-7 xl:grid-cols-3">
            {(storeList.length ? storeList : [{ id: "default", name: "NuBuah Cimahi", code: "NB", address_lines: STORE.addressLines, phone: STORE.phone }]).map((x) => (
              <div key={x.id} className="rounded-3xl bg-white/10 p-5" data-testid={`visit-store-${x.code}`}>
                <MapPin className="size-6 text-zest" />
                <div className="mt-3 font-heading font-bold">{x.name}</div>
                <address className="mt-1 text-sm leading-relaxed text-white/80 not-italic" data-testid="store-address">
                  {x.address_lines.map((l) => (
                    <span key={l} className="block">
                      {l}
                    </span>
                  ))}
                </address>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
                  <a href={mapsLink(x.address_lines)} target="_blank" rel="noreferrer" className="text-zest hover:underline" data-testid="store-address-link">
                    Maps
                  </a>
                  {x.phone && (
                    <a href={`https://wa.me/${waNumber(x.phone)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zest hover:underline" data-testid="store-phone-link">
                      <MessageCircle className="size-4" /> <span data-testid="store-phone">{x.phone}</span>
                    </a>
                  )}
                </div>
              </div>
            ))}
            <a
              href={STORE.instagram}
              target="_blank"
              rel="noreferrer"
              className="group rounded-3xl bg-white/10 p-5 transition-colors duration-200 hover:bg-white/15"
              data-testid="store-instagram-link"
            >
              <SiInstagram size={24} color="#FFE81A" />
              <div className="mt-3 font-heading font-bold">Instagram</div>
              <div className="mt-1 font-heading text-xl font-black italic" data-testid="store-instagram">
                {STORE.instagramHandle}
              </div>
              <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-zest">
                Lihat promo <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-1" />
              </span>
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-teal-deep py-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
          <BrandMark />
          <p className="max-w-sm text-sm text-white/60" data-testid="footer-address">
            {STORE.addressLines.join(", ")} · {STORE.phone}
          </p>
          <div className="flex items-center gap-4 text-sm">
            <a href={STORE.instagram} target="_blank" rel="noreferrer" aria-label="Instagram NuBuah" className="text-white/80 hover:text-zest" data-testid="footer-link-instagram">
              <SiInstagram size={18} />
            </a>
            <a href={STORE.whatsapp} target="_blank" rel="noreferrer" aria-label="WhatsApp NuBuah" className="text-white/80 hover:text-zest" data-testid="footer-link-whatsapp">
              <MessageCircle className="size-[18px]" />
            </a>
            {cur?.code && (
              <Link to={`/m/${cur.code}`} className="text-white/80 hover:text-zest" data-testid="footer-link-selfcheckout">
                Pesan online
              </Link>
            )}
          </div>
        </div>
      </footer>
    </div>
    </StoreCode.Provider>
  );
}
