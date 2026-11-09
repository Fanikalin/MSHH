//! TUI-рендерер (ratatui): единственный модуль ядра, знающий про рисование.
//! GUI-рендерер (будущий) будет получать то же состояние `App`.

use mshh_module_api::model::{Avatar, Body, MessageView};
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::app::{ckey, truncate_id, App, Focus, MgrRow, SettingsRow, SideRow, TOAST_TTL};
use crate::ratings::RatingColor;

fn muted() -> Style {
    Style::new().fg(Color::DarkGray)
}

/// Прямоугольники главного экрана (для рендера и хит-теста мыши).
pub struct MainLayout {
    pub search: Rect,
    pub settings_btn: Rect,
    pub groups: Rect,
    pub chats: Rect,
    pub header: Rect,
    pub messages: Rect,
    pub composer: Rect,
    /// Строка кнопок модуля внутри композера (None — кнопок нет).
    pub composer_buttons: Option<Rect>,
    /// Кружок активного аккаунта левее поля ввода.
    pub account_chip: Rect,
    /// Нижняя строка правой панели (счётчики).
    pub status: Rect,
}

/// Единая раскладка: сайдбар (поиск/настройки/группы/чаты) + правая панель.
pub fn main_layout(area: Rect, groups: usize, composer_height: u16) -> MainLayout {
    let cols = Layout::horizontal([Constraint::Percentage(30), Constraint::Fill(1)]).split(area);
    let sidebar_w = cols[0].width.saturating_sub(2).max(1);
    let groups_h = (groups as u16 + 3).clamp(3, 9).min(area.height.saturating_sub(9));
    let rows = Layout::vertical([
        Constraint::Length(3),
        Constraint::Length(1),
        Constraint::Length(groups_h),
        Constraint::Fill(1),
    ])
    .split(cols[0]);
    let search_inner = Rect::new(rows[0].x + 1, rows[0].y + 1, sidebar_w, 1);
    let settings_btn = Rect::new(rows[1].x + 1, rows[1].y, sidebar_w, 1);
    let groups_inner = Rect::new(rows[2].x + 1, rows[2].y, sidebar_w, groups_h.saturating_sub(2));
    let chats = rows[3];

    let right = Layout::vertical([
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(composer_height),
        Constraint::Length(1),
    ])
    .split(cols[1]);
    let right_w = right[2].width.saturating_sub(2).max(1);
    let composer_inner_y = right[2].y + 1;
    // Строка 0 композера — кнопки модуля (если есть), далее строка ввода
    // с кружком аккаунта слева.
    let (buttons_row, input_row) = if composer_height > 3 {
        (Some(composer_inner_y), composer_inner_y + 1)
    } else {
        (None, composer_inner_y)
    };
    let chip = Rect::new(right[2].x + 1, input_row, 4, 1);
    MainLayout {
        search: search_inner,
        settings_btn,
        groups: groups_inner,
        chats,
        header: right[0],
        messages: right[1],
        composer: right[2],
        composer_buttons: buttons_row
            .map(|y| Rect::new(right[2].x + 1, y, right_w, 1)),
        account_chip: chip,
        status: right[3],
    }
}

/// Обрезать строку до `n` символов с многоточием.
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n.saturating_sub(1)).collect::<String>() + "…"
    }
}

/// Цвет кружка из имени (стабильный для одного имени).
fn name_color(name: &str) -> Color {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    name.hash(&mut h);
    const PALETTE: [Color; 8] = [
        Color::Blue,
        Color::Magenta,
        Color::Red,
        Color::Green,
        Color::Cyan,
        Color::Yellow,
        Color::DarkGray,
        Color::White,
    ];
    PALETTE[(h.finish() as usize) % PALETTE.len()]
}

/// Кружок-аватар: `(спан, ширина)`. None → цвет из имени + первая буква.
fn avatar_chip(avatar: Option<&Avatar>, name: &str) -> (Span<'static>, usize) {
    let bg = name_color(name);
    let fg = match bg {
        Color::Yellow | Color::Cyan | Color::White | Color::Green => Color::Black,
        _ => Color::White,
    };
    let text = match avatar {
        Some(Avatar::Initial { text }) => truncate(text, 3),
        Some(Avatar::Image { .. }) => "▦".to_string(),
        None => {
            let c = name.trim().chars().next().unwrap_or('?');
            c.to_uppercase().to_string()
        }
    };
    let shown = format!(" {text} ");
    let w = shown.chars().count() as u16;
    (
        Span::styled(shown, Style::new().bg(bg).fg(fg).add_modifier(Modifier::BOLD)),
        w as usize,
    )
}

