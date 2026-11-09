use std::path::Path;
use std::sync::Mutex;

use mshh_module_api::model::{Row, SqlValue};
use rusqlite::types::Value as RValue;
use rusqlite::types::ValueRef;
use rusqlite::{Connection};

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
