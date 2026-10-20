use super::*;
use crate::memory::{open_in_memory_db, UpdateMemoryInput};

fn fixture() -> (tempfile::TempDir, MemoryDb, VaultConfig) {
    let dir = tempfile::tempdir().unwrap();
    let settings = default_config(&dir.path().join("vault"));
    (dir, open_in_memory_db().unwrap(), settings)
}
fn item(db: &MemoryDb, id: &str, kind: MemoryType, text: &str) -> MemoryItem {
    let item = MemoryItem {
        id: id.into(),
        memory_type: kind,
        title: "测试记忆".into(),
        content: text.into(),
        source: MemorySource::UserExplicit,
        importance: 3,
        confidence: 1.0,
        recency_score: 1.0,
        privacy_level: PrivacyLevel::PublicToUser,
        status: MemoryStatus::Active,
        created_at: 1,
        updated_at: 1,
        last_used_at: None,
        expires_at: None,
        tags: vec!["中文".into()],
        embedding_id: None,
        is_pinned: false,
    };
    db.create(&item).unwrap();
    item
}
fn file(settings: &VaultConfig, db: &MemoryDb, id: &str) -> PathBuf {
    Path::new(&settings.directory).join(
        tracked(db, &settings.directory)
            .unwrap()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap()
            .path,
    )
}
fn replace(path: &Path, old: &str, new: &str) {
    let raw = fs::read_to_string(path).unwrap();
    assert!(raw.contains(old));
    fs::write(path, raw.replace(old, new)).unwrap();
}
fn resolve_current(db: &MemoryDb, s: &VaultConfig, id: &str, path: &str, choice: &str) {
    let p = preview(db, s, id, path).unwrap();
    resolve(
        db,
        s,
        &ResolveInput {
            memory_id: id.into(),
            path: path.into(),
            choice: choice.into(),
            piko_version: p.piko_version,
            file_version: p.file_version,
        },
    )
    .unwrap();
}

