CREATE TABLE soul_profiles (
    profile_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    default_resource_version TEXT NOT NULL,
    user_overrides TEXT NOT NULL CHECK(json_valid(user_overrides)),
    confirmed_evolution TEXT NOT NULL CHECK(json_valid(confirmed_evolution)),
    updated_at INTEGER NOT NULL
);
CREATE TABLE soul_role_versions (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, revision INTEGER NOT NULL,
    source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), created_at INTEGER NOT NULL,
    UNIQUE(profile_id, revision)
);
CREATE TABLE soul_candidates (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    dedupe_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected')),
    created_at INTEGER NOT NULL, reviewed_at INTEGER
);
CREATE TABLE soul_open_loops (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1),
    content TEXT NOT NULL, source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    candidate_id TEXT UNIQUE,
    time_expression TEXT, time_baseline INTEGER NOT NULL, timezone TEXT NOT NULL,
    starts_at INTEGER, ends_at INTEGER, parser_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending_review','tracking','due','closed','cancelled','expired')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER,
    CHECK((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at >= starts_at))
);
CREATE INDEX soul_open_loops_state ON soul_open_loops(state, ends_at);
CREATE TRIGGER soul_open_loops_capacity_insert BEFORE INSERT ON soul_open_loops
WHEN NEW.state IN ('tracking','due') AND (SELECT count(*) FROM soul_open_loops WHERE state IN ('tracking','due')) >= __MAX_ACTIVE_LOOPS__
BEGIN SELECT RAISE(ABORT, 'Active open loop limit reached'); END;
CREATE TRIGGER soul_open_loops_capacity_update BEFORE UPDATE OF state ON soul_open_loops
WHEN NEW.state IN ('tracking','due') AND OLD.state NOT IN ('tracking','due') AND (SELECT count(*) FROM soul_open_loops WHERE state IN ('tracking','due')) >= __MAX_ACTIVE_LOOPS__
BEGIN SELECT RAISE(ABORT, 'Active open loop limit reached'); END;
CREATE TABLE soul_proactive_ledger (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('task_unresolved','open_loop','greeting','milestone','pattern','small_talk','output_feedback')),
    source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    dedupe_key TEXT NOT NULL UNIQUE, template_id TEXT NOT NULL,
    valid_from INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > valid_from),
    state TEXT NOT NULL CHECK(state IN ('pending','dispatching','shown','responded','dismissed','ignored','revoked','expired','failed','uncertain')),
    created_at INTEGER NOT NULL, dispatching_at INTEGER, shown_at INTEGER,
    receipt_at INTEGER, visible_seconds INTEGER NOT NULL DEFAULT 0 CHECK(visible_seconds >= 0)
);
CREATE INDEX soul_ledger_pending ON soul_proactive_ledger(state, valid_from, expires_at);
-- One persistent quota bucket, never separate fresh buckets per timezone.
CREATE TABLE soul_quota (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    local_date TEXT NOT NULL, timezone TEXT NOT NULL,
    high_water_at INTEGER NOT NULL, reset_not_before INTEGER NOT NULL,
    total_used INTEGER NOT NULL CHECK(total_used >= 0),
    category_used TEXT NOT NULL CHECK(json_valid(category_used)),
    last_dispatch_at INTEGER
);
CREATE TABLE soul_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision >= 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
    enabled_since INTEGER NOT NULL, cleared_through INTEGER NOT NULL,
    category_settings TEXT NOT NULL CHECK(json_valid(category_settings))
);
CREATE TABLE soul_backoff (
    category TEXT PRIMARY KEY, consecutive_ignored INTEGER NOT NULL DEFAULT 0,
    last_ignored_at INTEGER, recover_after INTEGER
);
CREATE TABLE soul_mood_snapshot (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), rule_version INTEGER NOT NULL,
    scores TEXT NOT NULL CHECK(json_valid(scores)), current_mood TEXT NOT NULL,
    last_decay_at INTEGER NOT NULL
);
CREATE TABLE soul_events (
    dedupe_key TEXT PRIMARY KEY, kind TEXT NOT NULL,
    source_ref TEXT NOT NULL CHECK(json_valid(source_ref)), occurred_at INTEGER NOT NULL
);
CREATE TABLE soul_history_baseline (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled_at INTEGER NOT NULL,
    local_date TEXT NOT NULL, timezone TEXT NOT NULL
);
CREATE TABLE soul_milestones (
    milestone_key TEXT PRIMARY KEY, achieved_at INTEGER NOT NULL,
    event_ref TEXT NOT NULL CHECK(json_valid(event_ref))
);
