//! Точка входа `mshh`.

use std::sync::mpsc;
use std::time::Duration;

use crossterm::event;
use mshh_core::{app::App, args, dirs, events::Event, loader, logger, ratings, render, runtime::Runtime, store::Store, tui};

fn main() -> std::process::ExitCode {
    let args = args::parse();
    let paths = dirs::resolve(&args);
    logger::init(&paths.log, args.verbose);

    if args.list {
        return loader::list(&paths.modules);
    }

    let store = match Store::open(&paths.db) {
        Ok(s) => std::sync::Arc::new(s),
        Err(e) => {
            eprintln!("mshh: не удалось открыть БД {}: {e}", paths.db.display());
            return std::process::ExitCode::FAILURE;
        }
    };

    let (tx, rx) = mpsc::channel::<Event>();
    let input_tx = tx.clone();
    let mut runtime = Runtime::new(store, tx, paths.modules.clone());
    for e in runtime.load_available() {
        logger::warn("core", &e);
        eprintln!("mshh: {e}");
    }
    runtime.start_all();

    if args.headless {
        eprintln!("mshh: headless, модулей: {}; выход по Ctrl+C", runtime.instances().len());
        for ev in rx {
            if let Event::Ui { module, cmd } = ev {
                logger::info(&module, &format!("{cmd:?}"));
            }
        }
        return std::process::ExitCode::SUCCESS;
    }

    // ---------- TUI ----------

    let mut terminal = match tui::init() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("mshh: не удалось инициализировать терминал: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    // Поток ввода: клавиатура/мышь -> канал ядра. Не join-им: процесс
    // завершается сразу после restore, чтение /dev/tty блокируется.
    let reader = std::thread::Builder::new()
        .name("mshh-input".into())
        .spawn(move || loop {
            match event::read() {
                Ok(ev) => {
                    if input_tx.send(Event::Input(ev)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        });

    let mut app = App::new(runtime.instances().len());
    // Вшитый каталог доверия; загруженные модули вне каталога — «неизвестные».
    let mut trust = ratings::builtin();
    for inst in runtime.instances() {
        match trust.iter_mut().find(|v| v.module_id == inst.info.id) {
            Some(v) => v.installed = true,
            None => trust.push(ratings::unknown(&inst.info.id, &inst.info.name)),
        }
    }
    app.trust = trust;
    loop {
        if let Ok(frame) = terminal.draw(|f| render::draw(f, &app)) {
            app.area = frame.area;
        }
        let first = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(ev) => Some(ev),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut batch = Vec::new();
        if let Some(ev) = first {
            batch.push(ev);
        }
        while let Ok(ev) = rx.try_recv() {
            batch.push(ev);
        }
        for ev in batch {
            match ev {
                Event::Input(ie) => {
                    if let Some(action) = app.on_input(&ie) {
                        runtime.send_action(&action.module, action.ev);
                    }
                }
                Event::Ui { module, cmd } => app.apply_ui(&module, cmd),
            }
        }
        if app.quit {
            break;
        }
    }

    runtime.shutdown(Duration::from_secs(2));
    tui::restore();
    drop(reader);
    std::process::ExitCode::SUCCESS
}
