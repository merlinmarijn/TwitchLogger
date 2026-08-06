-- Keep the oldest hot message as the gallery owner for each image URL. The
-- image re-index job applies the same rule across hot and cold storage.
WITH message_images AS (
  SELECT DISTINCT m.id, m.timestamp, image.value AS image_url
  FROM chat_messages AS m
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(m.image_urls, '[]'::jsonb)
  ) AS image(value)
  WHERE m.deleted_at IS NULL
),
ranked_images AS (
  SELECT id, image_url,
         row_number() OVER (
           PARTITION BY image_url ORDER BY timestamp, id
         ) AS occurrence
  FROM message_images
),
duplicate_images AS (
  SELECT id, jsonb_agg(image_url ORDER BY image_url) AS image_urls
  FROM ranked_images
  WHERE occurrence > 1
  GROUP BY id
),
cleaned_messages AS (
  SELECT
    m.id,
    (
      SELECT COALESCE(jsonb_agg(image.value ORDER BY image.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements_text(
        COALESCE(m.image_urls, '[]'::jsonb)
      ) WITH ORDINALITY AS image(value, ordinality)
      WHERE NOT (duplicates.image_urls ? image.value)
    ) AS image_urls,
    (
      SELECT COALESCE(jsonb_agg(hidden.value ORDER BY hidden.value), '[]'::jsonb)
      FROM (
        SELECT value
        FROM jsonb_array_elements_text(
          COALESCE(m.hidden_image_urls, '[]'::jsonb)
        ) AS existing(value)
        UNION
        SELECT value
        FROM jsonb_array_elements_text(duplicates.image_urls) AS duplicate(value)
      ) AS hidden(value)
    ) AS hidden_image_urls
  FROM chat_messages AS m
  JOIN duplicate_images AS duplicates ON duplicates.id = m.id
)
UPDATE chat_messages AS message
SET image_urls = cleaned.image_urls,
    hidden_image_urls = cleaned.hidden_image_urls,
    has_images = jsonb_array_length(cleaned.image_urls) > 0,
    gallery_channel_id = CASE
      WHEN jsonb_array_length(cleaned.image_urls) > 0 THEN message.channel_id
      ELSE NULL
    END
FROM cleaned_messages AS cleaned
WHERE message.id = cleaned.id;
