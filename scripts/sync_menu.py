#!/usr/bin/env python3
"""Regenerate the backend menu catalogs from frontend/src/data/menu.ts.

`menu.ts` (plus `codes.ts`) is the single hand-maintained menu source. The backend's
price verifier and code tables are GENERATED from it by this script, so they can never
drift out of sync. Run it after every menu change:

    python scripts/sync_menu.py          # regenerate
    python scripts/sync_menu.py --check  # exit 1 if the generated files are stale (CI)

It fails loudly if the menu structure changes in a way it cannot follow.
"""
from __future__ import annotations

import difflib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MENU_TS = ROOT / "frontend/src/data/menu.ts"
CODES_TS = ROOT / "frontend/src/data/codes.ts"
OUT_CATALOG = ROOT / "backend/lib/price_catalog.py"
OUT_CODES = ROOT / "backend/lib/builtin_codes.py"

K = lambda n: n * 1000  # noqa: E731


def slug(s: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))


# ---------------------------------------------------------------- TS parsing

def match_bracket(s: str, i: int) -> int:
    close = {"[": "]", "{": "}"}[s[i]]
    depth = 0
    for j in range(i, len(s)):
        if s[j] == s[i]:
            depth += 1
        elif s[j] == close:
            depth -= 1
            if depth == 0:
                return j
    raise ValueError(f"unbalanced bracket in {s[i:i+60]!r}")


def to_py(s: str) -> str:
    """TS data literal -> python source (quote bare keys, map JS literals)."""
    s = re.sub(r"([{,]\s*)([A-Za-z_$][\w$]*)\s*:", r'\1"\2":', s)
    s = re.sub(r"\btrue\b", "True", s)
    s = re.sub(r"\bfalse\b", "False", s)
    return s.replace("undefined", "None")


def extract(src: str, name: str) -> str:
    i = src.index(f"const {name}")
    i = src.index("=", i) + 1
    while src[i] not in "[{":
        i += 1
    return src[i : match_bracket(src, i) + 1]


