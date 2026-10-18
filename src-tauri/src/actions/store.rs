//! In-memory pending drafts. Owns the queue lock and one-time consumption semantics.
use super::ActionDraft;
use std::{collections::HashMap, sync::Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DraftStoreError {
    Unavailable,
    Expired,
}

#[derive(Default)]
pub(crate) struct ActionDrafts(Mutex<HashMap<String, ActionDraft>>);

impl ActionDrafts {
    pub(crate) fn insert(&self, draft: ActionDraft) -> Result<(), DraftStoreError> {
        self.0
            .lock()
            .map_err(|_| DraftStoreError::Unavailable)?
            .insert(draft.id.clone(), draft);
        Ok(())
    }

    /// Authorization can inspect an owned snapshot without consuming the pending action.
    pub(crate) fn get(&self, id: &str) -> Result<Option<ActionDraft>, DraftStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| DraftStoreError::Unavailable)?
            .get(id)
            .cloned())
    }

    /// Removal and expiry detection happen under one lock; only one caller can consume an ID.
    pub(crate) fn take(&self, id: &str) -> Result<ActionDraft, DraftStoreError> {
        self.0
            .lock()
            .map_err(|_| DraftStoreError::Unavailable)?
            .remove(id)
            .ok_or(DraftStoreError::Expired)
    }

    pub(crate) fn discard(
        &self,
        ids: impl IntoIterator<Item = String>,
    ) -> Result<(), DraftStoreError> {
        let mut drafts = self.0.lock().map_err(|_| DraftStoreError::Unavailable)?;
        for id in ids {
            drafts.remove(&id);
        }
        Ok(())
    }
}
