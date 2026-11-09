use std::path::Path;
use std::sync::Mutex;

use mshh_module_api::model::{Row, SqlValue};
use rusqlite::types::Value as RValue;
use rusqlite::types::ValueRef;
use rusqlite::{Connection};

/// Профиль: экземпляр модуля с собственным аккаунтом.
#[derive(Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub module: String,
    pub name: String,
    pub enabled: bool,
}

impl Store {
    pub fn profiles(&self) -> Result<Vec<Profile>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, module, name, enabled FROM core_profiles ORDER BY created ASC, rowid ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    module: r.get(1)?,
                    name: r.get(2)?,
                    enabled: r.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn profile_add(&self, module: &str, name: &str) -> Result<Profile, String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let id = format!(
            "p{}{:02x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            SEQ.fetch_add(1, Ordering::Relaxed),
        );
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO core_profiles (id, module, name, enabled, created) VALUES (?1, ?2, ?3, 1, ?4)",
            rusqlite::params![id, module, name, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(Profile { id, module: module.into(), name: name.into(), enabled: true })
    }

    pub fn profile_rename(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE core_profiles SET name = ?1 WHERE id = ?2", [name, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn profile_set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE core_profiles SET enabled = ?1 WHERE id = ?2",
            rusqlite::params![enabled as i64, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn profile_delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM core_profiles WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM core_settings WHERE profile = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Значения настроек профиля: map ключ -> строковое значение.
    pub fn settings_all(&self, profile: &str) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM core_settings WHERE profile = ?1 ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([profile], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn setting_set(&self, profile: &str, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO core_settings (profile, key, value) VALUES (?1, ?2, ?3) \
             ON CONFLICT (profile, key) DO UPDATE SET value = excluded.value",
            [profile, key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Настройки отображения самого ядра (профиль `__app`).
    pub fn app_get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT value FROM core_app WHERE key = ?1",
            [key],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    pub fn app_set(&self, key: &str, value: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "INSERT INTO core_app (key, value) VALUES (?1, ?2) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [key, value],
            );
        }
    }
}

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Единый SQLite-коннект ядра. Таблицы модуля — с префиксом `mod_<id>_`,
/// KV-пространство модуля изолировано колонкой `module` в `core_kv`.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS core_kv (\
             module TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, \
             PRIMARY KEY (module, key))",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS core_profiles (\
             id TEXT PRIMARY KEY, module TEXT NOT NULL, name TEXT NOT NULL, \
             enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS core_settings (\
             profile TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, \
             PRIMARY KEY (profile, key))",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS core_app (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    /// SQL от модуля: любые запросы в рамках доверенной модели
    /// (модуль — нативный код, см. docs/MODULES.md).
    pub fn exec(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<Row>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let ncols = stmt.column_count();
        let bound: Vec<RValue> = params.iter().map(to_rusqlite).collect();
        let mut rows =
            stmt.query(rusqlite::params_from_iter(bound.iter())).map_err(|e| e.to_string())?;
        let mut out: Vec<Row> = Vec::new();
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let mut row: Row = Vec::with_capacity(ncols);
            for i in 0..ncols {
                row.push(cell(r, i));
            }
            out.push(row);
        }
        Ok(out)
    }

    pub fn kv_get(&self, module: &str, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt =
            conn.prepare("SELECT value FROM core_kv WHERE module = ?1 AND key = ?2").map_err(|e| e.to_string())?;
        let mut rows = stmt.query([module, key]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => r.get::<_, String>(0).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }

    pub fn kv_set(&self, module: &str, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO core_kv (module, key, value) VALUES (?1, ?2, ?3) \
             ON CONFLICT (module, key) DO UPDATE SET value = excluded.value",
            [module, key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn to_rusqlite(v: &SqlValue) -> RValue {
    match v {
        SqlValue::Null => RValue::Null,
        SqlValue::Int(i) => RValue::Integer(*i),
        SqlValue::Real(f) => RValue::Real(*f),
        SqlValue::Text(s) => RValue::Text(s.clone()),
        SqlValue::Blob(b) => RValue::Blob(b.clone()),
    }
}

fn cell(r: &rusqlite::Row<'_>, i: usize) -> SqlValue {
    match r.get_ref(i) {
        Ok(ValueRef::Null) => SqlValue::Null,
        Ok(ValueRef::Integer(i)) => SqlValue::Int(i),
        Ok(ValueRef::Real(f)) => SqlValue::Real(f),
        Ok(ValueRef::Text(t)) => SqlValue::Text(String::from_utf8_lossy(t).into_owned()),
        Ok(ValueRef::Blob(b)) => SqlValue::Blob(b.to_vec()),
        Err(_) => SqlValue::Null,
    }
}
