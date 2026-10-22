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
  scheduled_for?: string | null; // UTC pickup slot (scheduled orders only)
  pay_at_pickup?: boolean; // scheduled orders only: leave payment open, cashier records it at pickup
  coupon_code?: string | null; // P5 customer programs (server-validated, snapshotted)
  redeem_points?: number;
  member_no?: string | null; // cashier-side member identification (NB…)
}

export type DiscountType = "percent" | "fixed";

export interface Order {
  id: string;
  client_order_id?: string | null;
  order_no: string;
  channel?: string; // "pos" | "customer"
  payment_status?: string; // "paid" | "pending" (unpaid customer orders)
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
  member_no?: string | null;
  voided?: boolean;
  void_reason?: string | null;
  voided_at?: string | null;
  voided_by?: string | null;
  // P2 scheduling + preparation flow
  fulfillment?: string; // "immediate" | "scheduled"
  scheduled_for?: string | null; // UTC slot start
  pay_at_pickup?: boolean;
  status?: string; // received|confirmed|preparing|ready|completed|cancelled
  // P5 customer programs (snapshotted at creation)
  coupon_code?: string | null;
  coupon_amount?: number;
  points_redeemed?: number;
  redeem_value_amount?: number;
}

export type OrderStatus = "received" | "confirmed" | "preparing" | "ready" | "completed" | "cancelled";

// GET /orders/cashier-queue — action-first customer/scheduled queue for POS staff.
export interface CashierQueue {
  unpaid: Order[];
  processing: Order[];
  ready: Order[];
  completed: Order[];
}

// P2 scheduling — backend/models/schedule.py
export interface ScheduleInfo {
  enabled: boolean;
  slot_minutes: number;
  lead_time_minutes: number;
  max_days_ahead: number;
  capacity_per_slot: number;
  timezone: string;
  days: { date: string; open: boolean; reason: string | null }[];
  hours?: Record<string, string[]>;
  holidays?: string[];
}

export interface SlotOut {
  start_local: string;
  end_local: string;
  start_utc: string;
  available: boolean;
  reason?: string | null; // closed | past | lead_time | full
  taken: number;
  capacity?: number | null;
}

export interface SlotsDay {
  date: string;
  open: boolean;
  reason?: string | null;
  slots: SlotOut[];
}

export interface PublicScheduleInfo {
  store_code: string;
  timezone: string;
  enabled: boolean;
  slot_minutes: number;
  lead_time_minutes: number;
  max_days_ahead: number;
  is_open_now?: boolean;
  days: { date: string; open: boolean; reason: string | null }[];
}

export interface ScheduleConfig {
  enabled: boolean;
  slot_minutes: number;
  lead_time_minutes: number;
  max_days_ahead: number;
  capacity_per_slot: number;
  hours: Record<string, string[]>; // "0"=Minggu .. "6"=Sabtu, ["09:00","21:00"]; absent day = tutup
  holidays: string[]; // YYYY-MM-DD
}

