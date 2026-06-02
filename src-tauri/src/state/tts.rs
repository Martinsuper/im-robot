use std::process::Child;
use std::sync::Mutex;

#[derive(Default)]
pub struct LocalTts(pub Mutex<Option<Child>>);
