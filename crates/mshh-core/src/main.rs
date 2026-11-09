//! Точка входа `mshh`.

use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;

use crossterm::event;
use mshh_module_api::model::{Ev, FieldDef};
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
    let install_tx = tx.clone();
    let mut runtime = Runtime::new(store.clone(), tx, paths.modules.clone());
    for e in runtime.load_available() {
        logger::warn("core", &e);
        eprintln!("mshh: {e}");
    }

    // Профили: миграция первого запуска — по профилю на каждый модуль.
    let mut profiles = store.profiles().unwrap_or_default();
    if profiles.is_empty() && !runtime.loaded_ids().is_empty() {
        for id in runtime.loaded_ids() {
            let name = runtime
                .libs()
                .get(&id)
                .map(|l| l.info.name.clone())
                .unwrap_or_else(|| id.clone());
            match store.profile_add(&id, &name) {
                Ok(p) => profiles.push(p),
                Err(e) => logger::warn("core", &format!("профиль {id}: {e}")),
            }
        }
    }
    // Запуск включённых профилей.
    for p in &profiles {
        if p.enabled {
            if let Err(e) = runtime.start_profile(&p.id, &p.module, &settings_json(&store, &p.id)) {
                logger::error("core", &e);
                eprintln!("mshh: {e}");
            }
        }
    }

    if args.headless {
        eprintln!(
            "mshh: headless, профилей: {} (модулей: {}); выход по Ctrl+C",
            profiles.iter().filter(|p| p.enabled).count(),
            runtime.libs().len()
        );
        for ev in rx {
            if let Event::Ui { profile, cmd } = ev {
                logger::info(&profile, &format!("{cmd:?}"));
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

    let mut app = App::new(profiles.iter().filter(|p| p.enabled).count(), runtime.libs().len());
    app.profiles = profiles;
    app.groups = store.groups().unwrap_or_default();
    app.module_schemas = runtime
        .libs()
        .iter()
        .map(|(k, v)| (k.clone(), v.settings.clone()))
        .collect::<HashMap<String, Vec<FieldDef>>>();
    app.available_modules = runtime.loaded_ids().into_iter().map(|id| {
        let name = runtime.libs().get(&id).map(|l| l.info.name.clone()).unwrap_or_else(|| id.clone());
        (id, name)
    }).collect();
    for p in &app.profiles {
        app.settings_values.insert(p.id.clone(), store.settings_all(&p.id).unwrap_or_default());
    }
    // Каталог доверия: вшитые записи + «неизвестные» для посторонних модулей.
    let mut trust = ratings::builtin();
    for id in runtime.loaded_ids() {
        if !trust.iter().any(|v| v.module_id == id) {
            let name = runtime.libs().get(&id).map(|l| l.info.name.clone()).unwrap_or_else(|| id.clone());
            trust.push(ratings::unknown(&id, &name));
        }
    }
    app.trust = trust;
    refresh_installed(&mut app, &runtime);
    // Настройки отображения.
    for (key, _) in mshh_core::app::DisplaySettings::KEYS {
        if let Some(v) = store.app_get(key) {
            app.display.set(key, v != "0");
        }
    }

    let install_ctx = InstallCtx {
        tx: install_tx,
        work: paths.data.join("modules-src"),
        dest: paths.data.join("modules"),
    };

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
                        runtime.send_to_profile(&action.profile, action.ev);
                    }
                }
                Event::Ui { profile, cmd } => app.apply_ui(&profile, cmd),
                Event::Install { message, result } => match result {
                    None => {
                        if !message.is_empty() {
                            app.toast_now(message);
                        }
                    }
                    Some(Ok(so)) => {
                        app.mgr_busy = false;
                        match runtime.load_file(std::path::Path::new(&so)) {
                            Ok(info) => {
                                match store.profile_add(&info.id, &info.name) {
                                    Ok(p) => {
                                        app.settings_values.insert(
                                            p.id.clone(),
                                            store.settings_all(&p.id).unwrap_or_default(),
                                        );
                                        if let Err(e) = runtime.start_profile(
                                            &p.id,
                                            &p.module,
                                            &settings_json(&store, &p.id),
                                        ) {
                                            app.toast_now(format!("{e}"));
                                        }
                                        app.profiles.push(p);
                                        app.profile_count =
                                            app.profiles.iter().filter(|p| p.enabled).count();
                                    }
                                    Err(e) => app.toast_now(format!("профиль: {e}")),
                                }
                                refresh_installed(&mut app, &runtime);
                                app.on_modules_changed();
                                app.on_profiles_changed();
                                app.toast_now(format!("модуль {} установлен", info.id));
                            }
                            Err(e) => app.toast_now(format!("загрузка: {e}")),
                        }
                    }
                    Some(Err(e)) => {
                        app.mgr_busy = false;
                        app.toast_now(format!("установка не удалась: {e}"));
                    }
                },
            }
        }
        // Команды из настроек и менеджера.
        let cmds: Vec<mshh_core::app::CoreCmd> = app.core_cmds.drain(..).collect();
        for cmd in cmds {
            handle_core_cmd(&mut app, &mut runtime, &store, &install_ctx, cmd);
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

/// Контекст установки модулей из менеджера.
struct InstallCtx {
    tx: mpsc::Sender<Event>,
    work: std::path::PathBuf,
    dest: std::path::PathBuf,
}

/// Установленные модули для менеджера: из рантайма + рейтинги из каталога.
fn refresh_installed(app: &mut App, runtime: &Runtime) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for p in &app.profiles {
        *counts.entry(p.module.clone()).or_default() += 1;
    }
    let mut list: Vec<mshh_core::app::InstalledView> = runtime
        .libs()
        .values()
        .map(|l| {
            let hit = app
                .trust
                .iter()
                .enumerate()
                .find(|(_, v)| v.module_id == l.info.id)
                .map(|(i, v)| (i, v.color));
            mshh_core::app::InstalledView {
                id: l.info.id.clone(),
                name: l.info.name.clone(),
                version: l.info.version.clone(),
                profiles: counts.get(&l.info.id).copied().unwrap_or(0),
                color: hit.map(|(_, c)| c).unwrap_or(mshh_core::ratings::RatingColor::Red),
                rating_idx: hit.map(|(i, _)| i),
            }
        })
        .collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    app.installed_modules = list;
}

