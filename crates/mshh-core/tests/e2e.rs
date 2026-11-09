//! E2E: загрузка echo-модуля через реальный ABI, эхо roundtrip, персистентность.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use mshh_core::events::Event;
use mshh_core::runtime::Runtime;
use mshh_core::store::Store;
use mshh_module_api::model::{actions, Body, Ev, UiCmd};

fn echo_lib() -> PathBuf {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = PathBuf::from(manifest).join("../../target");
    for profile in ["debug", "release"] {
        let p = root.join(profile).join("libmshh_module_echo.so");
        if p.exists() {
            return p;
        }
    }
    panic!(
        "libmshh_module_echo.so не найден в target/{{debug,release}} — сначала: cargo build -p mshh-module-echo"
    );
}

fn drain_until(rx: &mpsc::Receiver<Event>, ms: u64, mut pred: impl FnMut(&Event) -> bool) -> Option<Event> {
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        let left = deadline.checked_duration_since(Instant::now()).unwrap_or(Duration::ZERO);
        match rx.recv_timeout(left) {
            Ok(ev) => {
                if pred(&ev) {
                    return Some(ev);
                }
            }
            Err(_) => return None,
        }
    }
}

#[test]
fn echo_roundtrip_and_persistence() {
    let dir = std::env::temp_dir().join(format!("mshh-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = dir.join("store.db");

    // 1. Загрузка и стартовый UI.
    let store = Store::open(&db).expect("store");
    let (tx, rx) = mpsc::channel::<Event>();
    let mut rt = Runtime::new(std::sync::Arc::new(store), tx, vec![]);
    rt.load_file(&echo_lib()).expect("загрузка echo");
    rt.start_all();
    assert!(
        drain_until(&rx, 3000, |ev| matches!(ev, Event::Ui { cmd: UiCmd::SetChats(_), .. })).is_some(),
        "нет SetChats после старта модуля"
    );

    // 2. Отправка -> эхо.
    rt.send_action(
        "echo",
        Ev::UiAction {
            action: actions::COMPOSER_SEND.into(),
            chat_id: Some("local".into()),
            payload: serde_json::json!({ "chat_id": "local", "text": "привет" }),
        },
    );
    assert!(
        drain_until(&rx, 3000, |ev| matches!(ev,
            Event::Ui { cmd: UiCmd::AddMessage(m), .. }
            if !m.out && matches!(&m.body, Body::Text(t) if t.contains("привет"))
        ))
        .is_some(),
        "эхо-ответ не получен"
    );
    rt.shutdown(Duration::from_secs(2));

    // 3. Персистентность: новый runtime на той же БД восстанавливает историю.
    let store2 = Store::open(&db).expect("store2");
    let (tx2, rx2) = mpsc::channel::<Event>();
    let mut rt2 = Runtime::new(std::sync::Arc::new(store2), tx2, vec![]);
    rt2.load_file(&echo_lib()).expect("загрузка echo #2");
    rt2.start_all();
    assert!(
        drain_until(&rx2, 3000, |ev| matches!(ev,
            Event::Ui { cmd: UiCmd::SetMessages { messages, .. }, .. }
            if messages.len() >= 2
        ))
        .is_some(),
        "история не восстановилась из БД"
    );
    rt2.shutdown(Duration::from_secs(2));

    let _ = std::fs::remove_dir_all(&dir);
}
