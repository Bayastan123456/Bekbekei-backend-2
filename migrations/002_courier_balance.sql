CREATE TABLE settings (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO settings(key,value) VALUES('courier_delivery_rate','8000');
CREATE TABLE courier_payouts (
 id uuid PRIMARY KEY,courier_id uuid NOT NULL REFERENCES users(id),amount integer NOT NULL CHECK(amount>0),
 comment text NOT NULL DEFAULT '',actor_id uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courier_payouts_courier ON courier_payouts(courier_id,created_at);
