//! Файловый журнал: `state_dir/mshh.log`. С TUI stderr использовать нельзя,
//! поэтому по умолчанию всё пишется в файл; `--verbose` дублирует в stderr.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use chrono::Local;

static FILE: Mutex<Option<File>> = Mutex::new(None);
static VERBOSE: AtomicBool = AtomicBool::new(false);
/// Порог: 0=ERROR .. 3=DEBUG.
static LEVEL: AtomicU8 = AtomicU8::new(2);

pub fn init(path: &Path, verbose: bool) {
    VERBOSE.store(verbose, Ordering::Relaxed);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let f = OpenOptions::new().create(true).append(true).open(path).ok();
    *FILE.lock().unwrap_or_else(|e| e.into_inner()) = f;
}

pub fn write(level: u8, tag: &str, msg: &str) {
    if level > LEVEL.load(Ordering::Relaxed) {
        return;
    }
    let name = match level {
        0 => "ERROR",
        1 => "WARN",
        2 => "INFO",
        _ => "DEBUG",
    };
    let line = format!(
        "{} [{:<5}] {}: {}\n",
        Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        name,
        tag,
        msg
    );
    if let Ok(mut g) = FILE.lock() {
        if let Some(f) = g.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }
    if VERBOSE.load(Ordering::Relaxed) {
        eprint!("{line}");
    }
}

pub fn error(tag: &str, msg: &str) {
    write(0, tag, msg)
}
pub fn warn(tag: &str, msg: &str) {
    write(1, tag, msg)
}
pub fn info(tag: &str, msg: &str) {
    write(2, tag, msg)
}
pub fn debug(tag: &str, msg: &str) {
    write(3, tag, msg)
}
