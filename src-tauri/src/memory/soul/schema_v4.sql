CREATE TABLE soul_topic_responses (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, topic_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL, proposed_state TEXT, proposed_time TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected')),
 created_at INTEGER NOT NULL, reviewed_at INTEGER
);
CREATE TABLE soul_continuity_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 history_enabled INTEGER NOT NULL DEFAULT 0, enabled_at INTEGER NOT NULL,
 timezone TEXT NOT NULL, nickname TEXT
);
CREATE TABLE soul_evidence (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_ref TEXT NOT NULL,
 field TEXT NOT NULL, value TEXT NOT NULL, occurred_at INTEGER NOT NULL,
 UNIQUE(conversation_id,field,value)
);
CREATE TABLE soul_evolution_pauses (field TEXT PRIMARY KEY, paused_at INTEGER NOT NULL);
CREATE TABLE soul_output_observations (
 output_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, output_kind TEXT NOT NULL,
 observed_at INTEGER, evidence_kind TEXT, source_ref TEXT NOT NULL
);
CREATE TABLE soul_category_baselines(category TEXT PRIMARY KEY, enabled_since INTEGER NOT NULL);
ALTER TABLE soul_output_observations ADD COLUMN owner_window TEXT NOT NULL DEFAULT '';
CREATE TABLE soul_observation_sources(observation_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(observation_id,source_id));
