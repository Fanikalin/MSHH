'use strict';

/**
 * MSHH module contract — JSDoc types shared by loader, runners and modules.
 * The user-facing contract lives in docs/MODULES.md.
 *
 * @typedef {Object} Chat
 * @property {string} id
 * @property {"dm"|"group"|"channel"} kind
 * @property {string} title
 * @property {string} [subtitle]
 * @property {number} ts                epoch ms, last activity
 * @property {number} unread
 * @property {boolean} [muted]
 * @property {string} [avatarPath]      file inside profile dataDir
 *
 * @typedef {Object} Media
 * @property {"image"|"file"|"audio"|"video"} kind
 * @property {string} [name]
 * @property {string} [mime]
 * @property {number} [size]
 * @property {string} [path]            file inside profile dataDir
 *
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} chatId
 * @property {string} senderId
 * @property {string} [senderName]
 * @property {number} ts                epoch ms
 * @property {boolean} out
 * @property {string} [text]
 * @property {Media} [media]
 * @property {string} [replyTo]
 * @property {boolean} [edited]
 * @property {boolean} [pending]
 *
 * @typedef {Object} PromptRequest
 * @property {"code"|"text"|"qr"} kind
 * @property {string} [title]
 * @property {string} [detail]
 * @property {Buffer} [qr]              PNG buffer, kind === "qr"
 * @property {number} [timeoutMs]
 *
 * @typedef {Object} PromptAnswer
 * @property {string} [value]
 *
 * @typedef {Object} ModuleCtx
 * @property {string} profileId
 * @property {string} name              profile display name
 * @property {Record<string, any>} config
 * @property {string} dataDir
 * @property {(level:"debug"|"info"|"warn"|"error", msg:string, meta?:any)=>void} log
 * @property {(type:"chat"|"chat-remove"|"message"|"message-edit"|"typing"|"status", payload:any)=>void} emit
 * @property {(req:PromptRequest)=>Promise<PromptAnswer>} prompt
 *
 * @typedef {Object} ModuleApi
 * @property {()=>Promise<void>} connect
 * @property {()=>Promise<void>} disconnect
 * @property {(chatId:string, opts:{beforeTs?:number, limit?:number})=>Promise<Message[]>} loadHistory
 * @property {(chatId:string, draft:{text?:string, files?:Array<{path:string, name?:string}>})=>Promise<Message>} sendMessage
 * @property {((chatId:string)=>Promise<void>)=} markRead
 * @property {((chatId:string)=>Promise<void>)=} sendTyping
 */

const FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'select'];

/** Validate a module manifest. Returns array of problem strings (empty = ok). */
function validateManifest(manifest, dirName) {
  const problems = [];
  const push = (m) => problems.push(m);
  if (!manifest || typeof manifest !== 'object') {
    return ['manifest.json не читается'];
  }
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(manifest.id)) {
    push('manifest.id: строка [a-z0-9][a-z0-9_-]* обязательна');
  } else if (dirName && manifest.id !== dirName) {
    push(`manifest.id ("${manifest.id}") должен совпадать с именем папки ("${dirName}")`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name) push('manifest.name обязателен');
  if (manifest.runtime !== undefined && !['main', 'renderer'].includes(manifest.runtime)) {
    push('manifest.runtime: "main" | "renderer"');
  }
  if (manifest.auth !== undefined && !['password', 'token', 'qr', 'custom'].includes(manifest.auth)) {
    push('manifest.auth: "password" | "token" | "qr" | "custom"');
  }
  if (manifest.fields !== undefined) {
    if (!Array.isArray(manifest.fields)) push('manifest.fields: массив');
    else {
      const names = new Set();
      manifest.fields.forEach((f, i) => {
        if (!f || typeof f.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.name)) {
          push(`fields[${i}].name обязателен ([a-zA-Z][a-zA-Z0-9_]*)`);
          return;
        }
        if (names.has(f.name)) push(`fields[${i}]: дубликат name "${f.name}"`);
        names.add(f.name);
        if (!FIELD_TYPES.includes(f.type)) push(`fields[${i}] ("${f.name}"): type ${FIELD_TYPES.join('|')}`);
        if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
          push(`fields[${i}] ("${f.name}"): select требует непустой options`);
        }
      });
    }
  }
  return problems;
}

module.exports = { validateManifest };
