CREATE TABLE soul_candidate_tombstones (
    dedupe_key TEXT PRIMARY KEY, source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    retired_at INTEGER NOT NULL
);
CREATE TABLE soul_delivery_tombstones (
    dedupe_key TEXT PRIMARY KEY, source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    retired_at INTEGER NOT NULL
);
CREATE TABLE soul_source_tombstones (
    source_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL
);
CREATE TABLE soul_domain_baselines (
    domain TEXT PRIMARY KEY, cleared_through INTEGER NOT NULL
);
CREATE TABLE soul_task_links (task_id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
CREATE TABLE soul_task_followups (
    root_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('needs_check','resolved')),
    updated_at INTEGER NOT NULL
);
