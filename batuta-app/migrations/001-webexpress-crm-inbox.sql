-- Preparation only; NOT applied remotely. Dedicated Web Express table, no academic tables changed.
CREATE TABLE IF NOT EXISTS webexpress_crm_inbox (
 event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 250),
 phone_id TEXT NOT NULL CHECK(phone_id='1224297864110431'),
 waba_id TEXT NOT NULL CHECK(waba_id='2090741322318574'),
 from_phone TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',timestamp_ms INTEGER NOT NULL,
 message_type TEXT NOT NULL,body TEXT,media_id TEXT,
 review_state TEXT NOT NULL,reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state='none'),
 created_at INTEGER NOT NULL,acked_at INTEGER,
 PRIMARY KEY(phone_id,event_id)
);
CREATE INDEX IF NOT EXISTS webexpress_crm_pending ON webexpress_crm_inbox(phone_id,waba_id,acked_at,created_at,event_id);

CREATE TABLE IF NOT EXISTS webexpress_crm_issues(change_hash TEXT PRIMARY KEY CHECK(length(change_hash)=64),reason TEXT NOT NULL,byte_count INTEGER NOT NULL,created_at INTEGER NOT NULL);
