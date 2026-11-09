//! Состояние оболочки и его редукция: UiCmd от модулей + ввод пользователя.
//!
//! Чаты скоупятся по профилю: внутренний ключ чата = `{profile}:{chat_id}`;
//! на границе ядра префикс снимается — модуль видит свои идентификаторы.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossterm::event::{
    Event as TermEvent, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use mshh_module_api::model::{
    actions, AccountView, ChatId, ChatView, Ev, FieldDef, MessageView, ModuleId, UiCmd,
};
use ratatui::layout::Rect;
use serde_json::{json, Map as JsonMap};

use crate::ratings::RatingView;
use crate::store::Profile;

pub const TOAST_TTL: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Focus {
    Chats,
    Composer,
}

pub struct LoginState {
    pub module: ModuleId,
    pub title: String,
    pub fields: Vec<FieldDef>,
    pub focus: usize,
    pub submit_action: String,
    pub cancel_action: String,
}

/// Действие, требующее доставки конкретному профилю.
pub struct PendingAction {
    pub profile: String,
    pub ev: Ev,
}

/// Команда ядру (персистентность/рантайм), исполняется в main-цикле.
#[derive(Debug)]
pub enum CoreCmd {
    SetDisplay { key: &'static str, value: bool },
    CreateProfile { module: String, name: String },
    RenameProfile { profile: String, name: String },
    SetProfileEnabled { profile: String, enabled: bool },
    DeleteProfile { profile: String },
    SaveSetting { profile: String, key: String, value: String },
    RestartProfile { profile: String },
}

/// Настройки отображения ядра.
#[derive(Clone, Debug)]
pub struct DisplaySettings {
    pub chat_subtitles: bool,
    pub msg_time: bool,
    pub time_24h: bool,
    pub hints_bar: bool,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        DisplaySettings {
            chat_subtitles: true,
            msg_time: true,
            time_24h: true,
            hints_bar: true,
        }
    }
}

impl DisplaySettings {
    pub const KEYS: [(&'static str, &'static str); 4] = [
        ("chat_subtitles", "Субтитры в списке чатов"),
        ("msg_time", "Время у сообщений"),
        ("time_24h", "24-часовой формат времени"),
        ("hints_bar", "Строка подсказок"),
    ];

    pub fn get(&self, key: &str) -> bool {
        match key {
            "chat_subtitles" => self.chat_subtitles,
            "msg_time" => self.msg_time,
            "time_24h" => self.time_24h,
            _ => self.hints_bar,
        }
    }

