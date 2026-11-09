//! Ядро MSHH: загрузка модулей, хранилище, TUI-оболочка.
//! Ядро не знает ни одного протокола — всё поведение приносят модули.

pub mod app;
pub mod args;
pub mod dirs;
pub mod events;
pub mod loader;
pub mod logger;
pub mod ratings;
pub mod render;
pub mod runtime;
pub mod store;
pub mod tui;
