//! Runtime: экземпляры модулей и host-vtable (сервисы ядра для модулей).
//!
//! Владение: `Arc<HostState>` принадлежит `ModuleInstance` и освобождается
//! после `destroy`. Если модуль не завершился по таймауту, его `Arc` явно
//! переезжает в graveyard runtime'а — висячих указателей не возникает,
//! потому что `Session` не `Send` и не может пережить поток `run`.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::unbounded;
use mshh_module_api::abi::{rc, MshhBuf, MshhHostVTable, MshhStr, ABI_VERSION};
use mshh_module_api::model::{Ev, SqlValue, UiCmd};
use serde_json::to_string;

use crate::events::Event;
use crate::loader::{load_all, ModuleInfoOwned, ModuleLib};
use crate::logger;
use crate::store::Store;

/// Контекст экземпляра: то, что ядро передаёт модулю как `ctx`.
struct HostCtx {
    module_id: String,
    tx: Sender<Event>,
    store: Arc<Store>,
}

/// Первое поле — vtable: `*const HostState` приводится к `*const MshhHostVTable`,
/// а `vtable.ctx` указывает на сам `HostState` (единый пойнтер, без арифметики).
#[repr(C)]
pub(crate) struct HostState {
    vtable: MshhHostVTable,
    ctx: HostCtx,
}

pub struct ModuleInstance {
    pub info: ModuleInfoOwned,
    lib: ModuleLib,
    handle: *mut c_void,
    host: Arc<HostState>,
    done_rx: crossbeam_channel::Receiver<()>,
    done_tx: crossbeam_channel::Sender<()>,
    running: bool,
}

/// Сырой handle экземпляра модуля. Send-обёртка только для передачи в поток
/// `run`: владелец — `ModuleInstance`, поток обязан завершиться до `destroy`.
#[repr(transparent)]
struct RawHandle(*mut c_void);
unsafe impl Send for RawHandle {}

/// Тело потока модуля. Обычная функция: замыкание в `start` передаёт
/// аргументы по значению целиком, disjoint-capture не затрагивает поля.
fn run_thread(run: crate::loader::RunFn, handle: RawHandle, done: crossbeam_channel::Sender<()>) {
    let RawHandle(handle) = handle;
    // # Safety: handle жив до destroy; destroy — после wait в stop().
    unsafe { run(handle) };
    let _ = done.send(());
}

impl ModuleInstance {
    fn new(lib: ModuleLib, store: Arc<Store>, tx: Sender<Event>) -> Result<ModuleInstance, String> {
        let state = Arc::new(HostState {
            vtable: MshhHostVTable {
                abi_version: ABI_VERSION,
                ctx: std::ptr::null_mut(),
                log: h_log,
                send_ui: h_send_ui,
                storage_exec: h_storage_exec,
                kv_get: h_kv_get,
                kv_set: h_kv_set,
                now_ms: h_now_ms,
                free: h_free,
            },
            ctx: HostCtx { module_id: lib.info.id.clone(), tx, store },
        });
        let mut state = state;
        {
            let sptr = Arc::as_ptr(&state) as *mut HostState as *mut c_void;
            // Refcount == 1, get_mut всегда Some.
            Arc::get_mut(&mut state).expect("уникальный Arc").vtable.ctx = sptr;
        }
        let vptr = Arc::as_ptr(&state) as *const MshhHostVTable;

        // # Safety: vtable жива, пока Arc принадлежит экземпляру; контракт
        // start/destroy: модуль обращается к host только из потока run.
        let handle = unsafe { (lib.start)(vptr) };
        if handle.is_null() {
            return Err(format!(
                "mshh_module_start вернул null для «{}» (экземпляр уже активен?)",
                lib.info.id
            ));
        }
        let (done_tx, done_rx) = unbounded();
        Ok(ModuleInstance {
            info: lib.info.clone(),
            lib,
            handle,
            host: state,
            done_rx,
            done_tx,
            running: false,
        })
    }

