use crate::types::TextAttachment;
use std::sync::Mutex;

#[derive(Default)]
pub struct TextAttachmentStore(pub Mutex<Option<TextAttachment>>);
