use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt};

pub async fn collect(reader: impl AsyncRead + Unpin, directory: &Path, id: &str, api_key: &str) {
    let mut reader = reader;
    let mut captured = Vec::new();
    let mut buffer = [0; 2048];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let keep = count.min(32_768usize.saturating_sub(captured.len()));
                captured.extend_from_slice(&buffer[..keep]);
                truncated |= keep < count;
            }
        }
    }
    let text = redact(&String::from_utf8_lossy(&captured), api_key);
    let _ = crate::storage::write(
        &directory.join(format!("{id}.json")),
        &serde_json::json!({"text":text,"truncated":truncated}),
    );
    if let Ok(entries) = std::fs::read_dir(directory) {
        let mut entries: Vec<_> = entries
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        entries.sort_by_key(|entry| {
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        let remove = entries.len().saturating_sub(20);
        for entry in entries.into_iter().take(remove) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn redact(text: &str, api_key: &str) -> String {
    let prefix: String = api_key.chars().take(8).collect();
    text.lines()
        .map(|line| {
            let lower = line.to_lowercase();
            if [
                "authorization",
                "bearer",
                "token",
                "api_key",
                "apikey",
                "api-key",
                "password",
                "secret",
                "cookie",
            ]
            .iter()
            .any(|word| lower.contains(word))
                || (!prefix.is_empty() && line.contains(&prefix))
                || (line.contains("://") && line.contains('@'))
            {
                "[敏感诊断已隐藏]".into()
            } else {
                line.chars().take(2000).collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::redact;
    #[test]
    fn diagnostic_secrets_and_partial_keys_are_not_saved() {
        let text = "HTTP 500\nAuthorization: Bearer private\nraw abcdefgh-partial\nhttps://user:pass@host/path\nmodel unavailable";
        let result = redact(text, "abcdefgh-long-secret");
        assert!(result.contains("HTTP 500") && result.contains("model unavailable"));
        assert!(
            !result.contains("private")
                && !result.contains("partial")
                && !result.contains("user:pass")
        );
    }
}
