//! Картинки в TUI: декодирование с кэшем и kitty-анимация GIF.
//!
//! Статичные картинки (аватары, обложки) рендерит ratatui-image —
//! kitty/sixel/iTerm2/halfblocks по возможностям терминала.
//! GIF-анимация: kitty-протокол, терминал-драйв — кадры заливаются один
//! раз (`a=f`), управление `a=a,s=3,v=1` (зациклить); приложение только
//! переключает кадры по таймеру пауз (`a=a,c=N`). Не-kitty показывает
//! статичный первый кадр.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use image::AnimationDecoder as _;
use image::ImageEncoder as _;
use image::DynamicImage;
use ratatui::layout::Rect;

static CACHE: OnceLock<Mutex<HashMap<String, DynamicImage>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, DynamicImage>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Кэш закодированных протоколов: (путь, cols, rows) → Protocol.
static PROTO_CACHE: OnceLock<Mutex<HashMap<String, std::sync::Arc<dyn ratatui_image::protocol::Protocol>>>> =
    OnceLock::new();

fn proto_cache() -> &'static Mutex<HashMap<String, std::sync::Arc<dyn ratatui_image::protocol::Protocol>>> {
    PROTO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Кэширующий вызов `Picker::new_protocol`.
pub fn cached_protocol(
    path: &str,
    cols: u16,
    rows: u16,
    make: impl FnOnce(
        DynamicImage,
        Rect,
    ) -> Option<std::sync::Arc<dyn ratatui_image::protocol::Protocol>>,
) -> Option<std::sync::Arc<dyn ratatui_image::protocol::Protocol>> {
    let key = format!("{path}|{cols}x{rows}");
    if let Ok(m) = proto_cache().lock() {
        if let Some(hit) = m.get(&key) {
            return Some(hit.clone());
        }
    }
    let img = decode(Path::new(path))?;
    let proto = make(img, Rect::new(0, 0, cols, rows))?;
    if let Ok(mut m) = proto_cache().lock() {
        m.insert(key, proto.clone());
    }
    Some(proto)
}

/// Декодировать картинку (кэш по пути). Для GIF — первый кадр.
pub fn decode(path: &Path) -> Option<DynamicImage> {
    let key = path.to_string_lossy().into_owned();
    if let Ok(m) = cache().lock() {
        if let Some(hit) = m.get(&key) {
            return Some(hit.clone());
        }
    }
    let img = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    if let Ok(mut m) = cache().lock() {
        m.insert(key, img.clone());
    }
    Some(img)
}

/// GIF-анимация: PNG-байты кадров + задержки кадров (мс, минимум 20).
pub fn gif_frames(path: &Path) -> Option<Vec<(Vec<u8>, u32)>> {
    let file = std::io::BufReader::new(std::fs::File::open(path).ok()?);
    let dec = image::codecs::gif::GifDecoder::new(file).ok()?;
    let mut out: Vec<(Vec<u8>, u32)> = Vec::new();
    for frame in dec.into_frames() {
        let frame = frame.ok()?;
        let delay = frame.delay().numer_denom_ms().0.max(20) as u32;
        let rgba = frame.buffer();
        let mut png = Vec::new();
        {
            let enc = image::codecs::png::PngEncoder::new(&mut png);
            enc.write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .ok()?;
        }
        out.push((png, delay));
    }
    (out.len() >= 2).then_some(out)
}

fn b64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn kitty_write(s: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(s.as_bytes());
    let _ = out.flush();
}

/// Отправить PNG по kitty-протоколу: base64, куски ≤4096, m=1/m=0.
/// `head` — control data первого куска (без `m`), `chunk_head` — префикс
/// последующих кусков (для кадров обязателен `a=f,`).
fn kitty_send_png(head: String, chunk_head: &str, png: &[u8]) {
    let data = b64(png);
    let bytes = data.as_bytes();
    let mut start = 0;
    let mut first = true;
    loop {
        let end = (start + 4096).min(bytes.len());
        let last = end >= bytes.len();
        let mut meta = if first { head.clone() } else { chunk_head.to_string() };
        if !meta.ends_with(',') {
            meta.push(',');
        }
        meta.push_str(if last { "m=0;" } else { "m=1;" });
        kitty_write(&format!("\x1b_G{meta}{}\x1b\\", &data[start..end]));
        first = false;
        if last {
            break;
        }
        start = end;
    }
}

/// Базовое изображение (корень анимации): `a=t`, без показа.
pub fn kitty_anim_root(image_id: u32, png: &[u8]) {
    kitty_send_png(
        format!("a=t,f=100,i={image_id},q=2"),
        "q=2,",
        png,
    );
}

/// Кадр анимации: `a=f` с задержкой до следующего кадра (номер кадра = 2..).
pub fn kitty_anim_frame_data(image_id: u32, png: &[u8], delay_ms: u32) {
    kitty_send_png(
        format!("a=f,i={image_id},f=100,z={delay_ms},q=2"),
        "a=f,q=2,",
        png,
    );
}

/// Запустить анимацию: терминал сам крутит кадры, зациклено.
pub fn kitty_anim_run(image_id: u32) {
    kitty_write(&format!("\x1b_Ga=a,i={image_id},s=3,v=1,q=2\x1b\\"));
}

/// Пауза кадра корня (root-кадр создаётся без gap).
pub fn kitty_anim_root_gap(image_id: u32, delay_ms: u32) {
    kitty_write(&format!("\x1b_Ga=a,i={image_id},r=1,z={delay_ms},q=2\x1b\\"));
}

/// Переключить текущий кадр (для таймерного перелистывания).
pub fn kitty_anim_switch(image_id: u32, frame_no: u32) {
    kitty_write(&format!("\x1b_Ga=a,i={image_id},c={frame_no},q=2\x1b\\"));
}

/// Разместить анимацию в конкретных ячейках: CUP курсор в угол + `a=p`
/// с масштабом c/r и `C=1`.
pub fn kitty_anim_place(image_id: u32, col: u16, row: u16, cols: u16, rows: u16) {
    kitty_write(&format!("\x1b[{};{}H", row + 1, col + 1));
    kitty_write(&format!(
        "\x1b_Ga=p,i={image_id},r={rows},c={cols},C=1,q=2\x1b\\"
    ));
}