def replace_maps(s: str) -> str:
    """X.map((v) => body) / [...].map((v) => body), with optional ... spread -> comprehensions."""
    out, i = [], 0
    pat = re.compile(r"(\.\.\.)?(?:(\w+)|\[([^\]]*)\])\.map\((?:\((\w+)\)|(\w+))\s*=>\s*")
    while True:
        m = pat.search(s, i)
        if not m:
            out.append(s[i:])
            break
        out.append(s[m.start() and i : m.start()])
        body_start = m.end()
        open_paren = s.index("(", m.start(), m.end())
        depth, j = 0, open_paren
        while True:
            if s[j] == "(":
                depth += 1
            elif s[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = s[body_start:j].rstrip().rstrip(",")
        var = m.group(4) or m.group(5)
        src_list = m.group(2) if m.group(2) is not None else f"[{m.group(3)}]"
        out.append(("*" if m.group(1) == "..." else "") + f"[{body} for {var} in {src_list}]")
        i = j + 1
    return "".join(out)


def opt(oid, label, r=0, l=None, extra=None):
    return {"id": oid, "label": label, "r": r, "l": l}


def parse_menu() -> tuple[dict, dict, dict]:
    src = MENU_TS.read_text(encoding="utf-8")
    codes_src = CODES_TS.read_text(encoding="utf-8")

    seeds = {
        name: eval(to_py(extract(src, name)))
        for name in ("SMOOTHIES", "BOWLS", "JUS", "ES_KUL_KUL", "ES_LOLI", "YOGURT_CIMORY",
                     "FRUIT_TIERS", "BOWL_TOPPINGS", "POTONG_FRUITS")
    }
    SMOOTHIES, BOWLS, JUS = seeds["SMOOTHIES"], seeds["BOWLS"], seeds["JUS"]
    ES_KUL_KUL, ES_LOLI, YOGURT = seeds["ES_KUL_KUL"], seeds["ES_LOLI"], seeds["YOGURT_CIMORY"]
    FRUIT_TIERS = seeds["FRUIT_TIERS"]
    BOWL_TOPPINGS, POTONG_FRUITS = seeds["BOWL_TOPPINGS"], seeds["POTONG_FRUITS"]

    auto_codes = eval(extract(codes_src, "AUTO_CODES"))

    # ---- option groups ----
    gi = src.index("export const GROUPS")
    gi = src.index("{", gi)
    g = src[gi : match_bracket(src, gi) + 1]
    # non-trivial constructs special-cased first (keep these strings in sync with menu.ts)
    g = g.replace(
        "FRUIT_TIERS.flatMap((t) => t.fruits.map((f) => opt(`cf-${slug(f)}`, f, t.price, undefined, { tier: t.tier })))",
        '[opt(f"cf-{slug(f)}", f, t["price"], None, {"tier": t["tier"]}) for t in FRUIT_TIERS for f in t["fruits"]]',
    )
    g = g.replace(
        "...[\"Original\", \"Strawberry\", \"Blueberry\", \"Mango\", \"Peach\"].map((v) => opt(`yogurt-${slug(v)}`, `Yogurt ${v}`, K(3))),",
        '*[opt(f"yogurt-{slug(v)}", f"Yogurt {v}", K(3)) for v in ["Original", "Strawberry", "Blueberry", "Mango", "Peach"]],',
    )
    g = re.sub(r"`([^`]*)`", lambda m: 'f"' + m.group(1).replace("${", "{") + '"', g)
    g = g.replace("undefined", "None")
    g = to_py(g)
    g = replace_maps(g)
    g = re.sub(r":\s*\*\[", ": [", g)
    env = {"opt": opt, "K": K, "slug": slug, "BOWL_TOPPINGS": BOWL_TOPPINGS,
           "POTONG_FRUITS": POTONG_FRUITS, "FRUIT_TIERS": FRUIT_TIERS, "None": None}
    if ".map(" in g or "flatMap" in g:
        raise SystemExit("sync_menu: unhandled .map()/flatMap in GROUPS — special-case it in scripts/sync_menu.py")
    groups_raw = eval(g, env)
    groups = {gid: {o["id"]: (o["r"], o.get("l")) for o in gdef["options"]} for gid, gdef in groups_raw.items()}
    # display labels exactly as the POS shows them (same option id can have different labels
    # per group, e.g. "madu" in drink_extra vs bowl_extra) — used by the price verifier
    option_labels = {gid: {o["id"]: o["label"] for o in gdef["options"]} for gid, gdef in groups_raw.items()}

    # ---- products: (id -> (r, l, sizes, pricing, groups)) and (id -> (code, name)) ----
    DRINK_GROUPS = ["sweet", "ice", "drink_extra"]
    products: dict[str, tuple] = {}
    codes: dict[str, tuple[str, str]] = {}

    def add(pid, r, l, sizes, pricing, grps, code=None, name=""):
        products[pid] = (r, l, sizes, pricing, list(grps))
        codes[pid] = (code, name)

    for code, name, desc, benefit, r, l, color in SMOOTHIES:
        pid = f"sm-{code.lower()}"
        add(pid, K(r), K(l), True, "fixed", DRINK_GROUPS, code or auto_codes.get(pid), name)
    for code, name, desc, price, color in BOWLS:
        pid = f"bw-{slug(name)}"
        add(pid, K(price), None, False, "fixed", ["bowl_topping", "bowl_extra"], code or auto_codes.get(pid), name)
    for name, r, l, color in JUS:
        pid = f"js-{slug(name)}"
        add(pid, K(r), K(l), True, "fixed", DRINK_GROUPS, auto_codes.get(pid), name)
    add("js-ekonomis", K(10), K(13), True, "fixed", ["eko_fruit", *DRINK_GROUPS], auto_codes.get("js-ekonomis", "JE"), "Jus Ekonomis")
    add("bp-buah-potong", K(11), K(16), False, "potong", ["potong_fruit", "potong_extra"], auto_codes.get("bp-buah-potong", "BP"), "Buah Potong")
    add("cu-jus", K(3), K(6), True, "custom", ["custom_fruit", "ice", "sweet", "drink_extra"], auto_codes.get("cu-jus"), "Jus Custom")
    add("cu-bowl", K(9), None, False, "custom", ["custom_fruit", "sweet", "bowl_topping", "custom_bowl_extra"], auto_codes.get("cu-bowl"), "Bowl Custom")
    for f, price in ES_KUL_KUL:
        pid = f"ek-{slug(f)}"
        add(pid, price, None, False, "fixed", [], auto_codes.get(pid), f"Es Kul Kul {f}")
    for f, price in ES_LOLI:
        pid = f"el-{slug(f)}"
        add(pid, price, None, False, "fixed", [], auto_codes.get(pid), f"Es Loli {f}")
    for f in YOGURT:
        pid = f"yc-{slug(f)}"
        add(pid, 3000, None, False, "fixed", [], auto_codes.get(pid), f"Yogurt Cimory {f}")
    add("sp-sop-buah", K(17), None, False, "fixed", ["kuah"], auto_codes.get("sp-sop-buah", "SB"), "Sop Buah")

    return products, groups, option_labels, codes


# ---------------------------------------------------------------- emitters

CATALOG_HEADER = '''"""CANONICAL BUILT-IN MENU PRICES — GENERATED by scripts/sync_menu.py from
frontend/src/data/menu.ts. Do not edit by hand; run `python scripts/sync_menu.py` instead.

The server recomputes every order line against this catalog so a tampered client
cannot sell items at arbitrary prices.

Product entry:  id -> (r, l, sizes, pricing, groups)
Option entry:   group -> option_id -> (r, l)   (l=None means "same as r")
"""

'''

CATALOG_STATIC = '''
# Default option groups for custom items whose `groups` is None (mirrors the frontend).
CATEGORY_DEFAULT_GROUPS = {
    "smoothie": ["sweet", "ice", "drink_extra"],
    "jus": ["sweet", "ice", "drink_extra"],
    "bowl": ["bowl_topping", "bowl_extra"],
    "sopsalad": ["kuah"],
    "snack": [],
}
'''


def fmt_products(products: dict) -> str:
    lines = ["PRODUCTS: dict[str, tuple[int, int | None, bool, str, list[str]]] = {"]
    for pid, (r, l, sizes, pricing, grps) in products.items():
        lits = ", ".join(f'"{g}"' for g in grps)
        lines.append(f'    "{pid}": ({r}, {l}, {sizes}, "{pricing}", [{lits}]),')
    lines.append("}")
    return "\n".join(lines)


def fmt_groups(groups: dict) -> str:
    lines = ["GROUPS: dict[str, dict[str, tuple[int, int | None]]] = {"]
    for gid, opts in groups.items():
        inner = ", ".join(f'"{oid}": ({r}, {l})' for oid, (r, l) in opts.items())
        lines.append(f'    "{gid}": {{{inner}}},')
    lines.append("}")
    return "\n".join(lines)


CODES_HEADER = '''"""Built-in product short codes (for receipts, fast search, and keyboard entry) —
GENERATED by scripts/sync_menu.py from frontend/src/data/menu.ts + codes.ts. Do not edit.
"""

'''

CODES_STATIC = '''def suggest_code(name: str, taken: set[str]) -> str:
    """Suggest a short, human-friendly code for a custom product name."""
    base = "".join(w[0] for w in re.split(r"[\\s\\-]+", name.strip()) if w).upper()[:3] or "X"
    code, n = base, 2
    while code in BUILTIN_CODES or code in taken:
        code, n = f"{base}{n}", n + 1
    return code
'''


def fmt_codes(codes: dict) -> str:
    lines = ["BUILTIN_PRODUCTS: dict[str, tuple[str | None, str]] = {"]
    for pid, (code, name) in codes.items():
        lines.append(f'    "{pid}": ({code!r}, "{name}"),')
    lines.append("}")
    lines.append("")
    lines.append("BUILTIN_CODES: set[str] = {c for c, _ in BUILTIN_PRODUCTS.values() if c}")
    return "\n".join(lines)


def fmt_labels(labels: dict) -> str:
    lines = ["# Display labels per group/option, exactly as shown in the POS (GENERATED).", "OPTION_LABELS: dict[str, dict[str, str]] = {"]
    for gid, opts in labels.items():
        inner = ", ".join(f'"{oid}": "{label}"' for oid, label in opts.items())
        lines.append(f'    "{gid}": {{{inner}}},')
    lines.append("}")
    return "\n".join(lines)


def render_catalog(products, groups, option_labels) -> str:
    return (CATALOG_HEADER + "K = 1000\n" + CATALOG_STATIC + "\n\n" + fmt_products(products)
            + "\n\n\n" + fmt_groups(groups) + "\n\n\n" + fmt_labels(option_labels) + "\n")


def render_codes(codes) -> str:
    return CODES_HEADER + "import re\n\n" + fmt_codes(codes) + "\n" + CODES_STATIC


def main() -> int:
    check = "--check" in sys.argv
    products, groups, option_labels, codes = parse_menu()

    new_catalog = render_catalog(products, groups, option_labels)
    new_codes = render_codes(codes)

    if check:
        ok = True
        for path, new in ((OUT_CATALOG, new_catalog), (OUT_CODES, new_codes)):
            old = path.read_text(encoding="utf-8") if path.exists() else ""
            if old != new:
                ok = False
                print(f"STALE: {path.relative_to(ROOT)}")
                print("\n".join(list(difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm=""))[:40]))
        print("menu catalogs up to date" if ok else "run: python scripts/sync_menu.py")
        return 0 if ok else 1

    OUT_CATALOG.write_text(new_catalog, encoding="utf-8")
    OUT_CODES.write_text(new_codes, encoding="utf-8")
    print(f"wrote {OUT_CATALOG.relative_to(ROOT)} ({len(products)} products, {len(groups)} groups)")
    print(f"wrote {OUT_CODES.relative_to(ROOT)} ({len(codes)} product codes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
