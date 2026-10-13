import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MenuPhoto from "@/components/MenuPhoto";
import { type Groups, type MenuOption, type OptionGroup, type Product } from "@/data/menu";
import { defaultSelection, isValid, lineName, priceLine, toOrderLine, type Selection, type Size } from "@/lib/pricing";
import { kShort, rupiah } from "@/lib/format";
import type { OrderLineIn } from "@/lib/types";
import { cn } from "@/lib/utils";

function Chip({
  active,
  disabled,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-95 disabled:opacity-40",
        active ? "border-teal-brand bg-teal-brand text-white" : "border-border bg-white text-teal-deep hover:border-teal-brand/60",
      )}
    >
      {children}
    </button>
  );
}

function optPriceLabel(o: MenuOption, size: Size | null) {
  const p = size === "L" ? (o.l ?? o.r) : o.r;
  if (!p) return null;
  return <span className="font-mono text-xs opacity-80">{p > 0 ? "+" : ""}{kShort(p)}</span>;
}

function GroupPicker({ group, sel, onToggle }: { group: OptionGroup; sel: Selection; onToggle: (g: OptionGroup, o: MenuOption) => void }) {
  const picked = sel.picks[group.id] ?? [];
  const full = group.max !== undefined && picked.length >= group.max && group.type === "multi";
  const tiers = [...new Set(group.options.map((o) => o.tier ?? ""))];
  return (
    <section className="space-y-2" data-testid={`group-${group.id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-heading text-sm font-bold text-teal-deep">
          {group.label}
          {group.min > 0 && <span className="ml-1 text-destructive">*</span>}
        </h4>
        {group.hint && <span className="text-xs text-muted-foreground">{group.hint}</span>}
      </div>
      {tiers.map((tier) => (
        <div key={tier || "all"} className="space-y-1.5">
          {tier && <div className="text-[11px] font-semibold uppercase tracking-wider text-teal-brand">{tier}</div>}
          <div className="flex flex-wrap gap-2">
            {group.options
              .filter((o) => (o.tier ?? "") === tier)
              .map((o) => {
                const active = picked.includes(o.id);
                return (
                  <Chip
                    key={o.id}
                    active={active}
                    disabled={!active && (full || !!o.soldOut)}
                    onClick={() => onToggle(group, o)}
                    testId={`option-${group.id}-${o.id}`}
                  >
                    {group.id === "custom_fruit" && active && (
                      <span className="grid size-4 place-items-center rounded-full bg-zest text-[10px] font-bold text-teal-deep">{picked.indexOf(o.id) + 1}</span>
                    )}
                    {o.label}
                    {o.soldOut ? <span className="text-[10px] font-bold text-destructive uppercase">habis</span> : group.id !== "custom_fruit" && optPriceLabel(o, sel.size)}
                  </Chip>
                );
              })}
          </div>
        </div>
      ))}
    </section>
  );
}

export default function ItemDialog({
  product,
  groups,
  onClose,
  onAdd,
}: {
  product: Product;
  groups: Groups;
  onClose: () => void;
  onAdd: (line: OrderLineIn) => void;
}) {
  const [sel, setSel] = useState<Selection>(() => defaultSelection(product, groups));
  const { unit } = priceLine(product, sel, groups);
  const valid = isValid(product, sel, groups);

  const toggle = (g: OptionGroup, o: MenuOption) =>
    setSel((s) => {
      const cur = s.picks[g.id] ?? [];
      let next: string[];
      if (g.type === "single") next = cur.includes(o.id) && g.min === 0 ? [] : [o.id];
      else next = cur.includes(o.id) ? cur.filter((x) => x !== o.id) : [...cur, o.id];
      return { ...s, picks: { ...s.picks, [g.id]: next } };
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" data-testid="item-dialog">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <MenuPhoto id={product.id} name={product.name} color={product.color} category={product.category} className="size-14 rounded-xl" />
            <div className="min-w-0">
              <DialogTitle className="font-heading text-lg font-extrabold italic text-teal-deep" data-testid="item-dialog-title">
                {product.code && <span className="mr-1.5 rounded-md bg-teal-brand px-1.5 py-0.5 text-xs not-italic text-white">{product.code}</span>}
                {lineName(product, sel)}
              </DialogTitle>
              <DialogDescription className="text-xs">{product.desc}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5">
          {product.sizes && (
            <section className="space-y-2">
              <h4 className="font-heading text-sm font-bold text-teal-deep">Ukuran</h4>
              <div className="grid grid-cols-2 gap-2">
                {(["R", "L"] as const).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    data-testid={`modifier-size-${sz === "R" ? "regular" : "large"}`}
                    aria-pressed={sel.size === sz}
                    onClick={() => setSel((s) => ({ ...s, size: sz }))}
                    className={cn(
                      "rounded-xl border-2 px-3 py-2.5 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98]",
                      sel.size === sz ? "border-teal-brand bg-mint" : "border-border bg-white hover:border-teal-brand/50",
                    )}
                  >
                    <div className="font-heading font-bold text-teal-deep">{sz === "R" ? "Regular" : "Large"}</div>
                    <div className="text-xs text-muted-foreground">
                      {sz === "R" ? "400 ml" : "600 ml"} · {product.pricing === "custom" ? "+" : ""}
                      {kShort(sz === "R" ? product.r : (product.l ?? product.r))}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {product.groups.map((gid) => {
            const group = groups[gid];
            // Hide deleted/unavailable groups instead of passing undefined to GroupPicker.
            if (!group) return null;
            return <GroupPicker key={gid} group={group} sel={sel} onToggle={toggle} />;
          })}

          <section className="space-y-2">
            <h4 className="font-heading text-sm font-bold text-teal-deep">Catatan</h4>
            <Input
              value={sel.note}
              onChange={(e) => setSel((s) => ({ ...s, note: e.target.value }))}
              placeholder="mis. tanpa sedotan, dipisah"
              maxLength={80}
              data-testid="item-note-input"
            />
          </section>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-3 sm:justify-between">
          <div className="flex items-center gap-1 rounded-full border bg-white p-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Kurangi jumlah"
              data-testid="item-qty-decrement"
              onClick={() => setSel((s) => ({ ...s, qty: Math.max(1, s.qty - 1) }))}
            >
              <Minus />
            </Button>
            <span className="w-6 text-center font-mono font-semibold" data-testid="item-qty-value">
              {sel.qty}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Tambah jumlah"
              data-testid="item-qty-increment"
              onClick={() => setSel((s) => ({ ...s, qty: Math.min(99, s.qty + 1) }))}
            >
              <Plus />
            </Button>
          </div>
          <Button
            size="lg"
            disabled={!valid}
            data-testid="modifier-confirm-button"
            className="h-11 flex-1 rounded-full bg-teal-brand text-base font-semibold hover:bg-teal-deep"
            onClick={() => {
              onAdd(toOrderLine(product, sel, groups));
              onClose();
            }}
          >
            Tambah · {rupiah(unit * sel.qty)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
