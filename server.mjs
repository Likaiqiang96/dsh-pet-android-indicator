#!/usr/bin/env node
/**
 * dsh-pet-screen — 手机全屏只显示鲸鱼娘。
 *
 * 复用 dsh-pet 的 106 段透明动画，按本机 DSH 会话状态切换：
 *   thinking → 思考冒泡 / working → 忙碌点按 / waiting → 踱步张望
 *   done     → 雀跃庆祝 / error   → 垂头叹气 / idle → 待机呼吸（夹杂随机小动作）
 *
 * 页面默认没有面板、没有文字，只有全屏的鲸鱼娘。加 ?hud=1 才显示状态气泡。
 * 不修改 DSH、不需要重启 DSH。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(ROOT, 'assets');
const ASSETS_HD = path.join(ROOT, 'assets-hd');
const ASSETS_LIGHT = path.join(ROOT, 'assets-light');
const ASSETS_DARK = path.join(ROOT, 'assets-dark');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 39100);
const HOST = process.env.HOST || '0.0.0.0';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSION_ROOT = path.join(DSH_HOME, 'sessions');
const TOKEN_FILE = path.join(ROOT, '.token');
const URL_FILE = path.join(ROOT, 'url.txt');
const POLL_MS = 600;
const TAIL_BYTES = 512 * 1024;

fs.mkdirSync(DATA, { recursive: true });

function ensureToken() {
  if (process.env.PET_TOKEN) return process.env.PET_TOKEN.trim();
  try {
    const value = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (value) return value;
  } catch {}
  const value = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, value + '\n', { mode: 0o600 });
  return value;
}
const TOKEN = ensureToken();

/* ------------------------------------------------------------------ */
/* 会话状态解析                                                        */
/* ------------------------------------------------------------------ */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const tailCache = new Map();

/** 会话列表按「最后一次用户提问」排序，避免后台工具写入把别的会话顶上来。 */
function lastPromptAt(sessionId) {
  try {
    const file = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = data?.record?.rows?.sessionListMetadata?.val?.lastPromptAt;
    return typeof value === 'number' ? value : 0;
  } catch { return 0; }
}

function newestSessionFile() {
  const candidates = [];
  let projects;
  try { projects = fs.readdirSync(SESSION_ROOT, { withFileTypes: true }); } catch { return null; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const pdir = path.join(SESSION_ROOT, project.name);
    let sessions;
    try { sessions = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue;
      const file = path.join(pdir, session.name, 'session.v4.jsonl.zstd');
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      candidates.push({ file, id: session.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  let best = null;
  for (const candidate of candidates) {
    const prompt = lastPromptAt(candidate.id);
    candidate.prompt = prompt;
    if (!best || prompt > best.prompt || (prompt === best.prompt && candidate.mtimeMs > best.mtimeMs)) best = candidate;
  }
  return best;
}

function readTail(file, max = TAIL_BYTES) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - max);
  const length = st.size - start;
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }
  return buf;
}

/** 会话文件是一串独立 zstd 帧；从尾部往前逐帧解压，凑够最近事件即可。 */
function decodeTailFrames(buf) {
  const offsets = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i >= 0) {
    offsets.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 1);
  }
  // zstdDecompressSync 会把起点之后的连续帧一起解出来；只解一次，
  // 否则每往前挪一帧都会把后面的内容重复拼进来。
  for (const offset of offsets) {
    try {
      const text = zstdDecompressSync(buf.subarray(offset)).toString('utf8');
      if (text) return text;
    } catch { /* 假帧头，试下一个 */ }
  }
  return '';
}

function readEvents(session) {
  const cached = tailCache.get(session.file);
  if (cached && cached.size === session.size && cached.mtimeMs === session.mtimeMs) return cached.events;
  const text = decodeTailFrames(readTail(session.file));
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.type === 'string') events.push(event);
    } catch { /* 未写完的行 */ }
  }
  const trimmed = events.length > 800 ? events.slice(-800) : events;
  tailCache.set(session.file, { size: session.size, mtimeMs: session.mtimeMs, events: trimmed });
  if (tailCache.size > 12) tailCache.delete(tailCache.keys().next().value);
  return trimmed;
}

