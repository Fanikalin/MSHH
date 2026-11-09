//! Пример модуля MSHH: локальный «протокол»-эхо.
//! Демонстрирует полный цикл ABI v2: схему БД с изоляцией по профилю,
//! настройки профиля, восстановление истории, стандартные действия.

use std::sync::atomic::{AtomicU64, Ordering};

use mshh_module_api::model::{
    actions, AccountView, Body, ChatView, Ev, FieldDef, MessageView, Row, SqlValue, UiCmd,
};
use mshh_module_api::prelude::*;
use mshh_module_api::register::Module;
use mshh_module_api::session::Session;

#[derive(Default)]
struct Echo;

const TAG: &str = "echo";
const CHAT: &str = "local";

impl Module for Echo {
    fn run(&self, s: Session) {
        s.info(TAG, "запуск");

        // Таблицы с суффиксом профиля: у двух профилей общая БД ядра.
        let table = format!("mod_echo_{}_messages", s.profile());
        let mut settings = Settings::load(&s);

        if let Err(e) = s.storage_exec(
            &format!(
                "CREATE TABLE IF NOT EXISTS {table} (\
                 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender TEXT NOT NULL, \
                 out INTEGER NOT NULL, ts_ms INTEGER NOT NULL, text TEXT NOT NULL)"
            ),
            &[],
        ) {
            s.error(TAG, &format!("не удалось создать схему: {e}"));
            return;
        }

        push_ui(&s);
        push_history(&s, &table);

        loop {
            match s.recv() {
                Some(Ev::Started) => {
                    push_ui(&s);
                    push_history(&s, &table);
                }
                Some(Ev::Settings { values }) => {
                    settings.apply(&s, &values);
                    s.info(TAG, "настройки профиля применены");
                }
                Some(Ev::UiAction { action, chat_id, payload }) => {
                    if action != actions::COMPOSER_SEND {
                        continue;
                    }
                    let chat = chat_id
                        .clone()
                        .or_else(|| payload.get("chat_id").and_then(|v| v.as_str()).map(String::from))
                        .unwrap_or_else(|| CHAT.to_string());
                    let Some(text) = payload.get("text").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    store_and_show(&s, &table, &chat, true, "Вы", text);
                    // «Сеть»: задержка и ответ удалённой стороны.
                    s.sleep(std::time::Duration::from_millis(settings.delay_ms));
                    store_and_show(&s, &table, &chat, false, "Echo", &settings.echo_of(text));
                }
                Some(Ev::Shutdown) | None => break,
            }
        }
        s.info(TAG, "остановка");
    }

    fn settings_schema(&self) -> Vec<FieldDef> {
        vec![
            FieldDef {
                id: "echo_template".into(),
                label: "Шаблон ответа ({text})".into(),
                secret: false,
                value: "Эхо: {text}".into(),
            },
            FieldDef {
                id: "delay_ms".into(),
                label: "Задержка ответа, мс".into(),
                secret: false,
                value: "300".into(),
            },
        ]
    }
}

/// Значения настроек профиля; обновляются событием Ev::Settings на лету.
struct Settings {
    template: String,
    delay_ms: u64,
}

impl Settings {
    fn load(s: &Session) -> Self {
        let template =
            s.kv_get("echo_template").ok().flatten().unwrap_or_else(|| "Эхо: {text}".into());
        let delay_ms = s
            .kv_get("delay_ms")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);
        Settings { template, delay_ms }
    }

    /// Применить значения из ядра (строки) и зафиксировать в kv.
    fn apply(&mut self, s: &Session, values: &serde_json::Value) {
        if let Some(t) = values.get("echo_template").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                self.template = t.to_string();
                let _ = s.kv_set("echo_template", t);
            }
        }
        if let Some(d) = values.get("delay_ms").and_then(|v| v.as_str()) {
            if let Ok(ms) = d.parse::<u64>() {
                self.delay_ms = ms;
                let _ = s.kv_set("delay_ms", d);
            }
        }
    }

    fn echo_of(&self, text: &str) -> String {
        self.template.replace("{text}", text)
    }
}

fn push_ui(s: &Session) {
    s.send_ui(&UiCmd::SetAccounts(vec![AccountView {
        id: "echo".into(),
        name: "Echo".into(),
        status: "локальный протокол".into(),
    }]));
    s.send_ui(&UiCmd::SetChats(vec![ChatView {
        id: CHAT.into(),
        title: "Локальный чат".into(),
        subtitle: Some("эхо-протокол".into()),
        unread: 0,
    }]));
}

fn push_history(s: &Session, table: &str) {
    let Ok(rows) = s.storage_exec(
        &format!(
            "SELECT id, chat_id, sender, out, ts_ms, text \
             FROM {table} ORDER BY ts_ms ASC, id ASC"
        ),
        &[],
    ) else {
        return;
    };
    let msgs: Vec<MessageView> = rows.iter().filter_map(row_to_msg).collect();
    if let Some(first) = msgs.first() {
        let chat_id = first.chat_id.clone();
        s.send_ui(&UiCmd::SetMessages { chat_id, messages: msgs });
    }
}

fn row_to_msg(r: &Row) -> Option<MessageView> {
    let id = as_text(r.first()?)?;
    let chat_id = as_text(r.get(1)?)?;
    let sender = as_text(r.get(2)?)?;
    let out = as_int(r.get(3)?)? != 0;
    let ts_ms = as_int(r.get(4)?)?;
    let text = as_text(r.get(5)?)?;
    Some(MessageView {
        id: id.into(),
        chat_id: chat_id.into(),
        sender: sender.into(),
        out,
        ts_ms: ts_ms as u64,
        body: Body::Text(text.into()),
    })
}

fn as_text(v: &SqlValue) -> Option<&str> {
    match v {
        SqlValue::Text(s) => Some(s),
        _ => None,
    }
}

fn as_int(v: &SqlValue) -> Option<i64> {
    match v {
        SqlValue::Int(i) => Some(*i),
        _ => None,
    }
}

fn store_and_show(s: &Session, table: &str, chat: &str, out: bool, sender: &str, text: &str) {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ts = s.now_ms();
    let id = format!("m{}-{}", ts, SEQ.fetch_add(1, Ordering::Relaxed));
    let _ = s.storage_exec(
        &format!(
            "INSERT INTO {table} (id, chat_id, sender, out, ts_ms, text) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ),
        &[
            SqlValue::Text(id.clone()),
            SqlValue::Text(chat.into()),
            SqlValue::Text(sender.into()),
            SqlValue::Int(out as i64),
            SqlValue::Int(ts as i64),
            SqlValue::Text(text.into()),
        ],
    );
    s.send_ui(&UiCmd::AddMessage(MessageView {
        id,
        chat_id: chat.into(),
        sender: sender.into(),
        out,
        ts_ms: ts,
        body: Body::Text(text.into()),
    }));
}

register_module!(Echo, id: "echo", name: "Echo", version: "0.1.0");
