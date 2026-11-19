#!/usr/bin/env node
'use strict';
// Персональная сборка MSHH для раздачи:
//   1. принимает api_id/api_hash Telegram (env MSHH_TELEGRAM_API_ID /
//      MSHH_TELEGRAM_API_HASH или интерактивно; api_hash вводится скрыто);
//   2. пишет их в mshh_modules/telegram/app-defaults.json (в git не попадает;
//      повторный запуск перезаписывает);
//   3. собирает приложение и пакует архив для раздачи.
// Ключи никогда не печатаются целиком: в выводе только последние 4 символа хеша.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const repoRoot = path.resolve(__dirname, '..');
const defaultsPath = path.join(repoRoot, 'mshh_modules', 'telegram', 'app-defaults.json');

const fail = (message) => {
  console.error(`\nОшибка: ${message}`);
  process.exit(1);
};
const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

/** Скрытый ввод: звёздочки вместо символов, Enter — конец, Backspace — стереть. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const chars = [];
    const { isRaw } = process.stdin;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(isRaw === true);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(chars.join(''));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (chars.length) {
            chars.pop();
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          reject(new Error('ввод прерван'));
          return;
        }
        if (char >= ' ') {
          chars.push(char);
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

function validate(apiId, apiHash) {
  if (!/^\d+$/.test(apiId) || Number(apiId) <= 0) {
    fail('api_id должен быть положительным целым числом (как в личном кабинете my.telegram.org).');
  }
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
    fail('api_hash должен состоять из 32 hex-символов (как выдаёт my.telegram.org).');
  }
}

function writeDefaults(apiId, apiHash) {
  fs.writeFileSync(defaultsPath, `${JSON.stringify({ apiId: Number(apiId), apiHash }, null, 2)}\n`);
  // страховка: ключи не должны быть отслеживаемыми
  const check = spawnSync('git', ['check-ignore', '-q', path.relative(repoRoot, defaultsPath)], { cwd: repoRoot });
  if (check.status !== 0) {
    fs.rmSync(defaultsPath);
    fail('.gitignore не покрывает app-defaults.json — запись отменена, ключи не сохранены.');
  }
  console.log(`✓ Ключи записаны в ${path.relative(repoRoot, defaultsPath)} (в git не попадает)`);
  console.log(`  api_id: ${apiId}; api_hash: ****${apiHash.slice(-4)}`);
}

function buildApp() {
  console.log('==> сборка приложения (npm run build)');
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}

function packageShare() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const outDir = path.join(repoRoot, 'dist-share');
  const outPath = path.join(outDir, `mshh-share-${stamp}.tar.gz`);
  fs.mkdirSync(outDir, { recursive: true });
  console.log('==> упаковка архива для раздачи');
  execFileSync(
    'tar',
    [
      '-czf', outPath,
      '--exclude=.git',
      '--exclude=node_modules',
      '--exclude=dist-share',
      '--exclude=mshh_modules/*/node_modules',
      '--exclude=.DS_Store',
      '-C', repoRoot, '.',
    ],
    { stdio: 'pipe' }
  );
  const listed = execFileSync('tar', ['-tzf', outPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!listed.split('\n').some((name) => name.endsWith('mshh_modules/telegram/app-defaults.json'))) {
    fail('в архиве нет app-defaults.json — сборка не годится для раздачи.');
  }
  return outPath;
}

(async () => {
  if (!fs.existsSync(path.join(repoRoot, 'package.json'))) fail('скрипт запущен не из репозитория MSHH');

  let apiId = process.env.MSHH_TELEGRAM_API_ID;
  let apiHash = process.env.MSHH_TELEGRAM_API_HASH;
  const fromEnv = apiId !== undefined || apiHash !== undefined;

  if (apiId && apiHash) {
    console.log('==> ключи взяты из переменных окружения');
  } else if (process.stdin.isTTY) {
    if (fromEnv) console.log('==> задан только один из ключей — второй спросим интерактивно');
    else console.log('==> введите ключи из https://my.telegram.org → API development tools');
    if (!apiId) apiId = await ask('api_id: ');
    if (!apiHash) {
      try {
        apiHash = await askHidden('api_hash (скрытый ввод): ');
      } catch {
        process.exit(1);
      }
    }
  } else {
    fail('ключи не заданы полностью. Передайте env MSHH_TELEGRAM_API_ID и MSHH_TELEGRAM_API_HASH (или запустите в интерактивном терминале).');
  }

  validate(String(apiId).trim(), String(apiHash).trim());
  writeDefaults(String(apiId).trim(), String(apiHash).trim());
  buildApp();
  const artifact = packageShare();
  console.log(`\n✓ Готово. Артефакт для раздачи:\n  ${artifact}`);
  console.log('  Получатель: распаковать → ./install.sh → mshh. В форме Telegram поля ключей уже заполнены.');
})().catch((error) => fail(error?.message || String(error)));