function textOf(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

function parseArgs(raw) {
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
}

const TOOL_LABELS = {
  bash: '运行命令', bash_persistent: '运行命令', read: '读文件', read_image: '看图', write: '写文件', edit: '改文件',
  grep: '搜索代码', glob: '找文件', web_search: '联网搜索', web_fetch: '抓取网页',
  subagent: '派子任务', job_output: '等后台任务', todo_write: '更新清单', ask_user_question: '等你确认',
  present: '交付文件', workflow: '跑工作流', skill: '加载技能', create_goal: '设定目标',
};

function toolDetail(name, args) {
  const pick = (...keys) => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim());
  let detail = '';
  if (name === 'bash' || name === 'bash_persistent' || name === 'pwsh') {
    detail = pick('description', 'command') || String(args?.command || '');
  } else if (['read', 'read_image', 'write', 'edit'].includes(name)) {
    detail = pick('file_path', 'path') || '';
  } else if (name === 'grep') {
    const where = pick('path', 'include');
    detail = (args?.pattern || '') + (where ? ` @ ${where}` : '');
  } else if (name === 'glob') {
    detail = args?.pattern || '';
  } else if (name === 'web_search') {
    detail = Array.isArray(args?.queries) ? args.queries.join(' / ') : pick('query') || '';
  } else if (name === 'web_fetch') {
    detail = pick('url') || '';
  } else if (name === 'subagent' || name === 'subagent_fork') {
    detail = pick('description') || '';
  } else if (name === 'job_output' || name === 'job_kill') {
    detail = pick('job_id') || '';
  } else {
    detail = Object.keys(args || {}).slice(0, 3).join(', ');
  }
  detail = String(detail).replace(/\s+/g, ' ').trim();
  return detail.length > 180 ? detail.slice(0, 179) + '…' : detail;
}