pub fn draw(f: &mut Frame, app: &App) {
    let area = f.area();
    let layout = main_layout(area, app.groups.len(), app.composer_height());

    draw_sidebar(f, app, &layout);
    draw_header(f, app, layout.header);
    draw_messages(f, app, layout.messages);
    draw_composer(f, app, &layout);
    if app.display.hints_bar {
        draw_status(f, app, layout.status);
    }

    if app.login.is_some() {
        draw_login(f, app, area);
    }
    if app.modules_open {
        draw_modules(f, app, area);
    }
    if let Some(i) = app.trust_facts {
        draw_facts(f, app, area, i);
    }
    if app.settings_open {
        draw_settings(f, app, area);
    }
    if app.account_picker {
        draw_account_picker(f, app, area);
    }
    draw_toast(f, app, area);
}

/// Сайдбар: строка поиска, кнопка настроек, группы, чаты.
fn draw_sidebar(f: &mut Frame, app: &App, l: &MainLayout) {
    // Поиск.
    let search_rect = Rect::new(
        l.search.x - 1,
        l.search.y.saturating_sub(1),
        l.search.width + 2,
        3,
    );
    let search_block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(if app.focus == Focus::Search {
            Style::new().fg(Color::Cyan)
        } else {
            muted()
        })
        .title(" Поиск ");
    f.render_widget(search_block, search_rect);
    let query = if app.search.is_empty() && app.focus != Focus::Search {
        Span::styled("все чаты и модули…", muted())
    } else {
        Span::raw(format!("{}▌", app.search))
    };
    f.render_widget(Paragraph::new(Line::from(query)), l.search);

    // Кнопка настроек.
    let style = Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD);
    f.render_widget(Paragraph::new(Line::from(Span::styled("[ ⚙ Настройки ]", style))), l.settings_btn);

    // Группы: «Все» + пользовательские.
    let mut group_lines: Vec<Line> = Vec::new();
    let all_sel = app.active_group.is_none();
    group_lines.push(Line::from(Span::styled(
        if all_sel { "> Все" } else { "  Все" },
        if all_sel {
            Style::new().bg(Color::DarkGray).add_modifier(Modifier::BOLD)
        } else {
            Style::new()
        },
    )));
    for g in &app.groups {
        let sel = app.active_group.as_deref() == Some(&g.id);
        group_lines.push(Line::from(Span::styled(
            format!("{}{}", if sel { "> " } else { "  " }, g.name),
            if sel {
                Style::new().bg(Color::DarkGray).add_modifier(Modifier::BOLD)
            } else {
                Style::new()
            },
        )));
    }
    let groups_block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(" Группы ");
    let groups_rect = Rect::new(
        l.groups.x.saturating_sub(1),
        l.groups.y.saturating_sub(1),
        l.groups.width + 2,
        l.groups.height + 2,
    );
    f.render_widget(groups_block, groups_rect);
    f.render_widget(Paragraph::new(group_lines), l.groups);

    // Чаты (обычный список или результаты поиска).
    let searching = !app.search.trim().is_empty();
    let title = if searching {
        format!(" Поиск: {} ", app.search.trim())
    } else {
        match app.active_group.as_ref().and_then(|id| app.groups.iter().find(|g| &g.id == id)) {
            Some(g) => format!(" Чаты · {} ", g.name),
            None => " Чаты ".to_string(),
        }
    };
    let rows = app.sidebar_rows();
    let inner_w = l.chats.width.saturating_sub(2) as usize;
    let mut items: Vec<ListItem> = Vec::new();
    for row in &rows {
        let mut spans: Vec<Span> = Vec::new();
        let selected;
        match row {
            SideRow::Chat(i) => {
                let Some(c) = app.chats.get(*i) else { continue };
                let (chip, _cw) = avatar_chip(c.avatar.as_ref(), &c.title);
                spans.push(chip);
                let mut title = c.title.clone();
                if c.unread > 0 {
                    title.push_str(&format!(" [{}]", c.unread));
                }
                spans.push(Span::styled(
                    title,
                    if c.unread > 0 {
                        Style::new().add_modifier(Modifier::BOLD)
                    } else {
                        Style::new()
                    },
                ));
                selected = app.selected.as_deref() == Some(c.id.as_str()) && app.focus == Focus::Chats;
                if app.display.chat_subtitles && c.unread == 0 {
                    if let Some(sub) = &c.subtitle {
                        spans.push(Span::styled(format!(" — {sub}"), muted()));
                    }
                }
            }
            SideRow::Hit(i) => {
                let Some(h) = app.search_results.get(*i) else { continue };
                let (chip, _) = avatar_chip(h.chat.avatar.as_ref(), &h.chat.title);
                spans.push(chip);
                spans.push(Span::raw(h.chat.title.clone()));
                // Справа: модуль и кружок доверия.
                let module = app.chat_module(&ckey(&h.profile, &h.chat.id));
                let trust = app.chat_trust(&module).map(|c| color_of(c));
                let right = format!("{module} ●");
                let used: usize = spans.iter().map(|s| s.content.chars().count()).sum();
                let pad = inner_w.saturating_sub(used + right.chars().count() + 1);
                spans.push(Span::raw(" ".repeat(pad)));
                spans.push(Span::styled(module.clone(), muted()));
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    "●",
                    Style::new().fg(trust.unwrap_or(Color::DarkGray)).add_modifier(Modifier::BOLD),
                ));
                spans.push(Span::styled(
                    format!(" {}", h.profile),
                    Style::new().fg(Color::DarkGray),
                ));
                selected = false;
            }
        }
        let mut line = Line::from(spans);
        if selected {
            line = line.style(Style::new().bg(Color::DarkGray));
        }
        items.push(ListItem::new(line));
    }
    if items.is_empty() {
        items.push(ListItem::new(Line::styled(
            if searching { "ничего не найдено" } else { "нет чатов" },
            muted(),
        )));
    }
    let chats_list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .title(title),
    );
    f.render_widget(chats_list, l.chats);

    // Курсор в поле поиска.
    if app.focus == Focus::Search {
        let x = l.search.x + app.search.chars().count() as u16;
        f.set_cursor_position(Position::new(
            x.min(l.search.x + l.search.width.saturating_sub(1)),
            l.search.y,
        ));
    }
}

