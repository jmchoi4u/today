// 오늘 비서 감시 프로그램. 자동 시작이 이 파일을 켠다: node supervisor.mjs
// 하는 일은 lib/updater.mjs에 있고, 여기서는 그 파일을 매번 새로 불러 부르기만 한다.
// (그래야 업데이트로 updater.mjs가 바뀌어도 이 프로그램을 다시 켤 필요가 없다. 이 파일은 되도록 고치지 않는다.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'supervisor.pid'), String(process.pid));

function log(msg) {
  const line = `${new Date().toISOString()} [감시] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(dataDir, 'bot.log'), line + '\n');
  } catch {
    /* 기록을 못 써도 계속 돈다 */
  }
}

const ctx = { here, root: path.resolve(here, '..'), dataDir, log, state: {}, env: {} };

function stop() {
  ctx.state.stopping = true;
  try {
    fs.writeFileSync(path.join(dataDir, 'stop.flag'), '1');
  } catch {}
  setTimeout(() => {
    try {
      ctx.state.child?.kill();
    } catch {}
    process.exit(0);
  }, 8000);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`감시 시작 (Node ${process.version})`);
for (;;) {
  try {
    const m = await import(`${pathToFileURL(path.join(here, 'lib', 'updater.mjs')).href}?t=${Date.now()}`);
    const r = await m.runOnce(ctx);
    if (r === 'stopped') break;
  } catch (e) {
    log(`감시 중 오류: ${e?.message || e}`);
    await new Promise(r => setTimeout(r, 30_000));
  }
}
process.exit(0);
