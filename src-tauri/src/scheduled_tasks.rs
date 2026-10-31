//! 定时委托（doc/design/18 §9）：`scheduled_tasks.json` 存 app_data_dir，
//! SUPERVISOR 常驻线程自适应轮询到期项，经 start_agent 同路径拉起 coding 任务。
//! 状态机 pending → fired →（任务终态回调）completed/failed/cancelled；
//! 取消复用 agent_cancel 同路径；workspace 互斥冲突时优雅失败（failed + 原因）。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// 定时任务条目上限（防止 storage 无界增长；淘汰最旧的终态记录）。
const MAX_SCHEDULED_TASKS: usize = 100;
/// conversationId 前缀（§9）：`scheduled-<projectId|目录哈希>`，与用户会话隔离。
const CONVERSATION_PREFIX: &str = "scheduled-";
/// 目录哈希长度（sha256 截断 64 bit），足够隔离不同工作目录。
const WORKSPACE_HASH_BYTES: usize = 8;
/// fired 状态的对账宽限：标记 fired 后启动任务在秒级完成，超过宽限仍无活动记录才按异常归类。
const RECONCILE_GRACE_SECS: u64 = 120;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledTask {
    pub(crate) id: String,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) project_id: Option<String>,
    #[serde(default)]
    pub(crate) workspace: Option<String>,
    /// 自主权档位名（doc/design/18 §5）：缺省时与 coding 标准一致。
    #[serde(default)]
    pub(crate) policy: Option<String>,
    /// 预算分钟数：缺省 90（coding 默认）。
    #[serde(default)]
    pub(crate) time_minutes: Option<u64>,
    pub(crate) scheduled_at: u64,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) fired_request_id: Option<String>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    pub(crate) created_at: u64,
    #[serde(default)]
    pub(crate) updated_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledTaskInput {
    prompt: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    policy: Option<String>,
    #[serde(default)]
    time_minutes: Option<u64>,
    /// 到期时间（unix 秒）。
    scheduled_at: u64,
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("scheduled_tasks.json"))
}

fn agent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("agent"))
}

/// 磁盘布局按创建时间正序（最旧在前）；过滤掉损坏条目而不是让整个列表不可用。
fn load(path: &Path) -> Result<Vec<ScheduledTask>, String> {
    Ok(crate::storage::read::<Vec<ScheduledTask>>(path)?
        .into_iter()
        .filter(|task| !task.id.is_empty())
        .collect())
}

fn save(path: &Path, tasks: &[ScheduledTask]) -> Result<(), String> {
    crate::storage::write(path, tasks)
}

fn new_id() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    format!("s-{:x}{:x}", nanos, u64::from_le_bytes(bytes))
}

