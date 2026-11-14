// 비서를 켜 두고, 죽으면 다시 켜고, 새 버전이 올라오면 받아서 바꿔 끼운다.
// supervisor.mjs가 매번 이 파일을 새로 불러오므로, 이 파일은 node 기본 모듈만 쓴다 (업데이트 뒤 새 코드가 바로 적용되게).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHECK_EVERY = 10 * 60 * 1000;
const POLL = 3000;
const QUICK = 30 * 1000; // 켜지고 이 안에 죽으면 "바로 죽음"으로 센다

const readText = f => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return '';
  }
};
const rm = f => fs.rmSync(f, { recursive: true, force: true });

export function readEnv(file) {
  const out = {};
  for (const raw of readText(file).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// 저장소의 최신 커밋 (공개 저장소라 토큰 없이 읽는다)
export async function latest({ repo, api, fetchFn = fetch }) {
  const url = api || `https://api.github.com/repos/${repo}/commits/main`;
  const r = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'today-bot' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub 응답 ${r.status}`);
  const j = await r.json();
  if (!/^[0-9a-f]{40}$/.test(j?.sha || '')) throw new Error('버전 정보를 읽지 못했어요');
  return { sha: j.sha, message: String(j.commit?.message || '').split('\n')[0].slice(0, 80) };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// 새 버전을 받아 임시 폴더에 풀고, 켜질 수 있는 코드인지 확인한다. 돌고 있는 비서는 건드리지 않는다.
export async function prepare({ dataDir, repo, sha, tarUrl, fetchFn = fetch }) {
  const tgz = path.join(dataDir, 'update.tgz');
  const tmp = path.join(dataDir, 'update-tmp');
  rm(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  const r = await fetchFn(tarUrl || `https://codeload.github.com/${repo}/tar.gz/${sha}`, { headers: { 'User-Agent': 'today-bot' }, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`내려받기 실패 (${r.status})`);
  fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
  // Windows 10 이상과 macOS·Linux에 기본으로 있는 tar를 쓴다. 드라이브 글자(C:) 문제를 피하려고 상대 경로로
  const x = spawnSync('tar', ['-xzf', 'update.tgz', '-C', 'update-tmp', '--strip-components=1'], { cwd: dataDir, encoding: 'utf8' });
  rm(tgz);
  if (x.error || x.status !== 0) throw Object.assign(new Error(`압축 풀기 실패: ${x.error?.message || x.stderr || x.status}`), { bad: true });
  for (const f of ['bot/main.mjs', 'bot/supervisor.mjs', 'bot/lib/updater.mjs', 'js/core.js']) {
    if (!fs.existsSync(path.join(tmp, f))) throw Object.assign(new Error(`새 버전에 ${f}가 없어요`), { bad: true });
  }
  for (const f of [...walk(path.join(tmp, 'bot')), ...walk(path.join(tmp, 'js'))].filter(f => /\.m?js$/.test(f))) {
    const c = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (c.status !== 0) throw Object.assign(new Error(`새 버전에 문법 오류: ${path.relative(tmp, f)}`), { bad: true });
  }
  const t = spawnSync(process.execPath, [path.join(tmp, 'bot', 'main.mjs'), '--selftest'], { cwd: path.join(tmp, 'bot'), encoding: 'utf8', timeout: 30_000 });
  if (t.status !== 0) throw Object.assign(new Error(`새 버전이 켜지지 않아요: ${(t.stderr || '').trim().split('\n').pop() || t.status}`), { bad: true });
  return tmp;
}

// 폴더를 통째로 복사한다. 설정(.env), 기록(data), 설치한 모듈(node_modules)은 건너뛴다.
// (fs.cpSync는 백업 폴더가 bot/data 안에 있으면 "자기 안으로 복사"라며 거절해서 직접 돈다)
const SKIP = new Set(['data', 'node_modules', '.env']);
function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    return fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (!SKIP.has(name)) copyTree(path.join(src, name), path.join(dst, name));
  }
}

// 지금 코드를 백업하고 새 코드를 덮어쓴다. .env, data, node_modules는 건드리지 않는다.
export function install({ root, dataDir, tmp }) {
  const backup = path.join(dataDir, 'backup');
  rm(backup);
  for (const d of ['bot', 'js']) {
    if (fs.existsSync(path.join(root, d))) copyTree(path.join(root, d), path.join(backup, d));
  }
  for (const name of fs.readdirSync(tmp)) {
    if (!SKIP.has(name)) copyTree(path.join(tmp, name), path.join(root, name));
  }
  rm(tmp);
}

export function rollback({ root, dataDir }) {
  const backup = path.join(dataDir, 'backup');
  if (!fs.existsSync(path.join(backup, 'bot'))) return false;
  for (const d of ['bot', 'js']) {
    if (fs.existsSync(path.join(backup, d))) copyTree(path.join(backup, d), path.join(root, d));
  }
  return true;
}

// 비서에게 전할 말 (비서가 켜져 있을 때 읽어서 텔레그램으로 보내고 지운다)
const notice = (dataDir, text) => fs.writeFileSync(path.join(dataDir, 'notice.txt'), text);

async function stopChild(ctx) {
  const child = ctx.state.child;
  if (!child || child.exitCode !== null) return;
  // Windows에는 부드럽게 끄는 신호가 없어서, 파일로 "꺼 줘"를 전하고 기다린다
  fs.writeFileSync(path.join(ctx.dataDir, 'stop.flag'), '1');
  for (let i = 0; i < 15 && child.exitCode === null; i++) await sleep(1000);
  if (child.exitCode === null) child.kill();
  for (let i = 0; i < 5 && child.exitCode === null; i++) await sleep(500);
  rm(path.join(ctx.dataDir, 'stop.flag'));
  rm(path.join(ctx.dataDir, 'bot.lock'));
}