function cleanOutput(text) {
  return String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function shortTitle(title) {
  const value = String(title || '').replace(/\s+/g, ' ').trim();
  return value.length > 42 ? value.slice(0, 41) + '…' : value;
}

function cachedTitle(sessionId) {
  try {
    const file = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const title = data?.record?.rows?.title?.val;
    return typeof title === 'string' ? title : '';
  } catch { return ''; }
}

function buildStatus(session, events) {
  let title = '';
  let lastReasoning = '';
  let lastText = '';
  let turnActive = false;
  let turnStart = 0;
  let lastTurnEnd = null;
  let step = 0;
  let turnNumber = 0;
  let lastEventTime = session.mtimeMs;
  let waiting = false;
  let stepStart = 0;
  let lastUsage = null;
  let lastModel = '';
  let lastTTFT = null;
  let lastStepMs = null;
  let lastTps = null;
  let lastAssistantAt = 0;
  let sumInput = 0;
  let sumOutput = 0;
  let sumCache = 0;
  let sumTotal = 0;
  let usageSteps = 0;
  const calls = [];
  const callById = new Map();
  const resultById = new Map();

  for (const event of events) {
    const time = Number(event.time) || 0;
    if (time) lastEventTime = time;
    const data = event.data || {};
    switch (event.type) {
      case 'session/title':
        if (data.title) title = String(data.title);
        break;
      case 'turn/start':
        turnActive = true; turnStart = time || Date.now(); waiting = false;
        break;
      case 'turn/end':
        turnActive = false;
        lastTurnEnd = { time: time || Date.now(), reason: data.reason?.kind || 'completed' };
        break;
      case 'step/start':
        if (typeof data.step === 'number') step = data.step;
        if (typeof data.turn === 'number') turnNumber = data.turn;
        stepStart = time || 0;
        break;
      case 'assistant/message': {
        if (typeof data.step === 'number') step = data.step;
        if (typeof data.turn === 'number') turnNumber = data.turn;
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) lastReasoning = part.text.trim();
            else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lastText = part.text.trim();
          }
        }
        const usage = data.usage || {};
        if (typeof usage.outputTokens === 'number') {
          lastUsage = usage;
          lastModel = String(data.message?.source?.model || lastModel || '');
          lastAssistantAt = time || lastAssistantAt;
          usageSteps++;
          sumInput += Number(usage.inputTokens) || 0;
          sumOutput += Number(usage.outputTokens) || 0;
          sumCache += Number(usage.cacheReadTokens) || 0;
          sumTotal += Number(usage.totalTokens) || 0;
        }
        const stream = Array.isArray(data.stream) ? data.stream : [];
        const times = stream.map(item => Number(item.time)).filter(Boolean);
        if (times.length) {
          const first = Math.min(...times);
          const last = Math.max(...times);
          if (stepStart) lastTTFT = Math.max(0, first - stepStart);
          const genMs = Math.max(0, last - first);
          if (usage.outputTokens > 0 && genMs > 200) lastTps = usage.outputTokens / (genMs / 1000);
          if (stepStart) lastStepMs = Math.max(0, time - stepStart);
        }
        break;
      }
      case 'tool/call': {
        const call = {
          id: data.callId || `${time}:${calls.length}`,
          name: String(data.name || 'tool'),
          args: parseArgs(data.arguments),
          time: time || Date.now(),
          step: typeof data.step === 'number' ? data.step : step,
          turn: typeof data.turn === 'number' ? data.turn : turnNumber,
          done: false,
        };
        calls.push(call);
        callById.set(call.id, call);
        break;
      }
      case 'tool/result': {
        const id = data.toolCallId || data.message?.toolCallId || data.message?.source?.callId;
        const outcome = { text: cleanOutput(textOf(data.message)), isError: !!data.message?.isError, time: time || Date.now() };
        resultById.set(id, outcome);
        const call = callById.get(id);
        if (call) call.done = true;
        break;
      }
      case 'approval/request':
      case 'user-question/request':
        waiting = true;
        break;
      default:
        break;
    }
  }

  const callList = [...callById.values()];
  const pendingCall = [...callList].reverse().find(call => !call.done) || null;
  const lastCall = callList[callList.length - 1] || null;
  const activeCall = pendingCall || lastCall;
  const activeResult = activeCall ? resultById.get(activeCall.id) || null : null;
  const now = Date.now();
  const ageSec = Math.max(0, (now - lastEventTime) / 1000);
  const running = !!pendingCall;
  const recentError = activeResult?.isError && now - activeResult.time < 8000;

  let state;
  if (waiting) state = 'waiting';
  else if (recentError) state = 'error';
  else if (running) state = 'working';
  else if (turnActive) state = 'thinking';
  else if (lastTurnEnd && now - lastTurnEnd.time < 9000 && lastTurnEnd.reason === 'completed') state = 'done';
  else state = 'idle';
  if (ageSec > 900 && state !== 'done') state = 'idle';

  const recentCalls = callList.filter(call => !turnNumber || call.turn === turnNumber).slice(-4);
  const steps = recentCalls.map(call => {
    const outcome = resultById.get(call.id);
    return {
      id: call.id,
      step: call.step || 0,
      name: call.name,
      label: TOOL_LABELS[call.name] || call.name,
      detail: toolDetail(call.name, call.args),
      status: outcome ? (outcome.isError ? 'error' : 'done') : 'running',
      time: call.time,
      output: outcome ? outcome.text.slice(-300) : '',
    };
  });
  const label = activeCall ? (TOOL_LABELS[activeCall.name] || activeCall.name) : '';
  const detail = activeCall ? toolDetail(activeCall.name, activeCall.args) : '';
  const durationSec = turnStart && lastTurnEnd ? Math.round((lastTurnEnd.time - turnStart) / 1000) : 0;
  const headline = state === 'thinking' ? `思考中 · 第 ${step || 1} 步`
    : state === 'working' ? `执行中 · ${label}${detail ? ' · ' + detail.slice(0, 28) : ''}`
      : state === 'done' ? `完成${durationSec ? ` · 用时 ${durationSec}s` : ''}`
        : state === 'error' ? `出错了 · ${label || '工具返回错误'}`
          : state === 'waiting' ? '等你确认'
            : '空闲';

  return {
    sessionId: session.id,
    title: shortTitle(title || cachedTitle(session.id) || '当前会话'),
    state,
    mood: state === 'done' ? 'happy' : state,
    active: ['thinking', 'working', 'waiting', 'error'].includes(state),
    headline,
    thinking: lastReasoning,
    finalText: lastText,
    tool: activeCall ? {
      name: activeCall.name,
      label: label || activeCall.name,
      detail,
      running,
      output: activeResult?.text?.slice(-1600) || '',
      isError: !!activeResult?.isError,
    } : null,
    step,
    steps,
    turn: turnNumber,
    updatedAt: Math.round(lastEventTime),
    age: Math.round(ageSec),
    rev: events.length,
    inference: {
      model: lastModel,
      tokPerSec: lastTps,
      ttftMs: lastTTFT,
      stepMs: lastStepMs,
      inputTokens: lastUsage?.inputTokens ?? null,
      outputTokens: lastUsage?.outputTokens ?? null,
      cacheReadTokens: lastUsage?.cacheReadTokens ?? null,
      totalTokens: lastUsage?.totalTokens ?? null,
      sumInput, sumOutput, sumCache, sumTotal, steps: usageSteps,
      at: lastAssistantAt,
    },
  };
}

