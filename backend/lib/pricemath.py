"""Pure order-line price computation — no database access, fully unit-testable.

verify_line (lib/pricing.py) is a thin fetch-layer around compute_line; every money
decision lives here: base prices, sizes, the potong fruit-count rule, custom-fruit
multipliers, per-store overrides, and sold-out/hidden gates.
"""

import re
from typing import Optional


class PriceError(Exception):
    """carries an HTTP status code + message for the API layer"""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


_XN_RE = re.compile(r"^(?P<label>.+?) x(?P<n>[23])$")


def _ov_price(base: Optional[int], doc: Optional[dict], size: Optional[str], sized: bool) -> int:
    """Apply a per-store override: a null (or size-mismatched) override field keeps the base value.
    An r-only override never leaks onto the L price — same rule the POS has always used."""
    if doc:
        v = doc.get("l") if (sized and size == "L") else doc.get("r")
        if v is not None:
            return v
    return base or 0


def compute_line(product: dict, menu_ov: Optional[dict], options_index: dict, line, reject_hidden: bool = False) -> int:
    """options_index: {(group_id, label) -> {"group", "id", "r", "l", "ov"}} for every option of
    every group this product offers (labels are the row labels, already renamed)."""
    pid = product["id"]

    if menu_ov and menu_ov.get("sold_out"):
        raise PriceError(409, f'"{line.name}" sedang habis')
    if reject_hidden and menu_ov and menu_ov.get("hidden"):
        raise PriceError(409, f'"{line.name}" tidak tersedia')

    pricing = product.get("pricing", "fixed")
    base_r, base_l = product["r"], product.get("l")
    sizes = bool(product.get("sizes")) or base_l is not None
    size = line.size if sizes else None

    # base price
    if pricing == "potong":
        fruit_labels = {lbl for (gid, lbl) in options_index if gid == "potong_fruit"}
        n_fruits = sum(1 for o in line.options if o.label.split(" x")[0] in fruit_labels)
        base = base_l if (n_fruits > 4 and base_l is not None) else base_r
        base = _ov_price(base, menu_ov, None, sized=False)
    else:
        base_for_size = base_l if (sizes and size == "L" and base_l is not None) else base_r
        base = _ov_price(base_for_size, menu_ov, size, sized=sizes)

    total = base
    for picked in line.options:
        found = None
        mult = 1
        label = picked.label
        for key, cand in options_index.items():
            if key[1] == picked.label:
                found = cand
                break
        if not found and pricing == "custom":
            m = _XN_RE.match(picked.label)
            if m:
                for key, cand in options_index.items():
                    if key[1] == m.group("label"):
                        found, label, mult = cand, m.group("label"), int(m.group("n"))
                        break
        if not found:
            raise PriceError(422, f"Opsi tidak dikenal: {picked.label}")

        ov = found.get("ov")
        if ov and ov.get("sold_out"):
            raise PriceError(409, f'Opsi "{label}" sedang habis')
        if found["group"] == "custom_fruit":
            expected = found["r"] * mult  # xN suffix carries the multiplier; size-independent
        else:
            expected = _ov_price(found["l"] if (sizes and size == "L" and found.get("l") is not None) else found["r"], ov, size, sized=sizes)
        total += expected
        if expected != picked.price:
            raise PriceError(409, "Harga telah berubah, muat ulang menu lalu coba lagi")

    expected_unit = max(0, total)
    if expected_unit != line.unit_price:
        raise PriceError(409, "Harga tidak sesuai, muat ulang menu lalu coba lagi")
    return expected_unit


def build_options_index(groups: list[dict], option_rows: list[dict], option_overrides: dict) -> dict:
    """{(group_id, label): {"group", "id", "r", "l", "ov"}} from group rows + option rows.
    option_overrides: {(group_id, option_id): override doc}."""
    index = {}
    for g in groups:
        gid = g["id"]
        for o in option_rows:
            if o["group_id"] != gid:
                continue
            ov = option_overrides.get((gid, o["id"]))
            entry = {"group": gid, "id": o["id"], "r": o["r"], "l": o.get("l"), "ov": ov}
            index[(gid, o["label"])] = entry
    return index
