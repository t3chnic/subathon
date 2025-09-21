/* main.js — StreamElements Subathon Timer (stable init, no debug)
   Version: 1.4.0

   Features:
   - No end date; delta (freeze-safe)
   - Persistent via SE_API.store (reload/crash-safe)
   - Chat commands: !addtime / !subtime (h/m/s and HH:MM:SS)
   - Role gating: broadcaster | mods | everyone
   - Tier multipliers (t1/t2/t3/prime) + options for gifts & resub months
*/

(() => {
  // ---------- DOM bootstrap ----------
  const ROOT_ID = 'se-subathon-root';
  function mountDOM() {
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.style.position = 'relative';
    root.innerHTML = `
      <div id="se-subathon-label" style="display:none;"></div>
      <div id="se-subathon-time">00:00:00</div>
      <div id="se-subathon-fb" style="position:absolute;top:-2.2em;left:50%;transform:translateX(-50%);opacity:0;pointer-events:none;white-space:nowrap;"></div>
      <div id="se-subathon-ctrl" title="Click: pause/resume • Shift+Click: reset" style="position:absolute;inset:0;"></div>
    `;
    document.body.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
      #${ROOT_ID}{
        display:inline-flex;flex-direction:column;align-items:center;gap:6px;
        padding:8px 12px;border-radius:12px;background:rgba(0,0,0,0)
      }
      #se-subathon-label{
        font-family:system-ui,sans-serif;font-size:22px;color:#fff;font-weight:800;letter-spacing:.06em;
        text-transform:uppercase;opacity:.9;text-align:center
      }
      #se-subathon-time{
        font-family:system-ui,sans-serif;font-size:64px;color:#fff;font-weight:800;line-height:1;letter-spacing:.04em;
        text-align:center;white-space:nowrap;text-shadow:0 2px 8px rgba(0,0,0,.5)
      }
      #se-subathon-fb{
        font-family:system-ui,sans-serif;font-size:18px;color:#fff;transition:opacity .3s ease;
        text-shadow:0 2px 8px rgba(0,0,0,.5)
      }
      #se-subathon-fb.show{opacity:.95}
    `;
    document.head.appendChild(style);
  }
  mountDOM();

  // ---------- Baseline defaults (work even if onWidgetLoad is missed) ----------
  let fields = {
    // timer
    startSeconds: 3600,
    autostart: true,
    pauseOnZero: true,
    storageKey: 'subathon-timer-v1',

    // adds
    subSeconds: 60,
    resubPerMonthSeconds: 0,
    giftSubSeconds: 60,
    bitsPerSecond: 10,
    tipPerSecond: 1,

    // look
    showLabel: true,
    labelText: 'Subathon Time Remaining',
    fontFamily: 'Bebas Neue',
    fontSize: 64,
    textColor: '#ffffff',
    bgColor: 'rgba(0,0,0,0)',
    bold: true,
    shadow: true,

    // chat commands (ON by default)
    enableChatCommands: true,
    addTimeCommand: '!addtime',
    subTimeCommand: '!subtime',
    whoCanUse: 'mods', // 'broadcaster' | 'mods' | 'everyone'
    commandFeedback: true,
    feedbackFormat: '{user} {op} {delta} → {remaining}',

    // tier multipliers
    t1Mult: 1,
    t2Mult: 2,
    t3Mult: 6,
    primeMult: 1,
    applyTierToGifts: true,
    applyTierToResubMonths: true
  };

  // ---------- State ----------
  let STORE_KEY = fields.storageKey;
  let state = { remaining: 0, isRunning: false, lastWallClock: Date.now() };
  let rafId = null;
  let lastPersist = 0;
  let didInit = false; // for fallback bootstrap

  // ---------- Refs ----------
  const $root  = document.getElementById(ROOT_ID);
  const $label = document.getElementById('se-subathon-label');
  const $time  = document.getElementById('se-subathon-time');
  const $fb    = document.getElementById('se-subathon-fb');
  const $ctrl  = document.getElementById('se-subathon-ctrl');

  // ---------- Utils ----------
  const now = () => Date.now();

  function fmt(seconds) {
    const neg = seconds < 0;
    let s = Math.max(0, Math.floor(Math.abs(seconds)));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600);  s -= h * 3600;
    const m = Math.floor(s / 60);    s -= m * 60;
    const hh = (d > 0) ? String(h).padStart(2,'0') : String(h);
    const mm = String(m).padStart(2,'0');
    const ss = String(s).padStart(2,'0');
    return (d > 0 ? `${d}:` : '') + `${hh}:${mm}:${ss}` + (neg ? '-' : '');
  }

  function parseDuration(input) {
    if (!input || typeof input !== 'string') return 0;
    const str = input.trim().toLowerCase();
    // HH:MM:SS or MM:SS
    if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(str)) {
      const parts = str.split(':').map(n => parseInt(n,10));
      if (parts.length === 2) { const [mm, ss] = parts; return mm*60 + ss; }
      if (parts.length === 3) { const [hh, mm, ss] = parts; return hh*3600 + mm*60 + ss; }
    }
    // h/m/s mix
    let total = 0, m;
    const rx = /(\d+)\s*(h|m|s)?/g;
    while ((m = rx.exec(str)) !== null) {
      const v = parseInt(m[1],10), u = m[2] || 's';
      if (u === 'h') total += v * 3600;
      else if (u === 'm') total += v * 60;
      else total += v;
    }
    return total;
  }

  function humanDelta(sec) {
    const s = Math.abs(Math.floor(sec));
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const ss = s%60;
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (ss || (!h && !m)) parts.push(`${ss}s`);
    return parts.join(' ');
  }

  function showFeedback(text) {
    if (!fields.commandFeedback || !$fb) return;
    $fb.textContent = text;
    $fb.classList.add('show');
    clearTimeout(showFeedback._t);
    showFeedback._t = setTimeout(() => $fb.classList.remove('show'), 2500);
  }

  function applyStyle() {
    const font = (fields.fontFamily || 'Bebas Neue').trim();
    // Inject Google Font
    const linkId = 'se-subathon-font';
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}&display=swap`;
    let link = document.getElementById(linkId);
    if (!link || link.getAttribute('href') !== href) {
      if (link) link.remove();
      link = document.createElement('link');
      link.id = linkId; link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
    }

    const size = Number(fields.fontSize || 64);
    const weight = fields.bold ? 800 : 400;
    const txt = fields.textColor || '#ffffff';
    const bg = fields.bgColor || 'rgba(0,0,0,0)';
    const shadow = fields.shadow ? '0 2px 8px rgba(0,0,0,.5)' : 'none';

    $root.style.background = bg;
    $label.style.display = fields.showLabel ? 'block' : 'none';
    $label.textContent = fields.labelText || 'Subathon Time Remaining';

    [$label, $time, $fb].forEach(el => {
      el.style.fontFamily = `'${font}', system-ui, sans-serif`;
      el.style.color = txt;
    });
    $label.style.fontSize = Math.round(size * 0.35) + 'px';
    $label.style.fontWeight = String(weight);
    $time.style.fontSize = size + 'px';
    $time.style.fontWeight = String(weight);
    $time.style.textShadow = shadow;
    $fb.style.fontSize = Math.max(12, Math.round(size * 0.28)) + 'px';
    $fb.style.textShadow = shadow;
  }

  // ---------- Persistence ----------
  async function loadPersisted() {
    try {
      const saved = await SE_API.store.get(STORE_KEY);
      if (saved && typeof saved.remaining === 'number') {
        state = saved;
        if (state.isRunning) {
          const elapsed = Math.max(0, (now() - (saved.lastWallClock || now())) / 1000);
          state.remaining = Math.max(0, saved.remaining - elapsed);
          state.lastWallClock = now();
          await persist();
        }
      }
    } catch (e) {
      // ignore; widget still runs with defaults
    }
  }

  async function persist() {
    try { await SE_API.store.set(STORE_KEY, state); }
    catch (e) { /* ignore */ }
  }

  async function initFresh() {
    state.remaining = Math.max(0, Number(fields.startSeconds) || 0);
    state.isRunning = !!fields.autostart;
    state.lastWallClock = now();
    await persist();
  }

  // ---------- Timer ----------
  function tick() {
    const t = now();
    const dt = Math.max(0, (t - state.lastWallClock) / 1000);
    if (state.isRunning) state.remaining = Math.max(0, state.remaining - dt);
    state.lastWallClock = t;
    $time.textContent = fmt(state.remaining);

    if (fields.pauseOnZero && state.isRunning && state.remaining <= 0) {
      state.isRunning = false;
      persist();
    }

    if (t - lastPersist > 3000) { lastPersist = t; persist(); }

    rafId = requestAnimationFrame(tick);
  }

  // ---------- Time mutators ----------
  function addSeconds(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return;
    state.remaining += sec;
    state.lastWallClock = now();
    if (fields.pauseOnZero && state.remaining > 0) state.isRunning = true;
    persist();
  }

  // ---------- Subs / Bits / Tips ----------
  function getTierCode(ev) {
    const d = ev.data || ev;
    const rawTier = (d.tier || d.plan || '').toString().toLowerCase();
    const isPrime = d.isPrime || d.prime || /prime/.test(rawTier);
    if (isPrime) return 'prime';
    if (rawTier.includes('3000') || rawTier.includes('tier3')) return 't3';
    if (rawTier.includes('2000') || rawTier.includes('tier2')) return 't2';
    if (rawTier.includes('1000') || rawTier.includes('tier1')) return 't1';
    return 't1';
  }
  
  function getTierMultiplier(code) {
    switch (code) {
      case 't3': return Number(fields.t3Mult ?? 6);
      case 't2': return Number(fields.t2Mult ?? 2);
      case 'prime': return Number(fields.primeMult ?? 1);
      default: return Number(fields.t1Mult ?? 1);
    }
  }

  function handleSubscriber(ev) {
    const d = ev.data || ev;
    const isGift = !!d.gifted || !!d.bulkGifted || d.isGift;
    const count  = Number(d.amount || d.count || 1) || 1;
    const tierCode = getTierCode(d);
    const mult = getTierMultiplier(tierCode);

    if (isGift) {
      const base = Number(fields.giftSubSeconds) || 0;
      const perGift = fields.applyTierToGifts ? base * mult : base;
      addSeconds(count * perGift);
      return;
    }

    const baseSub = (Number(fields.subSeconds) || 0) * mult;
    addSeconds(baseSub);

    const months = Number(d.months || d.amount || 0) || 0;
    if (months > 1) {
      const perMonth = Number(fields.resubPerMonthSeconds) || 0;
      const perExtra = fields.applyTierToResubMonths ? perMonth * mult : perMonth;
      addSeconds((months - 1) * perExtra);
    }
  }

  function handleCheer(ev) {
    const bits = Number((ev.data || ev).amount || (ev.data || ev).bits || 0) || 0;
    const bps = Math.max(1, Number(fields.bitsPerSecond) || 10);
    addSeconds(Math.floor(bits / bps));
  }

  function handleTip(ev) {
    const amount = Number((ev.data || ev).amount || 0) || 0;
    const per = Math.max(0.01, Number(fields.tipPerSecond) || 1);
    addSeconds(Math.floor(amount / per));
  }

  // ---------- Chat commands ----------
  function getMessageText(ev) {
    const d = ev.data || ev;
    return (d.text || d.message || d.body || '').toString();
  }
  function getUserInfo(ev) {
    const d = ev.data || ev;
    const tags = d.tags || {};
    const badges = (tags.badges || '').toString().toLowerCase();
    const role = (d.role || d.userRole || '').toString().toLowerCase();
    const isBroadcaster = role === 'broadcaster' || badges.includes('broadcaster') || d.displayName === d.channel || d.username === d.channel;
    const isMod = role === 'moderator' || tags.mod === true || tags.mod === 1 || badges.includes('moderator');
    const name = d.displayName || d.nick || d.username || 'User';
    return { name, isBroadcaster, isMod };
  }
  function isAllowedByRole(ev) {
    const who = fields.whoCanUse || 'mods';
    if (who === 'everyone') return true;
    const u = getUserInfo(ev);
    if (who === 'broadcaster') return !!u.isBroadcaster;
    return !!(u.isBroadcaster || u.isMod);
  }

  function handleChatCommand(ev) {
    const textRaw = getMessageText(ev);
    if (!textRaw) return;

    const text = textRaw.trim();
    // Commands (lowercased for matching)
    const addCmd = (fields.addTimeCommand || '!addtime').toLowerCase();
    const subCmd = (fields.subTimeCommand || '!subtime').toLowerCase();
    const lower = text.toLowerCase();

    const isAdd = lower.startsWith(addCmd + ' ') || lower === addCmd;
    const isSub = lower.startsWith(subCmd + ' ') || lower === subCmd;
    if (!isAdd && !isSub) return;

    if (!isAllowedByRole(ev)) return;

    const arg = text.slice((isAdd ? addCmd.length : subCmd.length)).trim();
    const seconds = parseDuration(arg);
    if (!seconds || seconds <= 0) {
      showFeedback(`Invalid time. Try: 90s, 2m, 1h30m, 02:15:30`);
      return;
    }

    const delta = (isAdd ? 1 : -1) * seconds;
    state.remaining = Math.max(0, state.remaining + delta);
    state.lastWallClock = now();
    if (fields.pauseOnZero && state.remaining > 0) state.isRunning = true;
    persist();

    const u = getUserInfo(ev);
    const fbText = (fields.feedbackFormat || '{user} {op} {delta} → {remaining}')
      .replace('{user}', u.name)
      .replace('{op}', isAdd ? 'added' : 'removed')
      .replace('{delta}', humanDelta(seconds))
      .replace('{remaining}', fmt(state.remaining));
    showFeedback(fbText);
  }

  // ---------- Event routing ----------
  window.addEventListener('onEventReceived', function (obj) {
    if (!obj || !obj.detail) return;
    const listener = obj.detail.listener || '';
    const ev = obj.detail.event || {};

    if (listener === 'message') {
      if (fields.enableChatCommands) handleChatCommand(ev);
      return;
    }

    if (ev && typeof ev.type === 'string') {
      switch (ev.type) {
        case 'message':
          if (fields.enableChatCommands) handleChatCommand(ev);
          return;
        case 'subscriber':
          handleSubscriber(ev.data || ev);
          return;
        case 'cheer':
          handleCheer(ev.data || ev);
          return;
        case 'tip':
          handleTip(ev.data || ev);
          return;
        default:
          break;
      }
    }
  });

  // ---------- Init (normal path) ----------
  async function initWith(obj) {
    if (didInit) return;
    didInit = true;

    // Merge real field data if present
    if (obj && obj.detail && obj.detail.fieldData) {
      Object.assign(fields, obj.detail.fieldData);
    }
    STORE_KEY = (fields.storageKey || 'subathon-timer-v1').trim();

    applyStyle();
    await loadPersisted();

    // If nothing persisted, start fresh
    try {
      const existing = await SE_API.store.get(STORE_KEY);
      if (!existing || typeof existing.remaining !== 'number') {
        await initFresh();
      }
    } catch { /* ignore */ }

    // Ensure autostart
    if (fields.autostart && state.remaining > 0) {
      state.isRunning = true;
      state.lastWallClock = now();
      await persist();
    }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  window.addEventListener('onWidgetLoad', initWith);

  // ---------- Fallback bootstrap ----------
  // If onWidgetLoad was missed (load-order edge case), start with defaults after a short delay.
  setTimeout(() => { if (!didInit) initWith(null); }, 1500);

  // ---------- Optional tiny API for manual checks (kept minimal, no debug UI) ----------
  window.SubathonTimer = {
    version: '1.4.0',
    getState: () => ({ ...state }),
    add: (s) => addSeconds(Number(s)||0),
    reset: () => initFresh()
  };
})();