    /// Запуск потока модуля (`mshh_module_run` блокирует его до Shutdown).
    pub fn start(&mut self) -> Result<(), String> {
        if self.running {
            return Ok(());
        }
        let (handle, run, done) = (RawHandle(self.handle), self.lib.run, self.done_tx.clone());
        let id = self.info.id.clone();
        std::thread::Builder::new()
            .name(format!("mshh-mod-{id}"))
            .spawn(move || run_thread(run, handle, done))
            .map_err(|e| e.to_string())?;
        self.running = true;
        Ok(())
    }

    /// Отправить событие в очередь модуля (потокобезопасно, не блокирует).
    pub fn send(&self, ev: &Ev) -> bool {
        let Ok(json) = to_string(ev) else { return false };
        let s = MshhStr::from_str(&json);
        // # Safety: handle жив до destroy.
        unsafe { (self.lib.sink)(self.handle, s) == rc::OK }
    }

    /// Shutdown -> ожидание -> destroy. Возвращает `Some(host)`, если модуль
    /// не завершился: владелец обязан держать host живым (graveyard runtime'а).
    pub(crate) fn stop(&mut self, wait: Duration) -> Option<Arc<HostState>> {
        self.send(&Ev::Shutdown);
        let finished = if self.running {
            matches!(self.done_rx.recv_timeout(wait), Ok(()))
        } else {
            true
        };
        if finished {
            // # Safety: run() уже вернулся (или не запускался).
            unsafe { (self.lib.destroy)(self.handle) };
            self.handle = std::ptr::null_mut();
            self.running = false;
            None
        } else {
            logger::warn(
                "core",
                &format!("модуль «{}» не завершился за {wait:?} — экземпляр не уничтожен", self.info.id),
            );
            Some(Arc::clone(&self.host))
        }
    }
}

/// Все экземпляры + каталоги загрузки.
pub struct Runtime {
    store: Arc<Store>,
    tx: Sender<Event>,
    dirs: Vec<PathBuf>,
    instances: Vec<ModuleInstance>,
    /// Не завертившиеся модули: держим host живым до конца процесса.
    graveyard: Vec<Arc<HostState>>,
}

impl Runtime {
    pub fn new(store: Arc<Store>, tx: Sender<Event>, dirs: Vec<PathBuf>) -> Runtime {
        Runtime { store, tx, dirs, instances: Vec::new(), graveyard: Vec::new() }
    }

    /// Загрузить все модули из каталогов. Возвращает ошибки загрузки.
    pub fn load_available(&mut self) -> Vec<String> {
        let (libs, mut errors) = load_all(&self.dirs);
        for lib in libs {
            match ModuleInstance::new(lib, self.store.clone(), self.tx.clone()) {
                Ok(i) => self.instances.push(i),
                Err(e) => {
                    logger::warn("core", &e);
                    errors.push(e);
                }
            }
        }
        errors
    }

    /// Загрузить одну библиотеку (тесты, динамическая установка).
    pub fn load_file(&mut self, path: &Path) -> Result<(), String> {
        let lib = ModuleLib::load(path)?;
        if self.instances.iter().any(|i| i.info.id == lib.info.id) {
            return Err(format!("модуль «{}» уже загружен", lib.info.id));
        }
        let inst = ModuleInstance::new(lib, self.store.clone(), self.tx.clone())?;
        self.instances.push(inst);
        Ok(())
    }

    pub fn start_all(&mut self) {
        for i in &mut self.instances {
            if let Err(e) = i.start() {
                logger::error("core", &format!("запуск «{}»: {e}", i.info.id));
            }
        }
    }

    pub fn instances(&self) -> &[ModuleInstance] {
        &self.instances
    }

    pub fn instance(&self, id: &str) -> Option<&ModuleInstance> {
        self.instances.iter().find(|i| i.info.id == id)
    }

    pub fn send_action(&self, module_id: &str, ev: Ev) -> bool {
        match self.instance(module_id) {
            Some(i) => i.send(&ev),
            None => {
                logger::warn("core", &format!("модуль «{module_id}» не загружен"));
                false
            }
        }
    }

    pub fn shutdown(&mut self, wait: Duration) {
        for i in &mut self.instances {
            if let Some(host) = i.stop(wait) {
                self.graveyard.push(host);
            }
        }
        self.instances.clear();
    }
}

