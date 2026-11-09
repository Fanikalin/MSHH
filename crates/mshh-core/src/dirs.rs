use std::path::{Path, PathBuf};

use crate::args::Args;

pub struct Dirs {
    pub data: PathBuf,
    pub state: PathBuf,
    pub modules: Vec<PathBuf>,
    pub db: PathBuf,
    pub log: PathBuf,
}

pub fn resolve(a: &Args) -> Dirs {
    let data = a
        .data_dir
        .clone()
        .unwrap_or_else(|| xdg("XDG_DATA_HOME", ".local/share").join("mshh"));
    let state = a
        .state_dir
        .clone()
        .unwrap_or_else(|| xdg("XDG_STATE_HOME", ".local/state").join("mshh"));
    let modules = if a.modules_dir.is_empty() {
        let mut v = vec![data.join("modules")];
        let local = Path::new("./modules");
        if local.is_dir() {
            v.push(local.to_path_buf());
        }
        v
    } else {
        a.modules_dir.clone()
    };
    Dirs { db: data.join("store.db"), log: state.join("mshh.log"), modules, data, state }
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home().join(fallback),
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}
