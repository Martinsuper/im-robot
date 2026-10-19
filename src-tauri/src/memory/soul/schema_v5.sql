CREATE TABLE soul_proactive_ledger_v5 (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('task_unresolved','open_loop','greeting','milestone','pattern','small_talk','output_feedback','desktop_observation')),
    source_ref TEXT NOT NULL CHECK(json_valid(source_ref)),
    dedupe_key TEXT NOT NULL UNIQUE, template_id TEXT NOT NULL,
    valid_from INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > valid_from),
    state TEXT NOT NULL CHECK(state IN ('pending','dispatching','shown','responded','dismissed','ignored','revoked','expired','failed','uncertain')),
    created_at INTEGER NOT NULL, dispatching_at INTEGER, shown_at INTEGER,
    receipt_at INTEGER, visible_seconds INTEGER NOT NULL DEFAULT 0 CHECK(visible_seconds >= 0)
);

INSERT INTO soul_proactive_ledger_v5 SELECT * FROM soul_proactive_ledger;
DROP TABLE soul_proactive_ledger;
ALTER TABLE soul_proactive_ledger_v5 RENAME TO soul_proactive_ledger;
CREATE INDEX soul_ledger_pending ON soul_proactive_ledger(state,valid_from,expires_at);
CREATE TABLE soul_desktop_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 1,
 frequency TEXT NOT NULL DEFAULT 'natural', excluded_apps TEXT NOT NULL DEFAULT '[]',
 last_attempt INTEGER NOT NULL DEFAULT 0, budget_date TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO soul_desktop_control(singleton) VALUES(1);
