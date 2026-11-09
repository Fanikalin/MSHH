//! SDK для авторов модулей MSHH.
//!
//! Модуль — это `cdylib`, которая загружается ядром через `libloading`.
//! Автор реализует трейт [`register::Module`] и вызывает макрос
//! [`register_module!`] в корне крейта — он генерирует все экспорты ABI.

pub mod abi;
pub mod model;
pub mod register;
pub mod session;

pub mod prelude {
    pub use crate::abi::log_level;
    pub use crate::model::{
        actions, AccountView, Body, ChatView, Ev, FieldDef, MessageView, Row, SqlValue, UiCmd,
    };
    pub use crate::register::{Module, Instance};
    pub use crate::register_module;
    pub use crate::session::Session;
    pub use serde_json;
}
