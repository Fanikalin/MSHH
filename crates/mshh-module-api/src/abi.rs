//! Низкоуровневый C-ABI между ядром (host) и модулем.
//!
//! Правила владения памятью:
//! * все `MshhStr` валидны только на время вызова, в который они переданы;
//! * данные, которые ядро возвращает модулю через out-параметр `MshhBuf`,
//!   аллоцированы `libc::malloc` и освобождаются вызовом `vtable.free`;
//! * ядро копирует всё полученное от модуля до выхода из вызова.
//!
//! Обе стороны оборачивают тела FFI-функций в `catch_unwind`:
//! паника не должна пересекать границу ABI.

use std::ffi::c_void;

/// Версия ABI. Ядро не загружает модули с другой версией
/// (`mshh_abi_version() != ABI_VERSION` -> отказ).
pub const ABI_VERSION: u32 = 1;

pub mod log_level {
    pub const ERROR: u32 = 0;
    pub const WARN: u32 = 1;
    pub const INFO: u32 = 2;
    pub const DEBUG: u32 = 3;
}

/// Коды возврата host-функций.
pub mod rc {
    pub const OK: u32 = 0;
    pub const ERR: u32 = 1;
    /// kv_get: ключ не найден.
    pub const MISS: u32 = 2;
}

/// Строка `(ptr, len)`, заимствованная на время одного вызова.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MshhStr {
    pub ptr: *const u8,
    pub len: usize,
}

impl MshhStr {
    /// Заимствование на время вызова: строка должна пережить вызов.
    pub fn from_str(s: &str) -> Self {
        Self { ptr: s.as_ptr(), len: s.len() }
    }

    pub const fn from_static(s: &'static str) -> Self {
        Self { ptr: s.as_ptr(), len: s.len() }
    }

    /// # Safety
    /// `ptr`/`len` должны указывать на валидный UTF-8 буфер,
    /// живущий до конца текущего вызова.
    pub unsafe fn as_str<'a>(self) -> &'a str {
        match std::str::from_utf8(std::slice::from_raw_parts(self.ptr, self.len)) {
            Ok(s) => s,
            Err(_) => "",
        }
    }
}

// # Safety: данные по указателю иммутабельны (статические строки манифеста
// или буфер текущего вызова); MshhStr не даёт мутации и не хранит состояние.
unsafe impl Send for MshhStr {}
unsafe impl Sync for MshhStr {}

/// Буфер, выделенный ядром (`libc::malloc`). Модуль обязан освободить его
/// через `MshhHostVTable::free`.
#[repr(C)]
pub struct MshhBuf {
    pub ptr: *mut c_void,
    pub len: usize,
}

impl Default for MshhBuf {
    fn default() -> Self {
        Self { ptr: std::ptr::null_mut(), len: 0 }
    }
}

pub type LogFn = unsafe extern "C" fn(ctx: *mut c_void, level: u32, tag: MshhStr, msg: MshhStr);
/// JSON-сериализованный [`crate::model::UiCmd`].
pub type SendUiFn = unsafe extern "C" fn(ctx: *mut c_void, json: MshhStr);
/// SQL поверх БД ядра; `params_json` — `Vec<SqlValue>`, результат — JSON `Vec<Row>` в `out`.
pub type StorageExecFn =
    unsafe extern "C" fn(ctx: *mut c_void, sql: MshhStr, params_json: MshhStr, out: *mut MshhBuf) -> u32;
pub type KvGetFn = unsafe extern "C" fn(ctx: *mut c_void, key: MshhStr, out: *mut MshhBuf) -> u32;
pub type KvSetFn = unsafe extern "C" fn(ctx: *mut c_void, key: MshhStr, value: MshhStr) -> u32;
pub type NowMsFn = unsafe extern "C" fn(ctx: *mut c_void) -> u64;
/// Освобождает буферы, выделенные ядром (`libc::free`).
pub type FreeFn = unsafe extern "C" fn(ptr: *mut c_void);

/// Таблица host-функций. Ядро передаёт указатель в `mshh_module_start`;
/// указатель валиден всё время жизни экземпляра модуля.
#[repr(C)]
pub struct MshhHostVTable {
    pub abi_version: u32,
    /// Непрозрачный контекст экземпляра; первый аргумент всех функций.
    pub ctx: *mut c_void,
    pub log: LogFn,
    pub send_ui: SendUiFn,
    pub storage_exec: StorageExecFn,
    pub kv_get: KvGetFn,
    pub kv_set: KvSetFn,
    pub now_ms: NowMsFn,
    pub free: FreeFn,
}

/// Статическая информация о модуле; возвращается `mshh_module_info`.
/// Данные должны жить всё время жизни библиотеки.
#[repr(C)]
pub struct MshhModuleInfo {
    pub id: MshhStr,
    pub name: MshhStr,
    pub version: MshhStr,
}

/// Экспорты, которые каждый модуль обязан предоставить.
/// Генерируются макросом [`crate::register_module!`].
pub mod exports {
    pub const ABI_VERSION: &str = "mshh_abi_version";
    pub const MODULE_INFO: &str = "mshh_module_info";
    pub const MODULE_START: &str = "mshh_module_start";
    pub const MODULE_RUN: &str = "mshh_module_run";
    pub const EVENT_SINK: &str = "mshh_module_event_sink";
    pub const MODULE_DESTROY: &str = "mshh_module_destroy";
}
