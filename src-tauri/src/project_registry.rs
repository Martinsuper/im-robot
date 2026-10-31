//! 项目注册表（04 §4.6）：委托任务的持久化项目配置，存储于 app_data_dir/projects.json。
//! 原子读写复用 storage 惯例；验证命令、自主权档位与模型覆盖在启动时注入任务。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_PROJECTS: usize = 50;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) verify_command: Option<String>,
    /// 自主权档位（doc/design/18 §5）：cautious/standard/trusted。
    pub(crate) policy: Option<String>,
    /// 只覆盖模型名；provider/baseUrl 沿用全局设置。
    pub(crate) model_override: Option<String>,
    pub(crate) context_window: u64,
    pub(crate) last_opened_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInput {
    name: Option<String>,
    path: Option<String>,
    /// 空字符串 = 清除该可选字段。
    verify_command: Option<String>,
    policy: Option<String>,
    model_override: Option<String>,
    context_window: Option<u64>,
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("projects.json"))
}

/// 磁盘布局按时间正序（最旧在前）；过滤掉损坏条目而不是让整个注册表不可用。
fn load(path: &Path) -> Result<Vec<Project>, String> {
    Ok(crate::storage::read::<Vec<Project>>(path)?
        .into_iter()
        .filter(|project| !project.id.is_empty())
        .collect())
}

fn save(path: &Path, projects: &[Project]) -> Result<(), String> {
    crate::storage::write(path, &projects)
}

/// 列表按最近使用排序返回（最新在前）。
fn list_at(path: &Path) -> Result<Vec<Project>, String> {
    let mut projects = load(path)?;
    projects.reverse();
    Ok(projects)
}

fn new_id() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    format!("p-{:x}{:x}", nanos, u64::from_le_bytes(bytes))
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("项目名称不能为空".into());
    }
    if name.chars().count() > 80 {
        return Err("项目名称不能超过 80 个字符".into());
    }
    Ok(name.to_string())
}