    pub fn set(&mut self, key: &str, value: bool) {
        match key {
            "chat_subtitles" => self.chat_subtitles = value,
            "msg_time" => self.msg_time = value,
            "time_24h" => self.time_24h = value,
            _ => self.hints_bar = value,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SettingsScreen {
    Main,
    AddModule,
    Profile,
}

/// Строка экрана настроек: и семантика для activate(), и готовый текст для рендера.
#[derive(Clone)]
pub(crate) enum SettingsRow {
    Header(String),
    Toggle { key: &'static str, label: &'static str, value: bool },
    Profile { idx: usize, text: String, enabled: bool },
    AddProfile,
    ModulePick { idx: usize, text: String },
    Back,
    Rename,
    Enable { enabled: bool },
    ModuleSetting { field: usize, label: String, value: String, secret: bool },
    Restart,
    Delete { armed: bool },
}

enum InputTarget {
    RenameProfile(String),
    NewProfileName(String),
    SettingValue { profile: String, field: usize },
}

pub(crate) struct SettingsInput {
    pub(crate) label: String,
    pub(crate) buffer: String,
    target: InputTarget,
}

pub struct App {
    /// Аккаунты по профилям: (profile, view).
    pub accounts: Vec<(String, AccountView)>,
    /// Чаты; `ChatView.id` — внутренний ключ `{profile}:{chat_id}`.
    pub chats: Vec<ChatView>,
    pub messages: HashMap<ChatId, Vec<MessageView>>,
    pub selected: Option<ChatId>,
    pub focus: Focus,
    pub composer: String,
    pub presence: HashMap<ChatId, String>,
    pub login: Option<LoginState>,
    pub toast: Option<(String, Instant)>,
    /// Прокрутка истории от конца (в логических строках).
    pub scroll_from_end: u32,
    /// Внутренний ключ чата -> профиль-владелец.
    pub chat_owner: HashMap<ChatId, String>,
    pub module_count: usize,
    pub profile_count: usize,
    pub quit: bool,

    /// Вшитый каталог доверия + записи о загруженных модулях.
    pub trust: Vec<RatingView>,
    pub trust_open: bool,
    pub trust_sel: usize,
    /// Открытое окно фактов: индекс в `trust`.
    pub trust_facts: Option<usize>,
    pub trust_scroll: u32,

    /// Каталог профилей.
    pub profiles: Vec<Profile>,
    /// Значения настроек профилей: profile -> [(key, value)].
    pub settings_values: HashMap<String, Vec<(String, String)>>,
    /// Схемы настроек по module_id.
    pub module_schemas: HashMap<String, Vec<FieldDef>>,
    /// Загруженные модули (id, name) — кандидаты в новые профили.
    pub available_modules: Vec<(String, String)>,
    pub display: DisplaySettings,
    pub settings_open: bool,
    settings_sel: usize,
    settings_screen: SettingsScreen,
    settings_add_sel: usize,
    settings_profile_idx: usize,
    settings_rows: Vec<SettingsRow>,
    settings_input: Option<SettingsInput>,
    delete_armed: bool,
    /// Очередь команд ядру; main сливает после обработки ввода.
    pub core_cmds: Vec<CoreCmd>,
    /// Последняя известная площадь терминала (хит-тест мыши).
    pub area: Rect,
}

impl App {
    pub(crate) fn settings_screen_name(&self) -> &'static str {
        match self.settings_screen {
            SettingsScreen::Main => "main",
            SettingsScreen::AddModule => "add",
            SettingsScreen::Profile => "profile",
        }
    }

    pub(crate) fn settings_profile_idx(&self) -> usize {
        self.settings_profile_idx
    }

    pub(crate) fn settings_sel(&self) -> usize {
        self.settings_sel
    }

    pub(crate) fn settings_rows_ref(&self) -> &[SettingsRow] {
        &self.settings_rows
    }

    pub(crate) fn settings_input_ref(&self) -> Option<&SettingsInput> {
        self.settings_input.as_ref()
    }

    /// Перестроить строки настроек (после изменения профилей из main).
    pub fn on_profiles_changed(&mut self) {
        if self.settings_open {
            self.rebuild_settings_rows();
        }
    }
}
fn ckey(profile: &str, chat: &str) -> String {
    format!("{profile}:{chat}")
}

fn split_ckey(key: &str) -> (String, String) {
    match key.split_once(':') {
        Some((p, c)) => (p.to_string(), c.to_string()),
        None => (key.to_string(), String::new()),
    }
}

impl App {
    pub fn new(profile_count: usize, module_count: usize) -> App {
        App {
            accounts: Vec::new(),
            chats: Vec::new(),
            messages: HashMap::new(),
            selected: None,
            focus: Focus::Chats,
            composer: String::new(),
            presence: HashMap::new(),
            login: None,
            toast: None,
            scroll_from_end: 0,
            chat_owner: HashMap::new(),
            module_count,
            quit: false,
            trust: Vec::new(),
            trust_open: false,
            trust_sel: 0,
            trust_facts: None,
            trust_scroll: 0,
            profiles: Vec::new(),
            settings_values: HashMap::new(),
            module_schemas: HashMap::new(),
            available_modules: Vec::new(),
            display: DisplaySettings::default(),
            settings_open: false,
            settings_sel: 0,
            settings_screen: SettingsScreen::Main,
            settings_add_sel: 0,
            settings_profile_idx: 0,
            settings_rows: Vec::new(),
            settings_input: None,
            delete_armed: false,
            core_cmds: Vec::new(),
            area: Rect::new(0, 0, 1, 1),
            profile_count,
        }
    }

    pub fn toast_now(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now()));
    }

