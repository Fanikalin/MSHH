//! Установка модулей из git-репозиториев.
//!
//! Формат ссылки и требования к репозиторию — docs/MODULE-REPO.md.
//! Пайплайн: `git clone --depth 1` → поиск cdylib-крейтов (до 3 уровней
//! вложенности) → `cargo build --release` → копирование артефакта в каталог
//! модулей. Выполняется в отдельном потоке, прогресс — через канал ядра.

use std::path::{Path, PathBuf};

use crate::logger;

/// Базовые модули каталога MSHH: клонируются из нашего репозитория.
pub struct BaseModule {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub subdir: &'static str,
}

pub const BASE_MODULES: &[BaseModule] = &[
    BaseModule { id: "telegram", name: "Telegram", url: "https://github.com/Fanikalin/MSHH-modules.git", subdir: "telegram" },
    BaseModule { id: "matrix", name: "Matrix", url: "https://github.com/Fanikalin/MSHH-modules.git", subdir: "matrix" },
    BaseModule { id: "max", name: "MAX", url: "https://github.com/Fanikalin/MSHH-modules.git", subdir: "max" },
    BaseModule { id: "reticulum", name: "Reticulum", url: "https://github.com/Fanikalin/MSHH-modules.git", subdir: "reticulum" },
    BaseModule { id: "xmpp", name: "XMPP", url: "https://github.com/Fanikalin/MSHH-modules.git", subdir: "xmpp" },
    BaseModule { id: "irc", name: "IRC", url: "https://github.com/Fanikalin/MSHH-modules.git", subdir: "irc" },
];

/// Ссылка может нести подкаталог после `#`: `https://…/repo.git#modules/x`.
pub fn split_url(url: &str) -> (String, Option<String>) {
    match url.split_once('#') {
        Some((u, sub)) => {
            let sub = sub.trim().trim_end_matches('/');
            if sub.is_empty() {
                (u.to_string(), None)
            } else {
                (u.to_string(), Some(sub.to_string()))
            }
        }
        None => (url.to_string(), None),
    }
}

/// Найти cdylib-крейты в дереве репозитория (глубина ≤ 3).
/// Возвращает (путь к крейту, имя пакета).
pub fn find_cdylib_crates(repo: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    walk(repo, 0, &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, String)>) {
    if depth > 3 {
        return;
    }
    let manifest = dir.join("Cargo.toml");
    if manifest.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&manifest) {
            if let Ok(parsed) = raw.parse::<toml::Table>() {
                let cdylib = parsed
                    .get("lib")
                    .and_then(|l| l.get("crate-type"))
                    .and_then(|t| t.as_array())
                    .map(|a| a.iter().any(|v| v.as_str() == Some("cdylib")))
                    .unwrap_or(false);
                if cdylib {
                    if let Some(name) = parsed
                        .get("package")
                        .and_then(|p| p.get("name"))
                        .and_then(|n| n.as_str())
                    {
                        out.push((dir.to_path_buf(), name.to_string()));
                        return; // внутри крейта глубже не ищем
                    }
                }
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let skip = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n == "target" || n.starts_with('.'))
                    .unwrap_or(true);
                if !skip {
                    walk(&p, depth + 1, out);
                }
            }
        }
    }
}

/// Установить модуль из уже склонированного репозитория.
/// `subdir` ограничивает поиск крейтов поддеревом. Возвращает путь к .so.
pub fn install_from_repo(
    repo: &Path,
    subdir: Option<&str>,
    dest_dir: &Path,
    progress: &dyn Fn(String),
) -> Result<PathBuf, String> {
    let root = match subdir {
        Some(s) => {
            let p = repo.join(s);
            if !p.is_dir() {
                return Err(format!("подкаталог «{s}» не найден в репозитории"));
            }
            p
        }
        None => repo.to_path_buf(),
    };
    let crates = find_cdylib_crates(&root);
    let Some((crate_dir, pkg)) = crates.first().cloned() else {
        return Err("в репозитории не найдено ни одного cdylib-крейта (см. docs/MODULE-REPO.md)".into());
    };
    if crates.len() > 1 {
        progress(format!("в репозитории несколько модулей, устанавливаю первый: {pkg}"));
    }

    progress(format!("сборка {pkg} (cargo build --release)…"));
    let out = std::process::Command::new("cargo")
        .args(["build", "--release"])
        .current_dir(&crate_dir)
        .output()
        .map_err(|e| format!("cargo не запущен: {e}"))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let tail = tail.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("cargo build {pkg} завершился с ошибкой:\n{tail}"));
    }

    // Артефакт: crate target или общий workspace target — ищем от репозитория.
    let artifact = find_artifact(&root, &pkg, &crate_dir)
        .ok_or_else(|| format!("артефакт lib{pkg}.so не найден после сборки"))?;

    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(artifact.file_name().expect("имя файла"));
    std::fs::copy(&artifact, &dest).map_err(|e| format!("копирование: {e}"))?;
    logger::info("installer", &format!("установлен {} -> {}", artifact.display(), dest.display()));
    Ok(dest)
}

