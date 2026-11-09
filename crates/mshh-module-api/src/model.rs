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
    /// Значения настроек профиля (map key->value, строки). Приходит после
    /// `Started` и при каждом сохранении в «Настройках».
    Settings { values: Json },
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
    /// Строка профиля собеседника над чатом (правая панель). `text` —
    /// произвольное описание от модуля; `avatar` — его кружок.
    SetChatHeader { chat_id: ChatId, text: String, avatar: Option<Avatar> },
    /// Кнопки модуля в поле ввода. Рендерятся над строкой ввода;
    /// клик → [`actions::COMPOSER_BUTTON`] с `{"button": id, "chat_id": ...}`.
    SetComposerButtons(Vec<ComposerButton>),
    /// Ответ на [`actions::ACCOUNT_LIST`]: аккаунты профиля, которые МОГУТ
    /// писать в `chat_id` (именно они попадают в пикер). `chat_id` — без
    /// префикса профиля. Не ответив, модуль оставляет ядре полный список.
    SetAccountChoices { chat_id: ChatId, accounts: Vec<AccountView> },
    /// Ответ на [`actions::SEARCH_QUERY`]: найденные чаты этого профиля.
    /// `query` — та же строка, что пришла в запросе (ядро отбрасывает
    /// устаревшие ответы). Идентификаторы чатов — без префикса профиля.
    SearchResults { query: String, chats: Vec<ChatView> },
}

/// Кнопка модуля в поле ввода (эмодзи, голосовое, файл и т.д.).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ComposerButton {
    /// Стабильный идентификатор; возвращается модулю в `__composer.button`.
    pub id: String,
    /// Подпись/иконка (1–2 символа или короткий текст).
    pub label: String,
}

/// Кружок-аватар чата или аккаунта. Если `None`, ядро рисует цветной кружок
/// (цвет из имени) с первой буквой имени.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum Avatar {
    /// Буква/эмодзи вместо первой буквы; цвет ядро считает из имени.
    Initial { text: String },
    /// Картинка по локальному пути (модуль скачивает файл сам).
    Image { path: String },
}

/// Тип чата; влияет на фильтры групп и иконки. Модули проставляют сами.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatKind {
    /// Личная переписка.
    Person,
    /// Группа (многопользовательский чат).
    Group,
    /// Канал (только чтение).
    Channel,
    /// Бот.
    Bot,
}

impl Default for ChatKind {
    fn default() -> Self {
        ChatKind::Person
    }
}

impl ChatKind {
    /// Человекочитаемая метка для UI.
    pub fn label(&self) -> &'static str {
        match self {
            ChatKind::Person => "люди",
            ChatKind::Group => "группы",
            ChatKind::Channel => "каналы",
            ChatKind::Bot => "боты",
        }
    }

    /// Разбор из строки правила группы.
    pub fn parse(s: &str) -> Option<ChatKind> {
        match s {
            "person" => Some(ChatKind::Person),
            "group" => Some(ChatKind::Group),
            "channel" => Some(ChatKind::Channel),
            "bot" => Some(ChatKind::Bot),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ChatKind::Person => "person",
            ChatKind::Group => "group",
            ChatKind::Channel => "channel",
            ChatKind::Bot => "bot",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountView {
    pub id: AccountId,
    pub name: String,
    pub status: String,
    /// Активный аккаунт профиля: от его лица идут сообщения (кружок в
    /// композере). Ровно один на профиль.
    #[serde(default)]
    pub active: bool,
    /// Кружок аккаунта; None → цвет из имени + первая буква.
    #[serde(default)]
    pub avatar: Option<Avatar>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatView {
    pub id: ChatId,
    pub title: String,
    pub subtitle: Option<String>,
    pub unread: u32,
    /// Тип чата; отсутствующее поле в JSON читается как [`ChatKind::Person`].
    #[serde(default)]
    pub kind: ChatKind,
    /// Кружок чата; None → цвет из имени + первая буква.
    #[serde(default)]
    pub avatar: Option<Avatar>,
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
    /// Картинка/стикер/GIF. `path` — локальный файл, который скачал модуль;
    /// без `path` ядро показывает плейсхолдер. GIF анимируется в kitty/sixel.
    Image { alt: String, #[serde(default)] path: Option<String> },
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
    /// payload: `{"query": "..."}`. Поиск по чатам модуля; ответ —
    /// [`crate::model::UiCmd::SearchResults`]. Ядро шлёт при наборе в поиске.
    pub const SEARCH_QUERY: &str = "__search.query";
    /// payload: `{"account_id": "..."}`. Сменить активный аккаунт профиля;
    /// применяется ко всем чатам профиля. После смены модуль присылает
    /// актуальную историю открытого чата (`SetMessages`) и новый
    /// `SetAccounts` с `active`.
    pub const ACCOUNT_SWITCH: &str = "__account.switch";
    /// payload: `{"chat_id": "..."}`. Запрос списка аккаунтов, могущих
    /// писать в чат; ответ — [`crate::model::UiCmd::SetAccountChoices`].
    pub const ACCOUNT_LIST: &str = "__account.list";
    /// payload: `{"button": "<ComposerButton.id>", "chat_id": "..."}`.
    /// Нажатие кнопки модуля в поле ввода.
    pub const COMPOSER_BUTTON: &str = "__composer.button";
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