fn spawn_install(ctx: &InstallCtx, url: String, subdir: Option<String>) {
    let tx = ctx.tx.clone();
    let work = ctx.work.clone();
    let dest = ctx.dest.clone();
    let _ = std::thread::Builder::new()
        .name("mshh-install".into())
        .spawn(move || {
            let progress = |m: String| {
                let _ = tx.send(Event::Install { message: m, result: None });
            };
            let res = mshh_core::installer::install_from_url(
                &url,
                subdir.as_deref(),
                &work,
                &dest,
                &|m: String| progress(m.clone()),
            );
            let _ = tx.send(Event::Install {
                message: if res.is_ok() { "установка завершена".into() } else { String::new() },
                result: Some(res.map(|p| p.to_string_lossy().into_owned())),
            });
        });
}

fn settings_json(store: &Store, profile: &str) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (k, v) in store.settings_all(profile).unwrap_or_default() {
        map.insert(k, serde_json::json!(v));
    }
    serde_json::Value::Object(map)
}

fn handle_core_cmd(
    app: &mut App,
    runtime: &mut Runtime,
    store: &Store,
    install: &InstallCtx,
    cmd: mshh_core::app::CoreCmd,
) {
    use mshh_core::app::CoreCmd;
    match cmd {
        CoreCmd::SetDisplay { key, value } => {
            store.app_set(key, if value { "1" } else { "0" });
        }
        CoreCmd::CreateProfile { module, name } => match store.profile_add(&module, &name) {
            Ok(p) => {
                let values = store.settings_all(&p.id).unwrap_or_default();
                app.settings_values.insert(p.id.clone(), values);
                if p.enabled {
                    if let Err(e) = runtime.start_profile(&p.id, &p.module, &settings_json(store, &p.id)) {
                        app.toast_now(format!("{e}"));
                    }
                }
                app.profiles.push(p);
                app.profile_count = app.profiles.iter().filter(|p| p.enabled).count();
                app.on_profiles_changed();
            }
            Err(e) => app.toast_now(format!("не удалось создать профиль: {e}")),
        },
        CoreCmd::RenameProfile { profile, name } => {
            if let Err(e) = store.profile_rename(&profile, &name) {
                app.toast_now(format!("{e}"));
                return;
            }
            if let Some(p) = app.profiles.iter_mut().find(|p| p.id == profile) {
                p.name = name;
            }
            app.on_profiles_changed();
        }
        CoreCmd::SetProfileEnabled { profile, enabled } => {
            if let Err(e) = store.profile_set_enabled(&profile, enabled) {
                app.toast_now(format!("{e}"));
                return;
            }
            if let Some(p) = app.profiles.iter_mut().find(|p| p.id == profile) {
                p.enabled = enabled;
            }
            if enabled {
                let (module, sj) = match app.profiles.iter().find(|p| p.id == profile) {
                    Some(p) => (p.module.clone(), settings_json(store, &profile)),
                    None => return,
                };
                if let Err(e) = runtime.start_profile(&profile, &module, &sj) {
                    app.toast_now(format!("{e}"));
                }
            } else {
                runtime.stop_profile(&profile, Duration::from_secs(2));
            }
            app.profile_count = app.profiles.iter().filter(|p| p.enabled).count();
            app.on_profiles_changed();
        }
        CoreCmd::DeleteProfile { profile } => {
            runtime.stop_profile(&profile, Duration::from_secs(2));
            if let Err(e) = store.profile_delete(&profile) {
                app.toast_now(format!("{e}"));
                return;
            }
            app.profiles.retain(|p| p.id != profile);
            app.settings_values.remove(&profile);
            app.profile_count = app.profiles.iter().filter(|p| p.enabled).count();
            app.on_profiles_changed();
            app.toast_now("профиль удалён");
        }
        CoreCmd::SaveSetting { profile, key, value } => {
            if let Err(e) = store.setting_set(&profile, &key, &value) {
                app.toast_now(format!("{e}"));
                return;
            }
            if let Some(v) = app.settings_values.get_mut(&profile) {
                match v.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = value.clone(),
                    None => v.push((key.clone(), value.clone())),
                }
            }
            runtime.send_to_profile(&profile, Ev::Settings { values: settings_json(store, &profile) });
            app.toast_now("настройка сохранена");
        }
        CoreCmd::RestartProfile { profile } => {
            let (module, sj) = match app.profiles.iter().find(|p| p.id == profile) {
                Some(p) => (p.module.clone(), settings_json(store, &profile)),
                None => return,
            };
            runtime.restart_profile(&profile, &module, &sj, Duration::from_secs(2));
        }
        CoreCmd::InstallBase { idx } => {
            match mshh_core::installer::BASE_MODULES.get(idx) {
                Some(b) => spawn_install(install, b.url.to_string(), Some(b.subdir.to_string())),
                None => app.toast_now("нет такого базового модуля"),
            }
        }
        CoreCmd::InstallUrl { url } => {
            spawn_install(install, url, None);
        }
        CoreCmd::AddGroup { name } => match store.group_add(&name) {
            Ok(g) => {
                app.groups.push(g);
                app.on_groups_changed();
            }
            Err(e) => app.toast_now(format!("не удалось создать группу: {e}")),
        },
        CoreCmd::DeleteGroup { id } => {
            if let Err(e) = store.group_delete(&id) {
                app.toast_now(format!("{e}"));
                return;
            }
            app.groups.retain(|g| g.id != id);
            if app.active_group.as_deref() == Some(&id) {
                app.active_group = None;
            }
            app.on_groups_changed();
            app.toast_now("группа удалена");
        }
        CoreCmd::AddGroupRule { group, rule } => {
            if let Err(e) = store.group_rule_add(&group, &rule) {
                app.toast_now(format!("{e}"));
                return;
            }
            if let Some(g) = app.groups.iter_mut().find(|g| g.id == group) {
                if !g.rules.contains(&rule) {
                    g.rules.push(rule);
                }
            }
            app.on_groups_changed();
        }
        CoreCmd::RemoveGroupRule { group, rule } => {
            if let Err(e) = store.group_rule_remove(&group, &rule) {
                app.toast_now(format!("{e}"));
                return;
            }
            if let Some(g) = app.groups.iter_mut().find(|g| g.id == group) {
                g.rules.retain(|r| r != &rule);
            }
            app.on_groups_changed();
        }
        CoreCmd::SearchQuery { query } => {
            use mshh_module_api::model::actions;
            for p in &app.profiles {
                if !p.enabled {
                    continue;
                }
                runtime.send_to_profile(
                    &p.id,
                    Ev::UiAction {
                        action: actions::SEARCH_QUERY.into(),
                        chat_id: None,
                        payload: serde_json::json!({ "query": query }),
                    },
                );
            }
        }
    }
}
