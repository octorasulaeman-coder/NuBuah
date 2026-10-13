import type { Groups, MenuOption, Product } from "@/data/menu";
import type { OrderLineIn, OrderLineOption } from "@/lib/types";

export type Size = "R" | "L";

export interface Selection {
  size: Size | null;
  picks: Record<string, string[]>; // group id -> option ids (in pick order)
  qty: number;
  note: string;
}

export function defaultSelection(p: Product, groups: Groups): Selection {
  const picks: Record<string, string[]> = {};
  for (const gid of p.groups) {
    // Menu data can contain stale references to a deleted or not-yet-loaded group.
    // Keep the dialog usable instead of crashing while initializing selection.
    const group = groups[gid];
    picks[gid] = (group?.options ?? []).filter((o) => o.default && !o.soldOut).map((o) => o.id);
  }
  return { size: p.sizes ? "R" : null, picks, qty: 1, note: "" };
}

const optPrice = (o: MenuOption, size: Size | null) => (size === "L" ? (o.l ?? o.r) : o.r);

export function isValid(p: Product, sel: Selection, groups: Groups): boolean {
  return p.groups.every((gid) => {
    const g = groups[gid];
    // Ignore stale group IDs; the UI also omits unavailable groups.
    if (!g) return true;
    const n = sel.picks[gid]?.length ?? 0;
    return n >= g.min && (g.max === undefined || n <= g.max);
  });
}

export function lineName(p: Product, sel: Selection): string {
  if (p.pricing === "potong") {
    const n = sel.picks.potong_fruit?.length ?? 0;
    return n <= 1 ? "Single Buah Potong" : n > 4 ? "Mix Buah Potong Spesial" : "Mix Buah Potong";
  }
  return p.name;
}

/** Unit price + receipt option rows for a configured product. */
export function priceLine(p: Product, sel: Selection, groups: Groups): { unit: number; options: OrderLineOption[] } {
  let unit = p.sizes && sel.size === "L" ? (p.l ?? p.r) : p.r;
  const options: OrderLineOption[] = [];

  if (p.pricing === "potong") {
    const n = sel.picks.potong_fruit?.length ?? 0;
    unit = n > 4 ? (p.l ?? p.r) : p.r;
  }

  for (const gid of p.groups) {
    const g = groups[gid];
    // A product can retain a group ID after that group has been removed.
    if (!g) continue;
    const ids = sel.picks[gid] ?? [];
    const chosen = ids.map((id) => (g.options ?? []).find((o) => o.id === id)).filter((o): o is MenuOption => !!o);

    if (gid === "custom_fruit") {
      // 1 fruit = price x3; 2 fruits = first picked x2 + second; 3 fruits = sum.
      const mult = chosen.length === 1 ? [3] : chosen.length === 2 ? [2, 1] : [1, 1, 1];
      chosen.forEach((o, i) => {
        const price = o.r * (mult[i] ?? 1);
        unit += price;
        options.push({ label: mult[i] > 1 ? `${o.label} x${mult[i]}` : o.label, price });
      });
      continue;
    }

    for (const o of chosen) {
      const price = optPrice(o, sel.size);
      unit += price;
      options.push({ label: o.label, price });
    }
  }
  return { unit: Math.max(0, unit), options };
}

export function toOrderLine(p: Product, sel: Selection, groups: Groups): OrderLineIn {
  const { unit, options } = priceLine(p, sel, groups);
  return {
    product_id: p.id,
    name: lineName(p, sel),
    code: p.code ?? null,
    size: p.sizes ? sel.size : null,
    options,
    note: sel.note.trim() || null,
    unit_price: unit,
    qty: sel.qty,
  };
}
