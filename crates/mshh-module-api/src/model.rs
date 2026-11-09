//! Модель данных, общая для ядра и модулей. Передаётся через ABI в JSON.
//!
//! Формат — часть ABI: изменение serde-представления этих типов
//! требует поднятия [`crate::abi::ABI_VERSION`].

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

pub type ModuleId = String;
pub type AccountId = String;
/// Идентификатор чата; уникален внутри модуля.
pub type ChatId = String;
pub type MessageId = String;

/// Событие от ядра к модулю (в очередь модуля через `event_sink`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum Ev {
    /// Посылается сразу после `mshh_module_run`: модуль регистрирует UI.
    Started,
    /// Действие пользователя в оболочке. Имена — [`actions`] или свои.
    UiAction { action: String, chat_id: Option<ChatId>, payload: Json },
    /// Ядро завершается: модуль должен выйти из `run`.
    Shutdown,
}

/// Команда модуля ядру: изменение состояния оболочки (правила отображения).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum UiCmd {
    SetAccounts(Vec<AccountView>),
    /// Полная замена списка чатов.
    SetChats(Vec<ChatView>),
    /// Вставка или обновление одного чата (например, сброс/рост unread).
    UpsertChat(ChatView),
    /// Полная замена истории чата (например, при загрузке из БД).
    SetMessages { chat_id: ChatId, messages: Vec<MessageView> },
    /// Дозапись сообщения (в конец, с автопрокруткой, если чат открыт внизу).
    AddMessage(MessageView),
    SetPresence { chat_id: ChatId, text: String },
    /// Запросить форму входа; имена действий возвращает ядро модулю в payload.
    PromptLogin {
        title: String,
        fields: Vec<FieldDef>,
        submit_action: String,
        cancel_action: String,
    },
    CloseLogin,
    Toast { text: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountView {
    pub id: AccountId,
    pub name: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatView {
    pub id: ChatId,
    pub title: String,
    pub subtitle: Option<String>,
    pub unread: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MessageView {
    pub id: MessageId,
    pub chat_id: ChatId,
    /// Отправитель; для исходящих ядро показывает «Вы».
    pub sender: String,
    /// true — исходящее.
    pub out: bool,
    pub ts_ms: u64,
    pub body: Body,
}

/// Тело сообщения. TUI-рендерер показывает Image/File плейсхолдерами;
/// GUI-рендерер (будущий) рисует их по-настоящему.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum Body {
    Text(String),
    Image { alt: String },
    File { name: String, size: Option<u64> },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FieldDef {
    pub id: String,
    pub label: String,
    /// Скрывать ввод (пароли/токены).
    pub secret: bool,
    pub value: String,
}

/// Стандартные имена действий ядро -> модуль.
pub mod actions {
    /// payload: `{"chat_id": "..."}`. Ядро шлёт при выборе чата в списке.
    pub const CHAT_OPEN: &str = "__chat.open";
    /// payload: `{"chat_id": "...", "text": "..."}`. Отправка из композера.
    pub const COMPOSER_SEND: &str = "__composer.send";
    /// payload: `{"<field_id>": "value", ...}`. Сабмит формы входа.
    pub const LOGIN_SUBMIT: &str = "__login.submit";
    /// payload: `{}`. Отмена формы входа.
    pub const LOGIN_CANCEL: &str = "__login.cancel";
}

/// Значение SQL-параметра или ячейки результата.
/// `Blob` сериализуется как массив чисел (для больших двоичных данных
/// лучше хранить путь/ссылку, а не байты в KV/SQL-строках).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum SqlValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// Строка результата `storage_exec`.
pub type Row = Vec<SqlValue>;