fn find_artifact(root: &Path, pkg: &str, crate_dir: &Path) -> Option<PathBuf> {
    // Cargo превращает дефисы имени пакета в подчёркивания в имени файла.
    let names = [
        format!("lib{pkg}.so"),
        format!("lib{}.so", pkg.replace('-', "_")),
    ];
    // Сначала target крейта, затем общий target workspace.
    for base in [crate_dir.join("target/release"), root.join("target/release")] {
        for name in &names {
            let p = base.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut found = None;
    for name in &names {
        search_file(root, name, 0, 5, &mut found);
        if found.is_some() {
            break;
        }
    }
    found
}

fn search_file(dir: &Path, name: &str, depth: usize, max: usize, found: &mut Option<PathBuf>) {
    if found.is_some() || depth > max {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() && p.file_name().and_then(|n| n.to_str()) == Some(name) {
                *found = Some(p);
                return;
            }
            if p.is_dir() && !p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with('.')).unwrap_or(false) {
                search_file(&p, name, depth + 1, max, found);
            }
        }
    }
}

/// Полный цикл: клонировать и установить. `subdir` ограничивает поиск
/// крейтов поддеревом репозитория (для базовых модулей — обязателен).
/// Возвращает путь к .so.
pub fn install_from_url(
    url: &str,
    subdir: Option<&str>,
    work_dir: &Path,
    dest_dir: &Path,
    progress: &dyn Fn(String),
) -> Result<PathBuf, String> {
    let (clean_url, url_subdir) = split_url(url);
    let subdir = subdir.or(url_subdir.as_deref());
    if clean_url.is_empty() {
        return Err("пустая ссылка".into());
    }
    // Стабильное имя каталога: хеш ссылки.
    let hash = fnv1a(&clean_url);
    let repo_dir = work_dir.join(format!("repo-{hash:016x}"));
    if repo_dir.exists() {
        // Повторная установка: свежий клон поверх старого.
        let _ = std::fs::remove_dir_all(&repo_dir);
    }
    std::fs::create_dir_all(&repo_dir).map_err(|e| e.to_string())?;

    progress(format!("клонирование {clean_url}…"));
    let out = std::process::Command::new("git")
        .args(["clone", "--depth", "1", &clean_url, repo_dir.to_string_lossy().as_ref()])
        .output()
        .map_err(|e| format!("git не найден: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_dir_all(&repo_dir);
        return Err(format!("git clone: {}", msg.lines().last().unwrap_or("ошибка")));
    }
    let src_log = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !src_log.is_empty() {
        logger::debug("installer", &src_log);
    }

    install_from_repo(&repo_dir, subdir, dest_dir, progress)
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_subdir_split() {
        assert_eq!(split_url("https://x.y/r.git"), ("https://x.y/r.git".into(), None));
        let (u, s) = split_url("https://x.y/r.git#modules/tg");
        assert_eq!(u, "https://x.y/r.git");
        assert_eq!(s.as_deref(), Some("modules/tg"));
        let (u, s) = split_url("https://x.y/r.git#");
        assert_eq!(s, None);
    }

    #[test]
    fn detects_cdylib_crate() {
        let dir = std::env::temp_dir().join(format!("mshh-fix-{}", std::process::id()));
        let crate_dir = dir.join("nested/my-mod");
        std::fs::create_dir_all(crate_dir.join("src")).unwrap();
        std::fs::write(
            crate_dir.join("Cargo.toml"),
            "[package]\nname = \"mshh-module-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\ncrate-type = [\"cdylib\"]\n",
        )
        .unwrap();
        std::fs::write(crate_dir.join("src/lib.rs"), "pub fn x() {}").unwrap();
        let found = find_cdylib_crates(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, "mshh-module-fixture");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_and_installs_fixture() {
        // Полный цикл на крейте без зависимостей: build + copy.
        let dir = std::env::temp_dir().join(format!("mshh-inst-{}", std::process::id()));
        let crate_dir = dir.join("repo/my-mod");
        std::fs::create_dir_all(crate_dir.join("src")).unwrap();
        std::fs::write(
            crate_dir.join("Cargo.toml"),
            "[package]\nname = \"mshh-module-fixture2\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\ncrate-type = [\"cdylib\"]\n",
        )
        .unwrap();
        std::fs::write(crate_dir.join("src/lib.rs"), "").unwrap();
        let dest = dir.join("modules");
        let got = install_from_repo(&dir, Some("repo/my-mod"), &dest, &|m| {
            logger::debug("installer-test", &m)
        });
        assert!(got.is_ok(), "{got:?}");
        assert!(dest.join("libmshh_module_fixture2.so").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn installs_from_git_url() {
        // Полный путь: git clone (file://) + сборка + установка.
        let dir = std::env::temp_dir().join(format!("mshh-git-{}", std::process::id()));
        let repo = dir.join("repo");
        let crate_dir = repo.join("mod");
        std::fs::create_dir_all(crate_dir.join("src")).unwrap();
        std::fs::write(
            crate_dir.join("Cargo.toml"),
            "[package]\nname = \"mshh-module-fixture3\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\ncrate-type = [\"cdylib\"]\n",
        )
        .unwrap();
        std::fs::write(crate_dir.join("src/lib.rs"), "").unwrap();
        let cmds: [&[&str]; 3] = [
            &["init", "-q"],
            &["add", "-A"],
            &["-c", "user.email=t@t", "commit", "-q", "-m", "init"],
        ];
        for args in cmds {
            let st = std::process::Command::new("git").args(args).current_dir(&repo).output().unwrap();
            assert!(st.status.success(), "git {args:?} failed");
        }
        let url = format!("file://{}", repo.display());
        let dest = dir.join("modules");
        let got = install_from_url(
            &url,
            Some("mod"),
            &dir.join("src-cache"),
            &dest,
            &|m| logger::debug("installer-test", &m),
        );
        assert!(got.is_ok(), "{got:?}");
        assert!(dest.join("libmshh_module_fixture3.so").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
