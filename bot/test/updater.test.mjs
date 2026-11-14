import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import * as U from '../lib/updater.mjs';

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40);
const write = (f, s) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, s));
const read = f => fs.readFileSync(f, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 시험용 비서: --selftest면 바로 끝, 아니면 "켜짐" 파일을 남기고 stop.flag가 생길 때까지 돈다
const FAKE_MAIN = tag => `import fs from 'node:fs';
if (process.argv.includes('--selftest')) process.exit(0);
fs.mkdirSync('data', { recursive: true });
fs.appendFileSync('data/started.txt', '${tag}\\n');
setInterval(() => { if (fs.existsSync('data/stop.flag')) process.exit(0); }, 100);
`;

// 저장소 한 버전을 tar.gz로 만든다 (GitHub처럼 맨 위에 폴더 하나)
function makeTarball(dir, files) {
  const top = path.join(dir, 'src', 'today-x');
  fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
  for (const [f, s] of Object.entries(files)) write(path.join(top, f), s);
  const out = path.join(dir, 'repo.tgz');
  const r = spawnSync('tar', ['-czf', 'repo.tgz', '-C', 'src', 'today-x'], { cwd: dir });
  assert.equal(r.status, 0, 'tar로 시험용 묶음 만들기');
  return fs.readFileSync(out);
}
const repoFiles = (tag, extra = {}) => ({
  'bot/main.mjs': FAKE_MAIN(tag),
  'bot/supervisor.mjs': '// sup\n',
  'bot/lib/updater.mjs': '// updater\n',
  'bot/lib/new.mjs': `export const v = '${tag}';\n`,
  'js/core.js': `export const tag = '${tag}';\n`,
  'index.html': `<p>${tag}</p>`,
  ...extra,
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-upd-'));
  const root = path.join(dir, 'root'), here = path.join(root, 'bot'), dataDir = path.join(here, 'data');
  for (const [f, s] of Object.entries(repoFiles('v1'))) write(path.join(root, f), s);
  write(path.join(here, '.env'), 'TELEGRAM_BOT_TOKEN=secret\n');
  write(path.join(dataDir, 'state.json'), '{"owner":7}');
  write(path.join(here, 'node_modules', 'x', 'i.js'), 'keep');
  const remote = { sha: SHA1, message: '첫 버전', tar: null, status: 200 };
  const server = http.createServer((req, res) => {
    if (req.url === '/api') {
      res.writeHead(remote.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sha: remote.sha, commit: { message: remote.message } }));
    }
    res.writeHead(200);
    res.end(remote.tar);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const ctx = { here, root, dataDir, log: m => (logs.push(m), process.env.DBG && console.error('LOG', m)), state: {}, env: { UPDATE_API: `${base}/api`, UPDATE_TARBALL: `${base}/tar` }, poll: 100, backoff: 50, checkEvery: 200 };
  const close = () => (server.close(), fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, root, here, dataDir, remote, ctx, logs, close };
}

test('업데이트: 처음엔 기록만, 새 버전이면 받아서 덮어쓰고 설정·기록은 그대로', async () => {
  const t = await setup();
  try {
    assert.equal(await U.checkAndUpdate(t.ctx), false);
    assert.equal(read(path.join(t.dataDir, 'version.txt')), SHA1, '처음엔 지금 것을 최신으로 기록');
    assert.equal(await U.checkAndUpdate(t.ctx, { asked: true }), false);
    assert.match(read(path.join(t.dataDir, 'notice.txt')), /이미 최신이에요 \(aaaaaaa\)/);

    Object.assign(t.remote, { sha: SHA2, message: '둘째 버전\n\n본문', tar: makeTarball(t.dir, repoFiles('v2', { 'bot/.env': 'TELEGRAM_BOT_TOKEN=evil\n', 'bot/data/state.json': '{}' })) });
    assert.equal(await U.checkAndUpdate(t.ctx), true);
    assert.equal(read(path.join(t.root, 'js/core.js')), "export const tag = 'v2';\n");
    assert.equal(read(path.join(t.root, 'index.html')), '<p>v2</p>');
    assert.match(read(path.join(t.here, 'main.mjs')), /v2/);
    assert.equal(read(path.join(t.here, '.env')), 'TELEGRAM_BOT_TOKEN=secret\n', '.env는 덮어쓰지 않는다');
    assert.equal(read(path.join(t.dataDir, 'state.json')), '{"owner":7}', 'data는 덮어쓰지 않는다');
    assert.equal(read(path.join(t.here, 'node_modules/x/i.js')), 'keep');
    assert.equal(read(path.join(t.dataDir, 'version.txt')), SHA2);
    assert.match(read(path.join(t.dataDir, 'notice.txt')), /새 버전으로 다시 켜졌어요 \(bbbbbbb\)\.\n둘째 버전$/);
    assert.match(read(path.join(t.dataDir, 'backup/js/core.js')), /v1/, '이전 코드를 백업해 둔다');
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'backup/bot/.env')), '백업에 .env를 넣지 않는다');
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'update-tmp')));

    assert.ok(U.rollback(t.ctx));
    assert.match(read(path.join(t.root, 'js/core.js')), /v1/, '되돌리면 이전 코드');
  } finally {
    t.close();
  }
});