    // ---------- команды от модулей ----------

    /// Команда отображения от профиля. Идентификаторы чатов переписываются
    /// во внутренние ключи `{profile}:{chat_id}`.
    pub fn apply_ui(&mut self, profile: &str, mut cmd: UiCmd) {
        match &mut cmd {
            UiCmd::SetAccounts(v) => {
                self.accounts.retain(|(p, _)| p != profile);
                for a in v.drain(..) {
                    self.accounts.push((profile.to_string(), a));
                }
                return;
            }
            UiCmd::SetChats(v) => {
                for c in v.iter_mut() {
                    c.id = ckey(profile, &c.id);
                }
                for c in v.iter() {
                    self.chat_owner.insert(c.id.clone(), profile.to_string());
                }
                self.chats = std::mem::take(v);
                if let Some(sel) = self.selected.clone() {
                    if !self.chats.iter().any(|c| c.id == sel) {
                        self.selected = None;
                    }
                }
            }
            UiCmd::UpsertChat(c) => {
                c.id = ckey(profile, &c.id);
                self.chat_owner.insert(c.id.clone(), profile.to_string());
                match self.chats.iter_mut().find(|x| x.id == c.id) {
                    Some(slot) => *slot = c.clone(),
                    None => self.chats.push(c.clone()),
                }
            }
            UiCmd::SetMessages { chat_id, messages } => {
                let key = ckey(profile, chat_id);
                for m in messages.iter_mut() {
                    m.chat_id = key.clone();
                }
                if self.selected.as_deref() == Some(key.as_str()) {
                    self.scroll_from_end = 0;
                }
                self.messages.insert(key, std::mem::take(messages));
            }
            UiCmd::AddMessage(m) => {
                m.chat_id = ckey(profile, &m.chat_id);
                self.messages.entry(m.chat_id.clone()).or_default().push(m.clone());
            }
            UiCmd::SetPresence { chat_id, text } => {
                self.presence.insert(ckey(profile, chat_id), std::mem::take(text));
            }
            _ => {}
        }
        match cmd {
            UiCmd::PromptLogin { title, fields, submit_action, cancel_action } => {
                self.login = Some(LoginState {
                    module: profile.into(),
                    title,
                    fields,
                    focus: 0,
                    submit_action,
                    cancel_action,
                });
            }
            UiCmd::CloseLogin => {
                if self.login.as_ref().map(|l| l.module == profile).unwrap_or(false) {
                    self.login = None;
                }
            }
            UiCmd::Toast { text } => self.toast_now(text),
            _ => {}
        }
    }

    // ---------- ввод пользователя ----------

