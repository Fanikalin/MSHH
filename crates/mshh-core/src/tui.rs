//! Инициализация/восстановление терминала + panic-хук.

use crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::sync::OnceLock;

pub type Tui = Terminal<CrosstermBackend<std::io::Stdout>>;

static PICKER: OnceLock<std::sync::Mutex<ratatui_image::picker::Picker>> = OnceLock::new();

/// Детектор графического протокола терминала (kitty/sixel/iTerm2/halfblocks).
/// Запрос делает ДО запуска потока ввода, чтобы ответ терминала не съели
/// события клавиатуры. Нет ответа — halfblocks с приблизительным размером
/// ячейки.
pub fn init_picker() {
    match ratatui_image::picker::Picker::from_termios() {
        Ok(p) => {
            let _ = PICKER.set(std::sync::Mutex::new(p));
        }
        Err(_) => {
            // halfblocks с примерным размером ячейки.
            let mut p = ratatui_image::picker::Picker::new((8, 13));
            p.protocol_type = ratatui_image::picker::ProtocolType::Halfblocks;
            let _ = PICKER.set(std::sync::Mutex::new(p));
        }
    }
}

/// Доступ к пикеру (new_protocol требует &mut).
pub fn with_picker<R>(f: impl FnOnce(&mut ratatui_image::picker::Picker) -> R) -> Option<R> {
    let lock = PICKER.get()?;
    let mut p = lock.lock().ok()?;
    Some(f(&mut p))
}

/// Терминал понимает kitty graphics (в т.ч. анимацию GIF)?
pub fn is_kitty() -> bool {
    with_picker(|p| p.protocol_type == ratatui_image::picker::ProtocolType::Kitty).unwrap_or(false)
}

pub fn init() -> std::io::Result<Tui> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    // Паника не должна оставлять терминал в raw/альтернативном экране.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        hook(info);
    }));
    Terminal::new(CrosstermBackend::new(stdout))
}

pub fn restore() {
    let _ = disable_raw_mode();
    let _ = execute!(std::io::stdout(), LeaveAlternateScreen, DisableMouseCapture);
}
