import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CATEGORIES, GROUPS, PRODUCTS, type Groups, type MenuOption, type OptionGroup, type Product } from "@/data/menu";
import { apiGet } from "@/lib/api";
import type { CustomCategory, CustomGroup, CustomOption, CustomProduct, MenuEdit, MenuOverride, OptionOverride } from "@/lib/types";

export interface LiveProduct extends Product {
  soldOut: boolean;
  overridden: boolean;
  hidden: boolean;
  custom: boolean; // added from inside the app (stored in MongoDB), not from data/menu.ts
  base: Product; // the item before any price override (but after the owner's edits)
  edited: boolean; // the owner changed this built-in item's name, description, category, ...
  orig: Product; // how the item is built in, for "restore"
}

const DRINK_GROUPS = ["sweet", "ice", "drink_extra"];

/** Option groups an added item offers when the owner did not pick any: drinks and bowls as before, other categories none. */
export function defaultGroupsFor(category: string): string[] {
  if (category === "smoothie" || category === "jus") return DRINK_GROUPS;
  if (category === "bowl") return ["bowl_topping", "bowl_extra"];
  if (category === "sopsalad") return ["kuah"];
  return [];
}

function fromCustom(c: CustomProduct): Product {
  return {
    id: c.id,
    code: c.code || undefined,
    name: c.name,
    category: c.category,
    section: c.section || undefined,
    desc: c.desc,
    benefit: c.benefit || undefined,
    color: c.color,
    sizes: c.category !== "bowl" && c.l != null,
    r: c.r,
    l: c.category !== "bowl" && c.l != null ? c.l : undefined,
    pricing: "fixed",
    groups: c.groups ?? defaultGroupsFor(c.category),
  };
}