// ---------- host-функции vtable (все с catch_unwind) ----------

unsafe extern "C" fn h_log(ctx: *mut c_void, level: u32, tag: MshhStr, msg: MshhStr) {
    let _ = std::panic::catch_unwind(|| {
        // # Safety: ctx от ядра, валиден на время вызова.
        let st = unsafe { &*(ctx as *const HostState) };
        let (tag, msg) = unsafe { (tag.as_str(), msg.as_str()) };
        logger::write(level as u8, &format!("{}:{tag}", st.ctx.module_id), msg);
    });
}

unsafe extern "C" fn h_send_ui(ctx: *mut c_void, json: MshhStr) {
    let _ = std::panic::catch_unwind(|| {
        let st = unsafe { &*(ctx as *const HostState) };
        let s = unsafe { json.as_str() };
        match serde_json::from_str::<UiCmd>(s) {
            Ok(cmd) => {
                let _ = st.ctx.tx.send(Event::Ui { module: st.ctx.module_id.clone(), cmd });
            }
            Err(e) => logger::warn(&st.ctx.module_id, &format!("send_ui: некорректный JSON: {e}")),
        }
    });
}

unsafe extern "C" fn h_storage_exec(
    ctx: *mut c_void,
    sql: MshhStr,
    params_json: MshhStr,
    out: *mut MshhBuf,
) -> u32 {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let st = unsafe { &*(ctx as *const HostState) };
        let sql = unsafe { sql.as_str() };
        let params_json = unsafe { params_json.as_str() };
        let params: Vec<SqlValue> = match serde_json::from_str(params_json) {
            Ok(p) => p,
            Err(e) => {
                logger::warn(&st.ctx.module_id, &format!("storage_exec: параметры: {e}"));
                return rc::ERR;
            }
        };
        let rows = match st.ctx.store.exec(sql, &params) {
            Ok(rows) => rows,
            Err(e) => {
                logger::warn(&st.ctx.module_id, &format!("storage_exec: {e}"));
                return rc::ERR;
            }
        };
        let Ok(json) = to_string(&rows) else { return rc::ERR };
        unsafe { write_buf(&json, out) };
        rc::OK
    }));
    r.unwrap_or(rc::ERR)
}

unsafe extern "C" fn h_kv_get(ctx: *mut c_void, key: MshhStr, out: *mut MshhBuf) -> u32 {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let st = unsafe { &*(ctx as *const HostState) };
        let key = unsafe { key.as_str() };
        match st.ctx.store.kv_get(&st.ctx.module_id, key) {
            Ok(Some(v)) => {
                unsafe { write_buf(&v, out) };
                rc::OK
            }
            Ok(None) => rc::MISS,
            Err(e) => {
                logger::warn(&st.ctx.module_id, &format!("kv_get: {e}"));
                rc::ERR
            }
        }
    }));
    r.unwrap_or(rc::ERR)
}

unsafe extern "C" fn h_kv_set(ctx: *mut c_void, key: MshhStr, value: MshhStr) -> u32 {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let st = unsafe { &*(ctx as *const HostState) };
        let (key, value) = unsafe { (key.as_str(), value.as_str()) };
        match st.ctx.store.kv_set(&st.ctx.module_id, key, value) {
            Ok(()) => rc::OK,
            Err(e) => {
                logger::warn(&st.ctx.module_id, &format!("kv_set: {e}"));
                rc::ERR
            }
        }
    }));
    r.unwrap_or(rc::ERR)
}

unsafe extern "C" fn h_now_ms(_ctx: *mut c_void) -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

unsafe extern "C" fn h_free(ptr: *mut c_void) {
    if !ptr.is_null() {
        // # Safety: буфер выделен libc::malloc в write_buf.
        unsafe { libc::free(ptr) };
    }
}

/// # Safety: `out` — валидный указатель на MshhBuf модуля.
unsafe fn write_buf(data: &str, out: *mut MshhBuf) {
    let bytes = data.as_bytes();
    let buf = libc::malloc(bytes.len().max(1));
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, bytes.len());
    (*out).ptr = buf;
    (*out).len = bytes.len();
}
