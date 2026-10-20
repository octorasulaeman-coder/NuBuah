"""Money-path unit tests for lib.pricemath (pure functions, no database needed).

Run from the backend folder:  .venv\\Scripts\\python -m pytest tests/test_pricemath.py
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.pricemath import PriceError, build_options_index, compute_line  # noqa: E402


def line(pid, size=None, options=(), unit=0, name="X"):
    return SimpleNamespace(
        product_id=pid,
        size=size,
        name=name,
        options=[SimpleNamespace(label=l, price=p) for l, p in options],
        unit_price=unit,
    )


PRODUCT = {"id": "t-sm", "r": 14000, "l": 17000, "sizes": True, "pricing": "fixed"}
BOWL = {"id": "t-bw", "r": 29000, "l": None, "sizes": False, "pricing": "fixed"}
POTONG = {"id": "t-bp", "r": 11000, "l": 16000, "sizes": False, "pricing": "potong"}
CUSTOM = {"id": "t-cu", "r": 3000, "l": 6000, "sizes": True, "pricing": "custom"}

GROUPS = [
    {"id": "sweet", "label": "Gula"},
    {"id": "ice", "label": "Es"},
    {"id": "drink_extra", "label": "Tambahan"},
    {"id": "bowl_extra", "label": "Tambahan bowl"},
    {"id": "potong_fruit", "label": "Buah"},
    {"id": "custom_fruit", "label": "Buah custom"},
]
OPTIONS = [
    {"id": "no-sugar", "group_id": "sweet", "label": "No Sugar", "r": 0, "l": None},
    {"id": "extra-sugar", "group_id": "sweet", "label": "Extra Sugar", "r": 0, "l": None},
    {"id": "extra-ice", "group_id": "ice", "label": "Extra Ice", "r": 1000, "l": None},
    {"id": "madu-drink", "group_id": "drink_extra", "label": "Ganti gula jadi madu", "r": 3000, "l": 5000},
    {"id": "madu-bowl", "group_id": "bowl_extra", "label": "Ganti gula dengan madu", "r": 3000, "l": None},
    {"id": "bp-semangka", "group_id": "potong_fruit", "label": "Semangka", "r": 0, "l": None},
    {"id": "bp-melon", "group_id": "potong_fruit", "label": "Melon", "r": 0, "l": None},
    {"id": "bp-nanas", "group_id": "potong_fruit", "label": "Nanas", "r": 0, "l": None},
    {"id": "bp-pepaya", "group_id": "potong_fruit", "label": "Pepaya", "r": 0, "l": None},
    {"id": "bp-strawberry", "group_id": "potong_fruit", "label": "Strawberry", "r": 0, "l": None},
    {"id": "cf-mangga", "group_id": "custom_fruit", "label": "Mangga", "r": 4000, "l": None},
]
IDX = build_options_index(GROUPS, OPTIONS, {})


class TestBasePrices:
    def test_r_size(self):
        assert compute_line(PRODUCT, None, IDX, line("t-sm", None, (), 14000)) == 14000

    def test_l_size(self):
        assert compute_line(PRODUCT, None, IDX, line("t-sm", "L", (), 17000)) == 17000

    def test_wrong_price_rejected(self):
        with pytest.raises(PriceError) as e:
            compute_line(PRODUCT, None, IDX, line("t-sm", None, (), 9999))
        assert e.value.status == 409


class TestOptions:
    def test_extra_ice(self):
        ln = line("t-sm", None, (("Extra Ice", 1000),), 15000)
        assert compute_line(PRODUCT, None, IDX, ln) == 15000

    def test_sized_option_uses_l(self):
        ln = line("t-sm", "L", (("Ganti gula jadi madu", 5000),), 22000)
        assert compute_line(PRODUCT, None, IDX, ln) == 22000

    def test_same_label_different_group(self):
        # "madu" exists in two groups with different labels — must resolve independently
        ln = line("t-bw", None, (("Ganti gula dengan madu", 3000),), 32000)
        assert compute_line(BOWL, None, IDX, ln) == 32000

    def test_unknown_option_rejected(self):
        with pytest.raises(PriceError) as e:
            compute_line(PRODUCT, None, IDX, line("t-sm", None, (("Keju", 1000),), 15000))
        assert e.value.status == 422


class TestPotongRule:
    FRUITS4 = ("Semangka", "Melon", "Nanas", "Pepaya")

    def test_up_to_four_fruits_uses_r(self):
        ln = line("t-bp", None, [(f, 0) for f in self.FRUITS4], 11000)
        assert compute_line(POTONG, None, IDX, ln) == 11000

    def test_five_fruits_uses_l(self):
        ln = line("t-bp", None, [(f, 0) for f in (*self.FRUITS4, "Strawberry")], 16000)
        assert compute_line(POTONG, None, IDX, ln) == 16000


class TestCustomFruit:
    def test_multiplied_fruit(self):
        ln = line("t-cu", None, (("Mangga x3", 12000),), 15000)
        assert compute_line(CUSTOM, None, IDX, ln) == 15000

    def test_two_fruits_plain_prices(self):
        # production builds the index from the product's own groups only (see verify_line);
        # feed compute_line the same custom-only index — a potong fruit must NOT be matchable
        IDX_CU = build_options_index([{"id": "custom_fruit"}], OPTIONS, {})
        ln = line("t-cu", None, (("Mangga", 4000), ("Semangka", 0)), 7000)  # semangka not in custom group -> unknown
        with pytest.raises(PriceError):
            compute_line(CUSTOM, None, IDX_CU, ln)


class TestOverrides:
    def test_r_override(self):
        ov = {"r": 13000}
        assert compute_line(PRODUCT, ov, IDX, line("t-sm", None, (), 13000)) == 13000

    def test_r_override_never_leaks_to_l(self):
        # a store that only overrides R keeps the base L price — the POS rule since v6
        ov = {"r": 13000}
        assert compute_line(PRODUCT, ov, IDX, line("t-sm", "L", (), 17000)) == 17000

    def test_l_override(self):
        ov = {"l": 16000}
        assert compute_line(PRODUCT, ov, IDX, line("t-sm", "L", (), 16000)) == 16000

    def test_null_fields_keep_base(self):
        ov = {"r": None, "l": None}
        assert compute_line(PRODUCT, ov, IDX, line("t-sm", "L", (), 17000)) == 17000

    def test_option_override(self):
        ov = {("ice", "extra-ice"): {"r": 500}}
        idx = build_options_index(GROUPS, OPTIONS, ov)
        ln = line("t-sm", None, (("Extra Ice", 500),), 14500)
        assert compute_line(PRODUCT, None, idx, ln) == 14500


class TestGates:
    def test_sold_out(self):
        with pytest.raises(PriceError) as e:
            compute_line(PRODUCT, {"sold_out": True}, IDX, line("t-sm", None, (), 14000))
        assert e.value.status == 409

    def test_hidden_pos_allowed(self):
        assert compute_line(PRODUCT, {"hidden": True}, IDX, line("t-sm", None, (), 14000)) == 14000

    def test_hidden_customer_rejected(self):
        with pytest.raises(PriceError) as e:
            compute_line(PRODUCT, {"hidden": True}, IDX, line("t-sm", None, (), 14000), reject_hidden=True)
        assert e.value.status == 409