fn optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn canonical_workspace(path: &str) -> Result<String, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|_| "工作目录不存在或无法访问".to_string())?;
    if !canonical.is_dir() {
        return Err("请选择文件夹作为工作目录".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// §9：conversationId 取 `scheduled-<projectId|目录哈希>`；同项目/同目录复用会话，跨目录隔离。
fn scheduled_conversation_id(task: &ScheduledTask) -> Result<String, String> {
    let suffix = if let Some(project_id) = optional(&task.project_id) {
        project_id
    } else {
        let workspace = optional(&task.workspace).ok_or("定时任务缺少项目与工作目录")?;
        directory_hash(Path::new(&canonical_workspace(&workspace)?))
    };
    let id = format!("{CONVERSATION_PREFIX}{suffix}");
    if !crate::agent::valid_id(&id) {
        return Err("定时任务会话标识无效".into());
    }
    Ok(id)
}

fn directory_hash(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest
        .iter()
        .take(WORKSPACE_HASH_BYTES)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 档位名 → start 策略输入；缺省 None 时宿主按 coding 标准裁决。
fn policy_input(name: Option<&str>) -> Result<Option<crate::agent::TaskPolicyInput>, String> {
    let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    let preset = crate::agent::policy_preset(name)
        .ok_or("无效的自主权档位，仅支持 cautious/standard/trusted")?;
    Ok(Some(crate::agent::TaskPolicyInput {
        workspace_files: preset["workspaceFiles"].as_str().map(str::to_string),
        shell: preset["shell"].as_str().map(str::to_string),
        outside_workspace: preset["outsideWorkspace"].as_str().map(str::to_string),
    }))
}

fn create_at(path: &Path, input: ScheduledTaskInput, now: u64) -> Result<ScheduledTask, String> {
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("任务描述不能为空".into());
    }
    if prompt.len() > 100_000 {
        return Err("任务描述最多 100 KB".into());
    }
    let project_id = optional(&input.project_id);
    if let Some(id) = &project_id {
        if !crate::agent::valid_id(id) {
            return Err("无效的项目标识".into());
        }
    }
    let workspace = match optional(&input.workspace) {
        Some(workspace) => Some(canonical_workspace(&workspace)?),
        None => None,
    };
    if project_id.is_none() && workspace.is_none() {
        return Err("定时任务需要项目或工作目录".into());
    }
    if let Some(policy) = optional(&input.policy) {
        if crate::agent::policy_preset(&policy).is_none() {
            return Err("无效的自主权档位，仅支持 cautious/standard/trusted".into());
        }
    }
    if input
        .time_minutes
        .is_some_and(|minutes| minutes > crate::agent::MAX_BUDGET_MINUTES)
    {
        return Err("任务预算超出范围（最多 7 天）".into());
    }
    if input.scheduled_at < now {
        return Err("定时时间必须在未来".into());
    }
    let _transaction = crate::storage::transaction();
    let mut tasks = load(path)?;
    if tasks.len() >= MAX_SCHEDULED_TASKS {
        if let Some(oldest) = tasks
            .iter()
            .position(|task| task.status != "pending" && task.status != "fired")
        {
            tasks.remove(oldest);
        } else {
            return Err("定时任务数量已达上限".into());
        }
    }
    let task = ScheduledTask {
        id: new_id(),
        prompt,
        project_id,
        workspace,
        policy: optional(&input.policy),
        time_minutes: input.time_minutes,
        scheduled_at: input.scheduled_at,
        status: "pending".into(),
        fired_request_id: None,
        reason: None,
        created_at: now,
        updated_at: now,
    };
    tasks.push(task.clone());
    save(path, &tasks)?;
    Ok(task)
}

/// pending → cancelled；fired 任务返回原状态由调用方走 agent_cancel，终态回调迁移状态。
fn cancel_at(path: &Path, id: &str, now: u64) -> Result<ScheduledTask, String> {
    let _transaction = crate::storage::transaction();
    let mut tasks = load(path)?;
    let task = tasks
        .iter_mut()
        .find(|task| task.id == id)
        .ok_or("定时任务不存在")?;
    match task.status.as_str() {
        "pending" => {
            task.status = "cancelled".into();
            task.reason = Some("用户取消".into());
            task.updated_at = now;
        }
        "fired" => {}
        _ => return Err("该任务已结束，无法取消".into()),
    }
    let cancelled = task.clone();
    save(path, &tasks)?;
    Ok(cancelled)
}

/// 纯函数：把到期 pending 项标记为 fired 并生成运行 request_id（防重复拉起先落盘）。
fn collect_due(tasks: &mut [ScheduledTask], now: u64) -> Vec<ScheduledTask> {
    let mut due = Vec::new();
    for task in tasks {
        if task.status == "pending" && task.scheduled_at <= now {
            task.status = "fired".into();
            task.fired_request_id = Some(format!("sched-{}", task.id));
            task.updated_at = now;
            due.push(task.clone());
        }
    }
    due
}

/// 到期失败：优雅失败（failed + 原因），不重试。
fn fail_at(path: &Path, id: &str, reason: &str, now: u64) -> Result<(), String> {
    let _transaction = crate::storage::transaction();
    let mut tasks = load(path)?;
    let Some(task) = tasks.iter_mut().find(|task| task.id == id) else {
        return Ok(());
    };
    // 终态回调已迁移状态时不再回写失败。
    if task.status == "fired" {
        task.status = "failed".into();
        task.reason = Some(reason.chars().take(200).collect());
        task.updated_at = now;
        save(path, &tasks)?;
    }
    Ok(())
}

/// agent.rs 终态回调：fired 任务的定时记录随任务终态迁移（§9 状态机）。
pub(crate) fn on_agent_terminal(app: &AppHandle, request_id: &str, kind: &str) {
    let Ok(path) = file_path(app) else {
        return;
    };
    match terminal_update_at(&path, request_id, kind, crate::common::unix_timestamp()) {
        Ok(true) => {
            let _ = app.emit("scheduled-tasks-updated", ());
        }
        Ok(false) => {}
        Err(error) => eprintln!("[scheduled-tasks] {error}"),
    }
}

fn terminal_update_at(path: &Path, request_id: &str, kind: &str, now: u64) -> Result<bool, String> {
    let status = match kind {
        "completed" => "completed",
        "cancelled" => "cancelled",
        _ => "failed",
    };
    let _transaction = crate::storage::transaction();
    let mut tasks = load(path)?;
    let Some(task) = tasks.iter_mut().find(|task| {
        task.status == "fired" && task.fired_request_id.as_deref() == Some(request_id)
    }) else {
        return Ok(false);
    };
    task.status = status.to_string();
    task.updated_at = now;
    save(path, &tasks)?;
    Ok(true)
}

/// 崩溃恢复：fired 状态超过宽限期仍无进行中任务记录的，按记录终态归类。
/// 记录进行中（running/waiting）保持 fired；记录丢失按失败处理。
fn reconcile_fired_at(
    path: &Path,
    records: &[crate::agent::journal::TaskRecord],
    now: u64,
) -> Result<bool, String> {
    let _transaction = crate::storage::transaction();
    let mut tasks = load(path)?;
    let mut changed = false;
    for task in &mut tasks {
        if task.status != "fired" || task.updated_at + RECONCILE_GRACE_SECS > now {
            continue;
        }
        let request_id = task.fired_request_id.clone().unwrap_or_default();
        let target = match records
            .iter()
            .find(|record| record.request_id == request_id)
            .map(|record| record.status.as_str())
        {
            Some("running" | "waiting") => None,
            Some("completed") => Some(("completed", None)),
            Some("cancelled") => Some(("cancelled", None)),
            Some(_) => Some(("failed", Some("任务进程中断"))),
            None => Some(("failed", Some("任务未启动或运行记录已丢失"))),
        };
        if let Some((status, reason)) = target {
            task.status = status.to_string();
            if reason.is_some() {
                task.reason = reason.map(str::to_string);
            }
            task.updated_at = now;
            changed = true;
        }
    }
    if changed {
        save(path, &tasks)?;
    }
    Ok(changed)
}

/// 组装 start 输入并经 start_agent 同路径拉起（复用 agent_concurrency 配额与系统工具锁）。
async fn start_scheduled_agent(
    app: &AppHandle,
    task: &ScheduledTask,
    request_id: &str,
) -> Result<(), String> {
    let conversation_id = scheduled_conversation_id(task)?;
    let input = crate::agent::AgentStartInput {
        request_id: request_id.to_string(),
        conversation_id,
        knowledge_scope: None,
        cwd: task.workspace.clone(),
        prompt: task.prompt.clone(),
        unified: false,
        import_history: false,
        attachment_action: None,
        context_id: None,
        screenshot: None,
        include_screenshot: None,
        verification_of: None,
        proactive_message_id: None,
        resume_of: None,
        task_kind: Some("coding".into()),
        policy: policy_input(task.policy.as_deref())?,
        budget: Some(crate::agent::TaskBudgetInput {
            time_minutes: task.time_minutes,
            token_budget: None,
        }),
        project_id: task.project_id.clone(),
        verify_command: None,
        git_mode: None,
    };
    crate::agent::start_agent(
        app.clone(),
        app.state::<crate::agent::AgentRuntime>(),
        input,
        false,
    )
    .await
}

async fn fire(app: &AppHandle, task: ScheduledTask) {
    let request_id = task
        .fired_request_id
        .clone()
        .unwrap_or_else(|| format!("sched-{}", task.id));
    match start_scheduled_agent(app, &task, &request_id).await {
        Ok(()) => {
            let head = task.prompt.chars().take(40).collect::<String>();
            crate::notifications::task_event(app, &request_id, "info", "定时任务已开始", &head);
        }
        Err(error) => {
            let reason = error.chars().take(200).collect::<String>();
            if let Ok(path) = file_path(app) {
                let _ = fail_at(&path, &task.id, &reason, crate::common::unix_timestamp());
            }
            let _ = app.emit("scheduled-tasks-updated", ());
            crate::notifications::task_event(
                app,
                &request_id,
                "error",
                "定时任务启动失败",
                &reason,
            );
        }
    }
}

pub(crate) fn process_due(app: &AppHandle) -> Result<(), String> {
    let path = file_path(app)?;
    let now = crate::common::unix_timestamp();
    reconcile_stale(app, &path, now)?;
    let due = {
        let _transaction = crate::storage::transaction();
        let mut tasks = load(&path)?;
        let due = collect_due(&mut tasks, now);
        if due.is_empty() {
            return Ok(());
        }
        save(&path, &tasks)?;
        due
    };
    for task in due {
        let app = app.clone();
        crate::background::SUPERVISOR.spawn_async_effect(
            "scheduled-fire",
            move |_worker| async move {
                fire(&app, task).await;
            },
        );
    }
    Ok(())
}

/// 仅当存在超过宽限期的 fired 记录时才读取任务 journal（对账崩溃遗留）。
fn reconcile_stale(app: &AppHandle, path: &Path, now: u64) -> Result<(), String> {
    let stale = load(path)?
        .iter()
        .any(|task| task.status == "fired" && task.updated_at + RECONCILE_GRACE_SECS <= now);
    if !stale {
        return Ok(());
    }
    let journal = crate::agent::journal::TaskJournal::new(&agent_dir(app)?);
    let records = app
        .state::<crate::agent::AgentRuntime>()
        .recover_tasks(&journal, now)?;
    if reconcile_fired_at(path, &records, now)? {
        let _ = app.emit("scheduled-tasks-updated", ());
    }
    Ok(())
}

/// 下次轮询间隔（参考 reminder scheduler 的自适应轮询）：最近的到期项驱动，1-60 秒。
fn next_poll_delay(path: &Path) -> u64 {
    let now = crate::common::unix_timestamp();
    load(path)
        .unwrap_or_default()
        .iter()
        .filter(|task| task.status == "pending")
        .map(|task| task.scheduled_at.saturating_sub(now).clamp(1, 60))
        .min()
        .unwrap_or(60)
}

pub(crate) fn watch_scheduled_tasks(app: &AppHandle) {
    let app = app.clone();
    crate::background::SUPERVISOR.spawn("scheduled-tasks", move |worker| {
        while !worker.cancelled() {
            let revision = crate::storage::revision();
            let result = process_due(&app);
            worker.health(result.as_ref().map(|_| ()).map_err(Clone::clone));
            if let Err(error) = result {
                eprintln!("[scheduled-tasks] {error}");
            }
            if worker.cancelled() {
                break;
            }
            let delay = file_path(&app)
                .map(|path| next_poll_delay(&path))
                .unwrap_or(60);
            crate::storage::wait_for_change_until(
                revision,
                std::time::Duration::from_secs(delay),
                || worker.cancelled(),
            );
        }
        Ok(())
    });
}

#[tauri::command]
pub(crate) fn scheduled_task_list(app: AppHandle) -> Result<Vec<ScheduledTask>, String> {
    let _lease = crate::data_gate::try_read()?;
    let mut tasks = load(&file_path(&app)?)?;
    tasks.reverse();
    Ok(tasks)
}

#[tauri::command]
pub(crate) fn scheduled_task_create(
    app: AppHandle,
    input: ScheduledTaskInput,
) -> Result<ScheduledTask, String> {
    let _lease = crate::data_gate::try_read()?;
    let created = create_at(&file_path(&app)?, input, crate::common::unix_timestamp())?;
    let _ = app.emit("scheduled-tasks-updated", ());
    Ok(created)
}

#[tauri::command]
pub(crate) async fn scheduled_task_cancel(app: AppHandle, id: String) -> Result<(), String> {
    let _lease = crate::data_gate::try_read()?;
    let task = cancel_at(&file_path(&app)?, &id, crate::common::unix_timestamp())?;
    if task.status == "fired" {
        // 运行中的任务复用 agent_cancel 同路径；定时状态由终态回调迁移。
        if let Some(request_id) = task.fired_request_id {
            crate::agent::agent_cancel(
                app.clone(),
                app.state::<crate::agent::AgentRuntime>(),
                request_id,
            )
            .await?;
        }
    }
    let _ = app.emit("scheduled-tasks-updated", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(scheduled_at: u64) -> ScheduledTaskInput {
        ScheduledTaskInput {
            prompt: "整理收件箱并总结".into(),
            project_id: None,
            workspace: None,
            policy: None,
            time_minutes: None,
            scheduled_at,
        }
    }

    fn store_path(directory: &Path) -> PathBuf {
        directory.join("scheduled_tasks.json")
    }

    fn task_with_workspace(directory: &Path, scheduled_at: u64) -> ScheduledTask {
        let mut input = input(scheduled_at);
        input.workspace = Some(directory.to_string_lossy().into_owned());
        create_at(&store_path(directory), input, 1).unwrap()
    }

    #[test]
    fn create_validates_prompt_workspace_policy_budget_and_time() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled_tasks.json");
        let mut task = input(2_000);
        // 缺项目与目录直接拒绝。
        assert!(create_at(&path, task.clone(), 1).is_err());
        task.workspace = Some(directory.path().to_string_lossy().into_owned());
        let created = create_at(&path, task, 1).unwrap();
        assert!(created.id.starts_with("s-"));
        assert_eq!(created.status, "pending");
        assert_eq!(created.scheduled_at, 2_000);
        // 工作目录被规范化为绝对路径。
        assert!(Path::new(created.workspace.as_deref().unwrap()).is_absolute());
        // 过去时间、非法档位、超预算、空描述都拒绝。
        let mut late = input(1);
        late.workspace = Some(directory.path().to_string_lossy().into_owned());
        assert!(create_at(&path, late, 2).is_err());
        let mut bad_policy = input(3_000);
        bad_policy.workspace = Some(directory.path().to_string_lossy().into_owned());
        bad_policy.policy = Some("trusted2".into());
        assert!(create_at(&path, bad_policy, 2).is_err());
        let mut huge = input(3_000);
        huge.workspace = Some(directory.path().to_string_lossy().into_owned());
        huge.time_minutes = Some(u64::MAX);
        assert!(create_at(&path, huge, 2).is_err());
        let mut empty = input(3_000);
        empty.prompt = "  ".into();
        empty.workspace = Some(directory.path().to_string_lossy().into_owned());
        assert!(create_at(&path, empty, 2).is_err());
        // 磁盘布局按创建时间正序（最旧在前）。
        let mut second = input(3_000);
        second.workspace = Some(directory.path().to_string_lossy().into_owned());
        create_at(&path, second, 2).unwrap();
        let listed = load(&path).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].created_at, 1);
        assert_eq!(listed[1].created_at, 2);
    }

    #[test]
    fn conversation_ids_are_stable_per_project_and_isolated_per_directory() {
        let directory = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut by_project = input(10);
        by_project.project_id = Some("p-abc123".into());
        let by_project = create_at(
            &directory.path().join("scheduled_tasks.json"),
            by_project,
            1,
        )
        .unwrap();
        assert_eq!(
            scheduled_conversation_id(&by_project).unwrap(),
            "scheduled-p-abc123"
        );
        // 目录哈希：同目录稳定，跨目录不同，且都是合法会话标识。
        let first = task_with_workspace(directory.path(), 10);
        let second = task_with_workspace(directory.path(), 10);
        let third = task_with_workspace(other.path(), 10);
        let first_id = scheduled_conversation_id(&first).unwrap();
        assert_eq!(first_id, scheduled_conversation_id(&second).unwrap());
        assert_ne!(first_id, scheduled_conversation_id(&third).unwrap());
        assert!(crate::agent::valid_id(&first_id));
        assert_eq!(first_id.len(), CONVERSATION_PREFIX.len() + 16);
        // 缺项目与目录的任务无法派生会话。
        let orphan = ScheduledTask {
            id: new_id(),
            prompt: "整理收件箱".into(),
            project_id: None,
            workspace: None,
            policy: None,
            time_minutes: None,
            scheduled_at: 10,
            status: "pending".into(),
            fired_request_id: None,
            reason: None,
            created_at: 1,
            updated_at: 1,
        };
        assert!(scheduled_conversation_id(&orphan).is_err());
    }

    #[test]
    fn only_pending_due_tasks_fire_and_the_marker_persists() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled_tasks.json");
        let due = task_with_workspace(directory.path(), 100);
        let future = task_with_workspace(directory.path(), 300);
        let cancelled = task_with_workspace(directory.path(), 50);
        cancel_at(&path, &cancelled.id, 60).unwrap();
        let mut tasks = load(&path).unwrap();
        let fired = collect_due(&mut tasks, 200);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, due.id);
        assert_eq!(fired[0].status, "fired");
        assert_eq!(fired[0].fired_request_id, Some(format!("sched-{}", due.id)));
        save(&path, &tasks).unwrap();
        // 标记落盘：未来的任务保持 pending，已取消的不动。
        let tasks = load(&path).unwrap();
        let by_id = |id: &str| tasks.iter().find(|task| task.id == id).unwrap();
        assert_eq!(by_id(&due.id).status, "fired");
        assert_eq!(by_id(&future.id).status, "pending");
        assert_eq!(by_id(&cancelled.id).status, "cancelled");
        // 已 fired 的不会重复拉起（时间取在 future 任务到期之前）。
        let mut tasks = load(&path).unwrap();
        assert!(collect_due(&mut tasks, 250).is_empty());
    }

    #[test]
    fn cancel_rejects_terminal_tasks_and_marks_pending_cancelled() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled_tasks.json");
        let task = task_with_workspace(directory.path(), 100);
        // fired 状态原样返回（由 agent_cancel 负责取消，终态回调迁移）。
        let mut tasks = load(&path).unwrap();
        collect_due(&mut tasks, 100);
        save(&path, &tasks).unwrap();
        let fired = cancel_at(&path, &task.id, 110).unwrap();
        assert_eq!(fired.status, "fired");
        let mut tasks = load(&path).unwrap();
        tasks[0].status = "completed".into();
        save(&path, &tasks).unwrap();
        assert!(cancel_at(&path, &task.id, 120).is_err());
        assert!(cancel_at(&path, "s-missing", 120).is_err());
        let pending = task_with_workspace(directory.path(), 500);
        let cancelled = cancel_at(&path, &pending.id, 510).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.reason.as_deref(), Some("用户取消"));
    }

    #[test]
    fn terminal_events_advance_fired_records_and_ignore_others() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled_tasks.json");
        let task = task_with_workspace(directory.path(), 100);
        let mut tasks = load(&path).unwrap();
        collect_due(&mut tasks, 100);
        save(&path, &tasks).unwrap();
        let request_id = format!("sched-{}", task.id);
        // 未匹配的任务 id 不改写任何状态。
        assert!(!terminal_update_at(&path, "sched-other", "completed", 110).unwrap());
        assert!(terminal_update_at(&path, &request_id, "completed", 110).unwrap());
        let status_of = |id: &str| {
            load(&path)
                .unwrap()
                .into_iter()
                .find(|task| task.id == id)
                .unwrap()
                .status
        };
        assert_eq!(status_of(&task.id), "completed");
        // 已终态的 fired 记录不会被迟到的回调改写。
        assert!(!terminal_update_at(&path, &request_id, "failed", 120).unwrap());
        // cancelled 终态映射为 cancelled。
        let second = task_with_workspace(directory.path(), 200);
        let mut tasks = load(&path).unwrap();
        collect_due(&mut tasks, 200);
        save(&path, &tasks).unwrap();
        assert!(
            terminal_update_at(&path, &format!("sched-{}", second.id), "cancelled", 210).unwrap()
        );
        assert_eq!(status_of(&second.id), "cancelled");
    }

    #[test]
    fn reconcile_classifies_stale_fired_records_by_journal_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled_tasks.json");
        let agent_dir = directory.path().join("agent");
        let journal = crate::agent::journal::TaskJournal::new(&agent_dir);
        // 四种遗留：journal 已完成、已中断、运行中、记录丢失。
        let completed = task_with_workspace(directory.path(), 100);
        let interrupted = task_with_workspace(directory.path(), 100);
        let missing = task_with_workspace(directory.path(), 100);
        let running = task_with_workspace(directory.path(), 100);
        let mut tasks = load(&path).unwrap();
        collect_due(&mut tasks, 100);
        save(&path, &tasks).unwrap();
        for task in [&completed, &interrupted, &running] {
            journal
                .start(&format!("sched-{}", task.id), "scheduled-x", 100)
                .unwrap();
        }
        journal
            .event(
                &format!("sched-{}", completed.id),
                &json!({"type":"completed"}),
                200,
            )
            .unwrap();
        // 与 watcher 相同的对账来源：recover_active 把孤儿记录标记为 interrupted，
        // 活动（在 slot 中）任务的记录保持 running。
        let running_request = format!("sched-{}", running.id);
        let records = journal
            .recover_active(&[running_request.as_str()], 1_000)
            .unwrap();
        // 宽限期内不对账（刚标记 fired 的任务可能正在启动）。
        assert!(!reconcile_fired_at(&path, &records, 150).unwrap());
        assert!(reconcile_fired_at(&path, &records, 1_000).unwrap());
        let tasks = load(&path).unwrap();
        let by_id = |id: &str| tasks.iter().find(|task| task.id == id).unwrap();
        assert_eq!(by_id(&completed.id).status, "completed");
        assert_eq!(by_id(&interrupted.id).status, "failed");
        assert_eq!(
            by_id(&interrupted.id).reason.as_deref(),
            Some("任务进程中断")
        );
        assert_eq!(by_id(&missing.id).status, "failed");
        assert_eq!(
            by_id(&missing.id).reason.as_deref(),
            Some("任务未启动或运行记录已丢失")
        );
        // 运行中的任务保持 fired。
        assert_eq!(by_id(&running.id).status, "fired");
    }

    #[test]
    fn policy_input_maps_presets_and_rejects_unknown_names() {
        assert!(policy_input(None).unwrap().is_none());
        assert!(policy_input(Some("")).unwrap().is_none());
        let standard = policy_input(Some("standard")).unwrap().unwrap();
        assert_eq!(standard.workspace_files.as_deref(), Some("auto"));
        assert_eq!(standard.shell.as_deref(), Some("confirm"));
        assert_eq!(standard.outside_workspace.as_deref(), Some("confirm"));
        assert!(policy_input(Some("谨慎")).is_ok());
        assert!(policy_input(Some("aggressive")).is_err());
    }

    #[test]
    fn fail_at_reports_reason_only_while_still_fired() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scheduled_tasks.json");
        let task = task_with_workspace(directory.path(), 100);
        let mut tasks = load(&path).unwrap();
        collect_due(&mut tasks, 100);
        save(&path, &tasks).unwrap();
        fail_at(&path, &task.id, "另一个任务正在使用此目录", 110).unwrap();
        let tasks = load(&path).unwrap();
        assert_eq!(tasks[0].status, "failed");
        assert_eq!(tasks[0].reason.as_deref(), Some("另一个任务正在使用此目录"));
        // 已终态的记录不再回写。
        fail_at(&path, &task.id, "迟到的失败", 120).unwrap();
        assert_eq!(
            load(&path).unwrap()[0].reason.as_deref(),
            Some("另一个任务正在使用此目录")
        );
        assert!(fail_at(&path, "s-missing", "x", 120).is_ok());
    }
}
