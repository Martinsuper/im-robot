#!/usr/bin/env node
/**
 * i18n key completeness check (F6 收尾).
 *
 * 检查项：
 *   1. 扫描 src 下所有 t("key") / translate("key") 字面调用 + 已知动态 key
 *      （labelKey 选项数组、memoryTypes 的 type/source/relation 模板），
 *      三份 locale (zh-CN / en-US / ja-JP) 必须覆盖全部使用中的 key。
 *   2. 三份 locale 的 key 集合必须彼此一致（缺失与多余都报出来；
 *      "多余"仅指某一侧缺失导致的集合差，完全未被使用的 key 只提示不失败）。
 *   3. 所有含 {xxx} 占位符的 key，三份文件的占位符集合必须一致。
 *   4. zh-CN 的值必须与代码里 t() 的第二参 fallback 逐字相同
 *      （e2e 断言依赖中文逐字一致，这是硬约束）。
 *
 * 用法：node scripts/check-i18n-keys.mjs   （失败时以非零码退出）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'src');
const localeFiles = {
  'zh-CN': path.join(repoRoot, 'src', 'locales', 'zh-CN.json'),
  'en-US': path.join(repoRoot, 'src', 'locales', 'en-US.json'),
  'ja-JP': path.join(repoRoot, 'src', 'locales', 'ja-JP.json'),
};

const LOCALE_ORDER = ['zh-CN', 'en-US', 'ja-JP'];

// ---------------------------------------------------------------------------
// 1. 收集 src 下源码文件
// ---------------------------------------------------------------------------
function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// 字面调用：t("key"...) / t('key'...)，以及与 t 同签名的注入别名 translate("key"...)
// lookbehind 排除 import("x") / emit("x") / sort("x") 这类以 t 结尾的其它调用。
const LITERAL_CALL_RE = /(?<![A-Za-z0-9_.$])(?:t|translate)\(\s*["']([\w.-]+)["']/g;
// 简单形态的第二参（纯字符串字面量且调用到此结束），用于 zh 值与代码 fallback 的逐字比对。
const FALLBACK_RE =
  /(?<![A-Za-z0-9_.$])(?:t|translate)\(\s*["']([\w.-]+)["']\s*,\s*(["'])((?:\\.|(?!\2).)*)\2\s*\)/g;
// 选项数组的动态 key：labelKey: "app.tab.companion"
const LABEL_KEY_RE = /labelKey:\s*["']([\w.-]+)["']/g;

function unescapeJsLiteral(text) {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (match, esc) => {
    if (esc === 'n') return '\n';
    if (esc === 't') return '\t';
    if (esc === 'r') return '\r';
    if (esc === '0') return '\0';
    if (esc === 'b') return '\b';
    if (esc === 'f') return '\f';
    if (esc === 'v') return '\v';
    if (esc.startsWith('u{') || esc.startsWith('u') || esc.startsWith('x')) {
      const hex = esc.replace(/^[ux]{1,2}\{?/, '').replace('}', '');
      const code = Number.parseInt(hex, 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return esc;
  });
}

const sourceFiles = listSourceFiles(srcDir);

const usedLiteralKeys = new Map(); // key -> { file, fallback?: string }
const fallbackByKey = new Map(); // key -> 代码里的字符串 fallback（仅纯字面量第二参）

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(repoRoot, file).replaceAll('\\', '/');

  for (const match of source.matchAll(LITERAL_CALL_RE)) {
    const key = match[1];
    if (!usedLiteralKeys.has(key)) usedLiteralKeys.set(key, { file: rel });
  }
  for (const match of source.matchAll(FALLBACK_RE)) {
    const key = match[1];
    if (!fallbackByKey.has(key)) fallbackByKey.set(key, unescapeJsLiteral(match[3]));
  }
  for (const match of source.matchAll(LABEL_KEY_RE)) {
    const key = match[1];
    if (!usedLiteralKeys.has(key)) usedLiteralKeys.set(key, { file: rel });
  }
}

// ---------------------------------------------------------------------------
// 2. 动态 key 模板展开
// ---------------------------------------------------------------------------
function expandTypeUnion(source, typeName) {
  const match = source.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*([^;]+);`));
  if (!match) return [];
  return [...match[1].matchAll(/["']([\w.-]+)["']/g)].map((m) => m[1]);
}

const memoryTypesSource = fs.readFileSync(path.join(srcDir, 'features', 'memory', 'memoryTypes.ts'), 'utf8');

const dynamicKeys = new Map(); // key -> 描述
const memoryTypeValues = expandTypeUnion(memoryTypesSource, 'MemoryType');
const memorySourceValues = expandTypeUnion(memoryTypesSource, 'MemorySource');
const relationBlock = memoryTypesSource.match(/export\s+const\s+RELATION_LABELS[^{]*\{([^}]*)\}/);
const relationValues = relationBlock ? [...relationBlock[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]) : [];

for (const value of memoryTypeValues) dynamicKeys.set(`memory.type.${value}`, 'memoryTypes.ts MemoryType');
for (const value of memorySourceValues) dynamicKeys.set(`memory.source.${value}`, 'memoryTypes.ts MemorySource');
for (const value of relationValues) dynamicKeys.set(`memory.relation.${value}`, 'memoryTypes.ts RELATION_LABELS');

const usedKeys = new Map(usedLiteralKeys);
for (const [key, origin] of dynamicKeys) {
  if (!usedKeys.has(key)) usedKeys.set(key, { file: origin });
}

// ---------------------------------------------------------------------------
// 3. 读取 locale 文件（扁平化）
// ---------------------------------------------------------------------------
function flatten(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value === null || typeof value === 'object') {
      if (typeof value === 'object') flatten(value, fullKey, out);
      else out.set(fullKey, null); // 非法：null 值
    } else if (typeof value === 'string') {
      out.set(fullKey, value);
    } else {
      out.set(fullKey, null); // 非法：非字符串叶子
    }
  }
  return out;
}

const locales = new Map();
for (const [locale, file] of Object.entries(localeFiles)) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[i18n-check] 无法解析 ${file}: ${error.message}`);
    process.exit(1);
  }
  locales.set(locale, flatten(parsed));
}

// ---------------------------------------------------------------------------
// 4. 校验
// ---------------------------------------------------------------------------
const failures = [];
const notices = [];

// 4.1 缺失 key
for (const locale of LOCALE_ORDER) {
  const messages = locales.get(locale);
  const missing = [...usedKeys.keys()].filter((key) => !messages.has(key));
  if (missing.length > 0) {
    failures.push(`${locale} 缺失 ${missing.length} 个 key:\n  ${missing.sort().join('\n  ')}`);
  }
}

// 4.2 三份文件 key 集合一致
const keySets = LOCALE_ORDER.map((locale) => new Set(locales.get(locale).keys()));
for (let i = 1; i < LOCALE_ORDER.length; i++) {
  const [baseName, baseSet] = [LOCALE_ORDER[0], keySets[0]];
  const otherName = LOCALE_ORDER[i];
  const otherSet = keySets[i];
  const onlyInBase = [...baseSet].filter((key) => !otherSet.has(key));
  const onlyInOther = [...otherSet].filter((key) => !baseSet.has(key));
  if (onlyInBase.length > 0) {
    failures.push(`${otherName} 缺少 ${onlyInBase.length} 个 ${baseName} 存在的 key:\n  ${onlyInBase.sort().join('\n  ')}`);
  }
  if (onlyInOther.length > 0) {
    failures.push(`${otherName} 多出 ${onlyInOther.length} 个 ${baseName} 没有的 key:\n  ${onlyInOther.sort().join('\n  ')}`);
  }
}

// 4.3 占位符集合一致
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
{
  const allKeys = new Set([...keySets.flat()]);
  for (const key of allKeys) {
    const placeholderSets = LOCALE_ORDER.map((locale) => {
      const value = locales.get(locale).get(key);
      return value == null ? null : new Set([...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
    });
    const first = placeholderSets[0];
    if (first === null) continue;
    for (let i = 1; i < LOCALE_ORDER.length; i++) {
      const other = placeholderSets[i];
      if (other === null) continue;
      const missing = [...first].filter((p) => !other.has(p));
      const extra = [...other].filter((p) => !first.has(p));
      if (missing.length > 0 || extra.length > 0) {
        const detail = [];
        if (missing.length > 0) detail.push(`${LOCALE_ORDER[i]} 缺少占位符 {${missing.join('} {')}}`);
        if (extra.length > 0) detail.push(`${LOCALE_ORDER[i]} 多出占位符 {${extra.join('} {')}}`);
        failures.push(`key "${key}" 的占位符不一致: ${detail.join('; ')}`);
      }
    }
  }
}

// 4.4 zh-CN 值必须与代码 fallback 逐字一致（e2e 硬约束）
{
  const zh = locales.get('zh-CN');
  for (const [key, fallback] of fallbackByKey) {
    if (!usedKeys.has(key)) continue; // 只约束真正使用中的 key
    const localeValue = zh.get(key);
    if (localeValue === undefined) continue; // 缺失已在 4.1 报告
    if (localeValue !== fallback) {
      failures.push(
        `key "${key}" 的 zh-CN 值与代码 fallback 不一致:\n  locale = ${JSON.stringify(localeValue)}\n  code   = ${JSON.stringify(fallback)}`,
      );
    }
  }
}

// 4.5 未使用的 key（仅提示，不作为失败项）
const unusedByAll = [...keySets[0]].filter((key) => !usedKeys.has(key)).sort();
if (unusedByAll.length > 0) {
  notices.push(`当前未在代码中使用的 key（仅提示，不影响退出码）: ${unusedByAll.length} 个\n  ${unusedByAll.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// 5. 报告
// ---------------------------------------------------------------------------
const namespaceStats = new Map();
for (const key of usedKeys.keys()) {
  const ns = key.split('.')[0];
  namespaceStats.set(ns, (namespaceStats.get(ns) ?? 0) + 1);
}

console.log(`[i18n-check] 使用中的 key: ${usedKeys.size} 个（字面 ${usedLiteralKeys.size} + 动态展开 ${dynamicKeys.size}）`);
console.log(
  `[i18n-check] 命名空间分布: ${[...namespaceStats.entries()].sort().map(([ns, count]) => `${ns}=${count}`).join(', ')}`,
);
for (const locale of LOCALE_ORDER) {
  console.log(`[i18n-check] ${locale}: ${locales.get(locale).size} 个 key`);
}

for (const notice of notices) console.log(`[i18n-check] 提示: ${notice}`);

if (failures.length > 0) {
  console.error(`\n[i18n-check] 发现 ${failures.length} 类问题:\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log('[i18n-check] 通过：三份 locale key 完整、集合一致、占位符一致、zh-CN 与代码 fallback 逐字一致。');
