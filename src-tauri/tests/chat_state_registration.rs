/// Guard the chat command's IPC-injected database type against startup registration.
#[test]
fn chat_memory_state_matches_registered_shared_database() {
    let startup = include_str!("../src/lib.rs");
    let chat = include_str!("../src/chat.rs");
    assert!(startup.contains("app.manage(Arc::new(memory_db))"));
    assert!(chat.contains("memory_db: State<'_, Arc<memory::MemoryDb>>"));
    assert!(!chat.contains("memory_db: State<'_, memory::MemoryDb>"));
}
