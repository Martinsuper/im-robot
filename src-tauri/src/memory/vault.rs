//! A classified Markdown mirror with three-way reconciliation. SQLite remains the recall index.
//! Only active, non-private memories are mirrored. External deletion requires an explicit decision.
use super::model::PrivacyLevel;
use super::{ListMemoriesInput, MemoryDb, MemoryItem, MemorySource, MemoryStatus, MemoryType};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State};

static SYNC_LOCK: Mutex<()> = Mutex::new(());
const MAX_NOTES: usize = 10_000;
const MAX_NOTE_BYTES: u64 = 1024 * 1024;
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS memory_vault_config(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_vault_state(
 root TEXT NOT NULL,memory_id TEXT NOT NULL,path TEXT NOT NULL,base_memory_hash TEXT NOT NULL,base_file_hash TEXT NOT NULL,
 PRIMARY KEY(root,memory_id),UNIQUE(root,path)
);
CREATE TABLE IF NOT EXISTS memory_vault_report(root TEXT PRIMARY KEY,value TEXT NOT NULL);
"#;
pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn now() -> u64 {
    crate::common::unix_timestamp()
}
fn err<T: std::fmt::Display>(value: T) -> String {
    value.to_string()
}
fn category(kind: &MemoryType) -> &'static str {
    match kind {
        MemoryType::Profile => "用户档案",
        MemoryType::Event => "事件记忆",
        MemoryType::Semantic => "项目知识",
        MemoryType::Operational => "操作记录",
        MemoryType::Reflection => "反思总结",
    }
}
fn kinds() -> [MemoryType; 5] {
    [
        MemoryType::Profile,
        MemoryType::Event,
        MemoryType::Semantic,
        MemoryType::Operational,
        MemoryType::Reflection,
    ]
}
fn eligible(item: &MemoryItem) -> bool {
    item.status == MemoryStatus::Active && item.privacy_level == PrivacyLevel::PublicToUser
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub enabled: bool,
    pub directory: String,
    #[serde(default)]
    pub paused_reason: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIssue {
    pub memory_id: Option<String>,
    pub path: String,
    pub kind: String,
    pub message: String,
    pub can_resolve: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub synced_at: u64,
    pub exported: usize,
    pub imported: usize,
    pub removed: usize,
    pub issues: Vec<VaultIssue>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub config: VaultConfig,
    pub report: SyncReport,
    pub tracked_count: usize,
    pub persistent: bool,
}
#[derive(Clone)]
struct Tracked {
    id: String,
    path: String,
    base_memory: String,
    base_file: String,
}

// Metadata is ordinary YAML, so editors such as Obsidian may reformat it freely.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct Frontmatter {
    piko_id: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<MemoryType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    importance: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_yaml::Value>,
}
#[derive(Clone, Debug, Serialize)]
struct Editable {
    title: String,
    content: String,
    tags: Vec<String>,
    importance: u8,
    kind: MemoryType,
}
impl Editable {
    fn from_memory(item: &MemoryItem) -> Self {
        Self {
            title: item.title.clone(),
            content: item.content.trim_end_matches('\n').into(),
            tags: item.tags.clone(),
            importance: item.importance,
            kind: item.memory_type.clone(),
        }
    }
    fn fingerprint(&self) -> Result<String, String> {
        Ok(hash(&serde_json::to_string(self).map_err(err)?))
    }
    fn validate(&self) -> Result<(), String> {
        if self.title.trim().is_empty()
            || self.title.contains(['\r', '\n'])
            || self.title.chars().count() > 500
        {
            return Err("标题需要为 1 至 500 字的单行文字".into());
        }
        if self.content.trim().is_empty() {
            return Err("笔记正文不能为空".into());
        }
        if self.importance > 5 {
            return Err("importance 需要在 0 至 5 之间".into());
        }
        if self.tags.len() > 100 || self.tags.iter().any(|t| t.chars().count() > 120) {
            return Err("标签数量或长度超出上限".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Note {
    path: String,
    raw: String,
    metadata: Frontmatter,
    edit: Editable,
}
fn parse_note(path: &str, raw: &str, folder_kind: MemoryType) -> Result<Note, String> {
    let normalized = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (metadata, body) = if let Some(rest) = normalized.strip_prefix("---\n") {
        let boundary = rest.find("\n---\n").ok_or("YAML 元数据缺少结束的 --- 行")?;
        let metadata = serde_yaml::from_str::<Frontmatter>(&rest[..boundary])
            .map_err(|e| format!("YAML 元数据无效：{e}"))?;
        (metadata, &rest[boundary + 5..])
    } else {
        (Frontmatter::default(), normalized.as_str())
    };
    if metadata
        .piko_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 500)
    {
        return Err("piko_id 无效".into());
    }
    // A folder move is a deliberate category change. The folder is authoritative over the type hint.
    let body = body.trim_start_matches('\n');
    let (title, content) = if let Some(heading) = body.strip_prefix("# ") {
        let (title, rest) = heading.split_once('\n').unwrap_or((heading, ""));
        (
            title.trim().to_string(),
            rest.strip_prefix('\n')
                .unwrap_or(rest)
                .trim_end_matches('\n')
                .to_string(),
        )
    } else {
        (
            Path::new(path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            body.trim_end_matches('\n').to_string(),
        )
    };
    let edit = Editable {
        title,
        content,
        tags: metadata.tags.clone().unwrap_or_default(),
        importance: metadata.importance.unwrap_or(3),
        kind: folder_kind,
    };
    edit.validate()?;
    Ok(Note {
        path: path.into(),
        raw: raw.into(),
        metadata,
        edit,
    })
}
fn render(item: &MemoryItem, previous: Option<&Frontmatter>) -> Result<String, String> {
    let mut meta = previous.cloned().unwrap_or_default();
    meta.piko_id = Some(item.id.clone());
    meta.kind = Some(item.memory_type.clone());
    meta.tags = Some(item.tags.clone());
    meta.importance = Some(item.importance);
    let yaml = serde_yaml::to_string(&meta).map_err(err)?;
    // The content itself remains Markdown; no body escaping or model rewriting.
    Ok(format!(
        "---\n{}---\n\n# {}\n\n{}\n",
        yaml.trim_start_matches("---\n"),
        item.title,
        item.content.trim_end_matches('\n')
    ))
}
fn filename(item: &MemoryItem) -> String {
    let title: String = item
        .title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .take(42)
        .collect();
    format!(
        "{}/{}--{}.md",
        category(&item.memory_type),
        if title.trim().is_empty() {
            "记忆"
        } else {
            title.trim()
        },
        &hash(&item.id)[..16]
    )
}
fn default_config(root: &Path) -> VaultConfig {
    VaultConfig {
        enabled: true,
        directory: root.to_string_lossy().into_owned(),
        paused_reason: None,
    }
}
fn config(db: &MemoryDb, default_root: &Path) -> Result<VaultConfig, String> {
    let conn = db.0.lock().map_err(err)?;
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_vault_config WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let mut result: VaultConfig = json
        .map(|s| serde_json::from_str(&s).map_err(err))
        .unwrap_or_else(|| Ok(default_config(default_root)))?;
    if result.directory.is_empty() {
        result.directory = default_root.to_string_lossy().into_owned();
    }
    Ok(result)
}
fn save_config(db: &MemoryDb, value: &VaultConfig) -> Result<(), String> {
    db.0.lock().map_err(err)?.execute("INSERT INTO memory_vault_config VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value",[serde_json::to_string(value).map_err(err)?]).map_err(err)?;
    Ok(())
}
fn tracked(db: &MemoryDb, root: &str) -> Result<Vec<Tracked>, String> {
    let conn = db.0.lock().map_err(err)?;
    let mut stmt=conn.prepare("SELECT memory_id,path,base_memory_hash,base_file_hash FROM memory_vault_state WHERE root=?1").map_err(err)?;
    let rows = stmt
        .query_map([root], |r| {
            Ok(Tracked {
                id: r.get(0)?,
                path: r.get(1)?,
                base_memory: r.get(2)?,
                base_file: r.get(3)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}
fn remember(
    db: &MemoryDb,
    root: &str,
    item: &MemoryItem,
    path: &str,
    raw: &str,
) -> Result<(), String> {
    db.0.lock().map_err(err)?.execute("INSERT INTO memory_vault_state VALUES(?1,?2,?3,?4,?5) ON CONFLICT(root,memory_id) DO UPDATE SET path=excluded.path,base_memory_hash=excluded.base_memory_hash,base_file_hash=excluded.base_file_hash",params![root,item.id,path,Editable::from_memory(item).fingerprint()?,hash(raw)]).map_err(err)?;
    Ok(())
}
fn untrack(db: &MemoryDb, root: &str, id: &str) -> Result<(), String> {
    db.0.lock()
        .map_err(err)?
        .execute(
            "DELETE FROM memory_vault_state WHERE root=?1 AND memory_id=?2",
            params![root, id],
        )
        .map_err(err)?;
    Ok(())
}
fn remember_report(db: &MemoryDb, root: &str, report: &SyncReport) -> Result<(), String> {
    db.0.lock().map_err(err)?.execute("INSERT INTO memory_vault_report VALUES(?1,?2) ON CONFLICT(root) DO UPDATE SET value=excluded.value",params![root,serde_json::to_string(report).map_err(err)?]).map_err(err)?;
    Ok(())
}
fn read_report(db: &MemoryDb, root: &str) -> Result<SyncReport, String> {
    let conn = db.0.lock().map_err(err)?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_vault_report WHERE root=?1",
            [root],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    value
        .map(|v| serde_json::from_str(&v).map_err(err))
        .unwrap_or_else(|| Ok(SyncReport::default()))
}
fn issue(
    report: &mut SyncReport,
    id: Option<&str>,
    path: &str,
    kind: &str,
    message: &str,
    can_resolve: bool,
) {
    report.issues.push(VaultIssue {
        memory_id: id.map(str::to_owned),
        path: path.into(),
        kind: kind.into(),
        message: message.into(),
        can_resolve,
    });
}

/// No relative traversal and no symlink inside a selected root, including category directories.
fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("知识库相对路径无效".into());
    }
    let mut result = root.to_path_buf();
    for part in path.components() {
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Markdown 同步不跟随符号链接".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(result)
}
fn read_note_file(path: &Path) -> Result<Option<String>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(err(e)),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_NOTE_BYTES {
        return Err("笔记需要为不超过 1 MB 的普通 UTF-8 文件".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    if bytes.len() as u64 > MAX_NOTE_BYTES {
        return Err("笔记超过 1 MB".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "笔记需要为 UTF-8 编码".into())
}
fn scan(
    root: &Path,
    directory: &Path,
    kind: &MemoryType,
    depth: usize,
    notes: &mut Vec<Note>,
    report: &mut SyncReport,
) -> Result<(), String> {
    if depth > 16 {
        return Err("Markdown 目录层级超过 16 层".into());
    }
    if notes.len() > MAX_NOTES {
        return Err("Markdown 笔记超过 10000 条".into());
    }
    if !directory.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(directory)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err("分类目录不能是符号链接".into());
    }
    let mut children: Vec<_> = fs::read_dir(directory)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    children.sort_by_key(|e| e.file_name());
    for child in children {
        let path = child.path();
        if child.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let meta = fs::symlink_metadata(&path).map_err(err)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            scan(root, &path, kind, depth + 1, notes, report)?;
            continue;
        }
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        if notes.len() >= MAX_NOTES {
            return Err("Markdown 笔记超过 10000 条".into());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(err)?
            .to_string_lossy()
            .into_owned();
        match read_note_file(&path).and_then(|raw| {
            parse_note(&relative, &raw.ok_or("笔记在读取期间被移走")?, kind.clone())
        }) {
            Ok(note) => notes.push(note),
            Err(message) => issue(report, None, &relative, "invalid", &message, false),
        }
    }
    Ok(())
}
/// Content checks prevent ordinary lost updates; each replaced file also has a local recovery copy.
fn markdown_id(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("---\n")?;
    let (header, _) = rest.split_once("\n---\n")?;
    serde_yaml::from_str::<Frontmatter>(header).ok()?.piko_id
}
fn write_checked(
    root: &Path,
    relative: &str,
    expected: Option<&str>,
    value: &str,
) -> Result<(), String> {
    if value.len() as u64 > MAX_NOTE_BYTES {
        return Err("记忆过长，无法写入 1 MB Markdown 笔记".into());
    }
    let path = safe_path(root, relative)?;
    let previous = read_note_file(&path)?;
    if previous.as_deref().map(hash).as_deref() != expected {
        return Err("文件已被其他编辑器修改，请重新同步".into());
    }
    fs::create_dir_all(path.parent().ok_or("笔记路径无效")?).map_err(err)?;
    if let Some(previous) = previous.as_deref() {
        let memory_id = markdown_id(value)
            .or_else(|| markdown_id(previous))
            .unwrap_or_else(|| relative.to_string());
        let history = format!(".piko-history/{}/{}.md", hash(&memory_id), hash(previous));
        let backup = safe_path(root, &history)?;
        fs::create_dir_all(backup.parent().unwrap()).map_err(err)?;
        if !backup.exists() {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&backup)
                .map_err(err)?;
            file.write_all(previous.as_bytes()).map_err(err)?;
            file.sync_all().map_err(err)?;
        }
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(err)?;
    temp.write_all(value.as_bytes()).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    // Recheck after writing the temp file, before replacing an editor's current version.
    if read_note_file(&path)?.as_deref().map(hash).as_deref() != expected {
        return Err("文件已被其他编辑器修改，请重新同步".into());
    }
    if expected.is_none() {
        temp.persist_noclobber(&path).map_err(err)?;
    } else {
        temp.persist(&path).map_err(err)?;
    }
    Ok(())
}
fn remove_checked(root: &Path, relative: &str, expected: &str) -> Result<(), String> {
    let path = safe_path(root, relative)?;
    let current = read_note_file(&path)?;
    if current.as_deref().map(hash).as_deref() != Some(expected) {
        return Err("文件已被修改，未删除".into());
    }
    fs::remove_file(path).map_err(err)
}

/// Import a note only if the database still contains the exact version we compared.
fn apply_edit(db: &MemoryDb, original: &MemoryItem, edit: &Editable) -> Result<MemoryItem, String> {
    edit.validate()?;
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    let count=tx.execute("UPDATE memory_items SET title=?1,content=?2,tags=?3,importance=?4,memory_type=?5,updated_at=?6 WHERE id=?7 AND title=?8 AND content=?9 AND tags=?10 AND importance=?11 AND memory_type=?12 AND status=?13 AND privacy_level=?14",
        params![edit.title,edit.content,serde_json::to_string(&edit.tags).map_err(err)?,edit.importance,edit.kind,now(),original.id,original.title,original.content,serde_json::to_string(&original.tags).map_err(err)?,original.importance,original.memory_type,MemoryStatus::Active,PrivacyLevel::PublicToUser]).map_err(err)?;
    if count != 1 {
        return Err("Piko 中的记忆已改变，请重新同步".into());
    }
    tx.execute("INSERT INTO memory_revisions(memory_id,previous_json,changed_at,reason) VALUES(?1,?2,?3,'markdownEdit')",params![original.id,serde_json::to_string(original).map_err(err)?,now()]).map_err(err)?;
    tx.execute("DELETE FROM retrieval_vectors WHERE id=?1", [&original.id])
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(MemoryItem {
        title: edit.title.clone(),
        content: edit.content.clone(),
        tags: edit.tags.clone(),
        importance: edit.importance,
        memory_type: edit.kind.clone(),
        updated_at: now(),
        ..original.clone()
    })
}
fn create_from_note(db: &MemoryDb, note: &Note, id: String) -> Result<MemoryItem, String> {
    note.edit.validate()?;
    let item = MemoryItem {
        id,
        memory_type: note.edit.kind.clone(),
        title: note.edit.title.clone(),
        content: note.edit.content.clone(),
        source: MemorySource::UserExplicit,
        importance: note.edit.importance,
        confidence: 1.0,
        recency_score: 1.0,
        privacy_level: PrivacyLevel::PublicToUser,
        status: MemoryStatus::Active,
        created_at: now(),
        updated_at: now(),
        last_used_at: None,
        expires_at: None,
        tags: note.edit.tags.clone(),
        embedding_id: None,
        is_pinned: false,
    };
    db.create(&item)?;
    Ok(item)
}

fn clear_history(root: &Path, memory_id: &str) -> Result<(), String> {
    let path = safe_path(root, &format!(".piko-history/{}", hash(memory_id)))?;
    if path.exists() {
        fs::remove_dir_all(path).map_err(err)?;
    }
    Ok(())
}
fn prepare_root(db: &MemoryDb, settings: &VaultConfig) -> Result<PathBuf, String> {
    let root = PathBuf::from(&settings.directory);
    if !root.is_absolute() {
        return Err("Markdown 知识库需要绝对路径".into());
    }
    if !root.exists() && !tracked(db, &settings.directory)?.is_empty() {
        return Err("Markdown 知识库目录不可用，请连接磁盘或重新选择目录；未修改任何记忆".into());
    }
    fs::create_dir_all(&root).map_err(err)?;
    let root = root.canonicalize().map_err(err)?;
    for kind in kinds() {
        let path = safe_path(&root, category(&kind))?;
        fs::create_dir_all(path).map_err(err)?;
    }
    let guide = root.join("Piko 使用说明.md");
    if !guide.exists() {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&guide)
            .map_err(err)?;
        file.write_all(GUIDE.as_bytes()).map_err(err)?;
    }
    Ok(root)
}
const GUIDE: &str = "# Piko Markdown 记忆库\n\n五个分类目录分别保存用户档案、事件记忆、项目知识、操作记录和反思总结。每条记忆是一篇笔记，可在 Obsidian 或文本编辑器中打开。\n\n## 编辑与新增\n\n- 修改 `# 标题`、正文以及 YAML 中的 `tags`、`importance`（0–5），Piko 会在约 15 秒内同步并更新检索。\n- 在分类目录中新建普通 `.md` 文件也可以加入记忆；用一行 `# 标题` 开头，其余内容作为正文。\n- 移动笔记到另一分类目录会更新分类；请保留 `piko_id`，它用于识别同一条记忆，不要复制到另一篇笔记。\n- 不要把密码或临时敏感信息写入普通笔记；仅有效、非私密记忆会被同步。\n\n## 冲突与删除\n\n两边同时修改时不会自动覆盖，在 Piko 的 Markdown 同步面板选择保留哪一侧。删除 Markdown 文件会产生待确认项，可选择恢复文件或让 Piko 忘记；在 Piko 中删除记忆会删除未被外部修改的对应文件。\n\n自动同步需要 Piko 正在运行。暂停同步或 Piko 未运行时，文件仍可编辑；下次恢复会进行三方比较。文件名初次创建后保持稳定，改标题不会自动改文件名。\n\n`.piko-history` 保存由 Piko 替换文件前的恢复副本，不会进入检索；在 Piko 中删除对应记忆时会清理这些副本。数据库快照恢复后会暂停 Markdown 同步，避免磁盘上的较新笔记覆盖恢复结果；确认后可重新启用。\n";

fn export_item(
    db: &MemoryDb,
    root: &Path,
    settings: &VaultConfig,
    item: &MemoryItem,
    note: Option<&Note>,
    path: &str,
) -> Result<(), String> {
    Editable::from_memory(item).validate()?;
    let first = Path::new(path)
        .components()
        .next()
        .ok_or("笔记路径无效")?
        .as_os_str()
        .to_string_lossy();
    let target = if first != category(&item.memory_type) {
        format!(
            "{}/{}",
            category(&item.memory_type),
            Path::new(path)
                .file_name()
                .ok_or("笔记路径无效")?
                .to_string_lossy()
        )
    } else {
        path.to_string()
    };
    let raw = render(item, note.map(|n| &n.metadata))?;
    let expected = note.map(|n| hash(&n.raw));
    write_checked(
        root,
        &target,
        if target == path {
            expected.as_deref()
        } else {
            None
        },
        &raw,
    )?;
    if target != path {
        if let Some(expected) = expected.as_deref() {
            remove_checked(root, path, expected)?;
        }
    }
    remember(db, &settings.directory, item, &target, &raw)
}
fn sync_inner(db: &MemoryDb, settings: &VaultConfig) -> Result<SyncReport, String> {
    let root = prepare_root(db, settings)?;
    let state = tracked(db, &settings.directory)?;
    let by_path: HashMap<_, _> = state
        .iter()
        .map(|s| (s.path.as_str(), s.id.as_str()))
        .collect();
    let by_id: HashMap<_, _> = state.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut report = SyncReport::default();
    let mut scanned = Vec::new();
    for kind in kinds() {
        scan(
            &root,
            &root.join(category(&kind)),
            &kind,
            0,
            &mut scanned,
            &mut report,
        )?;
    }
    let mut notes: HashMap<String, Note> = HashMap::new();
    let mut blocked = HashSet::new();
    for note in scanned {
        let id = note
            .metadata
            .piko_id
            .clone()
            .or_else(|| by_path.get(note.path.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| {
                format!(
                    "memory-vault-{}",
                    hash(&format!("{}\n{}", settings.directory, note.path))
                )
            });
        if let Some(old) = by_path.get(note.path.as_str()) {
            if *old != id {
                issue(
                    &mut report,
                    Some(old),
                    &note.path,
                    "identityChanged",
                    "piko_id 与原笔记不同，请还原编号或将新笔记另存为不含 piko_id 的文件",
                    false,
                );
                blocked.insert(old.to_string());
                blocked.insert(id);
                continue;
            }
        }
        if let Some(previous) = notes.get(&id) {
            issue(
                &mut report,
                Some(&id),
                &note.path,
                "duplicate",
                &format!(
                    "与 {} 使用了同一个 piko_id，请删除副本的 piko_id 后重新同步",
                    previous.path
                ),
                false,
            );
            blocked.insert(id);
            continue;
        }
        notes.insert(id, note);
    }
    let mut ids: HashSet<_> = notes
        .keys()
        .cloned()
        .chain(state.iter().map(|s| s.id.clone()))
        .collect();
    for item in db.list(ListMemoriesInput {
        status: Some(MemoryStatus::Active),
        limit: Some(100_000),
        ..Default::default()
    })? {
        if eligible(&item) {
            ids.insert(item.id);
        }
    }
    let mut ids: Vec<_> = ids.into_iter().collect();
    ids.sort();
    for id in ids {
        if blocked.contains(&id) {
            continue;
        }
        let note = notes.get(&id);
        let tracked = by_id.get(id.as_str()).copied();
        let item = db.get(&id)?;
        let path = note
            .map(|n| n.path.clone())
            .or_else(|| tracked.map(|s| s.path.clone()))
            .or_else(|| item.as_ref().map(filename))
            .unwrap_or_default();
        // Do not interpret a malformed note as a missing file and overwrite it.
        if report.issues.iter().any(|issue| issue.path == path) {
            continue;
        }
        let result = (|| -> Result<(), String> {
            match (item.as_ref().filter(|i| eligible(i)), note, tracked) {
                (Some(item), Some(note), base) => {
                    let db_hash = Editable::from_memory(item).fingerprint()?;
                    let file_hash = note.edit.fingerprint()?;
                    let equal = db_hash == file_hash;
                    let db_changed = base.is_none_or(|b| b.base_memory != db_hash);
                    let file_changed = base.is_none_or(|b| b.base_memory != file_hash);
                    if equal {
                        if base.is_some_and(|b| {
                            b.path == note.path
                                && b.base_memory == db_hash
                                && b.base_file == hash(&note.raw)
                        }) {
                            return Ok(());
                        }
                        if note.metadata.piko_id.as_deref() != Some(&id) {
                            let raw = render(item, Some(&note.metadata))?;
                            write_checked(&root, &note.path, Some(&hash(&note.raw)), &raw)?;
                            remember(db, &settings.directory, item, &note.path, &raw)?;
                        } else {
                            remember(db, &settings.directory, item, &note.path, &note.raw)?;
                        }
                    } else if !db_changed && file_changed {
                        let changed = apply_edit(db, item, &note.edit)?;
                        report.imported += 1;
                        remember(db, &settings.directory, &changed, &note.path, &note.raw)?;
                    } else if db_changed && !file_changed {
                        export_item(db, &root, settings, item, Some(note), &note.path)?;
                        report.exported += 1;
                    } else if db_changed && file_changed {
                        issue(
                            &mut report,
                            Some(&id),
                            &note.path,
                            "bothChanged",
                            "Piko 与 Markdown 均已修改，请选择保留哪一侧",
                            true,
                        );
                    } else {
                        // A pre-existing semantic difference (e.g. migration) is never guessed away.
                        issue(
                            &mut report,
                            Some(&id),
                            &note.path,
                            "bothChanged",
                            "两侧内容不一致，请选择保留哪一侧",
                            true,
                        );
                    }
                }
                (Some(item), None, None) => {
                    export_item(db, &root, settings, item, None, &path)?;
                    report.exported += 1;
                }
                (Some(_), None, Some(_)) => issue(
                    &mut report,
                    Some(&id),
                    &path,
                    "fileMissing",
                    "Markdown 文件已移走或删除，可恢复文件或确认让 Piko 忘记",
                    true,
                ),
                (None, Some(note), None) if item.is_none() => {
                    let created = create_from_note(db, note, id.clone())?;
                    report.imported += 1;
                    let raw = render(&created, Some(&note.metadata))?;
                    write_checked(&root, &note.path, Some(&hash(&note.raw)), &raw)?;
                    remember(db, &settings.directory, &created, &note.path, &raw)?;
                }
                (None, Some(note), Some(base)) => {
                    if hash(&note.raw) == base.base_file {
                        remove_checked(&root, &note.path, &base.base_file)?;
                        clear_history(&root, &id)?;
                        untrack(db, &settings.directory, &id)?;
                        report.removed += 1;
                    } else {
                        issue(&mut report,Some(&id),&path,"inactive","此记忆在 Piko 中已删除、归档或设为私密，但 Markdown 仍有修改；可删除文件或将文件另存为新记忆",true);
                    }
                }
                (None, Some(_), None) => issue(
                    &mut report,
                    Some(&id),
                    &path,
                    "inactive",
                    "此编号对应已失效或私密记忆，请选择删除文件或另存为新记忆",
                    true,
                ),
                (None, None, Some(_)) => {
                    clear_history(&root, &id)?;
                    untrack(db, &settings.directory, &id)?;
                }
                _ => {}
            }
            Ok(())
        })();
        if let Err(message) = result {
            issue(&mut report, Some(&id), &path, "error", &message, false);
        }
    }
    report.synced_at = now();
    Ok(report)
}
fn synchronize(db: &MemoryDb, settings: &VaultConfig) -> Result<SyncReport, String> {
    if !settings.enabled {
        return Err("Markdown 自动同步已暂停".into());
    }
    match sync_inner(db, settings) {
        Ok(report) => {
            remember_report(db, &settings.directory, &report)?;
            Ok(report)
        }
        Err(message) => {
            let mut report = read_report(db, &settings.directory)?;
            report.error = Some(message.clone());
            remember_report(db, &settings.directory, &report)?;
            Err(message)
        }
    }
}

fn version(item: Option<&MemoryItem>) -> Result<Option<String>, String> {
    item.map(|m| {
        Ok(hash(&format!(
            "{}|{:?}|{:?}|{:?}",
            Editable::from_memory(m).fingerprint()?,
            m.status,
            m.privacy_level,
            m.expires_at
        )))
    })
    .transpose()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPreview {
    pub memory_id: String,
    pub path: String,
    pub piko_title: Option<String>,
    pub piko_content: Option<String>,
    pub file_title: Option<String>,
    pub file_content: Option<String>,
    pub piko_version: Option<String>,
    pub file_version: Option<String>,
    pub active: bool,
    pub piko_metadata: Option<String>,
    pub file_metadata: Option<String>,
}
fn note_at(root: &Path, path: &str) -> Result<Option<Note>, String> {
    let first = Path::new(path)
        .components()
        .next()
        .ok_or("笔记路径无效")?
        .as_os_str()
        .to_string_lossy();
    let kind = kinds()
        .into_iter()
        .find(|k| category(k) == first)
        .ok_or("笔记需要位于记忆分类目录内")?;
    let full = safe_path(root, path)?;
    read_note_file(&full)?
        .map(|raw| parse_note(path, &raw, kind))
        .transpose()
}
fn confirm_issue(
    db: &MemoryDb,
    settings: &VaultConfig,
    id: &str,
    path: &str,
) -> Result<(), String> {
    if !read_report(db, &settings.directory)?
        .issues
        .iter()
        .any(|i| i.memory_id.as_deref() == Some(id) && i.path == path && i.can_resolve)
    {
        return Err("此待处理项已变化，请重新同步".into());
    }
    Ok(())
}
fn edit_summary(edit: &Editable) -> String {
    format!(
        "分类：{} · 重要度：{} · 标签：{}",
        category(&edit.kind),
        edit.importance,
        edit.tags.join("、")
    )
}
fn preview(
    db: &MemoryDb,
    settings: &VaultConfig,
    id: &str,
    path: &str,
) -> Result<ConflictPreview, String> {
    confirm_issue(db, settings, id, path)?;
    let root = Path::new(&settings.directory).canonicalize().map_err(err)?;
    let item = db.get(id)?;
    let note = note_at(&root, path)?;
    Ok(ConflictPreview {
        memory_id: id.into(),
        path: path.into(),
        piko_title: item.as_ref().map(|m| m.title.clone()),
        piko_content: item.as_ref().map(|m| m.content.clone()),
        file_title: note.as_ref().map(|n| n.edit.title.clone()),
        file_content: note.as_ref().map(|n| n.edit.content.clone()),
        piko_version: version(item.as_ref())?,
        file_version: note.as_ref().map(|n| hash(&n.raw)),
        active: item.as_ref().is_some_and(eligible),
        piko_metadata: item
            .as_ref()
            .map(|i| edit_summary(&Editable::from_memory(i))),
        file_metadata: note.as_ref().map(|n| edit_summary(&n.edit)),
    })
}
fn forget_checked(db: &MemoryDb, item: &MemoryItem) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(err)?;
    let tx = conn.transaction().map_err(err)?;
    let count=tx.execute("UPDATE memory_items SET status=?1,updated_at=?2 WHERE id=?3 AND title=?4 AND content=?5 AND tags=?6 AND importance=?7 AND memory_type=?8 AND status=?9 AND privacy_level=?10",params![MemoryStatus::Deleted,now(),item.id,item.title,item.content,serde_json::to_string(&item.tags).map_err(err)?,item.importance,item.memory_type,item.status,item.privacy_level]).map_err(err)?;
    if count != 1 {
        return Err("记忆已改变，请重新查看待处理项".into());
    }
    for (table, column) in [
        ("retrieval_vectors", "id"),
        ("memory_revisions", "memory_id"),
        ("memory_provenance", "memory_id"),
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE {column}=?1"),
            [&item.id],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInput {
    pub memory_id: String,
    pub path: String,
    pub choice: String,
    pub piko_version: Option<String>,
    pub file_version: Option<String>,
}
fn resolve(db: &MemoryDb, settings: &VaultConfig, input: &ResolveInput) -> Result<(), String> {
    confirm_issue(db, settings, &input.memory_id, &input.path)?;
    let root = Path::new(&settings.directory).canonicalize().map_err(err)?;
    let item = db.get(&input.memory_id)?;
    let note = note_at(&root, &input.path)?;
    if version(item.as_ref())? != input.piko_version
        || note.as_ref().map(|n| hash(&n.raw)) != input.file_version
    {
        return Err("两侧内容已变化，请重新打开比较后再选择".into());
    }
    match input.choice.as_str() {
        "piko" => {
            if let Some(item) = item.as_ref().filter(|m| eligible(m)) {
                export_item(db, &root, settings, item, note.as_ref(), &input.path)?;
            } else {
                if let Some(file_hash) = input.file_version.as_deref() {
                    remove_checked(&root, &input.path, file_hash)?;
                }
                clear_history(&root, &input.memory_id)?;
                untrack(db, &settings.directory, &input.memory_id)?;
            }
        }
        "file" => match note {
            Some(note) => {
                let changed = if let Some(item) = item.as_ref().filter(|m| eligible(m)) {
                    apply_edit(db, item, &note.edit)?
                } else {
                    let nonce = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos();
                    create_from_note(
                        db,
                        &note,
                        format!(
                            "memory-vault-{}",
                            hash(&format!("{}:{nonce}", input.memory_id))
                        ),
                    )?
                };
                let raw = render(&changed, Some(&note.metadata))?;
                write_checked(&root, &input.path, input.file_version.as_deref(), &raw)?;
                if changed.id != input.memory_id {
                    untrack(db, &settings.directory, &input.memory_id)?;
                    clear_history(&root, &input.memory_id)?;
                }
                remember(db, &settings.directory, &changed, &input.path, &raw)?;
            }
            None => {
                if let Some(item) = item.as_ref() {
                    forget_checked(db, item)?;
                }
                clear_history(&root, &input.memory_id)?;
                untrack(db, &settings.directory, &input.memory_id)?;
            }
        },
        _ => return Err("请选择保留 Piko 或 Markdown 的版本".into()),
    }
    Ok(())
}

fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("memory-vault"))
        .map_err(err)
}
fn persistent(app: &tauri::AppHandle) -> bool {
    app.try_state::<crate::data_snapshot::MemoryPersistence>()
        .is_some_and(|s| s.0)
}
fn ensure_persistent(app: &tauri::AppHandle) -> Result<(), String> {
    if !persistent(app) {
        Err("当前使用临时记忆数据库，已停用 Markdown 同步以保护磁盘上的记忆".into())
    } else {
        Ok(())
    }
}
fn status(db: &MemoryDb, default_root: &Path, persistent: bool) -> Result<VaultStatus, String> {
    let settings = config(db, default_root)?;
    Ok(VaultStatus {
        tracked_count: tracked(db, &settings.directory)?.len(),
        report: read_report(db, &settings.directory)?,
        config: settings,
        persistent,
    })
}
fn emit_updates(app: &tauri::AppHandle, report: &SyncReport) {
    let _ = app.emit("memory-vault-updated", ());
    if report.imported > 0 {
        let _ = app.emit("memories-updated", ());
    }
}
/// The frontend cannot choose an arbitrary path or application. Resolve only the saved vault.
fn configured_directory(db: &MemoryDb, default: &Path) -> Result<PathBuf, String> {
    let settings = config(db, default)?;
    let directory = PathBuf::from(&settings.directory);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("记忆目录尚未生成或不可用，请先同步并检查磁盘连接".into());
    }
    directory.canonicalize().map_err(err)
}
#[tauri::command]
pub async fn memory_vault_open_directory(
    app: tauri::AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    ensure_persistent(&app)?;
    let default = default_root(&app)?;
    let db = Arc::clone(db.inner());
    let directory =
        tauri::async_runtime::spawn_blocking(move || configured_directory(&db, &default))
            .await
            .map_err(|_| "读取记忆目录失败")??;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|_| "无法打开记忆目录，请检查系统文件管理器".into())
}
#[tauri::command]
pub fn memory_vault_status(
    app: tauri::AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<VaultStatus, String> {
    status(&db, &default_root(&app)?, persistent(&app))
}
#[tauri::command]
pub async fn memory_vault_configure(
    app: tauri::AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    enabled: bool,
    directory: Option<String>,
) -> Result<VaultStatus, String> {
    ensure_persistent(&app)?;
    let default = default_root(&app)?;
    let db = Arc::clone(db.inner());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = SYNC_LOCK.lock().map_err(err)?;
        let _lease = crate::data_gate::try_read()?;
        let mut settings = config(&db, &default)?;
        if let Some(directory) = directory {
            let selected = PathBuf::from(directory);
            if !selected.is_absolute() || !selected.is_dir() {
                return Err("请选择已存在的 Markdown 知识库目录".into());
            }
            settings.directory = selected
                .canonicalize()
                .map_err(err)?
                .to_string_lossy()
                .into_owned();
        }
        settings.enabled = enabled;
        settings.paused_reason = None;
        save_config(&db, &settings)?;
        status(&db, &default, true)
    })
    .await
    .map_err(|_| "Markdown 配置任务失败")??;
    let _ = app.emit("memory-vault-updated", ());
    Ok(result)
}
#[tauri::command]
pub async fn memory_vault_sync(
    app: tauri::AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<SyncReport, String> {
    ensure_persistent(&app)?;
    let default = default_root(&app)?;
    let db = Arc::clone(db.inner());
    let report = tauri::async_runtime::spawn_blocking(move || {
        let _guard = SYNC_LOCK.lock().map_err(err)?;
        let _lease = crate::data_gate::try_read()?;
        synchronize(&db, &config(&db, &default)?)
    })
    .await
    .map_err(|_| "Markdown 同步任务失败")??;
    emit_updates(&app, &report);
    Ok(report)
}
#[tauri::command]
pub async fn memory_vault_preview(
    app: tauri::AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    memory_id: String,
    path: String,
) -> Result<ConflictPreview, String> {
    let default = default_root(&app)?;
    let db = Arc::clone(db.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SYNC_LOCK.lock().map_err(err)?;
        let _lease = crate::data_gate::try_read()?;
        preview(&db, &config(&db, &default)?, &memory_id, &path)
    })
    .await
    .map_err(|_| "Markdown 比较任务失败")?
}
#[tauri::command]
pub async fn memory_vault_resolve(
    app: tauri::AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: ResolveInput,
) -> Result<SyncReport, String> {
    ensure_persistent(&app)?;
    let default = default_root(&app)?;
    let db = Arc::clone(db.inner());
    let cleanup_id = input.memory_id.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let _guard = SYNC_LOCK.lock().map_err(err)?;
        let _lease = crate::data_gate::try_read()?;
        let settings = config(&db, &default)?;
        if !settings.enabled {
            return Err("请先恢复 Markdown 同步".into());
        }
        resolve(&db, &settings, &input)?;
        synchronize(&db, &settings)
    })
    .await
    .map_err(|_| "Markdown 冲突处理失败")??;
    {
        let db = Arc::clone(app.state::<Arc<MemoryDb>>().inner());
        crate::common::on_blocking(move || {
            if let Some(item) = db.get(&cleanup_id)? {
                if item.status == MemoryStatus::Deleted {
                    if let Ok(mut conn) = db.0.lock() {
                        let _ = super::soul::lifecycle::delete_sources(
                            &mut conn,
                            &[cleanup_id],
                            now() as i64,
                        );
                    }
                }
            }
            Ok(())
        })
        .await?;
    }
    let _ = app.emit("memories-updated", ());
    emit_updates(&app, &report);
    Ok(report)
}

/// A restored DB must not immediately ingest newer external files and undo the restore.
pub(crate) fn pause_after_restore(conn: &Connection) -> Result<(), String> {
    migrate(conn)?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_vault_config WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let mut settings = value
        .and_then(|s| serde_json::from_str::<VaultConfig>(&s).ok())
        .unwrap_or_else(|| default_config(Path::new("")));
    settings.enabled = false;
    settings.paused_reason =
        Some("数据库已从快照恢复，Markdown 同步已暂停；请确认磁盘笔记后重新启用".into());
    conn.execute("INSERT INTO memory_vault_config VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value",[serde_json::to_string(&settings).map_err(err)?]).map_err(err)?;
    Ok(())
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        loop {
            if persistent(&app) {
                let app_for_worker = app.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                    let Ok(_guard) = SYNC_LOCK.try_lock() else {
                        return Ok(());
                    };
                    let _lease = crate::data_gate::try_read()?;
                    let db = app_for_worker.state::<Arc<MemoryDb>>();
                    let settings = config(&db, &default_root(&app_for_worker)?)?;
                    if settings.enabled {
                        match synchronize(&db, &settings) {
                            Ok(report) => emit_updates(&app_for_worker, &report),
                            Err(_) => {
                                let _ = app_for_worker.emit("memory-vault-updated", ());
                            }
                        }
                    }
                    Ok(())
                })
                .await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    });
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
