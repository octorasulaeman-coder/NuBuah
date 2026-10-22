// The fully data-driven menu: one bundle from the backend (menu_products / menu_groups /
// menu_options / menu_categories + per-store overrides). menu.ts is no longer read at
// runtime — everything the owner edits in Kelola Menu flows straight through.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { MenuBundle } from "@/lib/types";

export interface Product {
  id: string;
  code: string;
  name: string;
  desc: string;
  benefit: string;
  emoji: string | null;
  img: string | null;
  photo: string | null; // resolved display URL: uploaded media, else static path, else null
  category: string;
  section: string;
  sizes: boolean;
  pricing: "fixed" | "potong" | "custom";
  r: number;
  l: number | null;
  groups: string[]; // resolved option-group ids (category defaults + attached topping groups)
  color: string;
  soldOut: boolean;
  overridden: boolean;
  hidden: boolean;
  builtin: boolean;
  imgId: string | null;
}

export interface MenuOption {
  id: string;
  label: string;
  r: number;
  l: number | null;
  soldOut: boolean;
  tier?: string | null;
  default?: boolean;
}

export interface OptionGroup {
  id: string;
  label: string;
  type: "single" | "multi";
  min: number;
  max: number | null;
  hint: string;
  product_ids: string[];
  options: MenuOption[];
}

export type Groups = Record<string, OptionGroup>;
export interface Category {
  id: string;
  label: string;
  blurb: string;
  color: string;
  builtin: boolean;
}

// category default option groups (mirrors the backend fallback)
const CATEGORY_DEFAULT_GROUPS: Record<string, string[]> = {
  smoothie: ["sweet", "ice", "drink_extra"],
  jus: ["sweet", "ice", "drink_extra"],
  bowl: ["bowl_topping", "bowl_extra"],
  sopsalad: ["kuah"],
  snack: [],
};

export function defaultGroupsFor(category: string): string[] {
  return CATEGORY_DEFAULT_GROUPS[category] ?? [];
}

// Editor-facing product row: current effective values plus the original row and
// flags used by MenuEditor for reset/edited/custom display.
export interface LiveProduct extends Product {
  base: Product;
  orig: Product;
  custom: boolean;
  edited: boolean;
}

export function useMenu(storeId: string | null) {
  const q = useQuery({
    queryKey: ["menu-bundle", storeId],
    queryFn: () => apiGet<MenuBundle>(`/public/bundle?store_id=${storeId}`), // public: landing + POS + customer page share it
    enabled: !!storeId,
    staleTime: 10_000,
  });
  const bundle = q.data;

  const categories = useMemo<Category[]>(() => (bundle?.menu_categories ?? []).map((c) => ({ ...c })), [bundle]);

  const groups = useMemo<Groups>(() => {
    const g: Groups = {};
    for (const row of bundle?.menu_groups ?? []) {
      g[row.id] = {
        id: row.id,
        label: row.label,
        type: row.type,
        min: row.min ?? 0,
        max: row.max ?? null,
        hint: row.hint ?? "",
        product_ids: row.product_ids ?? [],
        options: [],
      };
    }
    const optOv = new Map((bundle?.option_overrides ?? []).map((o) => [`${o.group_id}/${o.option_id}`, o]));
    for (const row of bundle?.menu_options ?? []) {
      const group = g[row.group_id];
      if (!group) continue;
      const ov = optOv.get(`${row.group_id}/${row.id}`);
      group.options.push({
        id: row.id,
        label: row.label,
        r: ov?.r ?? row.r,
        l: ov && ov.l != null ? ov.l : row.l,
        soldOut: !!ov?.sold_out,
        tier: row.tier,
        default: row.default,
      });
    }
    return g;
  }, [bundle]);

  const allGroups = groups; // hidden options are already merged; editor uses the same map

  const allProducts = useMemo<LiveProduct[]>(() => {
    const ov = new Map((bundle?.menu_overrides ?? []).map((o) => [o.product_id, o]));
    const productEdits = new Map(
      (bundle?.edits ?? [])
        .filter((e) => e.kind === "product")
        .map((e) => [e.key, e]),
    );
    const codes = bundle?.codes ?? {};
    return (bundle?.menu_products ?? []).map((p) => {
      const o = ov.get(p.id);
      const e = productEdits.get(p.id);
      const own = p.groups ?? defaultGroupsFor(p.category);
      // groups attached via product_ids (topping groups that offer themselves on listed items)
      const attached = (bundle?.menu_groups ?? [])
        .filter((g) => g.product_ids?.includes(p.id) && !own.includes(g.id))
        .map((g) => g.id);

      const base: Product = {
        id: p.id,
        code: codes[p.id] ?? p.code ?? "",
        name: p.name,
        desc: p.desc,
        benefit: p.benefit,
        emoji: p.emoji,
        img: p.img,
        photo: p.img_id ? `/api/media/${p.img_id}` : p.img,
        category: p.category,
        section: p.section,
        sizes: p.sizes,
        pricing: p.pricing,
        r: p.r,
        l: p.l,
        groups: own.filter((gid) => !!groups[gid]),
        color: p.color,
        soldOut: false,
        overridden: false,
        hidden: false,
        builtin: p.builtin,
        imgId: p.img_id,
      };

      return {
        ...base,
        name: e?.name ?? base.name,
        desc: e?.desc ?? base.desc,
        category: e?.category ?? base.category,
        section: e?.section ?? base.section,
        color: e?.color ?? base.color,
        r: o?.r ?? base.r,
        l: o && o.l != null ? o.l : base.l,
        groups: [...base.groups, ...attached].filter((gid) => !!groups[gid]),
        soldOut: !!o?.sold_out,
        overridden: !!o && (o.r != null || o.l != null),
        hidden: !!o?.hidden,
        base,
        orig: base,
        custom: !p.builtin,
        edited: !!e,
      };
    });
  }, [bundle, groups]);

  const products = useMemo(() => allProducts.filter((p) => !p.hidden), [allProducts]);

  const optionOverridden = useMemo(
    () => new Set((bundle?.option_overrides ?? []).map((o) => `${o.group_id}/${o.option_id}`)),
    [bundle],
  );

  return {
    products,
    allProducts,
    categories,
    customCategories: (bundle?.menu_categories ?? []).filter((c) => !c.builtin),
    customGroups: (bundle?.menu_groups ?? []).filter((g) => !g.builtin),
    groups,
    allGroups,
    optionOverridden,
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}
