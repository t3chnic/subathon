/* main.js — StreamElements Subathon Timer (single-file, hostable)
   Features:
   - No end date; delta-based (freeze-safe)
   - Persistent across reloads using SE_API.store
   - Chat commands: !addtime / !subtime with h/m/s and HH:MM:SS
   - Role gating (broadcaster / mods / everyone)
   - Click overlay: click = pause/resume, Shift+click = reset
*/

(() => {
  // ---------- DOM bootstrap ----------
  const rootId = 'se-subathon-root';
  if (!document.getElementById(rootId)) {
    const $root = document.createElement('div');
    $root.id = rootId;
    $root.style.position = 'relative';
    $root.innerHTML = `
      <div id="se-subathon-label" style="display:none;"></div>
      <div id="se-subathon-time">00:00:00</div>
      <div id="se-subathon-fb" style="position:absolute;top:-2.2em;left:50%;transform:translateX(-50%);opacity:0;pointer-events:none;white-space:nowrap;"></div>
      <div id="se-subathon-ctrl" title="Click: pause/resume • Shift+Click: reset" style="position:absolute;inset:0;"></div>
    `;
    document.body.appendChild($root);

    // Base style (overridden on load with fields)
    const style = document.createElement('style');
    style.id = 'se-subathon-style';
    style.textContent = `
      #${rootId}{
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

  // ---------- State & refs ----------
  let fields = {};
  let STORE_KEY = 'subathon-timer-v1';
  let state = { remaining: 0, isRunning: false, lastWallClock: Date.now() };
  let rafId = null;
  let lastPersist = 0;

  const $root = document.getElementById(rootId);
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

    // Mixed h/m/s
    let total = 0; let m;
    const rx = /(\d+)\s*(h|m|s)?/g;
    while ((m = rx.exec(str)) !== null) {
      const v = parseInt(m[1],10);
      const u = m[2] || 's';
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
    // Inject Google Font link once per font
    const linkId = 'se-subathon-font';
    const existing = document.getElementById(linkId);
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}&display=swap`;
    if (!existing || existing.getAttribute('href') !== href) {
      if (existing) existing.remove();
      const l = document.createElement('link');
      l.id = linkId; l.rel = 'stylesheet'; l.href = href;
      document.head.appendChild(l);
    }

    const size = Number(fields.fontSize || 64);
    const weight = fields.bold ? 800 : 400;
    const txt = fields.textColor || '#ffffff';
    const bg = fields.bgColor || 'rgba(0,0,0,0)';
    const shadow = fields.shadow ? '0 2px 8px rgba(0,0,0,.5)' : 'none';

    $root.style.background = bg;
    $label.style.display = fields.showLabel ? 'block' : 'none';
    $label.textContent = fields.labelText || 'Subathon Time Remaining';

    // apply font + sizes
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

  function getTierCode(ev) {
    // Normalize common shapes: ev.tier, ev.plan ('1000','2000','3000'), prime flags
    const d = ev.data || ev;
    const rawTier = (d.tier || d.plan || '').toString().toLowerCase();
    const isPrime = d.isPrime || d.prime || /prime/.test(rawTier);
  
    // Twitch plans: 1000=T1, 2000=T2, 3000=T3. Some payloads use 'tier1', 'tier2', 'tier3'
    if (isPrime) return 'prime';
    if (rawTier.includes('3000') || rawTier.includes('tier3')) return 't3';
    if (rawTier.includes('2000') || rawTier.includes('tier2')) return 't2';
    if (rawTier.includes('1000') || rawTier.includes('tier1')) return 't1';
  
    // If nothing explicit, assume Tier 1 (safest)
    return 't1';
  }
  
  function getTierMultiplier(code) {
    switch (code) {
      case 't3':   return Number(fields.t3Mult ?? 6);
      case 't2':   return Number(fields.t2Mult ?? 2);
      case 'prime':return Number(fields.primeMult ?? 1);
      default:     return Number(fields.t1Mult ?? 1);
    }
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
      console.warn('SE_API.store.get failed', e);
    }
  }

  async function persist() {
    try {
      await SE_API.store.set(STORE_KEY, state);
    } catch (e) {
      console.warn('SE_API.store.set failed', e);
    }
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

    // periodic persist
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

  function handleSubscriber(ev) {
    const d = ev.data || ev;

    // Detect gift vs normal sub; count may be in amount/count
    const isGift = !!d.gifted || !!d.bulkGifted || d.isGift;
    const count  = Number(d.amount || d.count || 1) || 1;

    const tierCode = getTierCode(d);
    const mult = getTierMultiplier(tierCode);

    if (isGift) {
      // Gifted subs: multiply the per-gift seconds by count and (optionally) tier
      const base = Number(fields.giftSubSeconds) || 0;
      const applyTier = !!fields.applyTierToGifts;
      const perGift = applyTier ? base * mult : base;
      addSeconds(count * perGift);
      return;
    }

    // New sub / resub
    const baseSub = (Number(fields.subSeconds) || 0) * mult;
    addSeconds(baseSub);

    // Resub months bonus (optional) — often ev.amount/months carries total months
    const months = Number(d.months || d.amount || 0) || 0;
    if (months > 1) {
      const perMonth = Number(fields.resubPerMonthSeconds) || 0;
      const applyTierMonths = !!fields.applyTierToResubMonths;
      const perExtra = applyTierMonths ? perMonth * mult : perMonth;
      addSeconds((months - 1) * perExtra);
    }
  }

  function handleCheer(ev) {
    const bits = Number(ev.amount || ev.bits || 0) || 0;
    const bps = Math.max(1, Number(fields.bitsPerSecond) || 10);
    addSeconds(Math.floor(bits / bps));
  }

  function handleTip(ev) {
    const amount = Number(ev.amount || 0) || 0;
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

  // ---------- Event routing (reliable) ----------
  window.addEventListener('onEventReceived', function (obj) {
    if (!obj || !obj.detail) return;

    const listener = obj.detail.listener || '';
    const ev = obj.detail.event || {};

    if (listener === 'message-received') {
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

  // ---------- Boot ----------
  window.addEventListener('onWidgetLoad', async function (obj) {
    fields = (obj && obj.detail && obj.detail.fieldData) || {};

    // Defaults for when you only host JS
    fields.startSeconds ??= 3600;
    fields.autostart ??= true;
    fields.pauseOnZero ??= true;
    fields.storageKey ??= 'subathon-timer-v1';
    fields.subSeconds ??= 60;
    fields.resubPerMonthSeconds ??= 0;
    fields.giftSubSeconds ??= 60;
    fields.bitsPerSecond ??= 10;
    fields.tipPerSecond ??= 1;
    fields.showLabel ??= true;
    fields.labelText ??= 'Subathon Time Remaining';
    fields.fontFamily ??= 'Bebas Neue';
    fields.fontSize ??= 64;
    fields.textColor ??= '#ffffff';
    fields.bgColor ??= 'rgba(0,0,0,0)';
    fields.bold ??= true;
    fields.shadow ??= true;
    fields.enableChatCommands ??= true;
    fields.addTimeCommand ??= '!addtime';
    fields.subTimeCommand ??= '!subtime';
    fields.whoCanUse ??= 'mods'; // 'broadcaster' | 'mods' | 'everyone'
    fields.commandFeedback ??= true;
    fields.feedbackFormat ??= '{user} {op} {delta} → {remaining}';
    fields.t1Mult ??= 1;
    fields.t2Mult ??= 2;
    fields.t3Mult ??= 6;
    fields.primeMult ??= 1;
    fields.applyTierToGifts ??= true;
    fields.applyTierToResubMonths ??= true;

    STORE_KEY = (fields.storageKey || 'subathon-timer-v1').trim();
    applyStyle();

    await loadPersisted();

    // If nothing existed yet, init fresh
    try {
      const existing = await SE_API.store.get(STORE_KEY);
      if (!existing || typeof existing.remaining !== 'number') {
        await initFresh();
      }
    } catch { /* ignore */ }

    if (fields.autostart && state.remaining > 0) {
      state.isRunning = true;
      state.lastWallClock = now();
      await persist();
    }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  });
})();