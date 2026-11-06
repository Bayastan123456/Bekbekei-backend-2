ALTER TABLE support_threads ADD COLUMN updated_at timestamptz;
UPDATE support_threads SET updated_at=created_at;
ALTER TABLE support_threads ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE support_threads ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE support_messages ADD COLUMN client_message_id uuid;
CREATE UNIQUE INDEX support_message_client_key ON support_messages(thread_id,author_id,client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX support_message_cursor ON support_messages(thread_id,created_at,id);
