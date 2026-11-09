use crossterm::event::Event as TermEvent;
use mshh_module_api::model::UiCmd;

/// Всё, что главный цикл ядра получает извне.
#[derive(Debug)]
pub enum Event {
    /// Ввод пользователя (клавиатура, мышь, resize).
    Input(TermEvent),
    /// Команда отображения от экземпляра модуля (профиль).
    Ui { profile: String, cmd: UiCmd },
    /// Установка модуля: прогресс и финальный результат.
    Install { message: String, result: Option<Result<String, String>> },
}
