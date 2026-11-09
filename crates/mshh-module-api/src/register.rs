//! Трейт модуля и генерация экспортов ABI (макрос [`register_module!`]).

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use crossbeam_channel::{unbounded, Receiver, Sender};

use crate::abi::{log_level, rc, MshhHostVTable, MshhStr};
use crate::model::Ev;
use crate::session::Session;

/// Модуль. `run` вызывается в выделенном потоке ядра и блокирует до
/// получения `Ev::Shutdown` (или закрытия канала).
pub trait Module: Send + Sync + 'static {
    fn run(&self, session: Session);
}

/// Состояние одного экземпляра модуля; живёт в куче, ядро владеет
/// сырым указателем между `mshh_module_start` и `mshh_module_destroy`.
pub struct Instance<M: Module> {
    pub module: M,
    pub tx: Sender<Ev>,
    /// Receiver забирается ровно один раз — в `mshh_module_run`.
    pub rx: std::sync::Mutex<Option<Receiver<Ev>>>,
    pub host: *const MshhHostVTable,
}

// # Safety: M: Send + Sync; raw-указатель host валиден по контракту ядра.
unsafe impl<M: Module> Send for Instance<M> {}
unsafe impl<M: Module> Sync for Instance<M> {}

fn lock<'a, T>(m: &'a std::sync::Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Тело `mshh_module_start`.
///
/// # Safety
/// `host` должен быть валидным указателем от ядра.
pub unsafe fn start<M: Module + Default>(
    active: &AtomicBool,
    host: *const MshhHostVTable,
) -> *mut c_void {
    // Одна загруженная библиотека — один активный экземпляр.
    if host.is_null() || active.swap(true, Ordering::SeqCst) {
        return std::ptr::null_mut();
    }
    let (tx, rx) = unbounded::<Ev>();
    let inst = Box::new(Instance::<M> {
        module: M::default(),
        tx,
        rx: std::sync::Mutex::new(Some(rx)),
        host,
    });
    Box::into_raw(inst) as *mut c_void
}

/// Тело `mshh_module_run`: блокирует поток до завершения модуля.
///
/// # Safety
/// `handle` — указатель, вернувшийся из `start::<M>`.
pub unsafe fn run<M: Module + Default>(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    let inst = &*(handle as *const Instance<M>);
    let Some(rx) = lock(&inst.rx).take() else {
        return;
    };
    let session = Session::new(rx, inst.host);
    // Паника не должна пересекать границу extern "C".
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inst.module.run(session)));
}

/// Тело `mshh_module_event_sink`: ядро кладёт событие в очередь модуля.
/// Потокобезопасно, может вызываться параллельно с `run`.
///
/// # Safety
/// `handle` — указатель из `start::<M>`; `json` — валидный UTF-8 на время вызова.
pub unsafe fn dispatch_event<M: Module + Default>(handle: *mut c_void, json: MshhStr) -> u32 {
    if handle.is_null() {
        return rc::ERR;
    }
    let inst = &*(handle as *const Instance<M>);
    let s = json.as_str();
    match serde_json::from_str::<Ev>(s) {
        Ok(ev) => {
            let _ = inst.tx.send(ev);
            rc::OK
        }
        Err(e) => {
            let host = &*inst.host;
            let msg = format!("event_sink: некорректный JSON: {e}");
            (host.log)(host.ctx, log_level::WARN, MshhStr::from_str("module"), MshhStr::from_str(&msg));
            rc::ERR
        }
    }
}

/// Тело `mshh_module_destroy`.
///
/// # Safety
/// `handle` — указатель из `start::<M>`; ядро вызывает после завершения `run`.
pub unsafe fn destroy<M: Module + Default>(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    drop(Box::from_raw(handle as *mut Instance<M>));
}

/// Генерирует все экспорты ABI для модуля.
///
/// ```ignore
/// #[derive(Default)]
/// struct Echo;
///
/// impl Module for Echo {
///     fn run(&self, session: Session) { /* ... */ }
/// }
///
/// register_module!(Echo, id: "echo", name: "Echo", version: "0.1.0");
/// ```
///
/// Требования: тип реализует `Module + Default`; макрос вызывается в корне
/// крейта. Одна библиотека — один активный экземпляр.
#[macro_export]
macro_rules! register_module {
    ($module_ty:ty, id: $id:expr, name: $name:expr, version: $version:expr) => {
        static _MSHH_INFO: $crate::abi::MshhModuleInfo = $crate::abi::MshhModuleInfo {
            id: $crate::abi::MshhStr::from_static($id),
            name: $crate::abi::MshhStr::from_static($name),
            version: $crate::abi::MshhStr::from_static($version),
        };

        static _MSHH_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

        #[no_mangle]
        pub extern "C" fn mshh_abi_version() -> u32 {
            $crate::abi::ABI_VERSION
        }

        #[no_mangle]
        pub extern "C" fn mshh_module_info() -> *const $crate::abi::MshhModuleInfo {
            &_MSHH_INFO
        }

        #[no_mangle]
        pub extern "C" fn mshh_module_start(
            host: *const $crate::abi::MshhHostVTable,
        ) -> *mut std::ffi::c_void {
            unsafe { $crate::register::start::<$module_ty>(&_MSHH_ACTIVE, host) }
        }

        #[no_mangle]
        pub extern "C" fn mshh_module_run(handle: *mut std::ffi::c_void) {
            unsafe { $crate::register::run::<$module_ty>(handle) }
        }

        #[no_mangle]
        pub extern "C" fn mshh_module_event_sink(
            handle: *mut std::ffi::c_void,
            json: $crate::abi::MshhStr,
        ) -> u32 {
            unsafe { $crate::register::dispatch_event::<$module_ty>(handle, json) }
        }

        #[no_mangle]
        pub extern "C" fn mshh_module_destroy(handle: *mut std::ffi::c_void) {
            _MSHH_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
            unsafe { $crate::register::destroy::<$module_ty>(handle) }
        }
    };
}