/// Строка профиля собеседника над чатом; содержимое — модульное.
fn draw_header(f: &mut Frame, app: &App, area: Rect) {
    let Some(key) = app.selected.as_ref() else {
        return;
    };
    let (text, avatar) = match app.chat_header.get(key) {
        Some((t, a)) => (t.clone(), a.clone()),
        None => {
            // Fallback: профиль · модуль.
            let profile = app.chat_owner.get(key).cloned().unwrap_or_default();
            let pname = app
                .profiles
                .iter()
                .find(|p| p.id == profile)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| profile.clone());
            let module = app.chat_module(key);
            (format!("{pname} · {module}"), None)
        }
    };
    let title = app
        .chats
        .iter()
        .find(|c| &c.id == key)
        .map(|c| c.title.clone())
        .unwrap_or_else(|| truncate_id(key));
    let (chip, _) = avatar_chip(avatar.as_ref(), &title);
    let line = Line::from(vec![
        chip,
        Span::raw(" "),
        Span::styled(text, Style::new().add_modifier(Modifier::BOLD)),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn draw_messages(f: &mut Frame, app: &App, area: Rect) {
    let title = match app.selected.as_ref() {
        Some(id) => match app.chats.iter().find(|c| &c.id == id) {
            Some(c) => format!(" {} ", c.title),
            None => format!(" {id} "),
        },
        None => " История ".into(),
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(title);
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<Line> = Vec::new();
    if let Some(chat) = app.selected.as_ref() {
        if let Some(msgs) = app.messages.get(chat) {
            lines.extend(msgs.iter().map(|m| msg_line(m, app.display.msg_time, app.display.time_24h)));
            if let Some(p) = app.presence.get(chat) {
                if !p.is_empty() {
                    lines.push(Line::styled(p.clone(), Style::new().fg(Color::Cyan)));
                }
            }
        }
    }
    if lines.is_empty() {
        let hint = if app.module_count == 0 {
            "нет модулей — см. docs/MODULES.md"
        } else {
            "выберите чат ↑/↓"
        };
        lines.push(Line::styled(hint, muted()));
    }

    // Окно логических строк, снизу вверх, со сдвигом от конца.
    let h = inner.height as usize;
    let len = lines.len();
    let from_end = (app.scroll_from_end as usize).min(len);
    let end = len - from_end;
    let start = end.saturating_sub(h);
    f.render_widget(Paragraph::new(lines[start..end].to_vec()), inner);
}

fn msg_line(m: &MessageView, show_time: bool, time_24h: bool) -> Line<'static> {
    let time = if show_time {
        let fmt = if time_24h { "%H:%M" } else { "%I:%M %p" };
        chrono::DateTime::from_timestamp_millis(m.ts_ms as i64)
            .map(|d| d.with_timezone(&chrono::Local).format(fmt).to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let body = match &m.body {
        Body::Text(t) => t.clone(),
        Body::Image { alt } => format!("[изображение: {alt}]"),
        Body::File { name, size } => match size {
            Some(s) => format!("[файл: {name} ({s} Б)]"),
            None => format!("[файл: {name}]"),
        },
    };
    let sender = if m.out { "Вы".to_string() } else { m.sender.clone() };
    let sender_style = if m.out {
        Style::new().fg(Color::Green).add_modifier(Modifier::BOLD)
    } else {
        Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD)
    };
    Line::from(vec![
        Span::styled(format!("{time} "), muted()),
        Span::styled(sender, sender_style),
        Span::raw(": "),
        Span::raw(body),
    ])
}

fn draw_composer(f: &mut Frame, app: &App, l: &MainLayout) {
    let focused = app.focus == Focus::Composer && app.login.is_none();
    let border = if focused { Style::new().fg(Color::Cyan) } else { muted() };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border)
        .title(" Сообщение (Enter — отправить) ");
    f.render_widget(block, l.composer);

    let profile = app.selected_chat_profile_pub();

    // Кнопки модуля — первой строкой внутри композера.
    if let Some(btns_rect) = l.composer_buttons {
        let buttons = profile
            .as_ref()
            .and_then(|p| app.composer_buttons.get(p))
            .cloned()
            .unwrap_or_default();
        let mut spans: Vec<Span> = Vec::new();
        for b in &buttons {
            spans.push(Span::styled(
                format!("[{}] ", b.label),
                Style::new().fg(Color::Cyan),
            ));
        }
        if spans.is_empty() {
            spans.push(Span::styled(" ", muted()));
        }
        f.render_widget(Paragraph::new(Line::from(spans)), btns_rect);
    }

    // Кружок активного аккаунта + ввод.
    let chip_span = match profile.as_ref().and_then(|p| app.active_account(p)) {
        Some(acc) => avatar_chip(acc.avatar.as_ref(), &acc.name).0,
        None => Span::styled(" ? ", Style::new().bg(Color::DarkGray).fg(Color::White)),
    };
    let input_y = l.account_chip.y;
    let input_x = l.account_chip.x + l.account_chip.width;
    let input_w = l.composer.width.saturating_sub(input_x - l.composer.x + 1);
    let input_rect = Rect::new(input_x, input_y, input_w, 1);
    f.render_widget(Paragraph::new(Line::from(vec![chip_span, Span::raw(" ")])), Rect::new(
        l.account_chip.x,
        input_y,
        l.account_chip.width + 1,
        1,
    ));
    f.render_widget(Paragraph::new(app.composer.as_str()), input_rect);
    if focused {
        let x = input_x + app.composer.chars().count() as u16;
        f.set_cursor_position(Position::new(x.min(input_x + input_w.saturating_sub(1)), input_y));
    }
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    // Описания хот-кеев убраны; остаются только счётчики.
    let line = Line::from(Span::styled(
        format!("профилей: {} · модулей: {}", app.profile_count, app.module_count),
        muted(),
    ));
    f.render_widget(Paragraph::new(line), area);
}

fn draw_login(f: &mut Frame, app: &App, area: Rect) {
    let Some(login) = app.login.as_ref() else { return };
    let height = (login.fields.len() as u16 + 4).clamp(5, area.height.max(5));
    let width = 50.min(area.width.saturating_sub(4)).max(10);
    let rect = centered(width, height, area);
    f.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(Color::Cyan))
        .title(format!(" {} ", login.title));
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines: Vec<Line> = Vec::new();
    for (i, field) in login.fields.iter().enumerate() {
        let shown = if field.secret {
            "•".repeat(field.value.chars().count())
        } else {
            field.value.clone()
        };
        let cursor = if i == login.focus { "> " } else { "  " };
        let style = if i == login.focus { Style::new().fg(Color::Cyan) } else { Style::new() };
        lines.push(Line::from(vec![
            Span::styled(format!("{cursor}{}: ", field.label), style),
            Span::raw(shown),
        ]));
    }
    lines.push(Line::styled("Enter — отправить · Esc — отмена", muted()));
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_toast(f: &mut Frame, app: &App, area: Rect) {
    let Some((text, at)) = app.toast.as_ref() else { return };
    if at.elapsed() > TOAST_TTL {
        return;
    }
    let w = (text.chars().count() as u16 + 4).clamp(4, area.width.max(4));
    let rect = Rect::new(
        area.width.saturating_sub(w).saturating_sub(1),
        area.height.saturating_sub(4),
        w,
        3,
    )
    .intersection(area);
    f.render_widget(Clear, rect);
    let block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded);
    f.render_widget(Paragraph::new(text.as_str()).block(block), rect);
}

fn centered(width: u16, height: u16, area: Rect) -> Rect {
    let v = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(height),
        Constraint::Fill(1),
    ])
    .split(area);
    Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(width),
        Constraint::Fill(1),
    ])
    .split(v[1])[1]
}

