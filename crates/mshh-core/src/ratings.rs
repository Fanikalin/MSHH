//! Встроенный каталог доверия MSHH.
//!
//! Рейтинг модуля — сумма баллов фактов: `>= 7` зелёный, `0..=6` жёлтый,
//! `< 0` красный. Модули первой стороны (репозиторий MSHH) красными не
//! бывают: сам модуль считается проверенным, рисковать может только
//! протокол — тогда кламп до жёлтого.
//!
//! Каталог вшит в ядро и не берётся из модулей: модуль не может
//! оценивать сам себя. Карма (опенсоурс, рейтинг разработчика на GitHub)
//! входит в список фактов с баллами.

/// Один факт, на котором стоит рейтинг.
#[derive(Clone, Debug)]
pub struct TrustFact {
    pub text: String,
    pub points: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RatingColor {
    Green,
    Yellow,
    Red,
}

impl RatingColor {
    pub fn label(self) -> &'static str {
        match self {
            RatingColor::Green => "зелёный",
            RatingColor::Yellow => "жёлтый",
            RatingColor::Red => "красный",
        }
    }
}

/// Рейтинг одного модуля для отображения.
#[derive(Clone, Debug)]
pub struct RatingView {
    pub module_id: String,
    pub name: String,
    pub first_party: bool,
    pub installed: bool,
    pub color: RatingColor,
    pub score: i32,
    pub badges: Vec<String>,
    pub facts: Vec<TrustFact>,
}

/// Внутреннее описание каталога.
struct ModuleRating {
    module_id: &'static str,
    name: &'static str,
    first_party: bool,
    badges: &'static [&'static str],
    /// (баллы, текст).
    facts: &'static [(i32, &'static str)],
}

impl ModuleRating {
    fn score(&self) -> i32 {
        self.facts.iter().map(|f| f.0).sum()
    }

    fn color(&self) -> RatingColor {
        let raw = if self.score() >= 7 {
            RatingColor::Green
        } else if self.score() >= 0 {
            RatingColor::Yellow
        } else {
            RatingColor::Red
        };
        if self.first_party && raw == RatingColor::Red {
            RatingColor::Yellow
        } else {
            raw
        }
    }

    fn view(&self, installed: bool) -> RatingView {
        RatingView {
            module_id: self.module_id.into(),
            name: self.name.into(),
            first_party: self.first_party,
            installed,
            color: self.color(),
            score: self.score(),
            badges: self.badges.iter().map(|s| s.to_string()).collect(),
            facts: self
                .facts
                .iter()
                .map(|(p, t)| TrustFact { points: *p, text: t.to_string() })
                .collect(),
        }
    }
}

