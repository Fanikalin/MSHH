// Matrix module, runtime: "renderer".
// Логика здесь НЕ живёт: мост работает в рантайме рендерера —
// src/mshh/bridges/matrix.ts переиспользует matrix-js-sdk из бандла Cinny.
// Заглушка нужна, чтобы загрузчик модулей в main-процессе не пытался
// инстанцировать этот протокол в Node.
module.exports = { rendererAdapter: true };
