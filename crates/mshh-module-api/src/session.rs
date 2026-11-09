//! Безопасная обёртка над host-vtable для автора модуля.

use std::time::Duration;

use crossbeam_channel::Receiver;
use serde_json::to_string;

use crate::abi::{log_level, rc, MshhBuf, MshhHostVTable, MshhStr};
use crate::model::{Ev, Row, SqlValue, UiCmd};

/// Хост-сервисы + входящая очередь событий. Живёт на потоке модуля;
/// все методы блокирующие или быстрые — блокировать можно свободно,
/// ядро и UI при этом не блокируются.
///
/// Не `Send`: все обращения к host должны происходить из потока `run`,
/// пока ядро владеет экземпляром (см. docs/MODULES.md).
pub struct Session {
    rx: Receiver<Ev>,
    host: *const MshhHostVTable,
    profile: String,
}

impl Session {
    pub(crate) fn new(rx: Receiver<Ev>, host: *const MshhHostVTable, profile: String) -> Self {
        Self { rx, host, profile }
    }

    /// Идентификатор профиля ядра. Используй для изоляции таблиц:
    /// `mod_<id>_<profile>_...` — у двух профилей одного модуля общая БД.
    pub fn profile(&self) -> &str {
        &self.profile
    }

    // ---------- события ядра ----------

    /// Блокирующе ждёт следующее событие. `None` — канал закрыт.
    pub fn recv(&self) -> Option<Ev> {
        self.rx.recv().ok()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Option<Ev> {
        self.rx.recv_timeout(timeout).ok()
    }

    pub fn try_recv(&self) -> Option<Ev> {
        self.rx.try_recv().ok()
    }

    // ---------- UI ----------

    /// Отправить команду отображения ядру (потокобезопасно, не блокирует).
    pub fn send_ui(&self, cmd: &UiCmd) {
        let Ok(json) = to_string(cmd) else { return };
        // # Safety: host указатель валиден всё время жизни экземпляра (контракт ядра).
        let host = unsafe { &*self.host };
        unsafe { (host.send_ui)(host.ctx, MshhStr::from_str(&json)) }
    }

    // ---------- журнал ----------

    pub fn log(&self, level: u32, tag: &str, msg: &str) {
        // # Safety: см. send_ui.
        let host = unsafe { &*self.host };
        unsafe { (host.log)(host.ctx, level, MshhStr::from_str(tag), MshhStr::from_str(msg)) }
    }

    pub fn error(&self, tag: &str, msg: &str) {
        self.log(log_level::ERROR, tag, msg)
    }
    pub fn warn(&self, tag: &str, msg: &str) {
        self.log(log_level::WARN, tag, msg)
    }
    pub fn info(&self, tag: &str, msg: &str) {
        self.log(log_level::INFO, tag, msg)
    }
    pub fn debug(&self, tag: &str, msg: &str) {
        self.log(log_level::DEBUG, tag, msg)
    }

    // ---------- хранилище ----------

    /// SQL поверх БД ядра. Таблицы модуля обязаны иметь префикс `mod_<id>_`
    /// (см. docs/MODULES.md). Параметры — `?N`-плейсхолдеры.
    pub fn storage_exec(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<Row>, String> {
        let params_json = serde_json::to_string(params).map_err(|e| e.to_string())?;
        // # Safety: см. send_ui; все MshhStr живут до конца вызова.
        let host = unsafe { &*self.host };
        let mut out = MshhBuf::default();
        let r = unsafe {
            (host.storage_exec)(host.ctx, MshhStr::from_str(sql), MshhStr::from_str(&params_json), &mut out)
        };
        if r != rc::OK {
            return Err(format!("storage_exec: rc={r}"));
        }
        if out.ptr.is_null() {
            return Err("storage_exec: пустой ответ".into());
        }
        // Парсим до free.
        let bytes = unsafe { std::slice::from_raw_parts(out.ptr as *const u8, out.len) };
        let rows: Vec<Row> = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        unsafe { (host.free)(out.ptr) }
        Ok(rows)
    }

    /// KV ядра, изолированный по id модуля.
    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        // # Safety: см. send_ui.
        let host = unsafe { &*self.host };
        let mut out = MshhBuf::default();
        let r = unsafe { (host.kv_get)(host.ctx, MshhStr::from_str(key), &mut out) };
        match r {
            rc::OK => {
                let bytes = unsafe { std::slice::from_raw_parts(out.ptr as *const u8, out.len) };
                let s = String::from_utf8_lossy(bytes).into_owned();
                unsafe { (host.free)(out.ptr) };
                Ok(Some(s))
            }
            rc::MISS => Ok(None),
            _ => Err(format!("kv_get: rc={r}")),
        }
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        // # Safety: см. send_ui.
        let host = unsafe { &*self.host };
        let r = unsafe { (host.kv_set)(host.ctx, MshhStr::from_str(key), MshhStr::from_str(value)) };
        if r == rc::OK {
            Ok(())
        } else {
            Err(format!("kv_set: rc={r}"))
        }
    }

    // ---------- утилиты ----------

    pub fn now_ms(&self) -> u64 {
        // # Safety: см. send_ui.
        let host = unsafe { &*self.host };
        unsafe { (host.now_ms)(host.ctx) }
    }

    /// Сон потока модуля; ядро и UI не блокируются.
    pub fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
}