/** Static menu merged with one store's price / sold-out overrides. Falls back to the static menu offline. */
export function useMenu(storeId?: string | null) {
  const qs = storeId ? `?store_id=${storeId}` : "";
  const q = useQuery({ queryKey: ["menu-overrides", storeId ?? "default"], queryFn: () => apiGet<MenuOverride[]>(`/menu/overrides${qs}`) });
  const oq = useQuery({ queryKey: ["menu-option-overrides", storeId ?? "default"], queryFn: () => apiGet<OptionOverride[]>(`/menu/option-overrides${qs}`) });
  const cq = useQuery({ queryKey: ["custom-products"], queryFn: () => apiGet<CustomProduct[]>("/menu/custom-products") });
  const customProducts = cq.isError ? undefined : cq.data;
  const codeQ = useQuery({ queryKey: ["menu-codes"], queryFn: () => apiGet<Record<string, string>>("/menu/codes") });
  const codes = codeQ.isError ? undefined : codeQ.data;
  const ccq = useQuery({ queryKey: ["custom-categories"], queryFn: () => apiGet<CustomCategory[]>("/menu/custom-categories") });
  const customCategories = ccq.isError ? undefined : ccq.data;
  const eq = useQuery({ queryKey: ["menu-edits"], queryFn: () => apiGet<MenuEdit[]>("/menu/edits") });
  const edits = eq.isError ? undefined : eq.data;
  const cgq = useQuery({ queryKey: ["custom-groups"], queryFn: () => apiGet<CustomGroup[]>("/menu/custom-groups") });
  const customGroups = cgq.isError ? undefined : cgq.data;
  const cox = useQuery({ queryKey: ["custom-options"], queryFn: () => apiGet<CustomOption[]>("/menu/custom-options") });
  const customOptions = cox.isError ? undefined : cox.data;
  const overrides = q.isError ? undefined : q.data;
  const optionOverrides = oq.isError ? undefined : oq.data;

  // allGroups includes hidden options (the menu editor needs them); groups is what the order screen shows.
  const allGroups = useMemo<Groups>(() => {
    const map = new Map((optionOverrides ?? []).map((o) => [`${o.group_id}/${o.option_id}`, o]));
    const optEdits = new Map((edits ?? []).filter((e) => e.kind === "option").map((e) => [e.key, e]));
    const grpEdits = new Map((edits ?? []).filter((e) => e.kind === "group").map((e) => [e.key, e]));
    const withOverrides = (gid: string, opts: MenuOption[]) =>
      opts.map((opt0) => {
        const oe = optEdits.get(`${gid}/${opt0.id}`);
        const opt: MenuOption = oe?.name ? { ...opt0, label: oe.name, edited: true, origLabel: opt0.label } : opt0;
        const o = map.get(`${gid}/${opt.id}`);
        if (!o) return opt;
        return { ...opt, r: o.r ?? opt.r, l: opt.l === undefined ? undefined : (o.l ?? opt.l), soldOut: o.sold_out, hidden: !!o.hidden };
      });
    const added = (gid: string) =>
      (customOptions ?? [])
        .filter((c) => c.group_id === gid)
        .map((c): MenuOption => ({ id: c.id, label: c.label, r: c.r, l: c.l ?? undefined, custom: true, base: { r: c.r, l: c.l ?? undefined } }));

    const out: Groups = Object.fromEntries(
      Object.entries(GROUPS).map(([gid, g]) => {
        const ge = grpEdits.get(gid);
        return [gid, { ...g, ...(ge?.name ? { label: ge.name, edited: true, origLabel: g.label } : {}), options: withOverrides(gid, [...g.options, ...added(gid)]) }];
      }),
    );
    // Topping groups the owner created: pick one (required) or pick many (optional).
    for (const cg of customGroups ?? []) {
      const single = cg.type === "single";
      out[cg.id] = { id: cg.id, label: cg.label, type: cg.type, min: single ? 1 : 0, max: single ? 1 : undefined, options: withOverrides(cg.id, added(cg.id)) } as OptionGroup;
    }
    return out;
  }, [optionOverrides, customOptions, customGroups, edits]);

  const groups = useMemo<Groups>(
    () =>
      Object.fromEntries(
        Object.entries(allGroups).map(([gid, g]) => {
          const options = g.options.filter((o) => !o.hidden);
          if (gid.startsWith("cx-") && g.type === "single") {
            // a required pick-one group starts on its first available option
            const first = options.findIndex((o) => !o.soldOut);
            return [gid, { ...g, options: options.map((o, i) => ({ ...o, default: i === first })) }];
          }
          return [gid, { ...g, options }];
        }),
      ),
    [allGroups],
  );

  // allProducts includes hidden items (the menu editor needs them); products is what the POS and landing page show.
  const allProducts = useMemo<LiveProduct[]>(() => {
    const map = new Map((overrides ?? []).map((o) => [o.product_id, o]));
    const customIds = new Set((customProducts ?? []).map((c) => c.id));
    // custom groups only show on an item when there is something to pick (otherwise a required group would block ordering)
    const usable = (customGroups ?? []).filter((cg) => groups[cg.id]?.options.some((o) => !o.soldOut));
    const prodEdits = new Map((edits ?? []).filter((e) => e.kind === "product").map((e) => [e.key, e]));
    return [...PRODUCTS, ...(customProducts ?? []).map(fromCustom)].map((p0) => {
      // The code the owner set (or gave an added item) wins over the built-in default.
      const withCode: Product = codes?.[p0.id] ? { ...p0, code: codes[p0.id] } : p0;
      // Owner edits to a built-in item (name, description, category, ...) sit on top of the built-in values.
      const pe = prodEdits.get(p0.id);
      const p: Product = pe
        ? {
            ...withCode,
            name: pe.name ?? withCode.name,
            desc: pe.desc ?? withCode.desc,
            benefit: pe.benefit !== undefined ? pe.benefit || undefined : withCode.benefit,
            category: pe.category ?? withCode.category,
            section: pe.section !== undefined ? pe.section || undefined : withCode.section,
            color: pe.color ?? withCode.color,
          }
        : withCode;
      const custom = customIds.has(p.id);
      const extra = usable.filter((cg) => cg.product_ids.includes(p.id)).map((cg) => cg.id);
      // Keep only group IDs that currently exist, then append assigned custom groups once.
      // This prevents stale IDs stored on custom products from crashing checkout.
      const withGroups = (x: Product): Product => ({
        ...x,
        groups: [...new Set([...x.groups.filter((gid) => !!groups[gid]), ...extra.filter((gid) => !!groups[gid])])],
      });
      const o = map.get(p.id);
      if (!o) return { ...withGroups(p), soldOut: false, overridden: false, hidden: false, custom, base: p, edited: !!pe, orig: withCode };
      return { ...withGroups(p), r: o.r ?? p.r, l: p.l === undefined ? undefined : (o.l ?? p.l), soldOut: o.sold_out, overridden: true, hidden: !!o.hidden, custom, base: p, edited: !!pe, orig: withCode };
    });
  }, [overrides, customProducts, codes, customGroups, groups, edits]);

  const products = useMemo(() => allProducts.filter((p) => !p.hidden), [allProducts]);

  const optionOverridden = useMemo(() => new Set((optionOverrides ?? []).map((o) => `${o.group_id}/${o.option_id}`)), [optionOverrides]);

  // Built-in categories plus the ones the owner created in the app.
  const categories = useMemo(() => {
    const ce = new Map((edits ?? []).filter((e) => e.kind === "category").map((e) => [e.key, e]));
    const builtIn = CATEGORIES.map((c) => {
      const e = ce.get(c.id);
      return { id: c.id, label: e?.name ?? c.label, blurb: e?.desc ?? c.blurb, builtin: true, edited: !!e, origLabel: c.label, origBlurb: c.blurb };
    });
    const own = (customCategories ?? []).map((c) => ({ id: c.id, label: c.label, blurb: c.blurb, builtin: false, edited: false, origLabel: c.label, origBlurb: c.blurb }));
    return [...builtIn, ...own];
  }, [customCategories, edits]);

  return { products, allProducts, categories, customCategories: customCategories ?? [], customGroups: customGroups ?? [], groups, allGroups, optionOverridden, isLoading: q.isLoading };
}
