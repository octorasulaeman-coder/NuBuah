// Hand-mirrored from backend/models/order.py — keep in sync.
export type PaymentMethod = "cash" | "card" | "qris";

export interface OrderLineOption {
  label: string;
  price: number;
}

export interface OrderLineIn {
  product_id: string;
  name: string;
  code: string | null;
  size: "R" | "L" | null;
  options: OrderLineOption[];
  note: string | null;
  unit_price: number;
  qty: number;
}

export interface OrderLine extends OrderLineIn {
  line_total: number;
}

export interface OrderCreate {
  lines: OrderLineIn[];
  payment_method: PaymentMethod;
  cash_tendered: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  discount_type: DiscountType | null;
  discount_value: number;
  discount_note: string | null;
  store_id: string | null;
  client_order_id?: string; // idempotency key: a retried checkout returns the same order instead of double-charging
  approval_pin?: string | null; // owner PIN, required for cashier discounts above the store cap
}

export type DiscountType = "percent" | "fixed";

export interface Order {
  id: string;
  client_order_id?: string | null;
  order_no: string;
  business_date: string;
  store_id: string;
  store_name: string;
  store_address_lines: string[];
  store_phone: string;
  cashier_name: string | null;
  created_at: string;
  lines: OrderLine[];
  item_count: number;
  subtotal?: number | null; // before discount; missing on orders saved before discounts existed
  discount_type?: DiscountType | null;
  discount_value?: number;
  discount_amount?: number;
  discount_note?: string | null;
  total: number;
  payment_method: PaymentMethod;
  cash_tendered: number | null;
  change: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  voided?: boolean;
  void_reason?: string | null;
  voided_at?: string | null;
  voided_by?: string | null;
}

export interface OrdersSummary {
  count: number;
  revenue: number;
  items: number;
  by_method: Record<PaymentMethod, number>;
  voided_count?: number;
  voided_total?: number;
  discount_total?: number;
}

export interface OrderList {
  start: string;
  end: string;
  store_id: string | null;
  orders: Order[];
  summary: OrdersSummary;
}

export interface TodayInfo {
  date: string;
  timezone: string;
}

// backend/models/auth.py
export interface Me {
  id: string;
  kind: "user" | "pin";
  name: string;
  email: string | null;
  role: "owner" | "cashier";
  store_id: string | null;
  must_change_password?: boolean; // true while the bootstrap default password is still in use
}

// backend/models/drawer.py — cash drawer (modal, pengambilan, pengeluaran, tutup kasir)
export interface DrawerEventIn {
  store_id?: string | null;
  kind: "open" | "cash_out" | "expense";
  amount: number;
  note?: string | null;
}

export interface DrawerCloseIn {
  store_id?: string | null;
  date: string;
  counted: number; // cash physically counted in the drawer
}

export interface DrawerEvent {
  id: string;
  kind: "open" | "cash_out" | "expense" | "close";
  amount: number;
  variance: number | null;
  note: string | null;
  store_id: string;
  date: string;
  actor: string | null;
  created_at: string;
}

export interface DrawerSummary {
  date: string;
  store_id: string;
  opening: number;
  cash_sales: number;
  cash_out: number;
  expense: number;
  expected_cash: number;
  closing: DrawerEvent | null;
  events: DrawerEvent[];
}

export interface PublicStore {
  id: string;
  name: string;
  code: string;
  address_lines: string[];
  phone: string;
}

export interface Store extends PublicStore {
  has_pin: boolean;
  has_approval_pin: boolean;
  discount_cap: number; // percent; cashier discounts above this need the owner approval PIN
  created_at: string;
}

export interface StoreIn {
  name: string;
  code: string;
  address_lines: string[];
  phone: string;
  pin: string | null;
  approval_pin?: string | null; // owner PIN that approves over-cap cashier discounts
}

export type StoreUpdate = Partial<StoreIn>;

export interface StaffIn {
  name: string;
  email: string;
  password: string;
  store_id: string;
}

export interface Staff {
  id: string;
  name: string;
  email: string;
  role: "owner" | "cashier";
  store_id: string | null;
  created_at: string;
}

// backend/models/menu.py
export interface MenuOverrideIn {
  r: number | null;
  l: number | null;
  sold_out: boolean;
  hidden: boolean;
}

export interface MenuOverride extends MenuOverrideIn {
  store_id: string;
  product_id: string;
  updated_at: string;
}

export interface OptionOverrideIn {
  r: number | null;
  l: number | null;
  sold_out: boolean;
  hidden: boolean;
}

export interface OptionOverride extends OptionOverrideIn {
  store_id: string;
  group_id: string;
  option_id: string;
  updated_at: string;
}

// backend/models/report.py
export interface TopItem {
  name: string;
  qty: number;
  revenue: number;
}

export interface MethodTotal {
  method: string;
  count: number;
  total: number;
}

export interface ClosingReport {
  store_name: string | null;
  start: string;
  end: string;
  generated_at: string;
  count: number;
  revenue: number;
  items: number;
  average: number;
  first_order_no: string | null;
  last_order_no: string | null;
  methods: MethodTotal[];
  cash_in_drawer: number;
  voided_count?: number;
  voided_total?: number;
  gross?: number;
  discount_total?: number;
  by_store?: { store_name: string; count: number; revenue: number; discount_total: number }[];
  top_items: TopItem[];
}

// backend/models/menu.py (CustomProductIn / CustomProduct)
export interface CustomProductIn {
  name: string;
  code?: string; // unique item code; blank = generated automatically
  category: string; // smoothie / bowl / jus / snack / sopsalad or a custom category id (cx-...)
  section: string;
  groups: string[] | null; // null = default option groups for the category
  desc: string;
  benefit: string;
  r: number;
  l: number | null;
  color: string;
}

export interface CustomProduct extends CustomProductIn {
  id: string;
  created_at: string;
}

// backend/models/menu.py (CustomOptionIn / CustomOption): toppings and extras added from the app
export interface CustomOptionIn {
  group_id: string;
  label: string;
  r: number;
  l: number | null;
}

export interface CustomOption extends CustomOptionIn {
  id: string;
  created_at: string;
}

export interface BackupInfo {
  folder: string;
  keep_days: number;
  has_today: boolean;
  backups: { name: string; size: number; date: string; time: string }[];
}

export interface CustomCategoryIn {
  label: string;
  blurb: string;
}

export interface CustomCategory extends CustomCategoryIn {
  id: string;
}

export interface StaffUpdate {
  name?: string;
  email?: string;
  password?: string;
  store_id?: string;
}

export interface CustomGroupIn {
  label: string;
  type: "single" | "multi";
  product_ids: string[];
}

export interface CustomGroup extends CustomGroupIn {
  id: string;
}

// backend/models/menu.py (MenuEditIn): owner edits to built-in items, toppings, categories and groups
export interface MenuEdit {
  kind: "product" | "option" | "category" | "group";
  key: string; // product id | "group_id/option_id" | category id | group id
  name?: string;
  desc?: string;
  benefit?: string;
  category?: string;
  section?: string;
  color?: string;
}
