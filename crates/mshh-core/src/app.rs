//! Состояние оболочки и его редукция: UiCmd от модулей + ввод пользователя.
//!
//! Чаты скоупятся по профилю: внутренний ключ чата = `{profile}:{chat_id}`;
//! на границе ядра префикс снимается — модуль видит свои идентификаторы.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use crossterm::event::{
    Event as TermEvent, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use mshh_module_api::model::{
    actions, AccountView, Avatar, ChatId, ChatKind, ChatView, ComposerButton, Ev, FieldDef,
    MessageView, ModuleId, UiCmd,
};
use ratatui::layout::Rect;
use serde_json::{json, Map as JsonMap};

use crate::ratings::{RatingColor, RatingView};
use crate::store::{Group, GroupRule, Profile};

pub const TOAST_TTL: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Focus {
    Chats,
    Search,
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
    /// Установить базовый модуль по индексу каталога.
    InstallBase { idx: usize },
    /// Установить модуль из git-ссылки (docs/MODULE-REPO.md).
    InstallUrl { url: String },
    /// Группы чатов.
    AddGroup { name: String },
    DeleteGroup { id: String },
    AddGroupRule { group: String, rule: GroupRule },
    RemoveGroupRule { group: String, rule: GroupRule },
    /// Разослать поисковый запрос всем включённым профилям.
    SearchQuery { query: String },
}

pub(crate) fn truncate_id(s: &str) -> String {
    if s.chars().count() <= 16 {
        s.to_string()
    } else {
        s.chars().take(15).collect::<String>() + "…"
    }
}

/// Настройки отображения ядра.
#[derive(Clone, Debug)]
pub struct DisplaySettings {
    pub chat_subtitles: bool,
    pub msg_time: bool,
    pub time_24h: bool,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        DisplaySettings {
            chat_subtitles: true,
            msg_time: true,
            time_24h: true,
        }
    }
}

impl DisplaySettings {
    pub const KEYS: [(&'static str, &'static str); 3] = [
        ("chat_subtitles", "Субтитры в списке чатов"),
        ("msg_time", "Время у сообщений"),
        ("time_24h", "24-часовой формат времени"),
    ];

    pub fn get(&self, key: &str) -> bool {
        match key {
            "chat_subtitles" => self.chat_subtitles,
            "msg_time" => self.msg_time,
            _ => self.time_24h,
        }
    }

