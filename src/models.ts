// PostgreSQL timestamps are decoded as Date; bigint columns retain pg's string representation.
export type Role = 'CUSTOMER' | 'PICKER' | 'COURIER' | 'ADMIN';
export type Localized = { ru: string; ky?: string; en?: string };
export type OrderStatus =
  | 'AWAITING_PAYMENT'
  | 'CONFIRMED'
  | 'PICKING'
  | 'READY'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'RETURNING'
  | 'RETURNED';
export type PaymentStatus = 'UNPAID' | 'PAID' | 'REFUND_PENDING' | 'REFUNDED';
export interface User {
  id: string;
  phone: string;
  first_name: string;
  last_name: string;
  language: 'ru' | 'ky' | 'en';
  email: string | null;
  role: Role;
  password_hash: string | null;
  active: boolean;
  created_at: Date;
}
export interface Session {
  id: string;
  user_id: string;
  access_hash: string;
  refresh_hash: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}
export interface OtpChallenge {
  phone: string;
  code_hash: string;
  expires_at: Date;
  retry_at: Date;
  attempts: number;
  consumed_at: Date | null;
}
export interface Store {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radius_km: string;
  delivery_fee: number;
  minimum_order: number;
  opens_at: string;
  closes_at: string;
  timezone: string;
  active: boolean;
}
export interface Address {
  id: string;
  user_id: string;
  label: string;
  street: string;
  latitude: number;
  longitude: number;
  entrance: string;
  intercom: string;
  floor: string;
  apartment: string;
  comment: string;
}
export interface Cart {
  user_id: string;
  store_id: string;
}
export interface Promotion {
  code: string;
  kind: 'PERCENT' | 'FIXED' | 'FREE_DELIVERY' | 'GIFT';
  value: number;
  gift_product_id: string | null;
  trigger_product_ids: string[];
  minimum_order: number;
  starts_at: Date;
  ends_at: Date;
  usage_limit: number;
  used: number;
  active: boolean;
}
export interface Order {
  id: string;
  number: string;
  user_id: string;
  store_id: string;
  status: OrderStatus;
  payment_method: 'CASH' | 'QR';
  payment_status: PaymentStatus;
  subtotal: number;
  discount: number;
  delivery_fee: number;
  total: number;
  address_snapshot: Address;
  pricing_snapshot: { kind?: Promotion['kind'] | null; value?: number; firstDelivery?: boolean };
  email: string | null;
  courier_comment: string;
  cash_change_from: number | null;
  promo_code: string | null;
  idempotency_key: string;
  request_hash: string;
  expires_at: Date | null;
  waiting_until: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  name_snapshot: Localized;
  unit_snapshot: string;
  unit_price: number;
  quantity: number;
  picking_status: 'PENDING' | 'PICKED' | 'EXCLUDED' | 'REPLACED';
  replacement_product_id: string | null;
  replacement_price: number | null;
  replacement_name: Localized | null;
  replacement_status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | null;
  reserved_quantity: number;
}
export interface Payment {
  id: string;
  order_id: string;
  amount: number;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  provider: string;
  idempotency_key: string;
  created_at: Date;
}
export interface Refund {
  id: string;
  order_id: string;
  amount: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  created_at: Date;
}
export interface PickingTask {
  order_id: string;
  picker_id: string | null;
  claimed_at: Date | null;
  completed_at: Date | null;
}
export interface DeliveryTask {
  order_id: string;
  courier_id: string | null;
  shift_id: string | null;
  claimed_at: Date | null;
  picked_up_at: Date | null;
  arrived_at: Date | null;
  completed_at: Date | null;
}
export interface CourierShift {
  id: string;
  courier_id: string;
  started_at: Date;
  ended_at: Date | null;
}
export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  run_at: Date;
  attempts: number;
  completed_at: Date | null;
  last_error: string | null;
}

export type Actor = Pick<User, 'id' | 'role' | 'phone' | 'first_name' | 'last_name'> & { session_id: string };
