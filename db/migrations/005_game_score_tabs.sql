ALTER TABLE chat_tabs
  DROP CONSTRAINT IF EXISTS chat_tabs_layout_check;

ALTER TABLE chat_tabs
  ADD CONSTRAINT chat_tabs_layout_check
  CHECK (layout IN ('chat', 'gallery', 'scores'));
