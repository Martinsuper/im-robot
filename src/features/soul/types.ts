/** Wire contract with memory::soul::model. Times are Unix seconds.
 * Registered and reserved commands/events are listed in the design contract;
 * importing these types does not enable proactive delivery.
 */
export type ProactiveCategory =
  | "task_unresolved"
  | "open_loop"
  | "greeting"
  | "milestone"
  | "pattern"
  | "small_talk"
  | "output_feedback"
  | "desktop_observation";

export type DeliveryState =
  | "pending"
  | "dispatching"
  | "shown"
  | "responded"
  | "dismissed"
  | "ignored"
  | "revoked"
  | "expired"
  | "failed"
  | "uncertain";

export type OpenLoopState =
  | "pending_review"
  | "tracking"
  | "due"
  | "closed"
  | "cancelled"
  | "expired";

export interface SourceRef {
  kind: string;
  id: string;
  revision: number;
}

export interface ProactiveMessage {
  id: string;
  category: ProactiveCategory;
  source: SourceRef;
  dedupe_key: string;
  template_id: string;
  valid_from: number;
  expires_at: number;
  state: DeliveryState;
}

export interface ActivitySnapshot {
  observed_at: number;
  locked: boolean | null;
  idle: boolean | null;
  typing: boolean | null;
  agent_busy: boolean | null;
  awaiting_confirmation: boolean | null;
  pet_visible: boolean | null;
  quiet_mode: boolean | null;
}

export interface RoleProfile {
  profile_id: string;
  schema_version: number;
  revision: number;
  default_resource_version: string;
  user_overrides: Record<string, unknown>;
  confirmed_evolution: Record<string, unknown>;
  updated_at: number;
}

export interface RoleOverrides {
  background?: string;
  values?: string[];
  tone?: string;
  catchphrases?: string[];
  forbidden_phrases?: string[];
  care?: string;
  stance?: string;
  extra?: string;
}

export interface RoleContent {
  background: string;
  values: string[];
  tone: string;
  catchphrases: string[];
  forbidden_phrases: string[];
  care: string;
  stance: string;
  extra: string;
}

export interface RoleSnapshot {
  profile_id: string;
  schema_version: number;
  revision: number;
  default_resource_version: string;
  locale: string;
  user_overrides: RoleOverrides;
  effective: RoleContent;
  writable: boolean;
  fallback_reason: string | null;
  mood?: "happy" | "stifled" | "energized" | null;
}

export interface UpdateRoleInput {
  expected_revision: number;
  locale: string;
  user_overrides: RoleOverrides;
}

export interface ResetRoleInput {
  expected_revision: number;
  locale: string;
  clear_evolution_history: boolean;
}

export interface SoulDiagnostics {
  storage: "available" | "unavailable" | "volatile";
  schema_version: number | null;
  profile_valid: boolean;
  ledger_readable: boolean;
  proactive_enabled: boolean;
  issues: string[];
}

export type CandidateStatus = "pending_review" | "approved" | "rejected";

export interface OpenLoopTime {
  expression: string | null;
  baseline: number;
  timezone: string;
  starts_at: number | null;
  ends_at: number | null;
  parser_version: string;
}

export interface OpenLoop {
  id: string;
  revision: number;
  content: string;
  source: SourceRef;
  time: OpenLoopTime;
  state: OpenLoopState;
  closed_at: number | null;
}

export interface OpenLoopCandidate {
  id: string;
  source: SourceRef;
  dedupe_key: string;
  content: string;
  time: OpenLoopTime;
  status: CandidateStatus;
  created_at: number;
  reviewed_at: number | null;
}

export interface CategorySetting {
  category: ProactiveCategory;
  enabled: boolean;
  available: boolean;
  enabled_since: number | null;
  daily_limit: number;
}

export interface SoulSettings {
  revision: number;
  enabled: boolean;
  paused: boolean;
  enabled_since: number | null;
  categories: CategorySetting[];
  mood_enabled: boolean;
  evolution_enabled: boolean;
  daily_limit: number;
  cooldown_seconds: number;
}

export interface MessageReceipt {
  message_id: string;
  kind: "shown" | "responded" | "dismissed" | "hidden" | "delivery_failed";
  visible_seconds: number;
}

export interface ReviewOpenLoopInput {
  candidate_id: string;
  decision: CandidateStatus;
  content: string | null;
  time: OpenLoopTime | null;
}

export interface UpdateOpenLoopInput {
  id: string;
  expected_revision: number;
  content: string | null;
  time: OpenLoopTime | null;
  state: OpenLoopState | null;
}

export interface UpdateSoulSettingsInput {
  expected_revision: number;
  enabled: boolean | null;
  paused: boolean | null;
  categories: CategorySetting[] | null;
  mood_enabled: boolean | null;
  evolution_enabled: boolean | null;
}

export type SoulDataScope = "profile" | "open_loops" | "proactive" | "mood" | "history" | "all";
export interface ClearSoulInput { scopes: SoulDataScope[] }
export interface ListOpenLoopsInput { state: OpenLoopState | null }

export interface OpenLoopReviewCandidate {
  candidate: OpenLoopCandidate;
  similar_candidate_ids: string[];
  similar_loop_ids: string[];
}

export interface OpenLoopReviewQueue {
  candidates: OpenLoopReviewCandidate[];
  active_count: number;
  active_limit: number;
}
