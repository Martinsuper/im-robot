use std::path::Path;

pub(super) const MAX_PARALLEL_TASKS: usize = 2;

pub(super) struct TaskScope<'a> {
    pub request_id: &'a str,
    pub conversation_id: &'a str,
    pub workspace: Option<&'a Path>,
}

pub(super) fn workspace_available(
    tasks: &[TaskScope<'_>],
    request_id: &str,
    path: &Path,
) -> Result<(), String> {
    if tasks.iter().any(|task| {
        task.request_id != request_id
            && task
                .workspace
                .is_some_and(|other| path.starts_with(other) || other.starts_with(path))
    }) {
        return Err("另一个任务正在使用此目录，请等待它结束或选择其他目录。".into());
    }
    Ok(())
}

pub(super) fn admit(
    tasks: &[TaskScope<'_>],
    request_id: &str,
    conversation_id: &str,
    workspace: Option<&Path>,
) -> Result<(), String> {
    if tasks
        .iter()
        .any(|task| task.request_id == request_id || task.conversation_id == conversation_id)
    {
        return Err("此会话已有任务正在执行，请等待结束或新建会话。".into());
    }
    if tasks.len() >= MAX_PARALLEL_TASKS {
        return Err("最多同时执行两个任务，请等待一个任务结束后再发送。".into());
    }
    if let Some(path) = workspace {
        workspace_available(tasks, request_id, path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allows_independent_conversations_but_bounds_parallelism() {
        let mut tasks = vec![TaskScope {
            request_id: "r1",
            conversation_id: "c1",
            workspace: None,
        }];
        assert!(admit(&tasks, "r2", "c2", None).is_ok());
        assert!(admit(&tasks, "r2", "c1", None).is_err());
        assert!(admit(&tasks, "r1", "c2", None).is_err());
        tasks.push(TaskScope {
            request_id: "r2",
            conversation_id: "c2",
            workspace: None,
        });
        assert!(admit(&tasks, "r3", "c3", None)
            .unwrap_err()
            .contains("两个"));
        tasks.remove(0);
        assert!(admit(&tasks, "r3", "c3", None).is_ok());
    }
    #[test]
    fn rejects_overlapping_workspaces_but_allows_siblings_and_current_owner() {
        let tasks = [TaskScope {
            request_id: "r1",
            conversation_id: "c1",
            workspace: Some(Path::new("/work/app")),
        }];
        for path in ["/work", "/work/app", "/work/app/src"] {
            assert!(admit(&tasks, "r2", "c2", Some(Path::new(path))).is_err());
        }
        assert!(admit(&tasks, "r2", "c2", Some(Path::new("/work/app-other"))).is_ok());
        assert!(workspace_available(&tasks, "r1", Path::new("/work/app/src")).is_ok());
    }
}
