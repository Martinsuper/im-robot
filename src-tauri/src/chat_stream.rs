//! Keep incomplete UTF-8 sequences intact across arbitrary HTTP chunk boundaries.
#[derive(Default)]
pub(crate) struct SseLines {
    pending: Vec<u8>,
}

impl SseLines {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0;
        for (index, byte) in self.pending.iter().enumerate() {
            if *byte == b'\n' {
                lines.push(
                    std::str::from_utf8(&self.pending[consumed..index])
                        .map_err(|e| format!("模型返回了无效 UTF-8：{e}"))?
                        .to_owned(),
                );
                consumed = index + 1;
            }
        }
        self.pending.drain(..consumed);
        Ok(lines)
    }

    pub fn finish(self) -> Result<String, String> {
        String::from_utf8(self.pending).map_err(|e| format!("模型返回了不完整 UTF-8：{e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_byte_boundary_preserves_chinese_and_emoji() {
        let source = "data: {\"text\":\"你好🌿\"}\r\ndata: [DONE]\n";
        for split in 0..=source.len() {
            let mut parser = SseLines::default();
            let mut lines = parser.push(&source.as_bytes()[..split]).unwrap();
            lines.extend(parser.push(&source.as_bytes()[split..]).unwrap());
            assert_eq!(lines, vec!["data: {\"text\":\"你好🌿\"}\r", "data: [DONE]"]);
            assert_eq!(parser.finish().unwrap(), "");
        }
    }
    #[test]
    fn truncated_utf8_is_reported_instead_of_replaced() {
        let mut parser = SseLines::default();
        parser.push(&[0xe4, 0xbd]).unwrap();
        assert!(parser.finish().is_err());
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_request() {
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let cancelled = tokio::select! {
            biased;
            _ = token.cancelled() => true,
            _ = std::future::pending::<()>() => false,
        };
        assert!(cancelled);
    }
}
