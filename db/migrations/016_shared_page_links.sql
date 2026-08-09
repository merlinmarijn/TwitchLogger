CREATE TABLE IF NOT EXISTS shared_page_links (
  alias text PRIMARY KEY,
  page_search text NOT NULL CHECK (
    char_length(page_search) BETWEEN 0 AND 50000
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT shared_page_links_alias_format CHECK (
    alias ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'
  ),
  CONSTRAINT shared_page_links_future_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS shared_page_links_expires_at_idx
  ON shared_page_links (expires_at);
