//! Загрузка cdylib-модулей: сканирование каталогов, ABI-хендшейк, символы.

use std::collections::HashSet;
use std::ffi::{c_void, CStr};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use libloading::{Library, Symbol};
use mshh_module_api::abi::{exports, MshhHostVTable, MshhModuleInfo, MshhStr, ABI_VERSION};
use mshh_module_api::model::FieldDef;

/// Загруженные библиотеки живут до конца процесса: dlclose Rust-cdylib
/// небезопасен — libc остаётся с зарегистрированными модулем TLS/atexit
/// деструкторами и вызывает их в unmapped-память (SEGSEGV). Это явный
/// владелец с осознанным решением «не освобождать».
static LOADED_LIBS: Mutex<Vec<Library>> = Mutex::new(Vec::new());

#[derive(Clone, Debug)]
pub struct ModuleInfoOwned {
    pub id: String,
    pub name: String,
    pub version: String,
}

type StartFn = unsafe extern "C" fn(*const MshhHostVTable, MshhStr) -> *mut c_void;
pub type RunFn = unsafe extern "C" fn(*mut c_void);
type SinkFn = unsafe extern "C" fn(*mut c_void, MshhStr) -> u32;
type DestroyFn = unsafe extern "C" fn(*mut c_void);

/// Загруженная библиотека модуля: сырые символы + метаданные + схема настроек.
/// Сам `Library` хранится в `LOADED_LIBS` и не выгружается до конца процесса.
#[derive(Clone)]
pub struct ModuleLib {
    pub info: ModuleInfoOwned,
    pub path: PathBuf,
    /// Схема настроек профиля (пустая, если экспорт не реализован).
    pub settings: Vec<FieldDef>,
    pub start: StartFn,
    pub run: RunFn,
    pub sink: SinkFn,
    pub destroy: DestroyFn,
}

impl ModuleLib {
    pub fn load(path: &Path) -> Result<ModuleLib, String> {
        // # Safety: все вызовы — стандартный dlopen/dlsym контракт libloading.
        unsafe {
            let lib = Library::new(path).map_err(|e| format!("{}: {e}", path.display()))?;

            let abi_sym: Symbol<unsafe extern "C" fn() -> u32> =
                lib.get(exports::ABI_VERSION.as_bytes()).map_err(missing)?;
            let abi = abi_sym();
            if abi != ABI_VERSION {
                return Err(format!(
                    "{}: ABI модуля {abi} несовместим с ядром {ABI_VERSION}",
                    path.display()
                ));
            }

            let info_sym: Symbol<unsafe extern "C" fn() -> *const MshhModuleInfo> =
                lib.get(exports::MODULE_INFO.as_bytes()).map_err(missing)?;
            let iptr = info_sym();
            if iptr.is_null() {
                return Err(format!("{}: mshh_module_info вернул null", path.display()));
            }
            let raw = &*iptr;
            let info = ModuleInfoOwned {
                id: raw.id.as_str().to_string(),
                name: raw.name.as_str().to_string(),
                version: raw.version.as_str().to_string(),
            };

            let start: StartFn = *lib.get::<StartFn>(exports::MODULE_START.as_bytes()).map_err(missing)?;
            let run: RunFn = *lib.get::<RunFn>(exports::MODULE_RUN.as_bytes()).map_err(missing)?;
            let sink: SinkFn = *lib.get::<SinkFn>(exports::EVENT_SINK.as_bytes()).map_err(missing)?;
            let destroy: DestroyFn =
                *lib.get::<DestroyFn>(exports::MODULE_DESTROY.as_bytes()).map_err(missing)?;

            // Опциональный экспорт схемы настроек (ABI v2).
            let settings = match lib.get::<unsafe extern "C" fn() -> *const c_char>(
                exports::MODULE_SETTINGS.as_bytes(),
            ) {
                Ok(f) => {
                    let p = f();
                    if p.is_null() {
                        Vec::new()
                    } else {
                        let s = CStr::from_ptr(p).to_string_lossy();
                        serde_json::from_str(&s).unwrap_or_else(|e| {
                            crate::logger::warn(
                                "core",
                                &format!("{}: settings schema: {e}", info.id),
                            );
                            Vec::new()
                        })
                    }
                }
                Err(_) => Vec::new(),
            };

            // Библиотека не выгружается никогда (см. LOADED_LIBS).
            LOADED_LIBS.lock().unwrap_or_else(|e| e.into_inner()).push(lib);

            Ok(ModuleLib { info, path: path.to_path_buf(), settings, start, run, sink, destroy })
        }
    }
}

fn missing(e: libloading::Error) -> String {
    format!("нет экспорта: {e}")
}

/// Расширение динамической библиотеки для текущей платформы.
pub fn lib_ext() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "so"
    }
    #[cfg(target_os = "macos")]
    {
        "dylib"
    }
    #[cfg(target_os = "windows")]
    {
        "dll"
    }
}

pub fn module_files(dir: &Path) -> Vec<PathBuf> {
    let ext = lib_ext();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some(ext) {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// Загрузить все библиотеки из каталогов; дубликат id пропускается.
/// Возвращает (загруженные, ошибки).
pub fn load_all(dirs: &[PathBuf]) -> (Vec<ModuleLib>, Vec<String>) {
    let mut libs = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    for dir in dirs {
        for path in module_files(dir) {
            match ModuleLib::load(&path) {
                Ok(l) => {
                    if !seen.insert(l.info.id.clone()) {
                        errors.push(format!(
                            "{}: дубликат id «{}» — пропущен",
                            l.path.display(),
                            l.info.id
                        ));
                        continue;
                    }
                    libs.push(l);
                }
                Err(e) => errors.push(e),
            }
        }
    }
    (libs, errors)
}

/// `--list`: печатает найденные модули и выходит.
pub fn list(dirs: &[PathBuf]) -> std::process::ExitCode {
    let (libs, errors) = load_all(dirs);
    for e in errors {
        eprintln!("ошибка: {e}");
    }
    if libs.is_empty() {
        eprintln!("модули не найдены в: {dirs:?}");
        return std::process::ExitCode::FAILURE;
    }
    println!("{:<10} {:<24} {:<10} ПУТЬ", "ID", "ИМЯ", "ВЕРСИЯ");
    for l in &libs {
        println!(
            "{:<10} {:<24} {:<10} {}",
            l.info.id,
            l.info.name,
            l.info.version,
            l.path.display()
        );
    }
    std::process::ExitCode::SUCCESS
}
