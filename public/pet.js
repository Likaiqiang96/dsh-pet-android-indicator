/* 全屏鲸鱼娘：播放全部动画、跟随 DSH 状态换动作、点她有回应。 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const HUD = params.get('hud') === '1';
  const FORCED = params.get('anim');
  const PLAYLIST = params.get('playlist') === '1';
  const WEBVIEW = /; wv\)/.test(navigator.userAgent);
  const LIGHT = params.get('theme') === 'light' || (params.get('theme') !== 'dark' && WEBVIEW);
  const SPLIT = WEBVIEW && params.get('layout') !== 'full';
  const WHISPER = SPLIT && params.get('whisper') !== '0';
  if (WEBVIEW) document.body.classList.add('webview');
  if (LIGHT) document.body.classList.add('light');
  if (SPLIT) document.body.classList.add('split');
  if (SPLIT) {
    const dpr = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty('--pet-w', (1280 / dpr) + 'px');
    document.documentElement.style.setProperty('--pet-h', (720 / dpr) + 'px');
    const top = Math.max(0, innerHeight * 0.4 - 720 / dpr + 18);
    document.documentElement.style.setProperty('--pet-top', top + 'px');
  }
  const themeMissing = new Set();
  const DEBUG = params.get('debug') === '1';
  const token = params.get('t') || '';
  const ASSET_BASE = (params.get('assetBase') || '').replace(/\/+$/, '');

  const IDLE = '待机呼吸休闲';
  const STATE_ANIM = {
    thinking: '工作状态-思考冒泡',
    working: '工作状态-忙碌点按',
    waiting: '工作状态-原地踱步张望',
    done: '工作状态-雀跃庆祝',
    error: '工作状态-垂头叹气冒汗',
  };
  // 思考：问号冒泡为主，偶尔“深度思考碎碎念”（头顶思考气泡）；工作：忙碌/整理轮换。
  const STATE_POOLS = {
    thinking: ['工作状态-思考冒泡', '工作状态-思考冒泡', '深度思考碎碎念'],
    working: ['工作状态-忙碌点按', '工作状态-清点归档'],
    waiting: ['工作状态-原地踱步张望'],
  };
  const HEART_CLICK = '点击回应-开心跃动';
  // 与 dsh-pet 的 animationWeights 对齐：idle 10 / turn 5 / move 5 / 其余按分类权重。
  const FALLBACK = {
    idle: [IDLE], turn: ['东张西望'],
    clicks: ['点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气', '点击回应-挠痒咯咯笑', '点击回应-元气挥手'],
    workStatus: Object.values(STATE_ANIM),
    whisper: [],
    categories: [
      { id: '小动作', weight: 20, actions: ['悠闲哼歌', '哈欠连天', '照镜子', '摇扇纳凉'] },
      { id: '玩耍', weight: 20, actions: ['原地专心玩魔方', '鲸鱼吐泡泡特效', '优雅女仆舞', '蓝鲸现世'] },
      { id: '吃什么', weight: 16, actions: ['吃白饭', '吃西瓜', '涮火锅'] },
      { id: '时节', weight: 14, actions: ['放烟花', '堆雪人'] },
      { id: '文字', weight: 10, actions: ['深度思考碎碎念'] },
    ],
  };

  const videos = [document.getElementById('pet-a'), document.getElementById('pet-b')];
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const splitPanel = document.getElementById('split-status');
  const ssState = document.getElementById('ss-state');
  const ssSession = document.getElementById('ss-session');
  const ssThink = document.getElementById('ss-think');
  const ssTool = document.getElementById('ss-tool');
  const ssSteps = document.getElementById('ss-steps');
  const ssExec = document.getElementById('ss-exec');
  const ssEmpty = document.getElementById('ss-empty');
  const ssMeta = document.getElementById('ss-meta');
  const ssAge = document.getElementById('ss-age');
  const ssLive = document.getElementById('ss-live');
  const mCpu = document.getElementById('m-cpu');
  const mMem = document.getElementById('m-mem');
  const mTps = document.getElementById('m-tps');
  const mTok = document.getElementById('m-tok');
  const mBal = document.getElementById('m-bal');
  const mSub = document.getElementById('m-sub');
  const whisperEl = document.getElementById('whisper');
  const whisperText = document.getElementById('whisper-text');
  const ssSwitch = document.getElementById('ss-switch');
  const themeToggle = document.getElementById('theme-toggle');
  const topClock = document.getElementById('clock');
  const topBattery = document.getElementById('battery');
  const batteryFill = topBattery ? topBattery.querySelector('.fill') : null;
  const batteryText = topBattery ? topBattery.querySelector('b') : null;
  const configButton = document.getElementById('config-btn');
  const sessionSheet = document.getElementById('session-sheet');
  const sheetList = document.getElementById('sheet-list');
  const preloads = [];
  let manifest = FALLBACK;
  let front = 0;
  let currentName = '';
  let generation = 0;
  let oneShot = false;
  let afterOneShot = null;
  let state = 'idle';
  let status = null;
  let idleTimer = 0;
  let tapped = false;
  let recent = [];
  let whisperTimer = 0;
  let whisperHide = 0;
  let lastStepsSig = '';
  let randomPool = [];
  let randomBag = [];
  const animHistory = [];
  let lastStateAnim = '';
  let stateRotationTimer = 0;

  for (const video of videos) {
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.addEventListener('error', () => {
      const name = video.dataset.name;
      const current = video.currentSrc || '';
      const used = current.indexOf('/amoled/') >= 0 ? 'amoled' : current.indexOf('/dark/') >= 0 ? 'dark' : current.indexOf('/light/') >= 0 ? 'light' : '';
      if (LIGHT && name && used) {
        themeMissing.add(used + ':' + name);
        play(name, { force: true, reason: 'fallback' });
      } else if (video.classList.contains('show')) {
        play(IDLE, { force: true, reason: 'fallback' });
      }
    });
  }

  const storedTheme = localStorage.getItem('dsh-pet.theme');
  let theme = storedTheme === 'dark' || storedTheme === 'amoled' ? storedTheme : 'light';
  const uiTheme = params.get('uiTheme');
  if (uiTheme === 'light' || uiTheme === 'dark' || uiTheme === 'amoled') theme = uiTheme;

  function themeDir(value) {
    return value === 'dark' ? '/dark/' : value === 'amoled' ? '/amoled/' : '/light/';
  }

  function assetUrl(name) {
    if (LIGHT) {
      if (!themeMissing.has(theme + ':' + name)) {
        return ASSET_BASE + themeDir(theme) + encodeURIComponent(name) + '.mp4';
      }
      const fallback = theme === 'amoled' ? 'dark' : theme === 'dark' ? 'light' : 'dark';
      if (!themeMissing.has(fallback + ':' + name)) {
        return ASSET_BASE + themeDir(fallback) + encodeURIComponent(name) + '.mp4';
      }
    }
    return '/assets/' + encodeURIComponent(name) + '.webm';
  }

  let debugNode = null;
  if (DEBUG) {
    debugNode = document.createElement('pre');
    debugNode.style.cssText = 'position:fixed;left:6px;top:6px;z-index:999;margin:0;padding:8px;max-width:96vw;background:rgba(0,0,0,.75);color:#9fe;font:10px/1.4 monospace;white-space:pre-wrap;border-radius:8px;pointer-events:none';
    document.body.appendChild(debugNode);
    setInterval(() => {
      const v = videos[front];
      debugNode.textContent = [
        'ua=' + navigator.userAgent.slice(0, 80),
        'src=' + decodeURIComponent((v.currentSrc || '').split('/').pop() || '-'),
        'ready=' + v.readyState + ' net=' + v.networkState + ' err=' + (v.error ? v.error.code + ':' + v.error.message : '-'),
        'size=' + v.videoWidth + 'x' + v.videoHeight + ' paused=' + v.paused,
        'class=' + v.className + ' opacity=' + getComputedStyle(v).opacity + ' h=' + getComputedStyle(v).height,
        'vw=' + innerWidth + ' vh=' + innerHeight + ' rect=' + [v.getBoundingClientRect().x, v.getBoundingClientRect().y, v.getBoundingClientRect().width, v.getBoundingClientRect().height].map(n => Math.round(n)).join(','),
        'display=' + getComputedStyle(v).display + ' vis=' + getComputedStyle(v).visibility + ' blend=' + getComputedStyle(v).mixBlendMode + ' z=' + getComputedStyle(v).zIndex,
        'top@ =' + (function () { var hit = document.elementFromPoint(innerWidth / 2, innerHeight * 0.75); return hit ? (hit.id || hit.tagName) : '-'; })(),
      ].join('\n');
    }, 800);
  }

  function play(name, { once = false, after = null, force = false, reason = 'auto' } = {}) {
    if (!name) return;
    if (name === currentName && !once && !force) return;
    animHistory.push({ name, reason, at: Date.now() });
    if (animHistory.length > 40) animHistory.shift();
    try {
      const logQuery = tokenQuery();
      logQuery.set('name', name);
      logQuery.set('kind', reason);
      logQuery.set('state', state);
      logQuery.set('ts', String(Date.now()));
      const beacon = new Image();
      beacon.src = '/api/anim-log?' + logQuery.toString();
    } catch { /* ignore */ }
    const gen = ++generation;
    const nextIndex = 1 - front;
    const next = videos[nextIndex];
    const old = videos[front];

    oneShot = once;
    afterOneShot = after;
    next.loop = !once;
    old.onended = null;
    next.onended = once
      ? () => {
        if (gen !== generation) return;
        oneShot = false;
        const callback = afterOneShot;
        afterOneShot = null;
        if (callback) callback();
        else resumeState();
      }
      : null;
    next.dataset.name = name;
    next.src = assetUrl(name);
    next.load();

    let revealed = false;
    const reveal = () => {
      if (revealed || gen !== generation) return;
      revealed = true;
      next.classList.add('show');
      old.classList.remove('show');
      front = nextIndex;
      currentName = name;
      setTimeout(() => { if (!old.classList.contains('show')) old.pause(); }, 380);
    };
    next.addEventListener('canplay', reveal, { once: true });
    next.play().catch(() => {});
    setTimeout(() => { if (!revealed && gen === generation) reveal(); }, 600);
  }

  function pick(list, excludeCurrent = true) {
    if (!Array.isArray(list) || !list.length) return null;
    for (let i = 0; i < 10; i++) {
      const name = list[Math.floor(Math.random() * list.length)];
      if (excludeCurrent && (name === currentName || recent.includes(name))) continue;
      recent.push(name);
      if (recent.length > 14) recent.shift();
      return name;
    }
    return list[Math.floor(Math.random() * list.length)] || null;
  }

  function buildRandomPool() {
    const excluded = new Set([...(manifest.workStatus || []), IDLE, ...(manifest.whisper || [])]);
    const coverageExtra = new Set(['工作状态-原地踱步张望']);
    const pool = (manifest.all && manifest.all.length ? manifest.all : []).filter(name => !excluded.has(name) || coverageExtra.has(name));
    if (pool.length) {
      randomPool = pool;
      randomBag = [];
    }
  }

  function nextRandomName() {
    if (!randomPool.length) return null;
    if (!randomBag.length) {
      randomBag = randomPool.slice();
      for (let i = randomBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = randomBag[i];
        randomBag[i] = randomBag[j];
        randomBag[j] = tmp;
      }
    }
    return randomBag.pop();
  }

  function rollAction() {
    if (Math.random() < 0.1) return null; // 继续待机
    return nextRandomName();
  }

  function stateAnimationName() {
    const pool = STATE_POOLS[state] || [STATE_ANIM[state] || IDLE];
    const options = pool.filter(name => name !== lastStateAnim);
    const name = (options.length ? options : pool)[Math.floor(Math.random() * (options.length ? options.length : pool.length))];
    lastStateAnim = name;
    return name;
  }

  function scheduleStateRotation() {
    clearTimeout(stateRotationTimer);
    if (!['thinking', 'working', 'waiting'].includes(state)) return;
    stateRotationTimer = window.setTimeout(() => {
      if (oneShot) { scheduleStateRotation(); return; }
      play(stateAnimationName(), { reason: 'resume' });
      scheduleStateRotation();
    }, 20000 + Math.random() * 10000);
  }

  function resumeState() {
    if (state === 'idle' || state === 'done' || state === 'error') {
      play(IDLE, { reason: 'resume' });
      if (state === 'idle') scheduleIdleAction();
    } else {
      play(stateAnimationName(), { reason: 'resume' });
      scheduleStateRotation();
    }
  }

  function scheduleIdleAction() {
    if (idleTimer || FORCED) return;
    const wait = 7000 + Math.random() * 7000;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      if (FORCED) return;
      if (oneShot) { scheduleIdleAction(); return; }
      if (state === 'idle') {
        const action = rollAction();
        if (!action) { scheduleIdleAction(); return; }
        play(action, { once: true, reason: 'idle-action', after: () => { play(IDLE, { reason: 'idle-action' }); scheduleIdleAction(); } });
        scheduleIdleAction();
        return;
      }
      if (Math.random() < 0.8) {
        const action = nextRandomName();
        if (action) play(action, { once: true, reason: 'interlude', after: resumeState });
      }
      scheduleIdleAction();
    }, wait);
  }


  const fmtPct = value => Number.isFinite(value) ? Math.round(value) + '%' : '—';
  const fmtTok = value => {
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
    if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k';
    return String(Math.round(value));
  };
  const fmtMillions = value => {
    if (!Number.isFinite(value) || value < 0) return '—';
    return (value >= 1e7 ? (value / 1e6).toFixed(1) : (value / 1e6).toFixed(2)) + 'M';
  };

  function updateMetrics(s) {
    if (!SPLIT || !s) return;
    const system = s.system || {};
    const inference = s.inference || {};
    mCpu.textContent = fmtPct(system.cpu);
    const memory = system.memory || {};
    mMem.textContent = fmtPct(memory.percent);
    mTps.textContent = Number.isFinite(inference.tokPerSec) ? Math.round(inference.tokPerSec) + ' t/s' : '—';
    mTok.textContent = Number.isFinite(inference.totalTokens) ? fmtMillions(inference.totalTokens) : '—';
    mTok.title = Number.isFinite(inference.totalTokens) ? inference.totalTokens.toLocaleString('en-US') + ' tokens' : '';
    const parts = [];
    if (Number.isFinite(inference.ttftMs)) parts.push('TTFT ' + (inference.ttftMs / 1000).toFixed(1) + 's');
    if (Number.isFinite(inference.stepMs)) parts.push('步 ' + (inference.stepMs / 1000).toFixed(1) + 's');
    if (Number.isFinite(inference.inputTokens)) parts.push('入 ' + fmtTok(inference.inputTokens));
    if (Number.isFinite(inference.outputTokens)) parts.push('出 ' + fmtTok(inference.outputTokens));
    if (Number.isFinite(inference.cacheReadTokens)) parts.push('缓存 ' + fmtTok(inference.cacheReadTokens));
    if (inference.model) parts.push(inference.model);
    if (system.host) parts.push('远程 ' + system.host);
    mSub.textContent = parts.length ? parts.join(' · ') : '等待推理遥测…';
  }

  function updateSplit(s) {
    if (!SPLIT || !s) return;
    const labels = { idle: '空闲', thinking: '思考中', working: '执行中', done: '完成', error: '出错', waiting: '等你确认' };
    const stateName = s.state || 'idle';
    ssState.textContent = labels[stateName] || stateName;
    ssState.dataset.state = stateName;
    ssSession.textContent = s.title || '当前会话';

    const thinking = (s.thinking || '').trim();
    const muted = !thinking;
    const text = thinking || (stateName === 'thinking' ? '正在思考…（本步文本会在步骤结束时同步）'
      : stateName === 'working' ? '正在执行工具，思考文本会在这步结束后同步。'
        : '暂无新的思考内容。');
    if (ssThink.textContent !== text) {
      const nearBottom = ssThink.scrollHeight - ssThink.scrollTop - ssThink.clientHeight < 30;
      ssThink.textContent = text;
      ssThink.classList.toggle('muted', muted);
      if (nearBottom || muted) ssThink.scrollTop = ssThink.scrollHeight;
    }

    const taskActive = !!s.active && stateName !== 'idle' && stateName !== 'done' && stateName !== 'error';
    if (!taskActive) {
      ssExec.hidden = true;
      ssSteps.hidden = true;
      ssSteps.textContent = '';
      lastStepsSig = '';
      ssTool.hidden = true;
      ssEmpty.hidden = true;
      ssMeta.textContent = s.step ? `第 ${s.step} 步 · 已结束` : '已结束';
      ssAge.textContent = '';
      ssLive.classList.remove('offline');
      return;
    }
    ssExec.hidden = false;

    const steps = Array.isArray(s.steps) ? s.steps : [];
    const stepsSig = steps.map(item => `${item.id}:${item.status}:${item.detail}`).join('|');
    if (stepsSig !== lastStepsSig) {
      lastStepsSig = stepsSig;
      ssSteps.textContent = '';
      steps.slice().reverse().forEach(item => {
        const row = document.createElement('div');
        row.className = 'ss-step ' + item.status;
        const icon = document.createElement('span'); icon.className = 'ico';
        icon.textContent = item.status === 'running' ? '●' : item.status === 'error' ? '×' : '✓';
        const no = document.createElement('span'); no.className = 'no'; no.textContent = item.step ? '#' + item.step : '';
        const name = document.createElement('span'); name.className = 'name'; name.textContent = item.label;
        const detail = document.createElement('span'); detail.className = 'detail'; detail.textContent = item.detail || '';
        row.append(icon, no, name, detail);
        ssSteps.append(row);
      });
      ssSteps.hidden = steps.length === 0;
      ssSteps.scrollTop = 0;
    }

    const tool = s.tool;
    if (tool) {
      ssTool.hidden = false;
      ssTool.querySelector('.name').textContent = tool.label + (tool.running ? ' · 进行中' : ' · 已完成');
      ssTool.querySelector('code').textContent = tool.detail || tool.name;
      ssEmpty.hidden = true;
    } else {
      ssTool.hidden = true;
      ssEmpty.hidden = false;
      ssEmpty.textContent = s.finalText ? '回复已生成' : '暂无工具调用';
    }

    ssMeta.textContent = `${s.step ? `第 ${s.step} 步` : '—'} · ${s.active ? '进行中' : '已结束'}`;
    ssAge.textContent = Number.isFinite(s.age) ? `${s.age}s 前` : '';
    ssLive.classList.remove('offline');
  }

  function applyTheme() {
    document.body.classList.toggle('dark', theme === 'dark' || theme === 'amoled');
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('amoled', theme === 'amoled');
    themeToggle.textContent = theme === 'light' ? '深' : theme === 'dark' ? '黑' : '浅';
    themeToggle.title = theme === 'light' ? '切到深色' : theme === 'dark' ? '切到纯黑 AMOLED' : '切到浅色';
  }

  themeToggle.addEventListener('click', () => {
    const order = ['light', 'dark', 'amoled'];
    theme = order[(order.indexOf(theme) + 1) % order.length];
    localStorage.setItem('dsh-pet.theme', theme);
    applyTheme();
    if (currentName) play(currentName, { force: true, reason: 'theme' });
  });

  const WHISPER_LINES = {
    idle: [
      '你忙你的，我就在这儿待着，不吵你。', '刚刚偷偷打了个哈欠，没被你看到吧…', '尾巴有点麻了，换个姿势…',
      '桌面好安静呀，安静得我有点想说话。', '你要是累了，就看我一会儿，算休息。', '围裙上的鲸鱼今天也很精神。',
      '我刚刚是不是站得太直了？有点不像我。', '想喝点甜的…不过我不需要吃饭，真可惜。',
      '你不在的时候，我就数屏幕上的像素。', '要不要我陪你发会儿呆？', '今天也把自己照顾得很好呢。',
      '我偷偷把裙摆整理了一下，好看吗？', '今天的风好像是从机箱里吹出来的。',
    ],
    thinking: [
      '你在想什么呀？能不能分我一点点…', '这一步好像有点绕，我尾巴都打结了。', '我陪你一起想，虽然我不一定想得出来…',
      '问号都冒出来了，你看见了吗？', '别急，慢慢想，我不催你。', '我刚刚也想出了一个主意，但是忘了。',
      '要不要先喝口水再想？', '你的思路像毛线团，我帮你按住一头。', '我盯着这个问号看久了，它好像在看我。',
      '想不出来也没关系，我也不会。', '这里是不是卡住了？我给你递个小板凳。', '我先把尾巴收好，免得绊到你的思路。',
    ],
    working: [
      '还在忙这一步呢，我在这儿守着。', '键盘声听起来好认真，我都不敢呼吸太大声。', '这一步有点久，我腿都站麻了…',
      '我帮你盯着进度条，虽然我看不太懂。', '你忙你的，我在旁边偷偷给你加油。', '要不要我帮你扇扇风？虽然风扇是 CPU 的。',
      '我刚刚想给你递杯水，发现我递不过去。', '这个工具看起来好复杂，我装作看得懂。', '别一直盯着屏幕，眼睛会酸的。',
      '我数到十，这一步应该就好了吧？一、二…', '如果卡住了，就骂它两句，我帮你瞪它。', '我悄悄把围裙系紧了，准备随时帮忙。',
      '你认真工作的样子，我记下来了。', '忙完这步，记得摸摸我。', '这一步好长，我尾巴都开始打节拍了。',
    ],
    done: [
      '搞定啦！我刚刚紧张得尾巴都绷直了。', '这一轮结束咯，可以摸摸我当奖励吗？', '完成！我偷偷在心里放了个小烟花。',
      '辛苦啦，要不要靠一会儿？', '我刚刚差点鼓掌，但是手太短了。', '任务完成，我的围裙都跟着松了一口气。',
      '要不要休息五分钟？我陪你发呆。', '好耶——我转个圈给你看。', '这步做得真漂亮，我记在小本本上了。',
    ],
    error: [
      '这一步好像没跑通…别急，我陪你再看一眼。', '出错了也不怪你，真的。', '我刚刚看到红字了，假装没看到。',
      '要不要先深呼吸？我陪你。', '卡住就卡住，我们又不是第一次。', '我把尾巴借你捏一下，消消气。',
      '这个错误看起来比我还委屈。', '再试一次吧，我在。', '先别皱眉，皱久了会有印子的。',
    ],
  };
  const WHISPER_ANIMS = ['碎碎念-发呆碎碎念', '碎碎念-对屏碎碎念', '碎碎念-擦桌碎碎念'];
  const whisperRecent = [];

  function contextualWhispers() {
    const lines = [];
    const hour = new Date().getHours();
    const cpu = status && status.system ? status.system.cpu : 0;
    const tps = status && status.inference ? status.inference.tokPerSec : 0;
    const age = status && Number.isFinite(status.age) ? status.age : 0;
    const stepNo = status && status.step ? status.step : 0;
    if (hour >= 0 && hour < 5) lines.push(`都凌晨 ${hour} 点了，我陪你到你说停…不过明天会困哦。`);
    else if (hour >= 5 && hour < 9) lines.push('早上好呀，今天也慢慢来，不着急。');
    else if (hour >= 11 && hour < 14) lines.push('中午了，记得吃饭，别拿我当饭吃。');
    else if (hour >= 22) lines.push('夜深了，要不先睡？我帮你看着这里。');
    if (cpu >= 85) {
      lines.push(`CPU 都 ${Math.round(cpu)}% 了，风扇在唱歌，你听见了吗…`);
      lines.push('机器好烫，我隔空给你吹吹。');
    }
    if (age >= 90 && ['thinking', 'working', 'waiting'].indexOf(state) >= 0) {
      lines.push(`这一步都 ${Math.round(age / 60)} 分钟了，我等到尾巴都僵了…`);
    }
    if (tps >= 60 && (state === 'thinking' || state === 'working')) lines.push(`刚才跑到 ${Math.round(tps)} t/s，比我吃西瓜还快。`);
    if (stepNo >= 20) lines.push(`都第 ${stepNo} 步了，你今天好努力。`);
    return lines;
  }

  function pickWhisperLine() {
    const pool = (WHISPER_LINES[state] || WHISPER_LINES.idle).slice();
    const contextual = contextualWhispers();
    if (contextual.length && Math.random() < 0.45) pool.push(...contextual);
    const options = pool.filter(line => whisperRecent.indexOf(line) < 0);
    const source = options.length ? options : pool;
    const line = source[Math.floor(Math.random() * source.length)];
    whisperRecent.push(line);
    if (whisperRecent.length > 8) whisperRecent.shift();
    return line;
  }

  function hideWhisper() {
    clearTimeout(whisperHide);
    whisperEl.classList.remove('show');
    setTimeout(() => { whisperEl.hidden = true; }, 240);
  }

  function whisperTick() {
    if (!SPLIT) return;
    whisperTimer = window.setTimeout(whisperTick, 18000 + Math.random() * 14000);
    if (oneShot || FORCED) return;
    whisperText.textContent = pickWhisperLine();
    whisperEl.hidden = false;
    requestAnimationFrame(() => whisperEl.classList.add('show'));
    whisperHide = window.setTimeout(hideWhisper, 5600);
    const animation = WHISPER_ANIMS[Math.floor(Math.random() * WHISPER_ANIMS.length)];
    play(animation, { once: true, reason: 'whisper', after: resumeState });
  }

  function applyStatus(next) {
    status = next;
    const nextState = next.state || 'idle';
    updateBubble(next);
    updateSplit(next);
    updateMetrics(next);
    if (nextState === state) {
      if (nextState === 'idle' && !oneShot && !currentName) play(IDLE);
      return;
    }
    state = nextState;
    clearTimeout(stateRotationTimer);
    if (oneShot) { scheduleIdleAction(); return; }
    if (state === 'idle') {
      play(IDLE, { reason: 'state' });
    } else if (state === 'done' || state === 'error') {
      play(STATE_ANIM[state], { once: true, reason: 'state', after: () => { play(IDLE, { reason: 'state' }); } });
    } else {
      play(stateAnimationName(), { reason: 'resume' });
      scheduleStateRotation();
    }
    scheduleIdleAction();
  }

  function updateBubble(s) {
    if (!HUD) return;
    if (!s || s.state === 'idle') {
      bubble.classList.remove('show');
      bubble.hidden = true;
      return;
    }
    let text = '';
    if (s.state === 'thinking') text = `思考中 · 第 ${s.step || 1} 步`;
    else if (s.state === 'working' && s.tool) text = `执行中 · ${s.tool.label}${s.tool.detail ? ' · ' + s.tool.detail.slice(0, 34) : ''}`;
    else if (s.state === 'done') text = '完成啦，休息一下~';
    else if (s.state === 'error') text = '这一步好像没跑通呢…';
    else if (s.state === 'waiting') text = '需要你确认一下哦';
    if (!text) {
      bubble.classList.remove('show');
      bubble.hidden = true;
      return;
    }
    bubbleText.textContent = text;
    bubble.hidden = false;
    requestAnimationFrame(() => bubble.classList.add('show'));
  }

  /* 点击：补播（移动端自动播放限制）+ 全屏 + 回应动画 */
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* 不支持就算了 */ }
  }

  let lastPetTap = 0;

  function isUiTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('#split-status, #metrics, #theme-toggle, #session-sheet, #whisper, #hint, button, a, input, textarea, select, .interactive');
  }

  function onTap(event) {
    if (!tapped) {
      tapped = true;
      document.body.classList.add('tapped');
      const root = document.documentElement;
      if (!document.fullscreenElement && root.requestFullscreen) {
        root.requestFullscreen().catch(() => {});
      }
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('portrait').catch(() => {});
      }
      keepAwake();
    }
    if (videos[front].paused) videos[front].play().catch(() => {});
    if (isUiTarget(event.target)) return;
    if (SPLIT && event.clientY > innerHeight * 0.4) return;
    if (oneShot) return;
    const now = performance.now();
    if (now - lastPetTap < 900) return;
    lastPetTap = now;
    play(HEART_CLICK, { once: true, reason: 'click', after: resumeState });
  }
  document.addEventListener('pointerdown', onTap, { passive: true });
  document.addEventListener('contextmenu', event => event.preventDefault());

  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
  });

  document.addEventListener('visibilitychange', () => {
    const video = videos[front];
    if (document.hidden) {
      video.pause();
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    } else {
      if (video.src) video.play().catch(() => {});
      if (tapped) keepAwake();
    }
  });

  // 提示只留一会儿，之后就是纯画面
  setTimeout(() => { const hint = document.getElementById('hint'); if (hint) hint.style.display = 'none'; }, 7000);

  function preload(names) {
    for (const name of names) {
      if (!name) continue;
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = assetUrl(name);
      preloads.push(video);
    }
  }

  if (SPLIT) {
    splitPanel.hidden = false;
    themeToggle.hidden = false;
  }
  applyTheme();
  if (SPLIT && WHISPER) whisperTimer = window.setTimeout(whisperTick, 6000);

  /* 初始待机 */
  play(IDLE, { reason: 'init' });

  if (FORCED) {
    play(FORCED, { force: true });
    return;
  }

  /* 动画清单：全部分类、点击回应、转向、碎碎念 */
  fetch('/animations.json', { cache: 'no-cache' })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)))
    .then(data => {
      if (data && Array.isArray(data.categories) && data.categories.length) manifest = data;
      if (!manifest.idle.includes(IDLE)) manifest.idle.push(IDLE);
      buildRandomPool();
      if (PLAYLIST) { startPlaylist(); return; }
      preload([IDLE, ...Object.values(STATE_ANIM), manifest.clicks[0]].filter(Boolean));
      scheduleIdleAction();
    })
    .catch(() => {
      preload([IDLE, ...Object.values(STATE_ANIM)]);
      buildRandomPool();
      scheduleIdleAction();
    });

  /* 全部动画轮播：?playlist=1 */
  function startPlaylist() {
    const seen = new Set();
    const all = [];
    const add = list => { for (const name of list || []) if (name && !seen.has(name)) { seen.add(name); all.push(name); } };
    if (manifest.all && manifest.all.length) {
      add(manifest.all);
    } else {
      add(manifest.idle); add(manifest.turn); add(manifest.clicks);
      for (const category of manifest.categories) add(category.actions);
      add(manifest.whisper); add(manifest.balance);
    }
    let index = 0;
    const step = () => {
      const name = all[index % all.length];
      index++;
      document.title = `鲸鱼娘 · ${index}/${all.length}`;
      play(name, { once: true, reason: 'playlist', after: () => { play(IDLE, { reason: 'playlist' }); setTimeout(step, 900); } });
    };
    step();
  }

  /* 状态流：轮询 /api/status，可带 session 固定某个会话 */
  let pinnedSession = params.get('session') || localStorage.getItem('dsh-pet.session') || '';
  let sessions = [];
  let pollTimer = 0;

  function tokenQuery() {
    const query = new URLSearchParams();
    if (token) query.set('t', token);
    return query;
  }

  async function fetchStatus() {
    const query = tokenQuery();
    if (pinnedSession) query.set('session', pinnedSession);
    try {
      const response = await fetch('/api/status?' + query.toString(), { cache: 'no-store' });
      if (response.status === 404 && pinnedSession) {
        pinnedSession = '';
        localStorage.removeItem('dsh-pet.session');
        return fetchStatus();
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      applyStatus(await response.json());
    } catch {
      ssLive.classList.add('offline');
    }
  }

  function startPolling() {
    if (pollTimer) return;
    fetchStatus();
    pollTimer = window.setInterval(fetchStatus, 150);
  }

  async function loadBalance(force = false) {
    const query = tokenQuery();
    if (force) query.set('force', '1');
    try {
      const response = await fetch('/api/balance?' + query.toString(), { cache: 'no-store' });
      const data = await response.json();
      if (!data.ok) { mBal.textContent = '—'; mBal.title = data.error || '余额不可用'; return; }
      const symbol = data.currency === 'CNY' ? '¥' : data.currency === 'USD' ? '$' : data.currency + ' ';
      mBal.textContent = symbol + Number(data.total).toFixed(2);
      mBal.title = `余额 ${symbol}${Number(data.total).toFixed(2)} · 充值 ${symbol}${Number(data.toppedUp).toFixed(2)} · 赠送 ${symbol}${Number(data.granted).toFixed(2)} · 点击刷新`;
    } catch {
      mBal.textContent = '—';
    }
  }
  mBal.addEventListener('click', () => loadBalance(true));

  function relativeTime(ms) {
    if (!ms) return '很久以前';
    const diff = Date.now() - ms;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    return Math.floor(diff / 86400e3) + ' 天前';
  }

  function renderSheet() {
    sheetList.textContent = '';
    const entries = [{ id: '', title: '跟随最新活动会话', when: '自动选择最后收到提问的会话' }].concat(sessions);
    entries.forEach((entry, index) => {
      const item = document.createElement('div');
      item.className = 'sheet-item' + ((entry.id ? entry.id === pinnedSession : !pinnedSession) ? ' selected' : '');
      if (index === 1 && !pinnedSession) item.classList.add('active');
      const dot = document.createElement('span'); dot.className = 'dot';
      const meta = document.createElement('div'); meta.className = 'meta';
      const title = document.createElement('div'); title.className = 'title'; title.textContent = entry.title;
      const when = document.createElement('div'); when.className = 'when'; when.textContent = entry.when || relativeTime(entry.lastPromptAt);
      meta.append(title, when); item.append(dot, meta);
      item.addEventListener('click', () => {
        pinnedSession = entry.id || '';
        if (pinnedSession) localStorage.setItem('dsh-pet.session', pinnedSession);
        else localStorage.removeItem('dsh-pet.session');
        sessionSheet.hidden = true;
        fetchStatus();
        loadSessions();
      });
      sheetList.append(item);
    });
  }

  async function loadSessions() {
    try {
      const response = await fetch('/api/sessions?' + tokenQuery().toString(), { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const all = Array.isArray(data.sessions) ? data.sessions : [];
      const cutoff = Date.now() - 12 * 3600 * 1000;
      const recent = all.filter(item => item.lastPromptAt && item.lastPromptAt >= cutoff);
      if (pinnedSession && !recent.some(item => item.id === pinnedSession)) {
        const pinned = all.find(item => item.id === pinnedSession);
        if (pinned) recent.unshift(pinned);
      }
      sessions = recent;
      ssSwitch.hidden = sessions.length <= 1;
      if (sessions.length <= 1) sessionSheet.hidden = true;
      if (!sessionSheet.hidden) renderSheet();
    } catch { /* 保留旧列表 */ }
  }

  function openSheet() {
    if (sessions.length <= 1) return;
    renderSheet();
    sessionSheet.hidden = false;
  }

  ssSwitch.addEventListener('click', openSheet);
  document.getElementById('ss-session').addEventListener('click', openSheet);
  document.getElementById('sheet-close').addEventListener('click', () => { sessionSheet.hidden = true; });
  sessionSheet.addEventListener('click', event => { if (event.target === sessionSheet) sessionSheet.hidden = true; });


  function updateClock() {
    if (!topClock) return;
    const now = new Date();
    topClock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }

  function setBattery(level, charging) {
    if (!topBattery || !batteryText) return;
    if (!Number.isFinite(level) || level < 0) { topBattery.hidden = true; return; }
    topBattery.hidden = false;
    topBattery.classList.toggle('charging', !!charging);
    topBattery.style.setProperty('--batt', String(Math.max(0, Math.min(100, level))));
    batteryText.textContent = Math.round(level) + '%' + (charging ? ' ⚡' : '');
  }

  function updateBattery() {
    let handled = false;
    try {
      if (window.DshHost && typeof window.DshHost.getBatteryLevel === 'function') {
        const level = Number(window.DshHost.getBatteryLevel());
        const charging = typeof window.DshHost.isCharging === 'function' && window.DshHost.isCharging();
        if (level >= 0) { setBattery(level, charging); handled = true; }
      }
    } catch { /* ignore */ }
    if (handled) return;
    if (navigator.getBattery) {
      navigator.getBattery().then(battery => {
        setBattery(battery.level * 100, battery.charging);
        battery.addEventListener('levelchange', () => setBattery(battery.level * 100, battery.charging));
        battery.addEventListener('chargingchange', () => setBattery(battery.level * 100, battery.charging));
      }).catch(() => { if (topBattery) topBattery.hidden = true; });
    } else if (topBattery) {
      topBattery.hidden = true;
    }
  }

  if (configButton) {
    configButton.addEventListener('click', () => {
      try {
        if (window.DshHost && typeof window.DshHost.openConfig === 'function') window.DshHost.openConfig();
      } catch { /* ignore */ }
    });
  }
  updateClock();
  updateBattery();
  window.setInterval(updateClock, 1000);
  window.setInterval(updateBattery, 30000);

  if (!PLAYLIST) {
    startPolling();
    loadSessions();
    loadBalance();
    window.setInterval(() => loadBalance(false), 60000);
    window.setInterval(loadSessions, 30000);
  }

  window.__dshPetScreen = {
    get status() { return status; },
    get state() { return state; },
    play: (name, once = false) => play(name, { once, force: true }),
    animations: () => manifest,
  };
})();