test('업데이트: 깨진 버전은 적용하지 않고 건너뛴다. 꺼 두면 확인하지 않는다', async () => {
  const t = await setup();
  try {
    await U.checkAndUpdate(t.ctx);
    Object.assign(t.remote, { sha: SHA2, tar: makeTarball(t.dir, repoFiles('v2', { 'bot/lib/broken.mjs': 'const = ;' })) });
    assert.equal(await U.checkAndUpdate(t.ctx), false);
    assert.match(read(path.join(t.root, 'js/core.js')), /v1/, '지금 코드는 그대로');
    assert.equal(read(path.join(t.dataDir, 'version.txt')), SHA1);
    assert.equal(read(path.join(t.dataDir, 'bad-version.txt')), SHA2);
    assert.match(read(path.join(t.dataDir, 'notice.txt')), /문법 오류: bot\/lib\/broken\.mjs/);
    fs.rmSync(path.join(t.dataDir, 'notice.txt'));
    assert.equal(await U.checkAndUpdate(t.ctx), false, '같은 깨진 버전은 다시 받지 않는다');
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'notice.txt')), '같은 말을 반복하지 않는다');

    Object.assign(t.remote, { sha: SHA3, tar: makeTarball(t.dir, { 'README.md': 'x' }) });
    assert.equal(await U.checkAndUpdate(t.ctx), false, '필요한 파일이 없는 묶음');
    assert.equal(read(path.join(t.dataDir, 'bad-version.txt')), SHA3);

    t.remote.status = 500;
    assert.equal(await U.checkAndUpdate(t.ctx, { asked: true }), false);
    assert.match(read(path.join(t.dataDir, 'notice.txt')), /확인하지 못했어요/);

    Object.assign(t.remote, { status: 200, sha: 'd'.repeat(40), tar: makeTarball(t.dir, repoFiles('v4')) });
    fs.writeFileSync(path.join(t.here, '.env'), 'AUTO_UPDATE=off\n');
    assert.equal(await U.checkAndUpdate(t.ctx), false, 'AUTO_UPDATE=off면 자동으로는 안 받는다');
    assert.equal(await U.checkAndUpdate(t.ctx, { asked: true }), true, '/update로 시키면 받는다');
  } finally {
    t.close();
  }
});

test('감시: 비서를 켜고, 새 버전이 오면 끄고 바꾼 뒤 새 코드로 다시 켠다. 죽으면 다시 켠다', async () => {
  const t = await setup();
  try {
    const started = path.join(t.dataDir, 'started.txt');
    await U.checkAndUpdate(t.ctx); // 지금 버전을 먼저 기록해 둔다
    // 1) 켜진 채로 새 버전이 올라온다
    const run = U.runOnce(t.ctx);
    for (let i = 0; i < 50 && !fs.existsSync(started); i++) await sleep(100);
    assert.equal(read(started), 'v1\n');
    Object.assign(t.remote, { sha: SHA2, message: '둘째', tar: makeTarball(t.dir, repoFiles('v2')) });
    assert.equal(await run, 'updated');
    assert.notEqual(t.ctx.state.child.exitCode, null, '이전 비서는 꺼졌다');
    // 2) 다시 부르면 새 코드가 켜진다
    const run2 = U.runOnce(t.ctx);
    for (let i = 0; i < 50 && read(started) !== 'v1\nv2\n'; i++) await sleep(100);
    assert.equal(read(started), 'v1\nv2\n');
    // 3) 비서가 죽으면 runOnce가 끝나고 (다음 바퀴에서 다시 켠다)
    t.ctx.state.child.kill();
    assert.equal(await run2, 'exited');
    assert.ok(t.logs.some(l => /비서가 꺼졌어요/.test(l)));
    // 4) /update 표시 파일이 있으면 바로 확인한다
    t.ctx.checkEvery = 1e9;
    const run3 = U.runOnce(t.ctx);
    await sleep(300);
    Object.assign(t.remote, { sha: SHA3, message: '셋째', tar: makeTarball(t.dir, repoFiles('v3')) });
    fs.writeFileSync(path.join(t.dataDir, 'update.flag'), '1');
    assert.equal(await run3, 'updated');
    assert.match(read(path.join(t.root, 'js/core.js')), /v3/);
  } finally {
    t.ctx.state.child?.kill();
    t.close();
  }
});

test('감시: 새 버전이 켜지자마자 세 번 죽으면 이전 버전으로 되돌린다', async () => {
  const t = await setup();
  try {
    await U.checkAndUpdate(t.ctx);
    // 문법은 맞지만 켜면 바로 죽는 버전
    const bad = repoFiles('v2', { 'bot/main.mjs': "if (process.argv.includes('--selftest')) process.exit(0);\nprocess.exit(3);\n" });
    Object.assign(t.remote, { sha: SHA2, tar: makeTarball(t.dir, bad) });
    assert.equal(await U.checkAndUpdate(t.ctx), true);
    t.ctx.checkEvery = 1e9;
    for (let i = 0; i < 3; i++) assert.equal(await U.runOnce(t.ctx), 'exited');
    assert.equal(read(path.join(t.dataDir, 'version.txt')), SHA1);
    assert.equal(read(path.join(t.dataDir, 'bad-version.txt')), SHA2);
    assert.match(read(path.join(t.here, 'main.mjs')), /v1/, '이전 코드로 돌아왔다');
    assert.match(read(path.join(t.dataDir, 'notice.txt')), /이전 버전으로 되돌렸어요/);
    assert.equal(await U.checkAndUpdate(t.ctx), false, '그 버전은 다시 받지 않는다');
  } finally {
    t.close();
  }
});

test('설정 읽기', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '﻿# c\r\nAUTO_UPDATE=off\r\nUPDATE_REPO="me/x"\r\n');
  assert.deepEqual(U.readEnv(path.join(dir, '.env')), { AUTO_UPDATE: 'off', UPDATE_REPO: 'me/x' });
  assert.deepEqual(U.readEnv(path.join(dir, 'none')), {});
  fs.rmSync(dir, { recursive: true, force: true });
});