/// Прямоугольник пикера аккаунта.
pub fn account_picker_area(area: Rect) -> Rect {
    centered(46, 8, area)
}

fn draw_account_picker(f: &mut Frame, app: &App, area: Rect) {
    let rect = account_picker_area(area);
    f.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(Color::Cyan))
        .title(" Аккаунт от лица которого пишете ");
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let accounts = app.account_picker_open_accounts();
    let mut lines: Vec<Line> = Vec::new();
    for (i, acc) in accounts.iter().enumerate() {
        let sel = i == app.account_picker_sel();
        let cur = if sel { "> " } else { "  " };
        let (chip, _) = avatar_chip(acc.avatar.as_ref(), &acc.name);
        let mut line = Line::from(vec![
            chip,
            Span::raw(format!(" {cur}{}", acc.name)),
            Span::styled(
                if acc.active { "  · активный" } else { "" }.to_string(),
                Style::new().fg(Color::Green),
            ),
        ]);
        if sel {
            line = line.style(Style::new().bg(Color::DarkGray));
        }
        lines.push(line);
    }
    if accounts.is_empty() {
        lines.push(Line::styled("нет аккаунтов", muted()));
    }
    lines.push(Line::styled(
        "Enter — выбрать (для всех чатов профиля) · Esc — отмена",
        muted(),
    ));
    f.render_widget(Paragraph::new(lines), inner);
}

