//! TUI-рендерер (ratatui): единственный модуль ядра, знающий про рисование.
//! GUI-рендерер (будущий) будет получать то же состояние `App`.

use mshh_module_api::model::{Body, MessageView};
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::app::{App, Focus, TOAST_TTL};

fn muted() -> Style {
    Style::new().fg(Color::DarkGray)
}

pub fn draw(f: &mut Frame, app: &App) {
    let area = f.area();
    let cols = Layout::horizontal([Constraint::Percentage(30), Constraint::Fill(1)]).split(area);

    draw_sidebar(f, app, cols[0]);
    let right = Layout::vertical([
        Constraint::Fill(1),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .split(cols[1]);
    draw_messages(f, app, right[0]);
    draw_composer(f, app, right[1]);
    draw_status(f, app, right[2]);

    if app.login.is_some() {
        draw_login(f, app, area);
    }
    draw_toast(f, app, area);
}

fn draw_sidebar(f: &mut Frame, app: &App, area: Rect) {
    let acc_h = (app.accounts.len() as u16).clamp(1, 6) + 2;
    let rows = Layout::vertical([Constraint::Length(acc_h), Constraint::Fill(1)]).split(area);

    let acc_items: Vec<ListItem> = app
        .accounts
        .iter()
        .map(|a| {
            ListItem::new(Line::from(vec![
                Span::styled(a.name.clone(), Style::new().add_modifier(Modifier::BOLD)),
                Span::raw(" "),
                Span::styled(a.status.clone(), muted()),
            ]))
        })
        .collect();
    let acc_list = List::new(acc_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .title(" Аккаунты "),
    );
    f.render_widget(acc_list, rows[0]);

    let chat_items: Vec<ListItem> = app
        .chats
        .iter()
        .map(|c| {
            let mut spans = Vec::new();
            if c.unread > 0 {
                spans.push(Span::styled(c.title.clone(), Style::new().add_modifier(Modifier::BOLD)));
                spans.push(Span::styled(
                    format!(" [{}]", c.unread),
                    Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                ));
            } else {
                spans.push(Span::raw(c.title.clone()));
            }
            if let Some(sub) = &c.subtitle {
                spans.push(Span::styled(format!(" — {sub}"), muted()));
            }
            let mut item = ListItem::new(Line::from(spans));
            if app.selected.as_deref() == Some(c.id.as_str()) && app.focus == Focus::Chats {
                item = item.style(Style::new().bg(Color::DarkGray));
            }
            item
        })
        .collect();
    let chat_items = if chat_items.is_empty() {
        vec![ListItem::new(Line::styled("нет чатов", muted()))]
    } else {
        chat_items
    };
    let chat_list = List::new(chat_items).block(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .title(" Чаты "),
    );
    f.render_widget(chat_list, rows[1]);
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
            lines.extend(msgs.iter().map(msg_line));
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

fn msg_line(m: &MessageView) -> Line<'static> {
    let time = chrono::DateTime::from_timestamp_millis(m.ts_ms as i64)
        .map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default();
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

fn draw_composer(f: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == Focus::Composer && app.login.is_none();
    let border = if focused { Style::new().fg(Color::Cyan) } else { muted() };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border)
        .title(" Сообщение (Enter — отправить) ");
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(app.composer.as_str()), inner);
    if focused {
        let x = inner.x + app.composer.chars().count() as u16;
        f.set_cursor_position(Position::new(x.min(inner.right().saturating_sub(1)), inner.y));
    }
}

fn draw_status(f: &mut Frame, app: &App, area: Rect) {
    let hint = "Ctrl+Q выход · Tab фокус · Enter открыть/отправить · PgUp/PgDn история";
    let line = Line::from(vec![
        Span::styled(hint, muted()),
        Span::raw("  "),
        Span::styled(format!("модулей: {}", app.module_count), muted()),
    ]);
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
