CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, phone text NOT NULL UNIQUE, first_name text NOT NULL DEFAULT '', last_name text NOT NULL DEFAULT '',
 language text NOT NULL DEFAULT 'ru' CHECK(language IN ('ru','ky','en')), email text,
 role text NOT NULL DEFAULT 'CUSTOMER' CHECK(role IN ('CUSTOMER','PICKER','COURIER','ADMIN')),
 password_hash text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stores (
 id uuid PRIMARY KEY, name text NOT NULL, address text NOT NULL,
 latitude double precision NOT NULL, longitude double precision NOT NULL,
 radius_km numeric NOT NULL CHECK(radius_km>0), delivery_fee integer NOT NULL CHECK(delivery_fee>=0),
 minimum_order integer NOT NULL DEFAULT 0 CHECK(minimum_order>=0), opens_at time NOT NULL, closes_at time NOT NULL,
 timezone text NOT NULL DEFAULT 'Asia/Bishkek', active boolean NOT NULL DEFAULT true
);
CREATE TABLE staff_stores (user_id uuid REFERENCES users(id),store_id uuid REFERENCES stores(id),PRIMARY KEY(user_id,store_id));
CREATE TABLE sessions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),access_hash text UNIQUE NOT NULL,
 refresh_hash text UNIQUE NOT NULL,access_expires_at timestamptz NOT NULL,refresh_expires_at timestamptz NOT NULL,
 revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE otp_challenges (
 phone text PRIMARY KEY,code_hash text NOT NULL,expires_at timestamptz NOT NULL,retry_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0,consumed_at timestamptz
);
CREATE TABLE addresses (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),label text NOT NULL DEFAULT '',street text NOT NULL,
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 entrance text NOT NULL DEFAULT '',intercom text NOT NULL DEFAULT '',floor text NOT NULL DEFAULT '',apartment text NOT NULL DEFAULT '',comment text NOT NULL DEFAULT ''
);
CREATE TABLE categories (id uuid PRIMARY KEY,name jsonb NOT NULL,sort integer NOT NULL DEFAULT 0);
CREATE TABLE products (
 id uuid PRIMARY KEY,category_id uuid NOT NULL REFERENCES categories(id),name jsonb NOT NULL,description jsonb NOT NULL DEFAULT '{}',
 composition jsonb NOT NULL DEFAULT '{}',nutrition jsonb NOT NULL DEFAULT '{}',unit text NOT NULL,image_url text,
 is_new boolean NOT NULL DEFAULT false,age_restricted boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE store_products (
 store_id uuid REFERENCES stores(id),product_id uuid REFERENCES products(id),price integer NOT NULL CHECK(price>=0),
 stock integer NOT NULL CHECK(stock>=0),reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=stock),PRIMARY KEY(store_id,product_id)
);
CREATE TABLE favorites (user_id uuid REFERENCES users(id),product_id uuid REFERENCES products(id),PRIMARY KEY(user_id,product_id));
CREATE TABLE carts (user_id uuid PRIMARY KEY REFERENCES users(id),store_id uuid NOT NULL REFERENCES stores(id));
CREATE TABLE cart_items (user_id uuid REFERENCES carts(user_id) ON DELETE CASCADE,product_id uuid REFERENCES products(id),quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),PRIMARY KEY(user_id,product_id));
CREATE TABLE promotions (
 code text PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('PERCENT','FIXED','FREE_DELIVERY','GIFT')),value integer NOT NULL DEFAULT 0 CHECK(value>=0),
 gift_product_id uuid REFERENCES products(id),trigger_product_ids jsonb NOT NULL DEFAULT '[]',
 minimum_order integer NOT NULL DEFAULT 0 CHECK(minimum_order>=0),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 usage_limit integer NOT NULL CHECK(usage_limit>0),used integer NOT NULL DEFAULT 0 CHECK(used>=0),active boolean NOT NULL DEFAULT true
);
CREATE SEQUENCE order_number;
CREATE TABLE orders (
 id uuid PRIMARY KEY,number bigint NOT NULL DEFAULT nextval('order_number') UNIQUE,user_id uuid NOT NULL REFERENCES users(id),store_id uuid NOT NULL REFERENCES stores(id),
 status text NOT NULL CHECK(status IN ('AWAITING_PAYMENT','CONFIRMED','PICKING','READY','DELIVERING','DELIVERED','CANCELLED','RETURNING','RETURNED')),
 payment_method text NOT NULL CHECK(payment_method IN ('CASH','QR')),payment_status text NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN ('UNPAID','PAID','REFUND_PENDING','REFUNDED')),
 subtotal integer NOT NULL CHECK(subtotal>=0),discount integer NOT NULL DEFAULT 0 CHECK(discount>=0),delivery_fee integer NOT NULL CHECK(delivery_fee>=0),total integer NOT NULL CHECK(total>=0),
 address_snapshot jsonb NOT NULL,pricing_snapshot jsonb NOT NULL DEFAULT '{}',email text,courier_comment text NOT NULL DEFAULT '',cash_change_from integer,promo_code text REFERENCES promotions(code),
 idempotency_key text NOT NULL,request_hash text NOT NULL,expires_at timestamptz,waiting_until timestamptz,
 CHECK(discount<=subtotal AND total=subtotal-discount+delivery_fee),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,idempotency_key)
);
CREATE TABLE order_items (
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES orders(id),product_id uuid NOT NULL REFERENCES products(id),
 name_snapshot jsonb NOT NULL,unit_snapshot text NOT NULL,unit_price integer NOT NULL CHECK(unit_price>=0),quantity integer NOT NULL CHECK(quantity>0),
 picking_status text NOT NULL DEFAULT 'PENDING' CHECK(picking_status IN ('PENDING','PICKED','EXCLUDED','REPLACED')),
 replacement_product_id uuid REFERENCES products(id),replacement_price integer CHECK(replacement_price>=0),
 replacement_name jsonb,replacement_status text CHECK(replacement_status IN ('PROPOSED','ACCEPTED','REJECTED')),reserved_quantity integer NOT NULL CHECK(reserved_quantity>=0)
);
CREATE TABLE promotion_redemptions (code text REFERENCES promotions(code),user_id uuid REFERENCES users(id),order_id uuid REFERENCES orders(id),PRIMARY KEY(code,user_id));
CREATE TABLE order_status_history (id bigserial PRIMARY KEY,order_id uuid REFERENCES orders(id),status text NOT NULL,actor_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE picking_tasks (order_id uuid PRIMARY KEY REFERENCES orders(id),picker_id uuid REFERENCES users(id),claimed_at timestamptz,completed_at timestamptz);
CREATE TABLE courier_shifts (id uuid PRIMARY KEY,courier_id uuid REFERENCES users(id),started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz);
CREATE UNIQUE INDEX one_active_shift ON courier_shifts(courier_id) WHERE ended_at IS NULL;
CREATE TABLE delivery_tasks (order_id uuid PRIMARY KEY REFERENCES orders(id),courier_id uuid REFERENCES users(id),claimed_at timestamptz,picked_up_at timestamptz,arrived_at timestamptz,completed_at timestamptz,shift_id uuid REFERENCES courier_shifts(id));
CREATE TABLE courier_earnings (order_id uuid PRIMARY KEY REFERENCES orders(id),courier_id uuid REFERENCES users(id),shift_id uuid REFERENCES courier_shifts(id),amount integer NOT NULL CHECK(amount>=0),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ratings (order_id uuid PRIMARY KEY REFERENCES orders(id),user_id uuid REFERENCES users(id),courier_id uuid NOT NULL REFERENCES users(id),score integer NOT NULL CHECK(score BETWEEN 1 AND 5),comment text NOT NULL DEFAULT '');
CREATE TABLE payments (
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES orders(id),amount integer NOT NULL CHECK(amount>=0),status text NOT NULL CHECK(status IN ('PENDING','PAID','FAILED','EXPIRED')),
 provider text NOT NULL,idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(order_id,idempotency_key)
);
CREATE TABLE payment_events (provider_event_id text PRIMARY KEY,payment_id uuid REFERENCES payments(id),payload_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE refunds (id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES orders(id),amount integer NOT NULL CHECK(amount>0),status text NOT NULL CHECK(status IN ('PENDING','COMPLETED','FAILED')),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE support_threads (id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),order_id uuid REFERENCES orders(id),status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE support_messages (id uuid PRIMARY KEY,thread_id uuid REFERENCES support_threads(id),author_id uuid REFERENCES users(id),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE content (id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('BANNER','STORY','NOTICE','DOCUMENT','COLLECTION')),title jsonb NOT NULL,body jsonb NOT NULL DEFAULT '{}',image_url text,product_ids jsonb NOT NULL DEFAULT '[]',active boolean NOT NULL DEFAULT true,sort integer NOT NULL DEFAULT 0);
CREATE TABLE events (id bigserial PRIMARY KEY,user_id uuid REFERENCES users(id),store_id uuid REFERENCES stores(id),role text,type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs (id uuid PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,run_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0,completed_at timestamptz,last_error text);
CREATE TABLE audit_logs (id bigserial PRIMARY KEY,actor_id uuid REFERENCES users(id),action text NOT NULL,entity_id text,payload jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX orders_user_created ON orders(user_id,created_at DESC);
CREATE INDEX orders_store_status ON orders(store_id,status);
CREATE INDEX items_order ON order_items(order_id);
CREATE INDEX events_user_id ON events(user_id,id);
CREATE INDEX events_store_role ON events(store_id,role,id);
CREATE INDEX jobs_due ON jobs(run_at) WHERE completed_at IS NULL;
CREATE INDEX messages_thread ON support_messages(thread_id,created_at);