// ---------- каталог доверия ----------

/// Прямоугольник окна фактов.
pub fn facts_area(area: Rect) -> Rect {
    let h = (area.height * 7 / 10).clamp(7, area.height.max(7));
    let w = (area.width * 7 / 10).clamp(44, area.width.max(44));
    centered(w, h, area)
}

/// Прямоугольник менеджера модулей (для хит-теста мыши).
pub fn modules_area(area: Rect) -> Rect {
    let h = (area.height * 8 / 10).clamp(8, area.height.max(8));
    let w = 88.min(area.width.saturating_sub(2)).max(28);
    centered(w, h, area)
}

fn color_of(c: RatingColor) -> Color {
    match c {
        RatingColor::Green => Color::Green,
        RatingColor::Yellow => Color::Yellow,
        RatingColor::Red => Color::Red,
    }
}

fn draw_modules(f: &mut Frame, app: &App, area: Rect) {
    let rect = modules_area(area);
    f.render_widget(Clear, rect);
    let title = match app.modules_screen_name() {
        "add" => " Добавить модуль ".to_string(),
        _ => " Модули · Enter — факты рейтинга · m/Esc закрыть ".to_string(),
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(title);
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines: Vec<Line> = Vec::new();
    for (i, row) in app.mgr_rows_ref().iter().enumerate() {
        let selected = i == app.modules_sel();
        let cur = if selected { "> " } else { "  " };
        let mut spans: Vec<Span> = Vec::new();
        match row {
            MgrRow::Header(t) => {
                spans.push(Span::styled(t.clone(), Style::new().add_modifier(Modifier::BOLD)));
            }
            MgrRow::Installed { text, color, profiles, .. } => {
                spans.push(Span::styled("●", Style::new().fg(color_of(*color)).add_modifier(Modifier::BOLD)));
                spans.push(Span::raw(format!(" {cur}{text}")));
                spans.push(Span::styled(format!("  профилей: {profiles}"), muted()));
            }
            MgrRow::Add => {
                spans.push(Span::styled(
                    format!("{cur}+ Добавить модуль"),
                    Style::new().fg(Color::Cyan),
                ));
            }
            MgrRow::Base { text, installed, .. } => {
                if *installed {
                    spans.push(Span::styled(format!("{cur}{text}  — установлен"), muted()));
                } else {
                    spans.push(Span::raw(format!("{cur}{text}")));
                }
            }
            MgrRow::UrlInput => {
                spans.push(Span::styled(
                    format!("{cur}Добавить по ссылке (git)…"),
                    Style::new().fg(Color::Cyan),
                ));
            }
            MgrRow::Busy => {
                spans.push(Span::styled(format!("{cur}установка выполняется…"), muted()));
            }
            MgrRow::Back => {
                spans.push(Span::raw(format!("{cur}← Назад")));
            }
        }
        let mut line = Line::from(spans);
        if selected {
            line = line.style(Style::new().bg(Color::DarkGray));
        }
        lines.push(line);
    }
    if let Some(url) = app.mgr_url_ref() {
        lines.push(Line::from(vec![
            Span::styled("URL: ", Style::new().fg(Color::Cyan)),
            Span::raw(format!("{url}▌")),
            Span::styled("  (Enter — установить · Esc — отмена)", muted()),
        ]));
    }
    lines.push(Line::styled(
        "установка = git clone + cargo build --release; модуль — нативный код, ставьте только доверенное",
        muted(),
    ));
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_facts(f: &mut Frame, app: &App, area: Rect, index: usize) {
    let Some(r) = app.trust.get(index) else { return };
    let rect = facts_area(area);
    f.render_widget(Clear, rect);
    let c = color_of(r.color);
    let badges = if r.badges.is_empty() {
        String::new()
    } else {
        format!(" · {}", r.badges.join(" · "))
    };
    let party = if r.first_party { "первая сторона MSHH" } else { "сторонний модуль" };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(c))
        .title(format!(" {}: {:+} → {} ({party}){badges} ", r.module_id, r.score, r.color.label()));
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::styled(
        "Факты рейтинга (сумма баллов):",
        Style::new().add_modifier(Modifier::BOLD),
    ));
    for fact in &r.facts {
        let sign = if fact.points >= 0 {
            format!("+{}", fact.points)
        } else {
            format!("{}", fact.points)
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("{sign:>3} "),
                Style::new().fg(color_of_points(fact.points)).add_modifier(Modifier::BOLD),
            ),
            Span::raw(fact.text.clone()),
        ]));
    }
    lines.push(Line::styled("Esc — назад · PgUp/PgDn — прокрутка", muted()));
    let start = (app.trust_scroll as usize).min(lines.len().saturating_sub(1));
    f.render_widget(Paragraph::new(lines[start..].to_vec()), inner);
}