    /// Ввод пользователя. Возвращает действие для профиля, если оно есть.
    pub fn on_input(&mut self, ev: &TermEvent) -> Option<PendingAction> {
        match ev {
            TermEvent::Key(k) if k.kind == KeyEventKind::Press => self.on_key(k.code, k.modifiers),
            TermEvent::Mouse(m) => {
                if m.kind == MouseEventKind::Down(MouseButton::Left) {
                    if self.settings_open {
                        self.on_settings_click(m.column, m.row);
                        return None;
                    }
                    if self.trust_open || self.trust_facts.is_some() {
                        self.on_trust_click(m.column, m.row);
                        return None;
                    }
                }
                match m.kind {
                    MouseEventKind::ScrollUp => {
                        self.scroll_from_end = self.scroll_from_end.saturating_add(3);
                        None
                    }
                    MouseEventKind::ScrollDown => {
                        self.scroll_from_end = self.scroll_from_end.saturating_sub(3);
                        None
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn on_key(&mut self, code: KeyCode, mods: KeyModifiers) -> Option<PendingAction> {
        // Глобальные клавиши.
        match code {
            KeyCode::Char('q') if mods.contains(KeyModifiers::CONTROL) => {
                self.quit = true;
                return None;
            }
            KeyCode::PageUp if self.trust_facts.is_some() || self.settings_open => {
                self.settings_scroll(-5);
                return None;
            }
            KeyCode::PageDown if self.trust_facts.is_some() || self.settings_open => {
                self.settings_scroll(5);
                return None;
            }
            KeyCode::PageUp => {
                self.scroll_from_end = self.scroll_from_end.saturating_add(5);
                return None;
            }
            KeyCode::PageDown => {
                self.scroll_from_end = self.scroll_from_end.saturating_sub(5);
                return None;
            }
            _ => {}
        }

        if self.trust_open {
            return self.on_key_trust(code);
        }
        if self.settings_open {
            return self.on_key_settings(code);
        }
        if self.login.is_some() {
            return self.on_key_login(code, mods);
        }
        // Оверлеи.
        if code == KeyCode::Char('m') && !mods.contains(KeyModifiers::CONTROL) {
            self.trust_open = true;
            self.trust_sel = 0;
            self.trust_facts = None;
            self.trust_scroll = 0;
            return None;
        }
        if code == KeyCode::Char('s') && !mods.contains(KeyModifiers::CONTROL) {
            self.open_settings();
            return None;
        }

        match self.focus {
            Focus::Chats => match code {
                KeyCode::Up => {
                    let idx = self.selected_index().map(|i| i.saturating_sub(1)).unwrap_or(0);
                    self.select_chat(idx)
                }
                KeyCode::Down => {
                    let idx = self.selected_index().map(|i| i + 1).unwrap_or(0);
                    self.select_chat(idx)
                }
                KeyCode::Enter | KeyCode::Tab => {
                    self.focus = Focus::Composer;
                    None
                }
                _ => None,
            },
            Focus::Composer => match code {
                KeyCode::Tab => {
                    self.focus = Focus::Chats;
                    None
                }
                KeyCode::Backspace => {
                    self.composer.pop();
                    None
                }
                KeyCode::Enter => self.send_composer(),
                KeyCode::Char(c) if !mods.contains(KeyModifiers::CONTROL) => {
                    self.composer.push(c);
                    None
                }
                _ => None,
            },
        }
    }

    // ---------- настройки ----------

    fn open_settings(&mut self) {
        self.settings_open = true;
        self.settings_screen = SettingsScreen::Main;
        self.settings_sel = 0;
        self.settings_input = None;
        self.delete_armed = false;
        self.rebuild_settings_rows();
    }

    fn rebuild_settings_rows(&mut self) {
        self.settings_rows = match self.settings_screen {
            SettingsScreen::Main => {
                let mut rows = vec![SettingsRow::Header("Отображение".into())];
                for (key, label) in DisplaySettings::KEYS {
                    rows.push(SettingsRow::Toggle {
                        key,
                        label,
                        value: self.display.get(key),
                    });
                }
                rows.push(SettingsRow::Header("Профили".into()));
                for (i, p) in self.profiles.iter().enumerate() {
                    rows.push(SettingsRow::Profile {
                        idx: i,
                        text: format!("{} · {}", p.module, p.name),
                        enabled: p.enabled,
                    });
                }
                if !self.available_modules.is_empty() {
                    rows.push(SettingsRow::AddProfile);
                }
                rows
            }
            SettingsScreen::AddModule => {
                let mut rows = vec![SettingsRow::Back];
                for (i, (id, name)) in self.available_modules.iter().enumerate() {
                    rows.push(SettingsRow::ModulePick { idx: i, text: format!("{id} — {name}") });
                }
                rows
            }
            SettingsScreen::Profile => {
                let Some(p) = self.profiles.get(self.settings_profile_idx) else {
                    return;
                };
                let schema = self.module_schemas.get(&p.module);
                let mut rows = vec![
                    SettingsRow::Back,
                    SettingsRow::Rename,
                    SettingsRow::Enable { enabled: p.enabled },
                ];
                if let Some(fields) = schema {
                    if !fields.is_empty() {
                        rows.push(SettingsRow::Header("Настройки модуля".into()));
                        for (fi, fdef) in fields.iter().enumerate() {
                            let value = self
                                .settings_values
                                .get(&p.id)
                                .and_then(|v| v.iter().find(|(k, _)| *k == fdef.id))
                                .map(|(_, v)| v.clone())
                                .unwrap_or_else(|| fdef.value.clone());
                            rows.push(SettingsRow::ModuleSetting {
                                field: fi,
                                label: fdef.label.clone(),
                                value,
                                secret: fdef.secret,
                            });
                        }
                    }
                }
                rows.push(SettingsRow::Header("Действия".into()));
                rows.push(SettingsRow::Restart);
                rows.push(SettingsRow::Delete { armed: self.delete_armed });
                rows
            }
        };
        self.settings_sel = self.settings_sel.min(self.settings_rows.len().saturating_sub(1));
    }

    fn settings_scroll(&mut self, delta: i32) {
        if self.trust_facts.is_some() {
            if delta < 0 {
                self.trust_scroll = self.trust_scroll.saturating_add(5);
            } else {
                self.trust_scroll = self.trust_scroll.saturating_sub(5);
            }
            return;
        }
        // В настройках PgUp/PgDn двигают выбор.
        let delta = delta / 5;
        if delta < 0 {
            for _ in 0..(-delta) {
                self.settings_sel = self.settings_sel.saturating_sub(1);
            }
        } else {
            for _ in 0..delta {
                self.settings_sel = (self.settings_sel + 1).min(self.settings_rows.len().saturating_sub(1));
            }
        }
    }

    fn on_key_settings(&mut self, code: KeyCode) -> Option<PendingAction> {
        // Режим ввода текста.
        if let Some(input) = self.settings_input.as_mut() {
            match code {
                KeyCode::Esc => {
                    self.settings_input = None;
                }
                KeyCode::Enter => {
                    let input = self.settings_input.take().expect("input");
                    self.commit_settings_input(input);
                }
                KeyCode::Backspace => {
                    input.buffer.pop();
                }
                KeyCode::Char(c) => input.buffer.push(c),
                _ => {}
            }
            return None;
        }

        match code {
            KeyCode::Char('s') | KeyCode::Esc => {
                match self.settings_screen {
                    SettingsScreen::Main => self.settings_open = false,
                    _ => {
                        self.settings_screen = SettingsScreen::Main;
                        self.delete_armed = false;
                        self.rebuild_settings_rows();
                    }
                }
            }
            KeyCode::Up => {
                self.settings_sel = self.settings_sel.saturating_sub(1);
                self.delete_armed = false;
            }
            KeyCode::Down => {
                self.settings_sel =
                    (self.settings_sel + 1).min(self.settings_rows.len().saturating_sub(1));
                self.delete_armed = false;
            }
            KeyCode::Enter => self.settings_activate(),
            _ => {}
        }
        None
    }

    fn settings_activate(&mut self) {
        let Some(row) = self.settings_rows.get(self.settings_sel).cloned() else {
            return;
        };
        match row {
            SettingsRow::Header(_) => {}
            SettingsRow::Toggle { key, .. } => {
                let new_value = !self.display.get(key);
                self.display.set(key, new_value);
                self.core_cmds.push(CoreCmd::SetDisplay { key, value: new_value });
            }
            SettingsRow::Profile { idx, .. } => {
                self.settings_profile_idx = idx;
                self.settings_screen = SettingsScreen::Profile;
                self.settings_sel = 0;
                self.delete_armed = false;
                self.rebuild_settings_rows();
            }
            SettingsRow::AddProfile => {
                self.settings_screen = SettingsScreen::AddModule;
                self.settings_add_sel = 0;
                self.settings_sel = 0;
                self.rebuild_settings_rows();
            }
            SettingsRow::ModulePick { idx, .. } => {
                if let Some((module, _)) = self.available_modules.get(idx).cloned() {
                    self.settings_input = Some(SettingsInput {
                        label: "Имя профиля".into(),
                        buffer: String::new(),
                        target: InputTarget::NewProfileName(module),
                    });
                }
            }
            SettingsRow::Back => {
                self.settings_screen = SettingsScreen::Main;
                self.settings_sel = 0;
                self.delete_armed = false;
                self.rebuild_settings_rows();
            }
            SettingsRow::Rename => {
                if let Some(p) = self.profiles.get(self.settings_profile_idx) {
                    self.settings_input = Some(SettingsInput {
                        label: "Имя профиля".into(),
                        buffer: p.name.clone(),
                        target: InputTarget::RenameProfile(p.id.clone()),
                    });
                }
            }
            SettingsRow::Enable { enabled } => {
                if let Some(p) = self.profiles.get(self.settings_profile_idx) {
                    self.core_cmds.push(CoreCmd::SetProfileEnabled {
                        profile: p.id.clone(),
                        enabled: !enabled,
                    });
                }
            }
            SettingsRow::ModuleSetting { field, label, value, .. } => {
                if let Some(p) = self.profiles.get(self.settings_profile_idx) {
                    self.settings_input = Some(SettingsInput {
                        label,
                        buffer: value,
                        target: InputTarget::SettingValue {
                            profile: p.id.clone(),
                            field,
                        },
                    });
                }
            }
            SettingsRow::Restart => {
                if let Some(p) = self.profiles.get(self.settings_profile_idx) {
                    self.core_cmds.push(CoreCmd::RestartProfile { profile: p.id.clone() });
                    self.toast_now("профиль перезапускается…");
                }
            }
            SettingsRow::Delete { .. } => {
                if !self.delete_armed {
                    self.delete_armed = true;
                    self.rebuild_settings_rows();
                    return;
                }
                if let Some(p) = self.profiles.get(self.settings_profile_idx) {
                    self.core_cmds.push(CoreCmd::DeleteProfile { profile: p.id.clone() });
                }
                self.settings_screen = SettingsScreen::Main;
                self.delete_armed = false;
                self.settings_sel = 0;
                self.rebuild_settings_rows();
            }
        }
    }

    fn commit_settings_input(&mut self, input: SettingsInput) {
        match input.target {
            InputTarget::RenameProfile(pid) => {
                let name = input.buffer.trim().to_string();
                if !name.is_empty() {
                    self.core_cmds.push(CoreCmd::RenameProfile { profile: pid, name });
                }
            }
            InputTarget::NewProfileName(module) => {
                let name = input.buffer.trim().to_string();
                if !name.is_empty() {
                    self.core_cmds
                        .push(CoreCmd::CreateProfile { module, name: name.clone() });
                    self.toast_now(format!("профиль «{name}» создаётся…"));
                }
                self.settings_screen = SettingsScreen::Main;
            }
            InputTarget::SettingValue { profile, field } => {
                let schema = self
                    .profiles
                    .get(self.settings_profile_idx)
                    .and_then(|p| self.module_schemas.get(&p.module))
                    .cloned()
                    .unwrap_or_default();
                let key = schema.get(field).map(|f| f.id.clone()).unwrap_or_default();
                if key.is_empty() {
                    return;
                }
                self.core_cmds.push(CoreCmd::SaveSetting {
                    profile,
                    key,
                    value: input.buffer.clone(),
                });
            }
        }
        self.rebuild_settings_rows();
    }

    fn on_settings_click(&mut self, col: u16, row: u16) {
        let rect = crate::render::settings_area(self.area);
        let inside = col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;
        if !inside {
            self.settings_open = false;
            return;
        }
        if self.settings_input.is_some() {
            return;
        }
        let idx = row.saturating_sub(rect.y + 1) as usize;
        if idx < self.settings_rows.len() {
            self.settings_sel = idx;
        }
    }

    // ---------- доверие ----------

    fn on_key_trust(&mut self, code: KeyCode) -> Option<PendingAction> {
        match code {
            KeyCode::Char('m') | KeyCode::Esc => {
                if self.trust_facts.is_some() {
                    self.trust_facts = None;
                } else {
                    self.trust_open = false;
                }
            }
            KeyCode::Up if self.trust_facts.is_none() => {
                self.trust_sel = self.trust_sel.saturating_sub(1);
            }
            KeyCode::Down if self.trust_facts.is_none() => {
                self.trust_sel = (self.trust_sel + 1).min(self.trust.len().saturating_sub(1));
            }
            KeyCode::Enter if self.trust_facts.is_none() && !self.trust.is_empty() => {
                self.trust_facts = Some(self.trust_sel);
                self.trust_scroll = 0;
            }
            _ => {}
        }
        None
    }

    /// Клик мышью: выбор строки; клик по статусу `●` (первые 2 колонки строки)
    /// открывает факты. Клик вне окон закрывает их.
    fn on_trust_click(&mut self, col: u16, row: u16) {
        if let Some(_i) = self.trust_facts {
            let fa = crate::render::facts_area(self.area);
            let inside = col >= fa.x && col < fa.x + fa.width && row >= fa.y && row < fa.y + fa.height;
            if !inside {
                self.trust_facts = None;
            }
            return;
        }
        let list = crate::render::trust_area(self.area, self.trust.len());
        let inside = col >= list.x && col < list.x + list.width && row >= list.y && row < list.y + list.height;
        if !inside {
            self.trust_open = false;
            return;
        }
        let idx = row.saturating_sub(list.y + 1) as usize;
        if idx < self.trust.len() {
            self.trust_sel = idx;
            if col < list.x + 2 {
                self.trust_facts = Some(idx);
                self.trust_scroll = 0;
            }
        }
    }

    // ---------- чаты и композер ----------

    fn on_key_login(&mut self, code: KeyCode, mods: KeyModifiers) -> Option<PendingAction> {
        let module;
        let out;
        {
            let login = self.login.as_mut()?;
            module = login.module.clone();
            match code {
                KeyCode::Esc => {
                    out = Ev::UiAction {
                        action: login.cancel_action.clone(),
                        chat_id: None,
                        payload: json!({}),
                    };
                }
                KeyCode::Enter => {
                    let action = login.submit_action.clone();
                    let mut payload = JsonMap::new();
                    for f in &login.fields {
                        payload.insert(f.id.clone(), json!(f.value));
                    }
                    out = Ev::UiAction { action, chat_id: None, payload: payload.into() };
                }
                KeyCode::Tab | KeyCode::Down => {
                    let n = login.fields.len().max(1);
                    login.focus = (login.focus + 1) % n;
                    return None;
                }
                KeyCode::Up => {
                    let n = login.fields.len().max(1);
                    login.focus = (login.focus + n - 1) % n;
                    return None;
                }
                KeyCode::Backspace => {
                    if let Some(f) = login.fields.get_mut(login.focus) {
                        f.value.pop();
                    }
                    return None;
                }
                KeyCode::Char(c) if !mods.contains(KeyModifiers::CONTROL) => {
                    if let Some(f) = login.fields.get_mut(login.focus) {
                        f.value.push(c);
                    }
                    return None;
                }
                _ => return None,
            }
        }
        self.login = None;
        Some(PendingAction { profile: module, ev: out })
    }

    fn selected_index(&self) -> Option<usize> {
        let sel = self.selected.as_ref()?;
        self.chats.iter().position(|c| &c.id == sel)
    }

    fn select_chat(&mut self, idx: usize) -> Option<PendingAction> {
        if idx >= self.chats.len() {
            return None;
        }
        let chat = self.chats[idx].clone();
        self.selected = Some(chat.id.clone());
        self.scroll_from_end = 0;
        if let Some(slot) = self.chats.get_mut(idx) {
            slot.unread = 0;
        }
        let (profile, raw_chat) = split_ckey(&chat.id);
        Some(PendingAction {
            profile,
            ev: Ev::UiAction {
                action: actions::CHAT_OPEN.into(),
                chat_id: Some(raw_chat.clone()),
                payload: json!({ "chat_id": raw_chat }),
            },
        })
    }

    fn send_composer(&mut self) -> Option<PendingAction> {
        if self.composer.trim().is_empty() {
            return None;
        }
        let key = self.selected.clone()?;
        let profile = self.chat_owner.get(&key)?.clone();
        let raw_chat = split_ckey(&key).1;
        let text = std::mem::take(&mut self.composer);
        Some(PendingAction {
            profile,
            ev: Ev::UiAction {
                action: actions::COMPOSER_SEND.into(),
                chat_id: Some(raw_chat.clone()),
                payload: json!({ "chat_id": raw_chat, "text": text }),
            },
        })
    }
}