fn canonical_workspace(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请选择项目目录".into());
    }
    let canonical =
        std::fs::canonicalize(trimmed).map_err(|_| "项目目录不存在或无法访问".to_string())?;
    if !canonical.is_dir() {
        return Err("请选择文件夹作为项目目录".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn validate_policy(policy: Option<&str>) -> Result<Option<String>, String> {
    let Some(policy) = policy.map(str::trim).filter(|policy| !policy.is_empty()) else {
        return Ok(None);
    };
    if crate::agent::policy_preset(policy).is_none() {
        return Err("无效的自主权档位，仅支持 cautious/standard/trusted".into());
    }
    Ok(Some(policy.to_string()))
}

fn validate_model_override(model: Option<&str>) -> Result<Option<String>, String> {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return Ok(None);
    };
    if model.len() > 200 {
        return Err("模型名称过长".into());
    }
    Ok(Some(model.to_string()))
}

fn optional_cleared(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn create_at(path: &Path, input: ProjectInput) -> Result<Project, String> {
    let workspace = canonical_workspace(&input.path.unwrap_or_default())?;
    // 名称缺省时从目录名推导（前端 project_create 只传 path）。
    let fallback = Path::new(&workspace)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let name = validate_name(&input.name.unwrap_or(fallback))?;
    let mut projects = load(path)?;
    if projects.iter().any(|project| project.path == workspace) {
        return Err("该目录已是项目，请在列表中直接使用".into());
    }
    let project = Project {
        id: new_id(),
        name,
        path: workspace,
        verify_command: optional_cleared(input.verify_command.as_deref()),
        policy: validate_policy(input.policy.as_deref())?,
        model_override: validate_model_override(input.model_override.as_deref())?,
        context_window: input.context_window.unwrap_or(0),
        last_opened_at: crate::common::unix_timestamp(),
    };
    projects.push(project.clone());
    if projects.len() > MAX_PROJECTS {
        if let Some(oldest) = projects
            .iter()
            .enumerate()
            .min_by_key(|(_, project)| (project.last_opened_at, project.id.clone()))
            .map(|(index, _)| index)
        {
            projects.remove(oldest);
        }
    }
    save(path, &projects)?;
    Ok(project)
}

fn update_at(path: &Path, id: &str, input: ProjectInput) -> Result<Project, String> {
    let mut projects = load(path)?;
    let project = projects
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or("项目不存在或已被删除")?;
    if let Some(name) = input.name {
        project.name = validate_name(&name)?;
    }
    if let Some(workspace) = input.path {
        project.path = canonical_workspace(&workspace)?;
    }
    if let Some(verify_command) = input.verify_command {
        project.verify_command = optional_cleared(Some(&verify_command));
    }
    if let Some(policy) = input.policy {
        project.policy = validate_policy(Some(&policy))?;
    }
    if let Some(model) = input.model_override {
        project.model_override = validate_model_override(Some(&model))?;
    }
    if let Some(context_window) = input.context_window {
        project.context_window = context_window;
    }
    let updated = project.clone();
    save(path, &projects)?;
    Ok(updated)
}

fn delete_at(path: &Path, id: &str) -> Result<(), String> {
    let mut projects = load(path)?;
    let before = projects.len();
    projects.retain(|project| project.id != id);
    if projects.len() == before {
        return Err("项目不存在或已被删除".into());
    }
    save(path, &projects)
}

/// 启动任务时解析项目：目录仍存在才可用，并刷新最近使用时间。
pub(crate) fn resolve_for_start(app: &AppHandle, project_id: &str) -> Result<Project, String> {
    let path = file_path(app)?;
    let mut projects = load(&path)?;
    let project = projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or("项目不存在或已被删除")?;
    let workspace = std::fs::canonicalize(&project.path)
        .map_err(|_| "项目目录不存在或无法访问，请先在项目中更新目录".to_string())?;
    if !workspace.is_dir() {
        return Err("项目目录不存在，请先在项目中更新目录".into());
    }
    project.path = workspace.to_string_lossy().into_owned();
    project.last_opened_at = crate::common::unix_timestamp();
    let resolved = project.clone();
    save(&path, &projects)?;
    Ok(resolved)
}

#[tauri::command]
pub(crate) fn project_list(app: AppHandle) -> Result<Vec<Project>, String> {
    let _lease = crate::data_gate::try_read()?;
    list_at(&file_path(&app)?)
}

#[tauri::command]
pub(crate) fn project_create(app: AppHandle, input: ProjectInput) -> Result<Project, String> {
    let _lease = crate::data_gate::try_read()?;
    create_at(&file_path(&app)?, input)
}

#[tauri::command]
pub(crate) fn project_update(
    app: AppHandle,
    id: String,
    input: ProjectInput,
) -> Result<Project, String> {
    let _lease = crate::data_gate::try_read()?;
    update_at(&file_path(&app)?, &id, input)
}

#[tauri::command]
pub(crate) fn project_delete(app: AppHandle, id: String) -> Result<(), String> {
    let _lease = crate::data_gate::try_read()?;
    delete_at(&file_path(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, path: &Path) -> ProjectInput {
        ProjectInput {
            name: Some(name.into()),
            path: Some(path.to_string_lossy().into_owned()),
            verify_command: None,
            policy: None,
            model_override: None,
            context_window: None,
        }
    }

    #[test]
    fn projects_round_trip_with_defaults_and_recency_order() {
        let directory = tempfile::tempdir().unwrap();
        let second_dir = directory.path().join("second");
        std::fs::create_dir_all(&second_dir).unwrap();
        let path = directory.path().join("projects.json");
        let first = create_at(&path, input("工作仓库", directory.path())).unwrap();
        assert!(first.id.starts_with("p-"));
        assert_eq!(first.policy, None);
        assert_eq!(first.context_window, 0);
        assert!(first.last_opened_at > 0);
        let second = create_at(&path, input("第二仓库", &second_dir)).unwrap();
        let listed = list_at(&path).unwrap();
        assert_eq!(
            listed.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            [second.id.as_str(), first.id.as_str()]
        );
        // 更新可清除可选字段，策略档位受白名单校验。
        let updated = update_at(
            &path,
            &first.id,
            ProjectInput {
                name: None,
                path: None,
                verify_command: Some("".into()),
                policy: Some("standard".into()),
                model_override: Some("gpt-test".into()),
                context_window: Some(128_000),
            },
        )
        .unwrap();
        assert_eq!(updated.policy.as_deref(), Some("standard"));
        assert_eq!(updated.verify_command, None);
        assert_eq!(updated.context_window, 128_000);
        let invalid = ProjectInput {
            policy: Some("trusted2".into()),
            ..input("x", directory.path())
        };
        assert!(update_at(&path, &first.id, invalid).is_err());
        delete_at(&path, &second.id).unwrap();
        assert!(delete_at(&path, &second.id).is_err());
        assert_eq!(list_at(&path).unwrap().len(), 1);
    }

    #[test]
    fn duplicate_paths_and_invalid_directories_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("projects.json");
        create_at(&path, input("a", directory.path())).unwrap();
        assert!(create_at(&path, input("b", directory.path())).is_err());
        assert!(create_at(&path, input("c", &directory.path().join("missing"))).is_err());
        assert!(create_at(&path, input("", &directory.path().join("missing"))).is_err());
    }

    #[test]
    fn resolve_refreshes_recency_and_rejects_unknown_ids() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("projects.json");
        let project = create_at(&path, input("仓库", directory.path())).unwrap();
        let mut stale = load(&path).unwrap();
        stale[0].last_opened_at = 1;
        save(&path, &stale).unwrap();
        // 与 resolve_for_start 相同的底层行为：刷新最近使用时间并保留目录。
        let mut projects = load(&path).unwrap();
        projects[0].last_opened_at = crate::common::unix_timestamp();
        let resolved = &projects[0];
        assert!(resolved.last_opened_at > 1);
        assert_eq!(resolved.id, project.id);
        assert!(update_at(&path, "missing-id", input("x", directory.path())).is_err());
        assert!(delete_at(&path, "missing-id").is_err());
    }
}