/// Прямоугольник окна настроек (для хит-теста мыши).
pub fn settings_area(area: Rect) -> Rect {
    let h = (area.height * 7 / 10).clamp(10, area.height.max(10));
    let w = 80.min(area.width.saturating_sub(2)).max(30);
    centered(w, h, area)
}

fn draw_settings(f: &mut Frame, app: &App, area: Rect) {
    let rect = settings_area(area);
    f.render_widget(Clear, rect);
    let title = match app.settings_screen_name() {
        "main" => " Настройки · s/Esc закрыть · Enter — изменить ".to_string(),
        "add" => " Новый профиль: выберите модуль ".to_string(),
        "groups" => " Группы чатов ".to_string(),
        "group-rules" => " Группа: правила ".to_string(),
        "rule-kind" => " Какое правило добавить ".to_string(),
        "rule-type" => " Тип чата ".to_string(),
        "rule-module" => " Модуль ".to_string(),
        "rule-trust" => " Уровень доверия ".to_string(),
        "rule-chat" => " Выберите чат ".to_string(),
        _ => match app.profiles.get(app.settings_profile_idx()) {
            Some(p) => format!(" Профиль: {} ({}) ", p.name, p.module),
            None => " Профиль ".to_string(),
        },
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(Color::Cyan))
        .title(title);
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines: Vec<Line> = Vec::new();
    for (i, row) in app.settings_rows_ref().iter().enumerate() {
        let selected = i == app.settings_sel();
        let cur = if selected { "> " } else { "  " };
        let mut spans: Vec<Span> = Vec::new();
        match row {
            SettingsRow::Header(t) => {
                spans.push(Span::styled(t.clone(), Style::new().add_modifier(Modifier::BOLD)));
            }
            SettingsRow::Toggle { label, value, .. } => {
                spans.push(Span::raw(format!("{cur}{label} ")));
                spans.push(Span::styled(
                    if *value { "вкл" } else { "выкл" }.to_string(),
                    Style::new().fg(if *value { Color::Green } else { Color::DarkGray }),
                ));
            }
            SettingsRow::Profile { text, enabled, .. } => {
                spans.push(Span::raw(format!("{cur}{text} ")));
                spans.push(Span::styled(
                    if *enabled { "вкл" } else { "выкл" }.to_string(),
                    Style::new().fg(if *enabled { Color::Green } else { Color::DarkGray }),
                ));
            }
            SettingsRow::AddProfile => {
                spans.push(Span::styled(
                    format!("{cur}+ Добавить профиль"),
                    Style::new().fg(Color::Cyan),
                ));
            }
            SettingsRow::ModulePick { text, .. } => {
                spans.push(Span::raw(format!("{cur}{text}")));
            }
            SettingsRow::Back => {
                spans.push(Span::raw(format!("{cur}← Назад")));
            }
            SettingsRow::Rename => {
                spans.push(Span::raw(format!("{cur}Имя — изменить (Enter)")));
            }
            SettingsRow::Enable { enabled } => {
                spans.push(Span::raw(format!("{cur}Включён ")));
                spans.push(Span::styled(
                    if *enabled { "вкл" } else { "выкл" }.to_string(),
                    Style::new().fg(if *enabled { Color::Green } else { Color::DarkGray }),
                ));
            }
            SettingsRow::ModuleSetting { field: _, label, value, secret } => {
                let shown = if *secret { "•".repeat(value.chars().count()) } else { value.clone() };
                spans.push(Span::raw(format!("{cur}{label} ")));
                spans.push(Span::styled(
                    if shown.is_empty() { "(не задано)".to_string() } else { shown },
                    muted(),
                ));
            }
            SettingsRow::Restart => {
                spans.push(Span::raw(format!("{cur}Перезапустить профиль")));
            }
            SettingsRow::Delete { armed } => {
                let label = if *armed {
                    "Удалить профиль — Enter ЕЩЁ РАЗ для подтверждения!"
                } else {
                    "Удалить профиль"
                };
                spans.push(Span::styled(
                    format!("{cur}{label}"),
                    Style::new().fg(Color::Red),
                ));
            }
            SettingsRow::OpenModules => {
                spans.push(Span::styled(
                    format!("{cur}Модули и доверие (то же меню, что и на m)…"),
                    Style::new().fg(Color::Cyan),
                ));
            }
            SettingsRow::Group { text, .. } => {
                spans.push(Span::raw(format!("{cur}{text}")));
            }
            SettingsRow::AddGroup => {
                spans.push(Span::styled(
                    format!("{cur}+ Добавить группу"),
                    Style::new().fg(Color::Cyan),
                ));
            }
            SettingsRow::Rule { text, .. } => {
                spans.push(Span::raw(format!("{cur}{text} ")));
                spans.push(Span::styled("— Enter удалить", muted()));
            }
            SettingsRow::AddRule { .. } => {
                spans.push(Span::styled(
                    format!("{cur}+ Добавить правило"),
                    Style::new().fg(Color::Cyan),
                ));
            }
            SettingsRow::DeleteGroup { armed } => {
                let label = if *armed {
                    "Удалить группу — Enter ЕЩЁ РАЗ для подтверждения!"
                } else {
                    "Удалить группу"
                };
                spans.push(Span::styled(
                    format!("{cur}{label}"),
                    Style::new().fg(Color::Red),
                ));
            }
        }
        let mut line = Line::from(spans);
        if selected {
            line = line.style(Style::new().bg(Color::DarkGray));
        }
        lines.push(line);
    }
    if let Some(input) = app.settings_input_ref() {
        lines.push(Line::from(vec![
            Span::styled(format!("{}: ", input.label), Style::new().fg(Color::Cyan)),
            Span::raw(format!("{}▌", input.buffer)),
            Span::styled("  (Enter — сохранить · Esc — отмена)", muted()),
        ]));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn color_of_points(points: i32) -> Color {
    if points >= 0 {
        Color::Green
    } else {
        Color::Red
    }
}
