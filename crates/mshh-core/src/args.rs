use std::path::PathBuf;

#[derive(Debug, Default)]
pub struct Args {
    pub modules_dir: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub state_dir: Option<PathBuf>,
    pub list: bool,
    pub headless: bool,
    pub verbose: bool,
}

const HELP: &str = "\
mshh — мессенджер здорового человека: ядро без протоколов.

Использование: mshh [флаги]

  --list                 показать найденные модули и выйти
  --headless             без TUI: загрузить модули и работать до сигнала
  --verbose              дублировать журнал в stderr
  --modules-dir <путь>   каталог модулей (по умолчанию data/modules и ./modules)
  --data-dir <путь>      каталог данных (по умолчанию XDG_DATA_HOME + /mshh)
  --state-dir <путь>     каталог состояния (по умолчанию XDG_STATE_HOME + /mshh)
  -h, --help             эта справка";

pub fn parse() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1).collect::<Vec<_>>().into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--list" => a.list = true,
            "--headless" => a.headless = true,
            "--verbose" => a.verbose = true,
            "--modules-dir" => a.modules_dir = Some(next_value(&mut it, "--modules-dir")),
            "--data-dir" => a.data_dir = Some(next_value(&mut it, "--data-dir")),
            "--state-dir" => a.state_dir = Some(next_value(&mut it, "--state-dir")),
            "-h" | "--help" => {
                println!("{HELP}");
                std::process::exit(0);
            }
            other => {
                eprintln!("mshh: неизвестный аргумент: {other}\n\n{HELP}");
                std::process::exit(2);
            }
        }
    }
    a
}

fn next_value(it: &mut std::vec::IntoIter<String>, flag: &str) -> PathBuf {
    match it.next() {
        Some(v) if !v.starts_with("--") => PathBuf::from(v),
        _ => {
            eprintln!("mshh: {flag} требует путь");
            std::process::exit(2);
        }
    }
}
