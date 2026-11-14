// localStorage와 같은 모양의 파일 저장소. 앱의 store.js를 그대로 쓰려고 만든다.
// 바꿀 때마다 임시 파일에 쓰고 바꿔 끼워서, 쓰다 꺼져도 파일이 깨지지 않게 한다.
import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows에서 백신 등이 파일을 잡고 있으면 이름 바꾸기가 실패한다: 그냥 덮어쓴다
    fs.writeFileSync(file, text);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 남아도 다음 저장 때 덮어쓴다 */
    }
  }
}

export class FileStorage {
  // scrub(key, value): 파일에 쓸 때만 값을 바꾼다 (토큰 같은 비밀을 파일에 남기지 않으려고)
  constructor(file, { scrub = null } = {}) {
    this.file = file;
    this.scrub = scrub;
    this.map = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j)) this.map.set(k, String(v));
    } catch {
      /* 처음이거나 깨진 파일: 빈 저장소로 시작하고, 다음 동기화에서 다시 받는다 */
    }
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
    this.save();
  }
  removeItem(k) {
    if (this.map.delete(k)) this.save();
  }
  save() {
    const out = {};
    for (const [k, v] of this.map) out[k] = this.scrub ? this.scrub(k, v) : v;
    writeFileAtomic(this.file, JSON.stringify(out));
  }
}
