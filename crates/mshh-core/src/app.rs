//! Состояние оболочки и его редукция: UiCmd от модулей + ввод пользователя.

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

/// Действие, требующее доставки конкретному модулю.
pub struct PendingAction {
    pub module: ModuleId,
    pub ev: Ev,
}

pub struct App {
    pub accounts: Vec<AccountView>,
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
    pub chat_owner: HashMap<ChatId, ModuleId>,
    pub module_count: usize,
    pub quit: bool,
    /// Вшитый каталог доверия + записи о загруженных модулях.
    pub trust: Vec<RatingView>,
    pub trust_open: bool,
    pub trust_sel: usize,
    /// Открытое окно фактов: индекс в `trust`.
    pub trust_facts: Option<usize>,
    pub trust_scroll: u32,
    /// Последняя известная площадь терминала (хит-тест мыши).
    pub area: Rect,
}

impl App {
    pub fn new(module_count: usize) -> App {
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
            area: Rect::new(0, 0, 1, 1),
        }
    }

    pub fn toast_now(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now()));
    }

    /// Команда отображения от модуля.
    pub fn apply_ui(&mut self, module: &str, cmd: UiCmd) {
        match cmd {
            UiCmd::SetAccounts(v) => self.accounts = v,
            UiCmd::SetChats(v) => {
                for c in &v {
                    self.chat_owner.insert(c.id.clone(), module.into());
                }
                self.chats = v;
                if let Some(sel) = self.selected.clone() {
                    if !self.chats.iter().any(|c| c.id == sel) {
                        self.selected = None;
                    }
                }
            }
            UiCmd::UpsertChat(c) => {
                self.chat_owner.insert(c.id.clone(), module.into());
                match self.chats.iter_mut().find(|x| x.id == c.id) {
                    Some(slot) => *slot = c,
                    None => self.chats.push(c),
                }
            }
            UiCmd::SetMessages { chat_id, messages } => {
                if self.selected.as_deref() == Some(chat_id.as_str()) {
                    self.scroll_from_end = 0;
                }
                self.messages.insert(chat_id, messages);
            }
            UiCmd::AddMessage(m) => {
                self.messages.entry(m.chat_id.clone()).or_default().push(m);
            }
            UiCmd::SetPresence { chat_id, text } => {
                self.presence.insert(chat_id, text);
            }
            UiCmd::PromptLogin { title, fields, submit_action, cancel_action } => {
                self.login = Some(LoginState {
                    module: module.into(),
                    title,
                    fields,
                    focus: 0,
                    submit_action,
                    cancel_action,
                });
            }
            UiCmd::CloseLogin => {
                if self.login.as_ref().map(|l| l.module == module).unwrap_or(false) {
                    self.login = None;
                }
            }
            UiCmd::Toast { text } => self.toast_now(text),
        }
    }

    /// Ввод пользователя. Возвращает действие для модуля, если оно есть.
    pub fn on_input(&mut self, ev: &TermEvent) -> Option<PendingAction> {
        match ev {
            TermEvent::Key(k) if k.kind == KeyEventKind::Press => self.on_key(k.code, k.modifiers),
            TermEvent::Mouse(m) => {
                if m.kind == MouseEventKind::Down(MouseButton::Left)
                    && (self.trust_open || self.trust_facts.is_some())
                {
                    self.on_trust_click(m.column, m.row);
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
            KeyCode::PageUp if self.trust_facts.is_some() => {
                self.trust_scroll = self.trust_scroll.saturating_add(5);
                return None;
            }
            KeyCode::PageDown if self.trust_facts.is_some() => {
                self.trust_scroll = self.trust_scroll.saturating_sub(5);
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
        if self.login.is_some() {
            return self.on_key_login(code, mods);
        }
        // Каталог доверия.
        if code == KeyCode::Char('m') && !mods.contains(KeyModifiers::CONTROL) {
            self.trust_open = true;
            self.trust_sel = 0;
            self.trust_facts = None;
            self.trust_scroll = 0;
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
        Some(PendingAction { module, ev: out })
    }

    /// Клавиатура каталога доверия.
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
        let module = self.chat_owner.get(&chat.id).cloned()?;
        Some(PendingAction {
            module,
            ev: Ev::UiAction {
                action: actions::CHAT_OPEN.into(),
                chat_id: Some(chat.id.clone()),
                payload: json!({ "chat_id": chat.id }),
            },
        })
    }

    fn send_composer(&mut self) -> Option<PendingAction> {
        if self.composer.trim().is_empty() {
            return None;
        }
        let chat = self.selected.clone()?;
        let module = self.chat_owner.get(&chat)?.clone();
        let text = std::mem::take(&mut self.composer);
        Some(PendingAction {
            module,
            ev: Ev::UiAction {
                action: actions::COMPOSER_SEND.into(),
                chat_id: Some(chat.clone()),
                payload: json!({ "chat_id": chat, "text": text }),
            },
        })
    }
}