const CATALOG: &[ModuleRating] = &[
    ModuleRating {
        module_id: "echo",
        name: "Echo (пример)",
        first_party: true,
        badges: &["рекомендовано MSHH", "эталон для авторов модулей"],
        facts: &[
            (5, "локальный протокол без сети: данные не покидают машину"),
            (2, "покрыт e2e-тестами в репозитории ядра"),
        ],
    },
    ModuleRating {
        module_id: "telegram",
        name: "Telegram",
        first_party: true,
        badges: &["рекомендовано MSHH", "облачные чаты без E2E"],
        facts: &[
            (-2, "MTProto 2.0 — самописная криптография, полного независимого аудита нет"),
            (-3, "облачные чаты не E2E: сервер видит содержимое; секретные чаты модулем не поддерживаются"),
            (-2, "обязательный телефонный номер; метаданные на серверах Telegram"),
            (2, "открытый протокол; клиентский стек grammers — опенсоурс"),
            (3, "модуль первой стороны: код в репозитории MSHH"),
            (1, "активный публичный мейнтейнер grammers (Lonami)"),
        ],
    },
    ModuleRating {
        module_id: "matrix",
        name: "Matrix",
        first_party: true,
        badges: &["рекомендовано MSHH", "E2EE по умолчанию"],
        facts: &[
            (3, "E2EE (Olm/Megolm) включён по умолчанию; криптография прошла независимый аудит (NCC Group)"),
            (2, "открытый федеративный протокол, независимые серверы"),
            (-1, "хоум-сервер видит метаданные и контент комнат без E2EE"),
            (2, "matrix-rust-sdk — опенсоурс (Apache-2.0)"),
            (3, "модуль первой стороны"),
            (1, "разработка Matrix.org Foundation, публичный GitHub"),
        ],
    },
    ModuleRating {
        module_id: "max",
        name: "MAX",
        first_party: true,
        badges: &["ограниченный режим MSHH", "userbot: неофициальный API"],
        facts: &[
            (-2, "закрытый протокол и клиент, независимой проверки нет"),
            (-2, "E2E-шифрование отсутствует: весь трафик виден серверу MAX"),
            (-2, "обязательная идентификация телефоном; данные в юрисдикции РФ"),
            (-2, "user-режим через неофициальный API: меняется без предупреждения, риск блокировки аккаунта"),
            (-1, "токен сессии web.max.ru эквивалентен паролю: полный доступ к переписке"),
            (1, "официальный открытый Bot API (OpenAPI-схемы, Apache-2.0)"),
            (2, "модуль первой стороны с жёсткими ограничениями: allowlist хостов, без вложений, лимит 4000 символов"),
        ],
    },
    ModuleRating {
        module_id: "reticulum",
        name: "Reticulum",
        first_party: true,
        badges: &["рекомендовано MSHH", "без серверов и интернета"],
        facts: &[
            (3, "E2E через шифрованные RNS-link: X25519/Ed25519, AES-CBC+HMAC; текст не ходит в открытом виде"),
            (2, "полная децентрализация: работает без серверов и без интернета"),
            (2, "без обязательной идентификации: адреса — криптографические хэши"),
            (-2, "молодая экосистема: независимых аудитов криптосхемы нет"),
            (2, "опенсоурс стек RNS; модуль первой стороны"),
            (2, "автор RNS (markqvist) — активный публичный опенсоурс"),
        ],
    },
    ModuleRating {
        module_id: "xmpp",
        name: "XMPP",
        first_party: true,
        badges: &["рекомендовано MSHH", "OMEMO не поддерживается"],
        facts: &[
            (2, "открытый стандарт IETF (RFC 6120–6122), множество серверов"),
            (-2, "модуль не реализует OMEMO (XEP-0384): содержимое видит сервер"),
            (-1, "метаданные (ростер, presence) видны серверу"),
            (2, "опенсоурс стек xmpp-rs; модуль первой стороны"),
            (1, "TLS-подключение обязательно в модуле"),
            (1, "xmpp-rs — публичный активный опенсоурс"),
        ],
    },
    ModuleRating {
        module_id: "irc",
        name: "IRC",
        first_party: true,
        badges: &["рекомендовано MSHH", "только TLS"],
        facts: &[
            (1, "транспорт TLS обязателен в модуле (порт 6697)"),
            (-2, "E2E отсутствует: содержимое каналов видно серверу и всем участникам"),
            (1, "открытый стандарт (RFC 1459/2812)"),
            (2, "минимальная поверхность: текст, TLS, без вложений; первая сторона"),
            (1, "спецификации публичны, реализаций множество"),
        ],
    },
];

/// Вшитый каталог рейтингов (для отображения независимо от установки).
pub fn builtin() -> Vec<RatingView> {
    CATALOG.iter().map(|m| m.view(false)).collect()
}

/// Рейтинг для модуля вне каталога: неизвестное происхождение — красный.
pub fn unknown(module_id: &str, name: &str) -> RatingView {
    RatingView {
        module_id: module_id.into(),
        name: name.into(),
        first_party: false,
        installed: true,
        color: RatingColor::Red,
        score: -5,
        badges: Vec::new(),
        facts: vec![
            TrustFact { points: -2, text: "модуль вне встроенного каталога MSHH".into() },
            TrustFact { points: -2, text: "происхождение и разработчик неизвестны".into() },
            TrustFact { points: -1, text: "нативный код: полный доступ к процессу".into() },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_party_never_red() {
        for m in builtin() {
            assert!(m.first_party, "в каталоге должны быть только первые стороны");
            assert_ne!(m.color, RatingColor::Red, "{}", m.module_id);
        }
    }

    #[test]
    fn known_scores_and_colors() {
        let get = |id: &str| builtin().into_iter().find(|v| v.module_id == id).unwrap();
        let t = get("telegram");
        assert_eq!(t.score, -1);
        assert_eq!(t.color, RatingColor::Yellow, "кламп первой стороны");
        assert_eq!(get("max").score, -6);
        assert_eq!(get("max").color, RatingColor::Yellow, "кламп первой стороны");
        assert_eq!(get("matrix").score, 10);
        assert_eq!(get("matrix").color, RatingColor::Green);
        assert_eq!(get("reticulum").color, RatingColor::Green);
        assert_eq!(get("echo").score, 7);
        assert_eq!(get("echo").color, RatingColor::Green);
        assert_eq!(get("xmpp").score, 3);
        assert_eq!(get("xmpp").color, RatingColor::Yellow);
        assert_eq!(get("irc").color, RatingColor::Yellow);
    }

    #[test]
    fn unknown_module_is_red() {
        let u = unknown("strange", "Strange");
        assert_eq!(u.score, -5);
        assert_eq!(u.color, RatingColor::Red);
        assert!(!u.first_party);
    }
}