// 새 버전이 있으면 받아서 바꾼다. 바꿨으면 true
export async function checkAndUpdate(ctx, { asked = false } = {}) {
  const { root, dataDir, log } = ctx;
  const env = { ...readEnv(path.join(ctx.here, '.env')), ...ctx.env };
  if (!asked && String(env.AUTO_UPDATE || 'on').toLowerCase() === 'off') return false;
  const repo = env.UPDATE_REPO || 'jmchoi4u/today';
  const verFile = path.join(dataDir, 'version.txt');
  let cur = readText(verFile);
  let last;
  try {
    last = await latest({ repo, api: env.UPDATE_API, fetchFn: ctx.fetchFn });
  } catch (e) {
    if (asked) notice(dataDir, `새 버전을 확인하지 못했어요: ${e.message}`);
    return false;
  }
  if (!cur) {
    // 처음: 방금 받은 것이 최신이라고 보고 기록만 한다
    fs.writeFileSync(verFile, last.sha);
    cur = last.sha;
  }
  if (cur === last.sha) {
    if (asked) notice(dataDir, `이미 최신이에요 (${cur.slice(0, 7)}).`);
    return false;
  }
  if (readText(path.join(dataDir, 'bad-version.txt')) === last.sha) {
    if (asked) notice(dataDir, `최신 버전(${last.sha.slice(0, 7)})은 켜지지 않아서 건너뛰고 있어요. 다음 버전을 기다려요.`);
    return false;
  }
  let tmp;
  try {
    tmp = await prepare({ dataDir, repo, sha: last.sha, tarUrl: env.UPDATE_TARBALL, fetchFn: ctx.fetchFn });
  } catch (e) {
    log(`업데이트 준비 실패 (${last.sha.slice(0, 7)}): ${e.message}`);
    if (e.bad) fs.writeFileSync(path.join(dataDir, 'bad-version.txt'), last.sha); // 코드가 잘못된 버전은 다시 시도하지 않는다
    if (asked || e.bad) notice(dataDir, `업데이트를 못 했어요. 지금 버전으로 계속 돌아요.\n${e.message}`);
    return false;
  }
  await stopChild(ctx);
  install({ root, dataDir, tmp });
  fs.writeFileSync(verFile, last.sha);
  ctx.state.justUpdated = { sha: last.sha, prev: cur, quick: 0 };
  notice(dataDir, `새 버전으로 다시 켜졌어요 (${last.sha.slice(0, 7)}).\n${last.message}`);
  log(`업데이트 ${cur.slice(0, 7)} → ${last.sha.slice(0, 7)}`);
  return true;
}

// 비서를 한 번 켜서, 꺼지거나 업데이트될 때까지 지켜본다. 끝나면 supervisor가 이 파일을 새로 불러 다시 부른다.
export async function runOnce(ctx) {
  const { here, dataDir, log } = ctx;
  const st = ctx.state;
  rm(path.join(dataDir, 'stop.flag'));
  rm(path.join(dataDir, 'bot.lock'));
  const startedAt = Date.now();
  const child = spawn(process.execPath, [path.join(here, 'main.mjs')], { cwd: here, stdio: 'ignore', env: { ...process.env, TODAY_SUPERVISED: '1' }, windowsHide: true });
  st.child = child;
  child.on('error', e => log(`비서를 켜지 못했어요: ${e.message}`));
  st.lastCheck ??= 0; // 켜자마자 한 번 확인
  const flag = path.join(dataDir, 'update.flag');
  while (child.exitCode === null && child.signalCode === null) {
    await sleep(ctx.poll ?? POLL);
    const asked = fs.existsSync(flag);
    if (asked) rm(flag);
    if (asked || Date.now() - st.lastCheck >= (ctx.checkEvery ?? CHECK_EVERY)) {
      st.lastCheck = Date.now();
      try {
        if (await checkAndUpdate(ctx, { asked })) return 'updated';
      } catch (e) {
        log(`업데이트 중 오류: ${e.message}`);
      }
    }
    // 새 버전으로 1분 넘게 잘 돌면 합격
    if (st.justUpdated && Date.now() - startedAt > 60_000) st.justUpdated = null;
  }
  rm(path.join(dataDir, 'bot.lock'));
  const up = Date.now() - startedAt;
  if (st.stopping) return 'stopped';
  log(`비서가 꺼졌어요 (${Math.round(up / 1000)}초 만에, 코드 ${child.exitCode}). 다시 켜요.`);
  if (up < QUICK) {
    st.quick = (st.quick || 0) + 1;
    // 업데이트 직후 세 번 연속 바로 죽으면 이전 버전으로 되돌린다
    if (st.justUpdated && ++st.justUpdated.quick >= 3) {
      const { sha, prev } = st.justUpdated;
      if (rollback(ctx)) {
        fs.writeFileSync(path.join(dataDir, 'version.txt'), prev);
        fs.writeFileSync(path.join(dataDir, 'bad-version.txt'), sha);
        notice(dataDir, `새 버전(${sha.slice(0, 7)})이 켜지지 않아서 이전 버전으로 되돌렸어요.`);
        log(`되돌림 ${sha.slice(0, 7)} → ${prev.slice(0, 7)}`);
      }
      st.justUpdated = null;
      st.quick = 0;
    }
  } else st.quick = 0;
  await sleep(ctx.backoff ?? Math.min(60_000, 5000 * 2 ** Math.min(st.quick || 0, 4)));
  return 'exited';
}