    pub fn set(&mut self, key: &str, value: bool) {
        match key {
            "chat_subtitles" => self.chat_subtitles = value,
            "msg_time" => self.msg_time = value,
            _ => self.time_24h = value,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SettingsScreen {
    Main,
    AddModule,
    Profile,
    Groups,
    /// Правила группы; payload — индекс в `self.groups`.
    GroupRules(usize),
    /// Выбор типа правила; payload — индекс группы.
    RuleKind(usize),
    /// Выбор типа чата для правила «type»; payload — индекс группы.
    RuleTypePick(usize),
    /// Выбор модуля для правила «module».
    RuleModulePick(usize),
    /// Выбор уровня доверия для правила «trust».
    RuleTrustPick(usize),
    /// Выбор отдельного чата для правила «chat».
    RuleChatPick(usize),
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
    /// Открыть меню модулей и доверия (то же, что клавиша `m`).
    OpenModules,
    /// Группа в списке групп.
    Group { idx: usize, text: String },
    AddGroup,
    /// Правило группы; Enter — удалить.
    Rule { group_idx: usize, rule_idx: usize, text: String },
    AddRule { group_idx: usize },
    DeleteGroup { armed: bool },
}

enum InputTarget {
    RenameProfile(String),
    NewProfileName(String),
    SettingValue { profile: String, field: usize },
    NewGroupName,
}

/// Результат поиска одного профиля; `chat.id` — БЕЗ префикса профиля.
#[derive(Clone, Debug)]
pub struct SearchHit {
    pub chat: ChatView,
    pub profile: String,
}

/// Строка сайдбара: либо чат из списка, либо результат поиска.
#[derive(Clone, Copy, Debug)]
pub(crate) enum SideRow {
    /// Индекс в `self.chats`.
    Chat(usize),
    /// Индекс в `self.search_results`.
    Hit(usize),
}

/// Типизированное правило группы (в хранилище — пара kind/value).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rule {
    Kind(ChatKind),
    Module(String),
    Trust(RatingColor),
    Chat(String),
}

impl Rule {
    pub fn to_kv(&self) -> GroupRule {
        match self {
            Rule::Kind(k) => GroupRule { kind: "type".into(), value: k.as_str().into() },
            Rule::Module(m) => GroupRule { kind: "module".into(), value: m.clone() },
            Rule::Trust(c) => GroupRule { kind: "trust".into(), value: c.key().into() },
            Rule::Chat(key) => GroupRule { kind: "chat".into(), value: key.clone() },
        }
    }

    pub fn from_kv(r: &GroupRule) -> Option<Rule> {
        match r.kind.as_str() {
            "type" => ChatKind::parse(&r.value).map(Rule::Kind),
            "module" => Some(Rule::Module(r.value.clone())),
            "trust" => RatingColor::parse(&r.value).map(Rule::Trust),
            "chat" => Some(Rule::Chat(r.value.clone())),
            _ => None,
        }
    }

    /// Человекочитаемая метка; `module_name` — id → имя модуля.
    pub fn label(&self, module_name: &dyn Fn(&str) -> String) -> String {
        match self {
            Rule::Kind(k) => format!("тип: {}", k.label()),
            Rule::Module(m) => format!("модуль: {}", module_name(m)),
            Rule::Trust(c) => format!("доверие: {}", c.label()),
            Rule::Chat(key) => format!("чат: {}", truncate_id(key)),
        }
    }
}

pub(crate) struct SettingsInput {
    pub(crate) label: String,
    pub(crate) buffer: String,
    target: InputTarget,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MgrScreen {
    List,
    Add,
}

/// Установленный модуль для менеджера.
#[derive(Clone, Debug)]
pub struct InstalledView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub profiles: usize,
    /// Цвет рейтинга (вшитый каталог или «неизвестный»).
    pub color: RatingColor,
    /// Индекс в `trust` для окна фактов; None, если записи нет.
    pub rating_idx: Option<usize>,
}

/// Строка менеджера модулей.
pub(crate) enum MgrRow {
    Header(String),
    Installed { idx: usize, text: String, color: RatingColor, profiles: usize },
    Add,
    Base { base_idx: usize, text: String, installed: bool },
    UrlInput,
    Busy,
    Back,
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
    /// Менеджер модулей (клавиша m).
    pub modules_open: bool,
    pub modules_sel: usize,
    /// Открытое окно фактов: индекс в `trust`.
    pub trust_facts: Option<usize>,
    pub trust_scroll: u32,
    modules_screen: MgrScreen,
    mgr_rows: Vec<MgrRow>,
    mgr_url_input: Option<String>,
    pub mgr_busy: bool,
    /// Установленные модули (заполняет main из рантайма).
    pub installed_modules: Vec<InstalledView>,

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

    /// Группы чатов (фильтры сайдбара).
    pub groups: Vec<Group>,
    /// Активная группа (None = «Все»).
    pub active_group: Option<String>,
    /// Текущая строка поиска (сайдбар, над чатами).
    pub search: String,
    /// Ответы модулей на поиск; `chat.id` без префикса профиля.
    pub search_results: Vec<SearchHit>,
    /// Строка профиля собеседника над чатом (модульная); ключ — внутренний.
    pub chat_header: HashMap<ChatId, (String, Option<Avatar>)>,
    /// Кнопки композера по профилям.
    pub composer_buttons: HashMap<String, Vec<ComposerButton>>,
    /// Пикер аккаунта над композером.
    pub account_picker: bool,
    account_picker_sel: usize,
    /// Выбор аккаунтов от модуля (только могущие писать): chat_key → accounts.
    pub account_choices: HashMap<ChatId, Vec<AccountView>>,
    /// Активные kitty-анимации GIF (по путям файлов).
    pub anims: Vec<Anim>,
}

/// Одна kitty-анимация GIF.
#[derive(Clone, Debug)]
pub struct Anim {
    pub image_id: u32,
    pub path: String,
    /// Задержки кадров в мс.
    pub delays: Vec<u32>,
    /// Текущий кадр (0-based).
    pub cur: usize,
    /// Когда показывать следующий кадр.
    pub due: Instant,
}

impl App {
    /// Продвинуть kitty-анимации: из-за таймера — переключение кадра
    /// терминалом (кадры уже залиты).
    pub fn tick_anims(&mut self, now: Instant) {
        for a in &mut self.anims {
            if a.due <= now {
                a.cur = (a.cur + 1) % a.delays.len();
                crate::images::kitty_anim_switch(a.image_id, (a.cur + 1) as u32);
                a.due = now + Duration::from_millis(a.delays[a.cur] as u64);
            }
        }
    }

    /// Завести анимацию и разместить в ячейках (idempotent по пути).
    pub(crate) fn ensure_anim(&mut self, path: &str, col: u16, row: u16, cols: u16, rows: u16) {
        if let Some(a) = self.anims.iter_mut().find(|a| a.path == path) {
            crate::images::kitty_anim_place(a.image_id, col, row, cols, rows);
            return;
        }
        let Some(frames) = crate::images::gif_frames(Path::new(path)) else { return };
        let mut h: u64 = 0xcbf29ce484222325;
        for b in path.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        let image_id = ((h & 0x0FFF_FFFF) | 1) as u32;
        let delays: Vec<u32> = frames.iter().map(|(_, d)| *d).collect();
        let first_delay = delays[0];
        crate::images::kitty_anim_root(image_id, &frames[0].0);
        for (_, (png, d)) in frames.iter().enumerate().skip(1) {
            crate::images::kitty_anim_frame_data(image_id, png, *d);
        }
        crate::images::kitty_anim_root_gap(image_id, first_delay);
        crate::images::kitty_anim_run(image_id);
        crate::images::kitty_anim_place(image_id, col, row, cols, rows);
        self.anims.push(Anim {
            image_id,
            path: path.to_string(),
            delays,
            cur: 0,
            due: Instant::now() + Duration::from_millis(first_delay as u64),
        });
    }
}

impl App {
    pub(crate) fn settings_screen_name(&self) -> &'static str {
        match self.settings_screen {
            SettingsScreen::Main => "main",
            SettingsScreen::AddModule => "add",
            SettingsScreen::Profile => "profile",
            SettingsScreen::Groups => "groups",
            SettingsScreen::GroupRules(_) => "group-rules",
            SettingsScreen::RuleKind(_) => "rule-kind",
            SettingsScreen::RuleTypePick(_) => "rule-type",
            SettingsScreen::RuleModulePick(_) => "rule-module",
            SettingsScreen::RuleTrustPick(_) => "rule-trust",
            SettingsScreen::RuleChatPick(_) => "rule-chat",
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

    pub(crate) fn modules_screen_name(&self) -> &'static str {
        match self.modules_screen {
            MgrScreen::List => "list",
            MgrScreen::Add => "add",
        }
    }

    pub(crate) fn modules_sel(&self) -> usize {
        self.modules_sel
    }

    pub(crate) fn mgr_rows_ref(&self) -> &[MgrRow] {
        &self.mgr_rows
    }

    pub(crate) fn mgr_url_ref(&self) -> Option<&String> {
        self.mgr_url_input.as_ref()
    }

    /// Перестроить строки настроек (после изменения профилей из main).
    pub fn on_profiles_changed(&mut self) {
        if self.settings_open {
            self.rebuild_settings_rows();
        }
    }

    /// Перестроить строки настроек (после изменения групп из main).
    pub fn on_groups_changed(&mut self) {
        if self.settings_open {
            self.rebuild_settings_rows();
        }
    }
}
pub(crate) fn ckey(profile: &str, chat: &str) -> String {
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
            modules_open: false,
            modules_sel: 0,
            trust_facts: None,
            trust_scroll: 0,
            modules_screen: MgrScreen::List,
            mgr_rows: Vec::new(),
            mgr_url_input: None,
            mgr_busy: false,
            installed_modules: Vec::new(),
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
            groups: Vec::new(),
            active_group: None,
            search: String::new(),
            search_results: Vec::new(),
            chat_header: HashMap::new(),
            composer_buttons: HashMap::new(),
            account_picker: false,
            account_picker_sel: 0,
            account_choices: HashMap::new(),
            anims: Vec::new(),
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
            UiCmd::SearchResults { query, chats } => {
                // Устаревший ответ: запрос уже изменился.
                if query != self.search.trim() {
                    return;
                }
                self.search_results.retain(|h| h.profile != profile);
                for c in chats.drain(..) {
                    self.search_results.push(SearchHit { chat: c, profile: profile.to_string() });
                }
                return;
            }
            UiCmd::SetChatHeader { chat_id, text, avatar } => {
                self.chat_header
                    .insert(ckey(profile, chat_id), (std::mem::take(text), avatar.take()));
                return;
            }
            UiCmd::SetComposerButtons(v) => {
                self.composer_buttons.insert(profile.to_string(), std::mem::take(v));
                return;
            }
            UiCmd::SetAccountChoices { chat_id, accounts } => {
                let key = ckey(profile, chat_id);
                self.account_choices.insert(key, std::mem::take(accounts));
                return;
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
                    if self.modules_open || self.trust_facts.is_some() {
                        self.on_modules_click(m.column, m.row);
                        return None;
                    }
                    if self.account_picker {
                        self.on_account_picker_click(m.column, m.row);
                        return None;
                    }
                    if self.login.is_none() {
                        return self.on_main_click(m.column, m.row);
                    }
                    return None;
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

        if self.modules_open {
            return self.on_key_modules(code);
        }
        if self.account_picker {
            return self.on_key_account_picker(code);
        }
        if self.settings_open {
            return self.on_key_settings(code);
        }
        if self.login.is_some() {
            return self.on_key_login(code, mods);
        }
        // Оверлеи.
        if code == KeyCode::Char('m') && !mods.contains(KeyModifiers::CONTROL) {
            self.open_modules();
            return None;
        }
        if code == KeyCode::Char('s') && !mods.contains(KeyModifiers::CONTROL) {
            self.open_settings();
            return None;
        }

        match self.focus {
            Focus::Chats => match code {
                KeyCode::Up => {
                    let idx = self.selected_position().map(|i| i.saturating_sub(1)).unwrap_or(0);
                    self.select_visible(idx)
                }
                KeyCode::Down => {
                    let idx = self.selected_position().map(|i| i + 1).unwrap_or(0);
                    self.select_visible(idx)
                }
                KeyCode::Enter => {
                    self.focus = Focus::Composer;
                    None
                }
                KeyCode::Tab => {
                    self.focus = Focus::Search;
                    None
                }
                _ => None,
            },
            Focus::Search => match code {
                KeyCode::Esc => {
                    self.search.clear();
                    self.search_results.clear();
                    self.focus = Focus::Chats;
                    None
                }
                KeyCode::Enter => self.open_first_search_row(),
                KeyCode::Tab => {
                    self.focus = Focus::Composer;
                    None
                }
                KeyCode::Backspace => {
                    if self.search.pop().is_some() {
                        self.search_changed();
                    }
                    None
                }
                KeyCode::Char(c) if !mods.contains(KeyModifiers::CONTROL) => {
                    self.search.push(c);
                    self.search_changed();
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
                rows.push(SettingsRow::Header("Группы чатов".into()));
                for (i, g) in self.groups.iter().enumerate() {
                    rows.push(SettingsRow::Group {
                        idx: i,
                        text: format!("{} (правил: {})", g.name, g.rules.len()),
                    });
                }
                rows.push(SettingsRow::AddGroup);
                rows.push(SettingsRow::Header("Модули".into()));
                rows.push(SettingsRow::OpenModules);
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
            SettingsScreen::Groups => {
                let mut rows = vec![SettingsRow::Back];
                for (i, g) in self.groups.iter().enumerate() {
                    rows.push(SettingsRow::Group {
                        idx: i,
                        text: format!("{} (правил: {})", g.name, g.rules.len()),
                    });
                }
                rows.push(SettingsRow::AddGroup);
                rows
            }
            SettingsScreen::GroupRules(gi) => {
                let Some(g) = self.groups.get(gi) else { return };
                let module_name = |m: &str| {
                    self.available_modules
                        .iter()
                        .find(|(id, _)| id == m)
                        .map(|(_, n)| n.clone())
                        .unwrap_or_else(|| m.to_string())
                };
                let mut rows = vec![
                    SettingsRow::Back,
                    SettingsRow::Header(format!("Правила «{}» (Enter по правилу — удалить)", g.name)),
                ];
                for (ri, r) in g.rules.iter().enumerate() {
                    let text = Rule::from_kv(r)
                        .map(|rule| rule.label(&module_name))
                        .unwrap_or_else(|| format!("{}:{}", r.kind, r.value));
                    rows.push(SettingsRow::Rule { group_idx: gi, rule_idx: ri, text });
                }
                rows.push(SettingsRow::AddRule { group_idx: gi });
                rows.push(SettingsRow::DeleteGroup { armed: self.delete_armed });
                rows
            }
            SettingsScreen::RuleKind(_gi) => {
                let mut rows = vec![SettingsRow::Back];
                for (i, t) in ["По типу чата", "По модулю", "По доверию", "Отдельный чат"]
                    .iter()
                    .enumerate()
                {
                    rows.push(SettingsRow::ModulePick { idx: i, text: t.to_string() });
                }
                rows
            }
            SettingsScreen::RuleTypePick(_gi) => {
                let mut rows = vec![SettingsRow::Back];
                for (i, t) in
                    [ChatKind::Bot, ChatKind::Channel, ChatKind::Group, ChatKind::Person]
                        .iter()
                        .enumerate()
                {
                    rows.push(SettingsRow::ModulePick { idx: i, text: t.label().to_string() });
                }
                rows
            }
            SettingsScreen::RuleTrustPick(_gi) => {
                let mut rows = vec![SettingsRow::Back];
                for (i, t) in
                    [RatingColor::Green, RatingColor::Yellow, RatingColor::Red].iter().enumerate()
                {
                    rows.push(SettingsRow::ModulePick { idx: i, text: t.label().to_string() });
                }
                rows
            }
            SettingsScreen::RuleModulePick(_gi) => {
                let mut rows = vec![SettingsRow::Back];
                for (i, (id, name)) in self.available_modules.iter().enumerate() {
                    rows.push(SettingsRow::ModulePick { idx: i, text: format!("{id} — {name}") });
                }
                rows
            }
            SettingsScreen::RuleChatPick(_gi) => {
                let mut rows = vec![SettingsRow::Back];
                for (i, c) in self.chats.iter().enumerate() {
                    rows.push(SettingsRow::ModulePick { idx: i, text: truncate_id(&c.title) });
                }
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
            SettingsRow::OpenModules => {
                // То же меню, что открывается клавишей `m`.
                self.settings_open = false;
                self.open_modules();
            }
            SettingsRow::Group { idx, .. } => {
                self.settings_screen = SettingsScreen::GroupRules(idx);
                self.settings_sel = 0;
                self.delete_armed = false;
                self.rebuild_settings_rows();
            }
            SettingsRow::AddGroup => {
                self.settings_input = Some(SettingsInput {
                    label: "Название группы".into(),
                    buffer: String::new(),
                    target: InputTarget::NewGroupName,
                });
            }
            SettingsRow::Rule { group_idx, rule_idx, .. } => {
                let Some(g) = self.groups.get(group_idx) else { return };
                let Some(rule) = g.rules.get(rule_idx).cloned() else { return };
                self.core_cmds
                    .push(CoreCmd::RemoveGroupRule { group: g.id.clone(), rule });
            }
            SettingsRow::AddRule { group_idx } => {
                self.settings_screen = SettingsScreen::RuleKind(group_idx);
                self.settings_sel = 0;
                self.rebuild_settings_rows();
            }
            SettingsRow::DeleteGroup { .. } => {
                if !self.delete_armed {
                    self.delete_armed = true;
                    self.rebuild_settings_rows();
                    return;
                }
                let gi = match self.settings_screen {
                    SettingsScreen::GroupRules(gi) => gi,
                    _ => return,
                };
                if let Some(g) = self.groups.get(gi) {
                    self.core_cmds.push(CoreCmd::DeleteGroup { id: g.id.clone() });
                }
                self.settings_screen = SettingsScreen::Groups;
                self.delete_armed = false;
                self.settings_sel = 0;
                self.rebuild_settings_rows();
            }
            SettingsRow::ModulePick { idx, .. } => match self.settings_screen {
                SettingsScreen::AddModule => {
                    if let Some((module, _)) = self.available_modules.get(idx).cloned() {
                        self.settings_input = Some(SettingsInput {
                            label: "Имя профиля".into(),
                            buffer: String::new(),
                            target: InputTarget::NewProfileName(module),
                        });
                    }
                }
                SettingsScreen::RuleKind(gi) => {
                    let next = match idx {
                        0 => Some(SettingsScreen::RuleTypePick(gi)),
                        1 => Some(SettingsScreen::RuleModulePick(gi)),
                        2 => Some(SettingsScreen::RuleTrustPick(gi)),
                        3 => Some(SettingsScreen::RuleChatPick(gi)),
                        _ => None,
                    };
                    if let Some(s) = next {
                        self.settings_screen = s;
                        self.settings_sel = 0;
                        self.rebuild_settings_rows();
                    }
                }
                SettingsScreen::RuleTypePick(gi) => {
                    let kinds = [ChatKind::Bot, ChatKind::Channel, ChatKind::Group, ChatKind::Person];
                    if let Some(k) = kinds.get(idx) {
                        self.add_rule(gi, Rule::Kind(*k));
                    }
                }
                SettingsScreen::RuleTrustPick(gi) => {
                    let colors = [RatingColor::Green, RatingColor::Yellow, RatingColor::Red];
                    if let Some(c) = colors.get(idx) {
                        self.add_rule(gi, Rule::Trust(*c));
                    }
                }
                SettingsScreen::RuleModulePick(gi) => {
                    if let Some((module, _)) = self.available_modules.get(idx).cloned() {
                        self.add_rule(gi, Rule::Module(module));
                    }
                }
                SettingsScreen::RuleChatPick(gi) => {
                    if let Some(c) = self.chats.get(idx) {
                        self.add_rule(gi, Rule::Chat(c.id.clone()));
                    }
                }
                _ => {}
            }
            SettingsRow::Back => match self.settings_screen {
                SettingsScreen::RuleKind(gi) => {
                    self.settings_screen = SettingsScreen::GroupRules(gi);
                    self.settings_sel = 0;
                    self.delete_armed = false;
                    self.rebuild_settings_rows();
                }
                SettingsScreen::GroupRules(_) => {
                    self.settings_screen = SettingsScreen::Groups;
                    self.settings_sel = 0;
                    self.delete_armed = false;
                    self.rebuild_settings_rows();
                }
                SettingsScreen::RuleTypePick(gi)
                | SettingsScreen::RuleModulePick(gi)
                | SettingsScreen::RuleTrustPick(gi)
                | SettingsScreen::RuleChatPick(gi) => {
                    self.settings_screen = SettingsScreen::RuleKind(gi);
                    self.settings_sel = 0;
                    self.rebuild_settings_rows();
                }
                _ => {
                    self.settings_screen = SettingsScreen::Main;
                    self.settings_sel = 0;
                    self.delete_armed = false;
                    self.rebuild_settings_rows();
                }
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

    /// Добавить правило группе и вернуться к списку правил.
    fn add_rule(&mut self, group_idx: usize, rule: Rule) {
        let Some(g) = self.groups.get(group_idx) else { return };
        let kv = rule.to_kv();
        self.core_cmds.push(CoreCmd::AddGroupRule { group: g.id.clone(), rule: kv });
        self.settings_screen = SettingsScreen::GroupRules(group_idx);
        self.settings_sel = 0;
        self.rebuild_settings_rows();
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
            InputTarget::NewGroupName => {
                let name = input.buffer.trim().to_string();
                if !name.is_empty() {
                    self.core_cmds.push(CoreCmd::AddGroup { name: name.clone() });
                    self.toast_now(format!("группа «{name}» создаётся…"));
                }
                self.settings_screen = SettingsScreen::Groups;
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

    // ---------- менеджер модулей ----------

    fn open_modules(&mut self) {
        self.modules_open = true;
        self.modules_screen = MgrScreen::List;
        self.modules_sel = 0;
        self.trust_facts = None;
        self.trust_scroll = 0;
        self.mgr_url_input = None;
        self.rebuild_mgr_rows();
    }

    /// Перестроить строки менеджера (после установки/изменения модулей).
    pub fn on_modules_changed(&mut self) {
        if self.modules_open {
            self.rebuild_mgr_rows();
        }
    }

    fn rebuild_mgr_rows(&mut self) {
        self.mgr_rows = match self.modules_screen {
            MgrScreen::List => {
                let mut rows = vec![MgrRow::Header("Установленные модули".into())];
                for (i, m) in self.installed_modules.iter().enumerate() {
                    rows.push(MgrRow::Installed {
                        idx: i,
                        text: format!(
                            "{} {} v{}",
                            truncate_id(&m.id),
                            truncate_id(&m.name),
                            m.version
                        ),
                        color: m.color,
                        profiles: m.profiles,
                    });
                }
                if self.installed_modules.is_empty() {
                    rows.push(MgrRow::Header("нет установленных модулей".into()));
                }
                rows.push(MgrRow::Header("Действия".into()));
                rows.push(MgrRow::Add);
                rows
            }
            MgrScreen::Add => {
                let mut rows = vec![MgrRow::Back];
                rows.push(MgrRow::Header("Базовые".into()));
                for (i, b) in crate::installer::BASE_MODULES.iter().enumerate() {
                    let installed =
                        self.installed_modules.iter().any(|m| m.id == b.id);
                    rows.push(MgrRow::Base {
                        base_idx: i,
                        text: format!("{} — {}", b.id, b.name),
                        installed,
                    });
                }
                rows.push(MgrRow::Header("Другое".into()));
                if self.mgr_busy {
                    rows.push(MgrRow::Busy);
                } else {
                    rows.push(MgrRow::UrlInput);
                }
                rows
            }
        };
        self.modules_sel = self.modules_sel.min(self.mgr_rows.len().saturating_sub(1));
    }

    fn on_key_modules(&mut self, code: KeyCode) -> Option<PendingAction> {
        // Ввод ссылки.
        if let Some(url) = self.mgr_url_input.as_mut() {
            match code {
                KeyCode::Esc => self.mgr_url_input = None,
                KeyCode::Enter => {
                    let url = std::mem::take(url);
                    if url.trim().is_empty() {
                        self.mgr_url_input = None;
                    } else if self.mgr_busy {
                        self.toast_now("установка уже идёт");
                    } else {
                        self.mgr_busy = true;
                        self.mgr_url_input = None;
                        self.rebuild_mgr_rows();
                        self.core_cmds.push(CoreCmd::InstallUrl { url: url.trim().to_string() });
                        self.toast_now("установка начата…");
                    }
                }
                KeyCode::Backspace => {
                    url.pop();
                }
                KeyCode::Char(c) => url.push(c),
                _ => {}
            }
            return None;
        }

        match code {
            KeyCode::Char('m') | KeyCode::Esc => {
                if self.trust_facts.is_some() {
                    self.trust_facts = None;
                } else if self.modules_screen == MgrScreen::Add {
                    self.modules_screen = MgrScreen::List;
                    self.modules_sel = 0;
                    self.rebuild_mgr_rows();
                } else {
                    self.modules_open = false;
                }
            }
            KeyCode::Up if self.trust_facts.is_none() => {
                self.modules_sel = self.modules_sel.saturating_sub(1);
            }
            KeyCode::Down if self.trust_facts.is_none() => {
                self.modules_sel =
                    (self.modules_sel + 1).min(self.mgr_rows.len().saturating_sub(1));
            }
            KeyCode::Enter if self.trust_facts.is_none() => self.modules_activate(),
            _ => {}
        }
        None
    }

    fn modules_activate(&mut self) {
        let Some(row) = self.mgr_rows.get(self.modules_sel) else {
            return;
        };
        match row {
            MgrRow::Header(_) | MgrRow::Busy => {}
            MgrRow::Installed { idx, .. } => {
                if let Some(m) = self.installed_modules.get(*idx) {
                    if let Some(ri) = m.rating_idx {
                        self.trust_facts = Some(ri);
                        self.trust_scroll = 0;
                    }
                }
            }
            MgrRow::Add => {
                self.modules_screen = MgrScreen::Add;
                self.modules_sel = 0;
                self.rebuild_mgr_rows();
            }
            MgrRow::Base { base_idx, installed, .. } => {
                if *installed {
                    self.toast_now("модуль уже установлен");
                    return;
                }
                if self.mgr_busy {
                    self.toast_now("дождитесь окончания текущей установки");
                    return;
                }
                self.core_cmds.push(CoreCmd::InstallBase { idx: *base_idx });
                self.mgr_busy = true;
                self.rebuild_mgr_rows();
                self.toast_now("установка начата…");
            }
            MgrRow::UrlInput => {
                self.mgr_url_input = Some(String::new());
            }
            MgrRow::Back => {
                self.modules_screen = MgrScreen::List;
                self.modules_sel = 0;
                self.rebuild_mgr_rows();
            }
        }
    }

    fn on_modules_click(&mut self, col: u16, row: u16) {
        if self.trust_facts.is_some() {
            let fa = crate::render::facts_area(self.area);
            let inside = col >= fa.x && col < fa.x + fa.width && row >= fa.y && row < fa.y + fa.height;
            if !inside {
                self.trust_facts = None;
            }
            return;
        }
        let list = crate::render::modules_area(self.area);
        let inside = col >= list.x && col < list.x + list.width && row >= list.y && row < list.y + list.height;
        if !inside {
            self.modules_open = false;
            return;
        }
        let idx = row.saturating_sub(list.y + 1) as usize;
        if idx < self.mgr_rows.len() {
            self.modules_sel = idx;
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

    // ---------- сайдбар: группы и поиск ----------

    /// Типизированные правила активной группы применяются к чату (ИЛИ).
    fn group_allows(&self, chat: &ChatView) -> bool {
        let Some(id) = self.active_group.as_ref() else { return true };
        let Some(g) = self.groups.iter().find(|g| &g.id == id) else { return true };
        if g.rules.is_empty() {
            return true;
        }
        let owner = self.chat_owner.get(&chat.id).map(String::as_str).unwrap_or("");
        let module = self
            .profiles
            .iter()
            .find(|p| p.id == owner)
            .map(|p| p.module.as_str())
            .unwrap_or("");
        let trust = self
            .trust
            .iter()
            .find(|t| t.module_id == module)
            .map(|t| t.color);
        g.rules.iter().any(|r| match Rule::from_kv(r) {
            Some(Rule::Kind(k)) => chat.kind == k,
            Some(Rule::Module(m)) => module == m,
            Some(Rule::Trust(c)) => trust == Some(c),
            Some(Rule::Chat(key)) => chat.id == key,
            None => false,
        })
    }

    /// Строки сайдбара: поиск (локальные совпадения + ответы модулей)
    /// или чаты, отфильтрованные активной группой.
    pub(crate) fn sidebar_rows(&self) -> Vec<SideRow> {
        let query = self.search.trim();
        if !query.is_empty() {
            let q = query.to_lowercase();
            let mut rows: Vec<SideRow> = Vec::new();
            let mut seen: Vec<String> = Vec::new();
            for (i, c) in self.chats.iter().enumerate() {
                let hit = c.title.to_lowercase().contains(&q)
                    || c.id.to_lowercase().contains(&q);
                if hit {
                    seen.push(c.id.clone());
                    rows.push(SideRow::Chat(i));
                }
            }
            for (i, h) in self.search_results.iter().enumerate() {
                let key = ckey(&h.profile, &h.chat.id);
                if !seen.contains(&key) {
                    rows.push(SideRow::Hit(i));
                }
            }
            return rows;
        }
        self.chats
            .iter()
            .enumerate()
            .filter(|(_, c)| self.group_allows(c))
            .map(|(i, _)| SideRow::Chat(i))
            .collect()
    }

    /// Индексы чатов (без результатов поиска) — для клавиатурной навигации.
    fn chat_rows(&self) -> Vec<usize> {
        self.sidebar_rows()
            .into_iter()
            .filter_map(|r| match r {
                SideRow::Chat(i) => Some(i),
                SideRow::Hit(_) => None,
            })
            .collect()
    }

    /// Позиция выбранного чата среди видимых строк.
    fn selected_position(&self) -> Option<usize> {
        let sel = self.selected.as_ref()?;
        self.chat_rows().iter().position(|i| self.chats[*i].id == *sel)
    }

    /// Выбор видимого чата по позиции в отфильтрованном списке.
    fn select_visible(&mut self, pos: usize) -> Option<PendingAction> {
        let idx = *self.chat_rows().get(pos)?;
        let chat = self.chats[idx].clone();
        self.select_chat_view(chat)
    }

    /// Выбрать чат и попросить профиль его открыть.
    fn select_chat_view(&mut self, chat: ChatView) -> Option<PendingAction> {
        self.selected = Some(chat.id.clone());
        self.scroll_from_end = 0;
        if let Some(slot) = self.chats.iter_mut().find(|c| c.id == chat.id) {
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

    /// Открыть чат из результата поиска: модуль получит CHAT_OPEN и
    /// должен добавить чат через UpsertChat.
    fn open_hit(&mut self, idx: usize) -> Option<PendingAction> {
        let hit = self.search_results.get(idx)?.clone();
        let key = ckey(&hit.profile, &hit.chat.id);
        self.selected = Some(key.clone());
        self.chat_owner.insert(key, hit.profile.clone());
        self.scroll_from_end = 0;
        let raw = hit.chat.id.clone();
        Some(PendingAction {
            profile: hit.profile,
            ev: Ev::UiAction {
                action: actions::CHAT_OPEN.into(),
                chat_id: Some(raw.clone()),
                payload: json!({ "chat_id": raw }),
            },
        })
    }

    /// Запрос изменился: сбросить результаты и разослать профилям.
    fn search_changed(&mut self) {
        self.search_results.clear();
        let query = self.search.trim().to_string();
        if query.is_empty() {
            return;
        }
        self.core_cmds.push(CoreCmd::SearchQuery { query });
    }

    /// Enter в поиске: открыть первую строку результатов.
    fn open_first_search_row(&mut self) -> Option<PendingAction> {
        let row = *self.sidebar_rows().first()?;
        let action = match row {
            SideRow::Chat(i) => self.chats.get(i).cloned().and_then(|c| self.select_chat_view(c)),
            SideRow::Hit(i) => self.open_hit(i),
        };
        if action.is_some() {
            self.search.clear();
            self.search_results.clear();
            self.focus = Focus::Composer;
        }
        action
    }

    /// Клик по сайдбару/правой панели: раскладка из render::main_layout.
    fn on_main_click(&mut self, col: u16, row: u16) -> Option<PendingAction> {
        let l = crate::render::main_layout(self.area, self.composer_buttons_width());
        let inside = |r: Rect| col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height;

        if inside(l.search) {
            self.focus = Focus::Search;
            return None;
        }
        if inside(l.rail_settings) {
            self.open_settings();
            return None;
        }
        if inside(l.rail_groups) {
            let idx = row.saturating_sub(l.rail_groups.y) as usize;
            if idx == 0 {
                self.active_group = None;
            } else if let Some(g) = self.groups.get(idx - 1) {
                self.active_group = if self.active_group.as_deref() == Some(&g.id) {
                    None
                } else {
                    Some(g.id.clone())
                };
            }
            return None;
        }
        if inside(l.chats) {
            let idx = row.saturating_sub(l.chats.y + 1) as usize;
            let rows = self.sidebar_rows();
            let Some(row) = rows.get(idx).copied() else { return None };
            return match row {
                SideRow::Chat(i) => {
                    self.chats.get(i).cloned().and_then(|c| self.select_chat_view(c))
                }
                SideRow::Hit(i) => {
                    let a = self.open_hit(i);
                    if a.is_some() {
                        self.search.clear();
                        self.search_results.clear();
                        self.focus = Focus::Composer;
                    }
                    a
                }
            };
        }

        if inside(l.account_chip) {
            return self.open_account_picker();
        }
        if let Some(btns) = l.composer_buttons {
            if inside(btns) {
                let profile = self.selected_chat_profile()?;
                let idx = col.saturating_sub(btns.x) as usize;
                if let Some(b) = self
                    .composer_buttons
                    .get(&profile)
                    .and_then(|v| v.get(idx))
                    .cloned()
                {
                    let raw = split_ckey(&self.selected.clone()?).1;
                    return Some(PendingAction {
                        profile,
                        ev: Ev::UiAction {
                            action: actions::COMPOSER_BUTTON.into(),
                            chat_id: Some(raw.clone()),
                            payload: json!({ "button": b.id, "chat_id": raw }),
                        },
                    });
                }
                return None;
            }
        }
        if inside(l.composer) {
            self.focus = Focus::Composer;
            return None;
        }
        if inside(l.messages) || inside(l.header) {
            self.focus = Focus::Chats;
        }
        None
    }

    /// Профиль выбранного чата.
    fn selected_chat_profile(&self) -> Option<String> {
        let key = self.selected.as_ref()?;
        self.chat_owner.get(key).cloned()
    }

    /// Публичный доступ для рендера.
    pub(crate) fn selected_chat_profile_pub(&self) -> Option<String> {
        self.selected_chat_profile()
    }

    /// id модуля чата (по владельцу-профилю).
    pub(crate) fn chat_module(&self, key: &str) -> String {
        self.chat_owner
            .get(key)
            .and_then(|p| self.profiles.iter().find(|x| &x.id == p))
            .map(|p| p.module.clone())
            .unwrap_or_default()
    }

    /// Цвет доверия к модулю чата (из каталога рейтингов).
    pub(crate) fn chat_trust(&self, module: &str) -> Option<RatingColor> {
        self.trust.iter().find(|t| t.module_id == module).map(|t| t.color)
    }

    /// Активный аккаунт профиля (для кружка в композере).
    pub(crate) fn active_account(&self, profile: &str) -> Option<&AccountView> {
        self.accounts.iter().find(|(p, a)| p == profile && a.active).map(|(_, a)| a)
    }

    /// Ширина зоны кнопок модуля в строке ввода (справа).
    pub(crate) fn composer_buttons_width(&self) -> u16 {
        let Some(profile) = self.selected_chat_profile() else { return 1 };
        let w: usize = self
            .composer_buttons
            .get(&profile)
            .map(|v| v.iter().map(|b| b.label.chars().count() + 3).sum())
            .unwrap_or(0);
        (w as u16).max(1)
    }

    // ---------- пикер аккаунта ----------

    fn open_account_picker(&mut self) -> Option<PendingAction> {
        if self.selected_chat_profile().is_none() {
            return None;
        }
        // Спросить у модуля, кто МОЖЕТ писать в этот чат; пока модуль не
        // ответил, показываем прошлогний/полный список.
        let profile = self.selected_chat_profile()?;
        let raw = split_ckey(self.selected.as_ref()?).1;
        self.account_picker = true;
        self.account_picker_sel = 0;
        Some(PendingAction {
            profile,
            ev: Ev::UiAction {
                action: actions::ACCOUNT_LIST.into(),
                chat_id: Some(raw.clone()),
                payload: json!({ "chat_id": raw }),
            },
        })
    }

    /// Аккаунты для пикера: сначала ответ модуля (только могущие писать),
    /// если ответа нет — все аккаунты профиля.
    pub(crate) fn account_picker_open_accounts(&self) -> Vec<&AccountView> {
        let Some(profile) = self.selected_chat_profile() else { return Vec::new() };
        if let Some(key) = self.selected.as_ref() {
            if let Some(choices) = self.account_choices.get(key) {
                if !choices.is_empty() {
                    return choices.iter().collect();
                }
            }
        }
        self.accounts
            .iter()
            .filter(|(p, _)| *p == profile)
            .map(|(_, a)| a)
            .collect()
    }

    pub(crate) fn account_picker_sel(&self) -> usize {
        self.account_picker_sel
    }

    fn on_key_account_picker(&mut self, code: KeyCode) -> Option<PendingAction> {
        let n = self.account_picker_open_accounts().len();
        match code {
            KeyCode::Esc => self.account_picker = false,
            KeyCode::Up => self.account_picker_sel = self.account_picker_sel.saturating_sub(1),
            KeyCode::Down => {
                self.account_picker_sel = (self.account_picker_sel + 1).min(n.saturating_sub(1));
            }
            KeyCode::Enter => {
                let profile = self.selected_chat_profile()?;
                let account = self
                    .account_picker_open_accounts()
                    .get(self.account_picker_sel)?
                    .id
                    .clone();
                self.account_picker = false;
                return Some(PendingAction {
                    profile,
                    ev: Ev::UiAction {
                        action: actions::ACCOUNT_SWITCH.into(),
                        chat_id: None,
                        payload: json!({ "account_id": account }),
                    },
                });
            }
            _ => {}
        }
        None
    }

    fn on_account_picker_click(&mut self, col: u16, row: u16) {
        let rect = crate::render::account_picker_area(self.area);
        let inside = col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;
        if !inside {
            self.account_picker = false;
            return;
        }
        let idx = row.saturating_sub(rect.y + 1) as usize;
        let n = self.account_picker_open_accounts().len();
        if idx < n {
            self.account_picker_sel = idx;
        }
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
