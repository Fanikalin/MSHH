//! Пример модуля MSHH: локальный «протокол»-эхо.
//! Демонстрирует полный цикл: схему БД, восстановление истории,
//! отправку/приём сообщений, стандартные действия оболочки.

use std::sync::atomic::{AtomicU64, Ordering};

use mshh_module_api::model::{
    actions, AccountView, Body, ChatView, Ev, MessageView, Row, SqlValue, UiCmd,
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

        // Схема модуля: таблицы с префиксом mod_<id>_ (правило docs/MODULES.md).
        if let Err(e) = s.storage_exec(
            "CREATE TABLE IF NOT EXISTS mod_echo_messages (\
             id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender TEXT NOT NULL, \
             out INTEGER NOT NULL, ts_ms INTEGER NOT NULL, text TEXT NOT NULL)",
            &[],
        ) {
            s.error(TAG, &format!("не удалось создать схему: {e}"));
            return;
        }

        push_ui(&s);
        push_history(&s);

        loop {
            match s.recv() {
                Some(Ev::Started) => {
                    push_ui(&s);
                    push_history(&s);
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
                    store_and_show(&s, &chat, true, "Вы", text);
                    // «Сеть»: задержка и ответ удалённой стороны.
                    s.sleep(std::time::Duration::from_millis(300));
                    store_and_show(&s, &chat, false, "Echo", &format!("Эхо: {text}"));
                }
                Some(Ev::Shutdown) | None => break,
            }
        }
        s.info(TAG, "остановка");
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

fn push_history(s: &Session) {
    let Ok(rows) = s.storage_exec(
        "SELECT id, chat_id, sender, out, ts_ms, text \
         FROM mod_echo_messages ORDER BY ts_ms ASC, id ASC",
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

fn store_and_show(s: &Session, chat: &str, out: bool, sender: &str, text: &str) {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ts = s.now_ms();
    let id = format!("m{}-{}", ts, SEQ.fetch_add(1, Ordering::Relaxed));
    let _ = s.storage_exec(
        "INSERT INTO mod_echo_messages (id, chat_id, sender, out, ts_ms, text) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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
