// 오늘 비서 실행 파일. 사용: node main.mjs  (설정은 같은 폴더의 .env)
// 기록은 data/ 폴더에만 남기고, 토큰은 절대 화면이나 기록 파일에 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../js/store.js';
import { createSync } from '../js/sync.js';
import * as C from '../js/core.js';
import { loadEnv } from './lib/env.mjs';
import { FileStorage, writeFileAtomic } from './lib/filestore.mjs';
import { createTelegram } from './lib/telegram.mjs';
import { createLLM } from './lib/llm.mjs';
import { createBot, newPairCode } from './lib/bot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ----- 기록 파일 (1MB 넘으면 한 번 돌린다) -----
const logFile = path.join(dataDir, 'bot.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map(p => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* 기록 파일을 못 써도 비서는 계속 돈다 */
  }
}

// ----- 설정 -----
const KEYS = ['TELEGRAM_BOT_TOKEN', 'GITHUB_REPO', 'GITHUB_TOKEN', 'LLM_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'WAKE_WEEKDAY', 'WAKE_WEEKEND', 'QUIET_FROM', 'QUIET_TO', 'APP_URL'];
const env = { ...loadEnv(path.join(here, '.env')) };
for (const k of KEYS) if (process.env[k]) env[k] = process.env[k]; // 환경 변수가 있으면 그쪽이 먼저
const need = ['TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO'].filter(k => !env[k]);
if (need.length) {
  log(`설정이 비어 있어요: ${need.join(', ')}. install.cmd를 다시 실행하거나 .env를 채워 주세요.`);
  process.exit(1);
}
const hhmm = v => (/^\d{1,2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim().padStart(5, '0') : null);
const opts = {
  wakeWeekday: hhmm(env.WAKE_WEEKDAY ?? '07:00'),
  wakeWeekend: hhmm(env.WAKE_WEEKEND ?? '08:00'),
  quietFrom: hhmm(env.QUIET_FROM ?? '01:00'),
  quietTo: hhmm(env.QUIET_TO ?? '06:30'),
  appUrl: env.APP_URL || 'https://jmchoi4u.github.io/today/',
};

// ----- 점검만: node main.mjs --check (설치 프로그램이 쓴다) -----
const CHECK = process.argv.includes('--check');

// ----- 한 번에 하나만 돌게 (두 개가 돌면 텔레그램이 409로 막는다) -----
const lockFile = path.join(dataDir, 'bot.lock');
if (!CHECK) try {
  const pid = +fs.readFileSync(lockFile, 'utf8');
  // 돌고 있는 비서는 30초마다 잠금 파일 시각을 새로 한다. 2분 넘게 그대로면 남은 파일로 본다
  // (재부팅 뒤 Windows가 같은 프로세스 번호를 다른 프로그램에 줄 수 있어서 번호만 믿지 않는다)
  const fresh = Date.now() - fs.statSync(lockFile).mtimeMs < 120_000;
  if (pid && pid !== process.pid && fresh) {
    try {
      process.kill(pid, 0);
      log(`이미 실행 중이에요 (pid ${pid}). 이 창은 닫아도 돼요.`);
      process.exit(0);
    } catch {
      /* 그 프로세스는 이미 없다: 이어서 실행 */
    }
  }
} catch {
  /* 잠금 파일 없음 */
}
if (!CHECK) fs.writeFileSync(lockFile, String(process.pid));
const unlock = () => {
  if (CHECK) return;
  try {
    if (+fs.readFileSync(lockFile, 'utf8') === process.pid) fs.unlinkSync(lockFile);
  } catch {
    /* 이미 지워짐 */
  }
};

// ----- 상태 (주인, 보낸 알림, 기다리는 답) -----
const stateFile = path.join(dataDir, 'state.json');
let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch {
  state = {};
}
const save = () => writeFileAtomic(stateFile, JSON.stringify(state, null, 1));

// ----- 앱과 같은 저장소와 동기화 -----
const storage = new FileStorage(path.join(dataDir, 'store.json'));
// 60일 지난 날짜 기록은 기기에서 지운다 (원격 저장소에는 그대로 있다)
const keepFrom = C.addDays(C.dayKey(Date.now()), -60);
for (let i = storage.length - 1; i >= 0; i--) {
  const k = storage.key(i);
  if (k?.startsWith('today.day.') && k.slice(10) < keepFrom) storage.removeItem(k);
}
const store = createStore({ storage });
const repo = String(env.GITHUB_REPO).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
const gh = store.local().gh;
if (!gh || gh.repo !== repo || gh.token !== env.GITHUB_TOKEN) {
  // 처음이거나 바뀐 경우: 원격을 받기만 한다 (이 기기에서 만든 기본값으로 원격을 덮지 않게 markAllDirty는 하지 않는다)
  store.setLocal({ gh: { repo, token: env.GITHUB_TOKEN }, shas: {}, etags: {} }, true);
}
const sync = createSync({
  store,
  // 브라우저 전용 옵션(cache, keepalive)은 빼고, 응답이 멈추면 30초 뒤 끊는다
  fetchFn: (url, o = {}) => {
    const { cache: _c, keepalive: _k, ...rest } = o;
    return fetch(url, { ...rest, signal: AbortSignal.timeout(30_000) });
  },
  todayKey: () => C.dayKey(Date.now(), store.config().prefs?.rollover ?? 4),
  onStatus: s => {
    if (s.state === 'error' || s.state === 'offline') log(`동기화: ${s.msg}`);
  },
});

const tg = createTelegram({ token: env.TELEGRAM_BOT_TOKEN });
const llm = createLLM({
  provider: env.LLM_PROVIDER || 'gemini',
  geminiKey: env.GEMINI_API_KEY,
  geminiModel: env.GEMINI_MODEL || 'gemini-flash-latest',
  claudeKey: env.ANTHROPIC_API_KEY,
  claudeModel: env.CLAUDE_MODEL || 'claude-opus-5-5',
});
const bot = createBot({ store, sync, tg, llm, state, save, log, opts });

let running = true;
async function shutdown() {
  if (!running) return;
  running = false;
  log('끄는 중: 남은 기록을 올려요');
  try {
    await Promise.race([sync.syncNow({ pull: false }), sleep(8000)]);
  } catch {
    /* 다음 실행 때 올린다 */
  }
  save();
  unlock();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', unlock);
process.on('unhandledRejection', e => log('처리 안 된 오류', e?.message || String(e)));

// 설치 직후 점검: 텔레그램 토큰, 기록 저장소, AI 키를 한 번씩 확인하고 끝낸다
async function check() {
  let ok = true;
  try {
    const me = await tg.getMe();
    console.log(`[OK] 텔레그램 봇 @${me.username}`);
  } catch (e) {
    ok = false;
    console.log(`[X] 텔레그램: ${e.code === 401 || e.code === 404 ? '토큰이 틀렸어요' : e.message}`);
  }
  await sync.syncNow({ pull: true });
  const st = sync.status();
  if (st.state === 'ok') console.log(`[OK] 기록 저장소 ${repo} (항목 ${store.config().items.filter(i => !i.del).length}개)`);
  else {
    ok = false;
    console.log(`[X] 기록 저장소 ${repo}: ${st.msg || '받아 오지 못했어요'}. 토큰의 Repository access(이 저장소)와 Contents 권한(Read and write)을 확인해 주세요.`);
  }
  if (!llm) console.log(`[-] AI: ${env.LLM_PROVIDER === 'none' ? '쓰지 않음' : '키가 없어서 쓰지 않음'} (규칙으로 알아듣는 말만 처리해요)`);
  else {
    try {
      await llm.parse('오늘 상태 알려 줘', { key: 'check', nowText: '점검', items: [], top3: [] });
      console.log(`[OK] AI (${llm.provider})`);
    } catch (e) {
      ok = false;
      console.log(`[X] AI (${llm.provider}): ${e.message}`);
    }
  }
  console.log(state.owner ? '[OK] 텔레그램 대화와 연결돼 있어요' : '[-] 아직 텔레그램과 연결 전이에요 (설치가 끝나면 코드를 알려 드려요)');
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (CHECK) return check();
  log(`오늘 비서 시작 (Node ${process.version}, AI: ${llm ? llm.provider : '없음'})`);
  for (;;) {
    try {
      const me = await tg.getMe();
      log(`텔레그램 봇 @${me.username} 연결됨`);
      break;
    } catch (e) {
      log(`텔레그램 연결 실패: ${e.message}. 토큰을 확인해 주세요. 1분 뒤 다시 해요.`);
      await sleep(60_000);
    }
  }
  await bot.pull(true).catch(e => log('첫 동기화 실패', e.message));
  if (store.local().lastSync) log(`기록 저장소 ${repo} 받아 옴`);

  if (!state.owner) {
    state.pairCode ||= newPairCode();
    state.pairFails = 0;
    save();
    const msg = `\n==============================\n 텔레그램에서 내 봇에게 이렇게 보내 주세요:\n   /start ${state.pairCode}\n==============================\n`;
    console.log(msg);
    fs.writeFileSync(path.join(dataDir, 'PAIRING.txt'), `텔레그램에서 봇에게 보낼 문장: /start ${state.pairCode}\n`);
  } else {
    try {
      fs.unlinkSync(path.join(dataDir, 'PAIRING.txt'));
    } catch {
      /* 없음 */
    }
  }

  // 30초마다 먼저 말 걸 것 확인 (겹쳐 돌지 않게)
  let ticking = false;
  setInterval(async () => {
    try {
      const t = new Date();
      fs.utimesSync(lockFile, t, t); // 살아 있다는 표시
    } catch {
      /* 잠금 파일이 지워졌으면 다시 만든다 */
      try {
        fs.writeFileSync(lockFile, String(process.pid));
      } catch {}
    }
    if (ticking || !running) return;
    ticking = true;
    try {
      await bot.tick();
    } catch (e) {
      log('tick', e.message);
    } finally {
      ticking = false;
    }
  }, 30_000);

  // 텔레그램 받기 (긴 폴링)
  while (running) {
    try {
      const updates = await tg.getUpdates(state.offset, 50);
      for (const u of updates) {
        state.offset = u.update_id + 1;
        save();
        try {
          await bot.handleUpdate(u);
        } catch (e) {
          log('메시지 처리 실패', e.message);
        }
      }
    } catch (e) {
      if (e.code === 409) {
        log('같은 봇이 다른 곳에서도 돌고 있어요 (409). 하나만 켜 두세요. 30초 뒤 다시 해요.');
        await sleep(30_000);
      } else if (e.code === 401 || e.code === 404) {
        log('텔레그램 토큰이 틀렸어요. .env의 TELEGRAM_BOT_TOKEN을 확인해 주세요.');
        await sleep(60_000);
      } else {
        await sleep(e.retryAfter ? e.retryAfter * 1000 : 5000);
      }
    }
  }
}

main().catch(e => {
  log('멈춤', e.message);
  unlock();
  process.exit(1);
});