export interface CustomerDetail {
  customer: Customer;
  ledger: {
    id: string;
    customer_id: string;
    store_id: string;
    order_id?: string | null;
    delta: number;
    reason: string;
    actor?: string | null;
    note?: string | null;
    created_at: string;
  }[];
  recent_orders: { id: string; order_no: string; total: number; payment_status: string; created_at: string }[];
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

// --- customer side (Option B: order on phone, pay at the counter) ---
export interface PublicStoreInfo {
  id: string;
  name: string;
  code: string;
  address_lines: string[];
  phone: string;
  accepting_orders?: boolean;
  accepting_orders_message?: string | null;
}

// --- unified, fully-editable menu (data-driven; see scripts/migrate_menu_to_db.py) ---
export interface MenuProductRow {
  id: string;
  name: string;
  code: string;
  category: string;
  section: string;
  groups: string[] | null; // null = category default
  desc: string;
  benefit: string;
  emoji: string | null;
  img: string | null;    // built-in static path
  img_id: string | null; // uploaded photo (served at /api/media/<img_id>)
  color: string;
  sizes: boolean;
  pricing: "fixed" | "potong" | "custom";
  r: number;
  l: number | null;
  builtin: boolean;
  created_at: string;
}

export interface MenuGroupRow {
  id: string;
  label: string;
  type: "single" | "multi";
  min: number;
  max: number | null;
  hint: string;
  product_ids: string[];
  builtin: boolean;
}

export interface MenuOptionRow {
  id: string;
  group_id: string;
  label: string;
  r: number;
  l: number | null;
  default: boolean;
  tier: string | null;
  builtin: boolean;
}

export interface MenuCategoryRow {
  id: string;
  label: string;
  blurb: string;
  color: string;
  builtin: boolean;
}

export interface MenuBundle {
  menu_products: MenuProductRow[];
  menu_groups: MenuGroupRow[];
  menu_options: MenuOptionRow[];
  menu_categories: MenuCategoryRow[];
  menu_overrides: MenuOverride[];
  option_overrides: OptionOverride[];
  edits: MenuEdit[];
  codes: Record<string, string>;
}

export interface ProductImageResponse {
  img_id: string;
  url: string;
}

export interface PublicOrderStatus {
  id: string;
  order_no: string;
  store_name: string;
  payment_status: string; // "pending" = bayar di kasir, "paid"
  total: number;
  lines: OrderLine[];
  created_at: string;
  fulfillment?: string; // "immediate" | "scheduled"
  scheduled_for?: string | null; // UTC slot start
  pay_at_pickup?: boolean;
  status?: string; // received|confirmed|preparing|ready|completed|cancelled
  points_earned?: number; // loyalty points this order earned (once paid)
  subtotal?: number;
  discount_amount?: number;
  discount_note?: string | null;
  coupon_code?: string | null;
  coupon_amount?: number;
  points_redeemed?: number;
  redeem_value_amount?: number;
}
export interface PaymentAttemptPublic {
  id: string;
  order_id: string;
  order_no: string;
  amount: number;
  currency: string;
  method: string;
  status: string; // pending | paid | failed | expired
  qr_payload?: string | null;
  qr_image_url?: string | null;
  expires_at: string;
  paid_at?: string | null;
  failure_code?: string | null;
}

export interface PaymentsConfig {
  enabled: boolean;
  provider: string | null;
  mode: string | null;
  methods: string[];
  expiry_minutes: number | null;
}

// P5 customers — backend/models/customer.py
export interface Customer {
  id: string;
  store_id: string;
  name: string;
  phone: string;
  is_member?: boolean; // only members earn & redeem points
  member_no?: string | null; // e.g. NB123456, unique per store
  points: number;
  lifetime_spend: number;
  order_count: number;
  last_order_at?: string | null;
  marketing_opt_in: boolean;
}

export interface Coupon {
  id: string;
  store_id: string;
  code: string;
  description: string;
  type: "fixed" | "percent";
  value: number;
  min_spend: number;
  starts_at?: string | null;
  ends_at?: string | null;
  max_redemptions: number;
  per_customer_limit: number;
  used_count: number;
  applies_to: { type: "all" } | { type: "products" | "categories"; ids: string[] };
  active: boolean;
}

// P4 analytics — backend/models/report.py
export interface MethodTotal {
  method: string;
  count: number;
  total: number;
}

export interface Dashboard {
  start: string;
  end: string;
  generated_at: string;
  gross_sales: number;
  net_sales: number;
  net_after_refunds: number;
  qualifying_orders: number;
  average_order_value: number;
  discounts_total: number;
  refunds_total: number;
  refunds_count: number;
  voided_count: number;
  methods: MethodTotal[];
  series: { date: string; revenue: number; orders: number; refunds_total: number }[];
  gross_profit_available: boolean;
  definitions: Record<string, string>;
}

export interface ProductPerf {
  key: string;
  product_id?: string | null;
  category?: string | null;
  qty: number;
  revenue: number;
  orders_count: number;
}

export interface ProductPerformance {
  start: string;
  end: string;
  generated_at: string;
  by_quantity: ProductPerf[];
  by_revenue: ProductPerf[];
  low_performers: ProductPerf[];
  categories: { category: string; qty: number; revenue: number }[];
  top_options: { group: string; label: string; count: number }[];
  all_categories: string[]; // full menu taxonomy for filter chips
  all_option_groups: string[];
  gross_profit_available: boolean;
  definitions: Record<string, string>;
}

export interface PublicStore {
  id: string;
  name: string;
  code: string;
  address_lines: string[];
  phone: string;
  accepting_orders?: boolean;
  accepting_orders_message?: string | null;
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
  accepting_orders?: boolean;
  accepting_orders_message?: string | null;
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
