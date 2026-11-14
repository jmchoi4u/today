// .env 읽기: KEY=VALUE 한 줄씩. 메모장이 붙이는 BOM과 따옴표를 벗긴다
import fs from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function loadEnv(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