function allSessions() {
  const list = [];
  let projects;
  try { projects = fs.readdirSync(SESSION_ROOT, { withFileTypes: true }); } catch { return list; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const pdir = path.join(SESSION_ROOT, project.name);
    let sessions;
    try { sessions = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue;
      const file = path.join(pdir, session.name, 'session.v4.jsonl.zstd');
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      list.push({ file, id: session.name, mtimeMs: st.mtimeMs, size: st.size, prompt: lastPromptAt(session.name) });
    }
  }
  return list;
}

function sessionTitle(sessionId) {
  try {
    const file = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const title = data?.record?.rows?.title?.val;
    return typeof title === 'string' && title.trim() ? title : '未命名会话';
  } catch { return '未命名会话'; }
}

function listRecentSessions(limit = 12) {
  const list = allSessions();
  list.sort((a, b) => (b.prompt || b.mtimeMs) - (a.prompt || a.mtimeMs));
  return list.slice(0, limit).map(item => ({
    id: item.id,
    title: sessionTitle(item.id),
    lastPromptAt: item.prompt || 0,
    mtime: Math.round(item.mtimeMs),
  }));
}

function findSessionFile(sessionId) {
  if (!sessionId || !/^session-[A-Za-z0-9-]+$/.test(sessionId)) return null;
  return allSessions().find(item => item.id === sessionId) || null;
}

let cpuSnapshot = os.cpus().map(core => ({
  idle: core.times.idle,
  total: Object.values(core.times).reduce((sum, value) => sum + value, 0),
}));

function sampleCpu() {
  const now = os.cpus().map(core => ({
    idle: core.times.idle,
    total: Object.values(core.times).reduce((sum, value) => sum + value, 0),
  }));
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < now.length && i < cpuSnapshot.length; i++) {
    idleDelta += now[i].idle - cpuSnapshot[i].idle;
    totalDelta += now[i].total - cpuSnapshot[i].total;
  }
  cpuSnapshot = now;
  return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;
}

function sampleMemory() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalKb = Number((text.match(/^MemTotal:\s+(\d+)/m) || [])[1]) || 0;
    const availableKb = Number((text.match(/^MemAvailable:\s+(\d+)/m) || [])[1]) || 0;
    if (totalKb > 0) {
      const total = totalKb * 1024;
      const used = Math.max(0, total - availableKb * 1024);
      return { total, used, percent: Math.round(used / total * 1000) / 10 };
    }
  } catch { /* fall through */ }
  const total = os.totalmem();
  const used = total - os.freemem();
  return { total, used, percent: Math.round(used / total * 1000) / 10 };
}

function sampleSystem() {
  return {
    cpu: sampleCpu(),
    memory: sampleMemory(),
    load: Math.round(os.loadavg()[0] * 100) / 100,
    cores: os.cpus().length,
    uptime: Math.round(os.uptime()),
    host: os.hostname(),
  };
}

const balanceCache = { ts: 0, data: null, error: '' };

function deepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-web.env'), 'utf8');
    const match = text.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* no key */ }
  return '';
}

