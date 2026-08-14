ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_message_type_fk;

ALTER TABLE chat_message_types
  ALTER COLUMN id TYPE integer;

ALTER TABLE chat_messages
  ALTER COLUMN message_type_id TYPE integer;

ALTER SEQUENCE chat_message_types_id_seq
  AS integer
  NO MAXVALUE;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_message_type_fk
  FOREIGN KEY (message_type_id) REFERENCES chat_message_types(id);
