use std::sync::Mutex;

#[derive(Default)]
pub struct IdleDetection(pub Mutex<bool>);