async function queryBalance(force = false) {
  if (!force && balanceCache.data && Date.now() - balanceCache.ts < 55000) return balanceCache.data;
  const key = deepseekKey();
  if (!key) return { ok: false, error: '未找到 DEEPSEEK_API_KEY' };
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const payload = await response.json();
    const wallets = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
    const wallet = wallets.find(item => item.currency === 'CNY') || wallets[0] || {};
    const data = {
      ok: true,
      available: !!payload.is_available,
      currency: wallet.currency || 'CNY',
      total: Number(wallet.total_balance) || 0,
      granted: Number(wallet.granted_balance) || 0,
      toppedUp: Number(wallet.topped_up_balance) || 0,
      ts: Date.now(),
    };
    balanceCache.data = data; balanceCache.ts = Date.now(); balanceCache.error = '';
    return data;
  } catch (error) {
    balanceCache.error = String(error?.message || error);
    if (balanceCache.data) return { ...balanceCache.data, stale: true, error: balanceCache.error };
    return { ok: false, error: balanceCache.error };
  }
}

let latest = null;
let latestJSON = '';

function pollStatus() {
  const system = sampleSystem();
  const session = newestSessionFile();
  if (!session) {
    latest = { sessionId: '', title: 'DSH', state: 'idle', mood: 'idle', active: false, headline: '空闲', thinking: '', tool: null, step: 0, updatedAt: Date.now(), age: 0, rev: 0, system, inference: null };
    latestJSON = JSON.stringify(latest);
    return;
  }
  const events = readEvents(session);
  const status = buildStatus(session, events);
  status.system = system;
  const payload = JSON.stringify(status);
  if (payload !== latestJSON) {
    latestJSON = payload;
    latest = status;
    broadcast(status);
  }
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

const clients = new Set();

function broadcast(status) {
  const payload = `data: ${JSON.stringify(status)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, 15000).unref();

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const animLogPath = path.join(DATA, 'anim.log');
const animCounts = new Map();
const animRecent = [];
let animTotal = 0;

function recordAnim(name, kind, state) {
  if (typeof name !== 'string' || !name) return;
  const safeKind = typeof kind === 'string' ? kind.slice(0, 32) : 'unknown';
  const safeState = typeof state === 'string' ? state.slice(0, 24) : '';
  const entry = { ts: Date.now(), name: name.slice(0, 80), kind: safeKind, state: safeState };
  animTotal++;
  const key = safeKind + ' | ' + entry.name;
  animCounts.set(key, (animCounts.get(key) || 0) + 1);
  animRecent.push(entry);
  if (animRecent.length > 200) animRecent.shift();
  fs.appendFile(animLogPath, JSON.stringify(entry) + '\n', () => {});
}

function authorized(req, url) {
  const query = url.searchParams.get('t');
  if (query && query === TOKEN) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some(part => part.trim() === `dsh_screen=${TOKEN}`);
}

async function serveFile(req, res, file, type, extraHeaders = {}) {
  let stat;
  try { stat = await fsp.stat(file); } catch { res.writeHead(404).end('not found'); return; }
  if (stat.isDirectory()) { res.writeHead(404).end('not found'); return; }
  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    res.end();
    return;
  }
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size) start = stat.size - 1;
      if (end >= stat.size) end = stat.size - 1;
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        etag,
        'x-content-type-options': 'nosniff',
        ...extraHeaders,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  const headers = {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, relative);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(404).end(); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, res, file, type);
}

async function serveLight(req, res, pathname) {
  const relative = pathname.slice('/light/'.length);
  const file = path.resolve(ASSETS_LIGHT, relative);
  if (file !== ASSETS_LIGHT && !file.startsWith(ASSETS_LIGHT + path.sep)) { res.writeHead(404).end(); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, res, file, type, { 'access-control-allow-origin': '*' });
}

async function serveDark(req, res, pathname) {
  const relative = pathname.slice('/dark/'.length);
  const file = path.resolve(ASSETS_DARK, relative);
  if (file !== ASSETS_DARK && !file.startsWith(ASSETS_DARK + path.sep)) { res.writeHead(404).end(); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, res, file, type, { 'access-control-allow-origin': '*' });
}

async function serveAsset(req, res, pathname) {
  const relative = pathname.slice('/assets/'.length);
  const hd = path.resolve(ASSETS_HD, relative);
  const sd = path.resolve(ASSETS, relative);
  let file = null;
  if (hd !== ASSETS_HD && hd.startsWith(ASSETS_HD + path.sep)) {
    try { if ((await fsp.stat(hd)).isFile()) file = hd; } catch {}
  }
  if (!file) {
    if (sd !== ASSETS && !sd.startsWith(ASSETS + path.sep)) { res.writeHead(404).end(); return; }
    file = sd;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return serveFile(req, res, file, type, { 'access-control-allow-origin': '*' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  console.log(`${new Date().toISOString()} ${req.method} ${pathname} ${(req.headers['user-agent'] || '-').slice(0, 48)}`);

  if (pathname === '/' && url.searchParams.get('t') === TOKEN) {
    res.setHeader('set-cookie', `dsh_screen=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }

  const publicAsset = pathname.startsWith('/assets/') || pathname.startsWith('/light/') || pathname.startsWith('/dark/');
  const publicStatic = pathname === '/animations.json';
  if (!publicAsset && !publicStatic && !authorized(req, url)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('需要访问令牌：请使用启动时打印的带 ?t=… 的地址打开。\n');
    return;
  }

  try {
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      if (latest) res.write(`data: ${latestJSON}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (pathname === '/api/status') {
      const sessionId = url.searchParams.get('session');
      if (sessionId) {
        const file = findSessionFile(sessionId);
        if (!file) return json(res, { error: 'session not found' }, 404);
        const status = buildStatus(file, readEvents(file));
        status.system = sampleSystem();
        return json(res, status);
      }
      if (!latest) pollStatus();
      return json(res, latest);
    }
    if (pathname === '/api/sessions') {
      return json(res, { sessions: listRecentSessions(12) });
    }
    if (pathname === '/api/balance') {
      return json(res, await queryBalance(url.searchParams.get('force') === '1'));
    }
    if (pathname === '/api/assets') {
      const files = [];
      let totalBytes = 0;
      const hash = crypto.createHash('sha1');
      for (const [theme, dir] of [['light', ASSETS_LIGHT], ['dark', ASSETS_DARK]]) {
        let names = [];
        try { names = fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).sort(); } catch { continue; }
        for (const file of names) {
          const full = path.join(dir, file);
          const st = fs.statSync(full);
          const name = file.slice(0, -4);
          files.push({ theme, name, size: st.size });
          totalBytes += st.size;
          hash.update(theme + ':' + name + ':' + st.size + ':' + Math.round(st.mtimeMs) + '\n');
        }
      }
      return json(res, { ok: true, version: hash.digest('hex').slice(0, 16), totalBytes, count: files.length, files });
    }
    if (pathname === '/api/anim-log' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}');
        recordAnim(body.name, body.kind, body.state);
        return json(res, { ok: true });
      } catch (error) {
        return json(res, { ok: false, error: String(error?.message || error) }, 400);
      }
    }
    if (pathname === '/api/anim-log' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      if (name) recordAnim(name, url.searchParams.get('kind') || 'beacon', url.searchParams.get('state') || '');
      const counts = [...animCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
      return json(res, { ok: true, total: animTotal, counts, recent: animRecent.slice(-60) });
    }
    if (pathname === '/api/health') return json(res, { ok: true, clients: clients.size });
    if (pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        name: '鲸鱼娘 · 全屏',
        short_name: '鲸鱼娘',
        start_url: `/?t=${TOKEN}`,
        display: 'fullscreen',
        orientation: 'portrait',
        background_color: '#071018',
        theme_color: '#071018',
        icons: [{ src: '/assets/logo.png', sizes: '256x256', type: 'image/png' }],
      }));
      return;
    }
    if (pathname.startsWith('/light/')) return await serveLight(req, res, pathname);
    if (pathname.startsWith('/dark/')) return await serveDark(req, res, pathname);
    if (publicAsset) return await serveAsset(req, res, pathname);
    return await serveStatic(req, res, pathname);
  } catch (error) {
    console.error('[dsh-pet-screen]', error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal error');
  }
});

pollStatus();
setInterval(() => {
  try { pollStatus(); } catch (error) { console.error('[poll]', error.message); }
}, POLL_MS).unref();

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  const preferred = lan.find(ip => ip.startsWith('192.168.')) || lan.find(ip => ip.startsWith('10.')) || lan[0] || '127.0.0.1';
  const url = `http://${preferred}:${PORT}/?t=${TOKEN}`;
  try { fs.writeFileSync(URL_FILE, url + '\n'); } catch {}
  console.log(`[dsh-pet-screen] listening on ${HOST}:${PORT}`);
  console.log(`[dsh-pet-screen] 手机打开: ${url}`);
});