#[test]
fn exports_five_categories_and_ignores_private_or_inactive_memories() {
    let (_dir, db, s) = fixture();
    for (i, kind) in kinds().into_iter().enumerate() {
        item(
            &db,
            &format!("m{i}"),
            kind,
            "记住这个事实。\n正文包含 **Markdown**。",
        );
    }
    item(&db, "private", MemoryType::Profile, "秘密");
    item(&db, "archived", MemoryType::Event, "旧事");
    db.0.lock()
        .unwrap()
        .execute(
            "UPDATE memory_items SET privacy_level=?1 WHERE id='private'",
            [PrivacyLevel::SensitiveLocalOnly],
        )
        .unwrap();
    db.0.lock()
        .unwrap()
        .execute(
            "UPDATE memory_items SET status=?1 WHERE id='archived'",
            [MemoryStatus::Archived],
        )
        .unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.exported, 5);
    assert!(report.issues.is_empty());
    for (i, kind) in kinds().into_iter().enumerate() {
        let path = file(&s, &db, &format!("m{i}"));
        assert_eq!(path.parent().unwrap().file_name().unwrap(), category(&kind));
        let note = parse_note("note.md", &fs::read_to_string(path).unwrap(), kind).unwrap();
        assert_eq!(
            note.metadata.piko_id.as_deref(),
            Some(format!("m{i}").as_str())
        );
        assert!(note.edit.content.contains("**Markdown**"));
    }
    let again = synchronize(&db, &s).unwrap();
    assert_eq!(again.exported, 0);
    assert_eq!(again.imported, 0);
    assert!(again.issues.is_empty());
}
#[test]
fn plain_markdown_note_imports_and_is_actively_searchable() {
    let (_dir, db, s) = fixture();
    synchronize(&db, &s).unwrap();
    let path = Path::new(&s.directory).join("项目知识/数据库.md");
    fs::write(&path, "# 项目部署约定\n\n发布前需要执行数据库迁移。\n").unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.imported, 1);
    assert!(report.issues.is_empty());
    let hits = super::super::knowledge::search_local(&db, "数据库迁移", None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "项目部署约定");
    assert!(fs::read_to_string(path).unwrap().contains("piko_id:"));
    assert_eq!(
        db.get(&hits[0].id).unwrap().unwrap().memory_type,
        MemoryType::Semantic
    );
    assert_eq!(synchronize(&db, &s).unwrap().imported, 0);
}
#[test]
fn external_edits_update_history_tags_category_and_invalidate_vectors() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "我住在上海。");
    synchronize(&db, &s).unwrap();
    let old = file(&s, &db, "m");
    let moved = Path::new(&s.directory).join("项目知识/moved.md");
    replace(&old, "我住在上海。", "项目部署在杭州。");
    replace(&old, "importance: 3", "importance: 5");
    fs::rename(old, &moved).unwrap();
    db.0.lock()
        .unwrap()
        .execute(
            "INSERT INTO retrieval_vectors VALUES('m','old','model','[1,0]')",
            [],
        )
        .unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.imported, 1);
    assert!(report.issues.is_empty());
    let memory = db.get("m").unwrap().unwrap();
    assert_eq!(memory.content, "项目部署在杭州。");
    assert_eq!(memory.memory_type, MemoryType::Semantic);
    assert_eq!(memory.importance, 5);
    let conn = db.0.lock().unwrap();
    let reason: String = conn
        .query_row("SELECT reason FROM memory_revisions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(reason, "markdownEdit");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM retrieval_vectors", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    drop(conn);
    assert_eq!(file(&s, &db, "m"), moved);
    assert!(synchronize(&db, &s).unwrap().issues.is_empty());
}
#[test]
fn app_edits_export_without_conflicting_with_yaml_formatting_or_extra_fields() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "旧内容");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    replace(&path, "tags:\n- 中文", "aliases: [小皮]\ntags: [中文]");
    db.update(
        "m",
        UpdateMemoryInput {
            content: Some("新内容".into()),
            title: Some("新标题".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.exported, 1);
    assert!(report.issues.is_empty());
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains("新内容"));
    assert!(raw.contains("aliases:"));
    assert!(raw.contains("# 新标题"));
    assert_eq!(file(&s, &db, "m"), path);
    assert!(Path::new(&s.directory).join(".piko-history").exists());
}
#[test]
fn simultaneous_edits_preserve_both_and_stale_conflict_decisions_are_rejected() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "原始内容");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    replace(&path, "原始内容", "文件修改");
    db.update(
        "m",
        UpdateMemoryInput {
            content: Some("Piko 修改".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.issues[0].kind, "bothChanged");
    assert!(fs::read_to_string(&path).unwrap().contains("文件修改"));
    assert_eq!(db.get("m").unwrap().unwrap().content, "Piko 修改");
    let p = preview(&db, &s, "m", &report.issues[0].path).unwrap();
    replace(&path, "文件修改", "文件再修改");
    assert!(resolve(
        &db,
        &s,
        &ResolveInput {
            memory_id: "m".into(),
            path: p.path.clone(),
            choice: "file".into(),
            piko_version: p.piko_version,
            file_version: p.file_version
        }
    )
    .is_err());
    resolve_current(&db, &s, "m", &p.path, "file");
    assert_eq!(db.get("m").unwrap().unwrap().content, "文件再修改");
    assert!(synchronize(&db, &s).unwrap().issues.is_empty());
}
#[test]
fn a_missing_file_requires_explicit_restore_or_forget() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "长期事实");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    fs::remove_file(&path).unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.issues[0].kind, "fileMissing");
    assert_eq!(db.get("m").unwrap().unwrap().status, MemoryStatus::Active);
    assert!(!path.exists());
    resolve_current(&db, &s, "m", &report.issues[0].path, "piko");
    assert!(path.exists());
    synchronize(&db, &s).unwrap();
    fs::remove_file(&path).unwrap();
    let report = synchronize(&db, &s).unwrap();
    resolve_current(&db, &s, "m", &report.issues[0].path, "file");
    assert_eq!(db.get("m").unwrap().unwrap().status, MemoryStatus::Deleted);
    assert!(synchronize(&db, &s).unwrap().issues.is_empty());
    assert!(!path.exists());
}
#[test]
fn forgetting_in_piko_removes_clean_files_and_their_recovery_history() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "旧事实");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    db.update(
        "m",
        UpdateMemoryInput {
            content: Some("新事实".into()),
            ..Default::default()
        },
    )
    .unwrap();
    synchronize(&db, &s).unwrap();
    let history = Path::new(&s.directory).join(format!(".piko-history/{}", hash("m")));
    assert!(history.exists());
    db.delete("m").unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.removed, 1);
    assert!(!path.exists());
    assert!(!history.exists());
    assert!(tracked(&db, &s.directory).unwrap().is_empty());
}
#[test]
fn edited_file_never_silently_resurrects_a_forgotten_memory() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "原始事实");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    replace(&path, "原始事实", "外部新事实");
    db.delete("m").unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.issues[0].kind, "inactive");
    assert_eq!(db.get("m").unwrap().unwrap().status, MemoryStatus::Deleted);
    resolve_current(&db, &s, "m", &report.issues[0].path, "file");
    synchronize(&db, &s).unwrap();
    assert_eq!(db.get("m").unwrap().unwrap().status, MemoryStatus::Deleted);
    let state = tracked(&db, &s.directory).unwrap();
    assert_eq!(state.len(), 1);
    assert_ne!(state[0].id, "m");
    assert_eq!(db.get(&state[0].id).unwrap().unwrap().content, "外部新事实");
}
#[test]
fn duplicated_ids_and_invalid_markdown_do_not_overwrite_memories() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "保留事实");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    let copy = path.parent().unwrap().join("copy.md");
    fs::copy(&path, &copy).unwrap();
    replace(&copy, "保留事实", "副本内容");
    let report = synchronize(&db, &s).unwrap();
    assert!(report.issues.iter().any(|i| i.kind == "duplicate"));
    assert_eq!(db.get("m").unwrap().unwrap().content, "保留事实");
    fs::remove_file(copy).unwrap();
    fs::write(&path, "---\npiko_id: [broken\n---\n# 无效笔记\n\n正文").unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert!(report.issues.iter().any(|i| i.kind == "invalid"));
    assert_eq!(db.get("m").unwrap().unwrap().content, "保留事实");
    assert!(fs::read_to_string(path).unwrap().contains("[broken"));
}
#[test]
fn persisted_baselines_survive_database_reopening() {
    let (dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "重启前");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    let disk = dir.path().join("memory.db");
    db.0.lock().unwrap().backup("main", &disk, None).unwrap();
    drop(db);
    replace(&path, "重启前", "重启后外部编辑");
    let reopened = MemoryDb(crate::data_gate::DataMutex::new(
        Connection::open(disk).unwrap(),
    ));
    let report = synchronize(&reopened, &s).unwrap();
    assert_eq!(report.imported, 1);
    assert_eq!(
        reopened.get("m").unwrap().unwrap().content,
        "重启后外部编辑"
    );
    assert_eq!(tracked(&reopened, &s.directory).unwrap().len(), 1);
}
#[test]
fn snapshot_restore_pauses_sync_even_for_a_snapshot_without_vault_settings() {
    let (_dir, db, s) = fixture();
    pause_after_restore(&db.0.lock().unwrap()).unwrap();
    let restored = config(&db, Path::new(&s.directory)).unwrap();
    assert!(!restored.enabled);
    assert_eq!(restored.directory, s.directory);
    assert!(restored.paused_reason.is_some());
    assert!(synchronize(&db, &restored).is_err());
    assert!(!Path::new(&s.directory).exists());
}
#[test]
fn missing_root_and_late_editor_changes_never_cause_recreation_or_overwrites() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "事实");
    synchronize(&db, &s).unwrap();
    let path = file(&s, &db, "m");
    let original = fs::read_to_string(&path).unwrap();
    fs::write(&path, "新的编辑").unwrap();
    assert!(write_checked(
        Path::new(&s.directory),
        path.strip_prefix(&s.directory).unwrap().to_str().unwrap(),
        Some(&hash(&original)),
        "覆盖内容"
    )
    .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "新的编辑");
    fs::remove_dir_all(&s.directory).unwrap();
    assert!(synchronize(&db, &s).is_err());
    assert!(!Path::new(&s.directory).exists());
    assert_eq!(db.get("m").unwrap().unwrap().content, "事实");
}
#[test]
fn database_compare_and_swap_prevents_losing_a_concurrent_update() {
    let (_dir, db, _s) = fixture();
    let old = item(&db, "m", MemoryType::Profile, "旧内容");
    db.update(
        "m",
        UpdateMemoryInput {
            content: Some("并发修改".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut edit = Editable::from_memory(&old);
    edit.content = "文件修改".into();
    assert!(apply_edit(&db, &old, &edit).is_err());
    assert_eq!(db.get("m").unwrap().unwrap().content, "并发修改");
}
#[test]
fn piko_category_changes_move_the_file_and_do_not_create_a_sync_loop() {
    let (_dir, db, s) = fixture();
    item(&db, "m", MemoryType::Profile, "项目事实");
    synchronize(&db, &s).unwrap();
    let previous = file(&s, &db, "m");
    db.0.lock()
        .unwrap()
        .execute(
            "UPDATE memory_items SET memory_type=?1 WHERE id='m'",
            [MemoryType::Semantic],
        )
        .unwrap();
    let report = synchronize(&db, &s).unwrap();
    assert_eq!(report.exported, 1);
    assert!(report.issues.is_empty());
    let path = file(&s, &db, "m");
    assert_ne!(previous, path);
    assert!(!previous.exists());
    assert!(path.exists());
    assert!(path.to_string_lossy().contains("项目知识"));
    assert!(synchronize(&db, &s).unwrap().issues.is_empty());
}
#[cfg(unix)]
#[test]
fn symlinks_and_path_traversal_cannot_escape_the_vault() {
    use std::os::unix::fs::symlink;
    let (dir, db, s) = fixture();
    fs::create_dir_all(&s.directory).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, Path::new(&s.directory).join("用户档案")).unwrap();
    item(&db, "m", MemoryType::Profile, "内容");
    assert!(synchronize(&db, &s).is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    assert!(safe_path(Path::new(&s.directory), "../outside.md").is_err());
    assert!(safe_path(Path::new(&s.directory), "/tmp/outside.md").is_err());
}

#[test]
fn opener_resolves_only_the_saved_directory_and_rejects_missing_roots() {
    let (dir, db, s) = fixture();
    assert!(configured_directory(&db, Path::new(&s.directory)).is_err());
    synchronize(&db, &s).unwrap();
    assert_eq!(
        configured_directory(&db, Path::new(&s.directory)).unwrap(),
        Path::new(&s.directory).canonicalize().unwrap()
    );
    let selected = dir.path().join("chosen");
    fs::create_dir_all(&selected).unwrap();
    save_config(
        &db,
        &VaultConfig {
            directory: selected.to_string_lossy().into_owned(),
            ..s.clone()
        },
    )
    .unwrap();
    assert_eq!(
        configured_directory(&db, Path::new(&s.directory)).unwrap(),
        selected.canonicalize().unwrap()
    );
    fs::remove_dir(&selected).unwrap();
    assert!(configured_directory(&db, Path::new(&s.directory)).is_err());
}
