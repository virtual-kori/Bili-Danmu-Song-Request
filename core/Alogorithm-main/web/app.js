/* 弹幕点歌机 Web UI 前端逻辑 */
(function () {
  'use strict';

  var state = null;
  var ws = null;
  var wsRetry = 0;
  var qrTimer = null;
  // 歌词：歌词数据 + 当前高亮行，避免每次都重绘整块
  var lyricData = { songKey: '', name: '', singer: '', lines: [], loading: false };
  var lyricCurIdx = -2;
  var lyricSongKey = '';
  var lyricTries = 0;
  var lyricNextAt = 0;

  var $ = function (id) { return document.getElementById(id); };

  function api(path, options) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {})).then(function (r) {
      return r.json();
    });
  }

  function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtAgo(ts) {
    if (!ts) return '';
    var d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return d + ' 秒前';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    return Math.floor(d / 3600) + ' 小时前';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function connectWs() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = function () {
      wsRetry = 0;
      $('wsPill').textContent = 'WS 已连接';
      $('wsPill').className = 'pill ghost ok';
    };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === 'state') { state = msg.data; render(); }
        if (msg.type === 'danmaku-status') { renderDanmaku(msg.data); }
      } catch (e) { /* ignore */ }
    };
    ws.onclose = function () {
      $('wsPill').textContent = 'WS 断开';
      $('wsPill').className = 'pill ghost bad';
      wsRetry += 1;
      setTimeout(connectWs, Math.min(8000, 600 * wsRetry));
    };
    ws.onerror = function () { /* onclose 会接管 */ };
  }

  // ---------------------------------------------------------------- 渲染

  function render() {
    if (!state) return;
    var phase = state.phase || 'IDLE';
    var pill = $('phasePill');
    var map = { IDLE: '空闲', PLAYING: '播放中', STOPPING: '停止中', CLOSED: '已关闭' };
    pill.textContent = (state.statusText || map[phase] || phase);
    pill.className = 'pill' + (phase === 'PLAYING' ? ' ok' : phase === 'STOPPING' ? ' bad' : '');

    $('swDanmaku').checked = Boolean(state.switches && state.switches.danmakuOrder);
    $('swIdle').checked = Boolean(state.switches && state.switches.idleAutoPlay);

    var cur = state.current;
    if (cur) {
      $('nowName').textContent = cur.name;
      $('nowPlatform').textContent = cur.platformLabel || cur.platform || '';
      $('nowSinger').textContent = cur.singer || '未知歌手';
      $('nowMeta').textContent = (cur.album ? '专辑：' + cur.album + ' · ' : '') + (cur.paused ? '已暂停' : '播放中');
      $('nowRequester').textContent = cur.requester || '—';
      $('nowQuality').textContent = cur.qualityLabel || cur.quality || '—';
      var dur = Number(cur.duration) || 0;
      var pos = Number(cur.position) || 0;
      var pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
      $('progressFill').style.width = pct + '%';
      $('timeNow').textContent = fmtTime(pos);
      $('timeTotal').textContent = dur > 0 ? fmtTime(dur) : '--:--';
      var cover = $('cover');
      if (cur.cover) cover.innerHTML = '<img src="' + esc(cur.cover) + '" alt="" onerror="this.remove()" />';
      else cover.innerHTML = '<span>♪</span>';
    } else {
      $('nowName').textContent = '暂无播放';
      $('nowPlatform').textContent = '';
      $('nowSinger').textContent = '—';
      $('nowMeta').textContent = state.switches && state.switches.idleAutoPlay ? '队列为空，等待推荐曲目' : '队列为空时进入空闲状态';
      $('nowRequester').textContent = '—';
      $('nowQuality').textContent = '—';
      $('progressFill').style.width = '0%';
      $('timeNow').textContent = '00:00';
      $('timeTotal').textContent = '00:00';
      $('cover').innerHTML = '<span>♪</span>';
    }
    $('nowError').textContent = state.lastError || '—';

    var q = state.queue || [];
    $('queueCount').textContent = String(q.length);
    var list = $('queueList');
    if (!q.length) {
      list.innerHTML = '<li class="empty" style="display:block;border:none;background:none">队列为空，等待弹幕点歌</li>';
    } else {
      list.innerHTML = q
        .map(function (it, i) {
          return (
            '<li class="' + (it.pinned ? 'pinned' : '') + '">' +
            '<div class="idx">' + (i + 1) + '</div>' +
            '<div>' +
            '<div class="qname">' + esc(it.name) +
            (it.pinned ? ' <span class="badge pin">置顶</span>' : '') +
            '<span class="badge">' + esc(it.platformLabel || it.platform) + '</span>' +
            (it.qualityLabel ? '<span class="badge">' + esc(it.qualityLabel) + '</span>' : '') +
            (it.source === 'idle' || it.requester === '空闲推荐' ? '<span class="badge">推荐</span>' : '') +
            '</div>' +
            '<div class="qsub">' + esc(it.singer || '未知歌手') + ' · 点歌人 ' + esc(it.requester || '—') + ' · ' + fmtAgo(it.addedAt) + '</div>' +
            '</div>' +
            '<div class="row-actions">' +
            '<button class="btn small" data-pin="' + it.id + '" data-pinned="' + (it.pinned ? '1' : '0') + '">' + (it.pinned ? '取消置顶' : '置顶') + '</button>' +
            '<button class="btn small" data-up="' + it.id + '" data-index="' + i + '">↑</button>' +
            '<button class="btn small" data-down="' + it.id + '" data-index="' + i + '">↓</button>' +
            '<button class="btn small danger" data-del="' + it.id + '">删除</button>' +
            '</div>' +
            '</li>'
          );
        })
        .join('');
    }

    renderPlatforms();
    renderChat();
    renderDanmaku(state.danmaku);
    fillRulesOnce();
    renderSubLine();
    renderLyrics();
    $('footerInfo').textContent =
      '点歌前缀：“点歌 歌名 歌手” · 更新时间 ' + (state.timeText || '') + ' · MPV：' + (state.mpvPath || '');
  }

  // ---------------------------------------------------------------- 实时歌词

  /** 歌换了就重新拉歌词；每帧只按播放进度更新高亮行 */
  function renderLyrics() {
    if (!state) return;
    var cur = state.current;
    var key = cur ? (cur.platform + '::' + (cur.songId || '') + '::' + (cur.name || '')) : '';

    if (key !== lyricSongKey) {
      // 换歌（或停止播放）：重置歌词状态。
      // 引擎是异步取歌词的，所以这里要用独立的变量记录「这首歌已经问过几次」，
      // 不能把标记塞进 lyricData —— 每帧渲染都会重建 lyricData，标记会被冲掉。
      lyricSongKey = key;
      lyricCurIdx = -2;
      lyricTries = 0;
      lyricNextAt = Date.now() + 1500;
      lyricData = cur
        ? { songKey: key, name: cur.name, singer: cur.singer, lines: [], loading: true }
        : { songKey: '', name: '', singer: '', lines: [], loading: false };
      paintLyrics();
      if (cur) fetchLyric();
      return;
    }

    // 歌词还没到：每 1.5 秒追问一次，最多 8 次（12 秒），之后就不再打扰
    if (lyricData.loading && lyricTries < 8 && Date.now() >= lyricNextAt) {
      lyricTries += 1;
      lyricNextAt = Date.now() + 1500;
      fetchLyric();
    }
    highlightLyric();
  }

  /** 拉一次歌词；只接受与当前歌曲匹配的结果 */
  function fetchLyric() {
    var want = lyricSongKey;
    api('/api/lyric').then(function (r) {
      if (!r || !r.ok || !r.data) return;
      // 期间可能又换歌了，过期结果直接丢
      if (want !== lyricSongKey || r.data.songKey !== want) return;
      lyricData = {
        songKey: r.data.songKey,
        name: r.data.name || '',
        singer: r.data.singer || '',
        lines: r.data.lines || [],
        loading: Boolean(r.data.loading),
      };
      lyricCurIdx = -2;
      paintLyrics();
    });
  }

  /** 整块重绘（换歌 / 歌词刚回来时） */
  function paintLyrics() {
    var body = $('lyricsBody');
    var hint = $('lyricsHint');
    var cnt = $('lyricCount');
    if (!body || !hint) return;

    if (!lyricSongKey) {
      body.innerHTML = '';
      hint.style.display = 'block';
      hint.textContent = '等待播放…';
      if (cnt) cnt.textContent = '—';
      return;
    }
    if (lyricData.loading) {
      body.innerHTML = '';
      hint.style.display = 'block';
      hint.textContent = '正在获取歌词…';
      if (cnt) cnt.textContent = lyricData.name || '';
      return;
    }
    if (!lyricData.lines.length) {
      body.innerHTML = '';
      hint.style.display = 'block';
      hint.textContent = '这首歌没有歌词（纯音乐或暂无歌词源）';
      if (cnt) cnt.textContent = '无';
      return;
    }

    hint.style.display = 'none';
    if (cnt) cnt.textContent = lyricData.lines.length + ' 行';

    // 按模式决定渲染哪些行：
    //   scroll = 全部行（高亮当前行，靠自动滚动跟随）
    //   three  = 上 2 行 + 当前 + 下 2 行
    //   two    = 上一行 + 当前 + 下一行
    //   single = 只渲染当前行
    var mode = lyricCfg.mode || 'scroll';
    var all = lyricData.lines;
    var only;
    if (mode === 'scroll') {
      only = all.map(function (l, i) { return { l: l, i: i }; });
    } else if (mode === 'single') {
      only = [{ i: lyricCurIdx >= 0 ? lyricCurIdx : 0, placeholder: true }];
    } else {
      var span = mode === 'three' ? 2 : 1;
      var c = lyricCurIdx >= 0 ? lyricCurIdx : 0;
      only = [];
      for (var k = -span; k <= span; k++) {
        var j = c + k;
        if (j >= 0 && j < all.length) only.push({ l: all[j], i: j });
      }
    }
    body.innerHTML = only
      .map(function (o) {
        var text = o.placeholder ? (all[o.i] ? all[o.i].text : '') : o.l.text;
        return '<div class="ln" data-i="' + o.i + '">' + esc(text) + '</div>';
      })
      .join('');
    highlightLyric(true);
  }

  /** 按播放进度高亮当前行，并让它在框内居中 */
  function highlightLyric(force) {
    if (!lyricData.lines.length) return;
    var pos = (state && state.current && Number(state.current.position)) || 0;
    var lines = lyricData.lines;
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t <= pos) idx = i;
      else break;
    }
    var changed = idx !== lyricCurIdx;
    if (!changed && !force) return;
    lyricCurIdx = idx;

    // 非滚动模式（单行/两行/三行）下窗口会跟着当前行移动，
    // 所以索引一变就得重绘，否则窗口停在旧位置不动。
    var mode = lyricCfg.mode || 'scroll';
    if (changed && mode !== 'scroll') {
      paintLyrics();
      return;
    }

    var body = $('lyricsBody');
    if (!body) return;
    var nodes = body.children;
    // 用 data-i 找到当前行所在的节点（不同模式下节点与行号不再一一对应）
    var curNode = null;
    for (var n = 0; n < nodes.length; n++) {
      var di = Number(nodes[n].getAttribute('data-i'));
      var d = di - idx;
      var cls = 'ln';
      if (d === 0) { cls += ' cur'; curNode = nodes[n]; }
      else if (d === -1 || d === 1) cls += ' near';
      if (nodes[n].className !== cls) nodes[n].className = cls;
    }
    if (curNode && lyricCfg.follow) {
      var scroller = $('lyricsScroll');
      if (scroller) {
        var want = curNode.offsetTop - scroller.clientHeight / 2 + curNode.offsetHeight / 2;
        scroller.scrollTo({ top: Math.max(0, want), behavior: force ? 'auto' : 'smooth' });
      }
    }
    // 全屏歌词跟着一起更新
    paintLyricFull();
  }

  $('btnLyricToggle').addEventListener('click', function () {
    var mid = document.querySelector('.col-mid');
    if (!mid) return;
    var hidden = mid.classList.toggle('lyrics-hidden');
    this.textContent = hidden ? '展开' : '收起';
    if (!hidden) highlightLyric(true);
  });

  // ---------------------------------------------------------------- 歌词外观设置

  /** 可选配色（当前行 / 其他行各一组） */
  var LYRIC_COLORS = ['#ffffff', '#7ddcff', '#ffd166', '#ff8fb1', '#9ef01a', '#c9a7ff', '#ff9f68', '#8ea0b8'];
  var LYRIC_DEFAULTS = {
    cur: '#ffffff',
    other: '#6f8098',
    sizeCur: 15,
    sizeOther: 13,
    glow: false,
    follow: true,
    // 显示模式与对齐（内嵌面板、全屏、OBS 三处共用）
    mode: 'scroll',
    halign: 'center',
    valign: 'bottom',
    // OBS 独立字号（vh）：直播画面的字要明显大于网页里
    obsSizeCur: 11,
    obsSizeOther: 4.5,
    // 自定义 CSS：原样注入 OBS 歌词页
    obsCss: '',
  };
  var lyricCfg = Object.assign({}, LYRIC_DEFAULTS);

  function loadLyricCfg() {
    try {
      var raw = localStorage.getItem('danmaku.lyricCfg');
      if (raw) lyricCfg = Object.assign({}, LYRIC_DEFAULTS, JSON.parse(raw));
    } catch {
      lyricCfg = Object.assign({}, LYRIC_DEFAULTS);
    }
  }
  function saveLyricCfg() {
    try {
      localStorage.setItem('danmaku.lyricCfg', JSON.stringify(lyricCfg));
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }

  /** 把配置写到 CSS 变量上，内嵌面板、全屏歌词、OBS 链接会一起生效 */
  function applyLyricCfg() {
    var r = document.documentElement.style;
    r.setProperty('--lyric-cur', lyricCfg.cur);
    r.setProperty('--lyric-other', lyricCfg.other);
    r.setProperty('--lyric-size-cur', lyricCfg.sizeCur + 'px');
    r.setProperty('--lyric-size-other', lyricCfg.sizeOther + 'px');
    r.setProperty('--lyric-glow', lyricCfg.glow ? '0 0 18px ' + hexToRgba(lyricCfg.cur, 0.75) : 'none');
    r.setProperty('--lyric-align', lyricCfg.halign || 'center');
    // 上下对齐只影响画面感最强的全屏歌词
    r.setProperty('--lyric-justify', lyricCfg.valign === 'top' ? 'flex-start' : lyricCfg.valign === 'middle' ? 'center' : 'flex-end');
    // 右对齐时高亮条换到右边（样式在 style.css 里）
    document.documentElement.classList.toggle('lyric-right', lyricCfg.halign === 'right');
    // 配置变了，OBS 链接里的参数也要跟着变
    if (typeof refreshObsUrl === 'function') refreshObsUrl();
  }

  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 'rgba(255,255,255,' + a + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 渲染某一组色块 */
  function renderSwatches(boxId, field) {
    var box = $(boxId);
    if (!box) return;
    box.innerHTML = LYRIC_COLORS.map(function (c) {
      return '<button class="swatch' + (String(lyricCfg[field]).toLowerCase() === c ? ' on' : '') +
        '" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
    }).join('') +
      '<input type="color" class="swatch" id="' + boxId + 'Custom" value="' + esc(lyricCfg[field]) +
      '" title="自定义颜色" style="cursor:pointer;background:transparent" />';
  }

  function syncLyricControls() {
    renderSwatches('swCur', 'cur');
    renderSwatches('swOther', 'other');
    $('inLyricSize').value = lyricCfg.sizeCur;
    $('lyricSizeVal').textContent = lyricCfg.sizeCur + 'px';
    $('inLyricSizeOther').value = lyricCfg.sizeOther;
    $('lyricSizeOtherVal').textContent = lyricCfg.sizeOther + 'px';
    $('inLyricGlow').checked = Boolean(lyricCfg.glow);
    $('inLyricFollow').checked = Boolean(lyricCfg.follow);
    if ($('inLyricMode')) $('inLyricMode').value = lyricCfg.mode || 'scroll';
    if ($('inLyricHAlign')) $('inLyricHAlign').value = lyricCfg.halign || 'center';
    if ($('inLyricVAlign')) $('inLyricVAlign').value = lyricCfg.valign || 'bottom';
    if ($('inObsCss')) $('inObsCss').value = lyricCfg.obsCss || '';
    if ($('inObsSizeCur')) {
      $('inObsSizeCur').value = lyricCfg.obsSizeCur;
      $('obsSizeCurVal').textContent = lyricCfg.obsSizeCur + 'vh';
    }
    if ($('inObsSizeOther')) {
      $('inObsSizeOther').value = lyricCfg.obsSizeOther;
      $('obsSizeOtherVal').textContent = lyricCfg.obsSizeOther + 'vh';
    }
  }

  // 色块点击
  ['swCur', 'swOther'].forEach(function (boxId) {
    var field = boxId === 'swCur' ? 'cur' : 'other';
    var box = $(boxId);
    if (!box) return;
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-color]') : null;
      if (b) {
        lyricCfg[field] = b.getAttribute('data-color');
        saveLyricCfg();
        applyLyricCfg();
        syncLyricControls();
        highlightLyric(true);
      }
    });
    box.addEventListener('input', function (ev) {
      if (ev.target && ev.target.type === 'color') {
        lyricCfg[field] = ev.target.value;
        saveLyricCfg();
        applyLyricCfg();
        highlightLyric(true);
      }
    });
  });

  $('inLyricSize').addEventListener('input', function () {
    lyricCfg.sizeCur = Number(this.value) || 15;
    $('lyricSizeVal').textContent = lyricCfg.sizeCur + 'px';
    saveLyricCfg();
    applyLyricCfg();
    highlightLyric(true);
  });
  $('inLyricSizeOther').addEventListener('input', function () {
    lyricCfg.sizeOther = Number(this.value) || 13;
    $('lyricSizeOtherVal').textContent = lyricCfg.sizeOther + 'px';
    saveLyricCfg();
    applyLyricCfg();
    highlightLyric(true);
  });
  $('inLyricGlow').addEventListener('change', function () {
    lyricCfg.glow = this.checked;
    saveLyricCfg();
    applyLyricCfg();
    highlightLyric(true);
  });
  $('inLyricFollow').addEventListener('change', function () {
    lyricCfg.follow = this.checked;
    saveLyricCfg();
  });
  $('btnLyricReset').addEventListener('click', function () {
    lyricCfg = Object.assign({}, LYRIC_DEFAULTS);
    saveLyricCfg();
    applyLyricCfg();
    syncLyricControls();
    highlightLyric(true);
  });

  // OBS 独立字号
  if ($('inObsSizeCur')) {
    $('inObsSizeCur').addEventListener('input', function () {
      lyricCfg.obsSizeCur = Number(this.value) || 11;
      $('obsSizeCurVal').textContent = lyricCfg.obsSizeCur + 'vh';
      saveLyricCfg();
      refreshObsUrl();
    });
  }
  if ($('inObsSizeOther')) {
    $('inObsSizeOther').addEventListener('input', function () {
      lyricCfg.obsSizeOther = Number(this.value) || 4.5;
      $('obsSizeOtherVal').textContent = lyricCfg.obsSizeOther + 'vh';
      saveLyricCfg();
      refreshObsUrl();
    });
  }

  // 歌词模式 / 左右对齐 / 上下对齐：面板、全屏、OBS 三处共用
  if ($('inLyricMode')) {
    $('inLyricMode').addEventListener('change', function () {
      lyricCfg.mode = this.value;
      saveLyricCfg();
      applyLyricCfg();
      paintLyrics();
      paintLyricFull();
      refreshObsUrl();
    });
  }
  if ($('inLyricHAlign')) {
    $('inLyricHAlign').addEventListener('change', function () {
      lyricCfg.halign = this.value;
      saveLyricCfg();
      applyLyricCfg();
      highlightLyric(true);
      paintLyricFull();
      refreshObsUrl();
    });
  }
  if ($('inLyricVAlign')) {
    $('inLyricVAlign').addEventListener('change', function () {
      lyricCfg.valign = this.value;
      saveLyricCfg();
      applyLyricCfg();
      paintLyricFull();
      refreshObsUrl();
    });
  }
  if ($('inObsCss')) {
    var cssTimer = null;
    $('inObsCss').addEventListener('input', function () {
      lyricCfg.obsCss = this.value;
      // 输入时别把链接刷得太勤，停 400ms 再更新
      if (cssTimer) clearTimeout(cssTimer);
      cssTimer = setTimeout(function () {
        saveLyricCfg();
        refreshObsUrl();
      }, 400);
    });
  }
  if ($('btnObsCssReset')) {
    $('btnObsCssReset').addEventListener('click', function () {
      lyricCfg.obsCss = '';
      saveLyricCfg();
      if ($('inObsCss')) $('inObsCss').value = '';
      refreshObsUrl();
    });
  }

  // ---------------------------------------------------------------- OBS 歌词链接

  /**
   * OBS 歌词层地址。
   *
   * 用**固定短链接** /obs-lytric：之前那种「颜色+字号+对齐+自定义 CSS 全塞进 URL」
   * 的写法又长又难念，在 OBS 里核对/手输都很痛苦。
   * 默认样式写在服务端（OBS_LYRIC_DEFAULTS），网页里的样式面板只影响网页内预览。
   */
  function obsLyricUrl() {
    return location.origin + '/obs-lytric';
  }

  function refreshObsUrl() {
    var input = $('obsLyricUrl');
    if (input) input.value = obsLyricUrl();
  }

  $('btnCopyObsLyric').addEventListener('click', function () {
    var url = obsLyricUrl();
    var ok = function () {
      var h = $('obsLyricHint');
      h.innerHTML = '✅ 已复制到剪贴板。粘到 OBS「浏览器源 → URL」即可（建议宽 1200、高 300，勾选「关闭源时关闭浏览器」）。';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok, function () {
        $('obsLyricUrl').select();
        document.execCommand && document.execCommand('copy');
        ok();
      });
    } else {
      $('obsLyricUrl').select();
      document.execCommand && document.execCommand('copy');
      ok();
    }
  });

  $('btnOpenObsLyric').addEventListener('click', function () {
    this.href = obsLyricUrl();
  });

  $('btnOpenObsLyricOBS').addEventListener('click', function () {
    alert(
      '在 OBS 里添加歌词：\n\n' +
        '1. 来源 → 加号 → 浏览器\n' +
        '2. URL 粘贴上面复制的链接（点「复制链接」获取）\n' +
        '3. 建议宽度 1200、高度 300\n' +
        '4. 勾选「源不可见时关闭」，并建议「自定义 CSS」留空\n' +
        '5. 背景默认透明，直接叠加在画面上即可\n\n' +
        '提示：改完配色/字号后，重新点一次「复制链接」，OBS 里把 URL 换掉即可。'
    );
  });

  // 勾选项变化时同步刷新链接（配置项本身已由 applyLyricCfg 触发刷新）
  setTimeout(function () {
    var boxes = ['inObsSong', 'inObsMeta', 'inObsWaiting'];
    boxes.forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', refreshObsUrl);
    });
    refreshObsUrl();
  }, 0);

  // ---------------------------------------------------------------- 全屏歌词

  function openLyricFull() {
    $('lyricFull').classList.add('show');
    document.body.classList.add('lyric-full-open');
    paintLyricFull();
  }
  function closeLyricFull() {
    $('lyricFull').classList.remove('show');
    document.body.classList.remove('lyric-full-open');
  }
  $('btnLyricExpand').addEventListener('click', openLyricFull);
  $('btnLyricExpand2').addEventListener('click', openLyricFull);
  $('btnLyricFullClose').addEventListener('click', closeLyricFull);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && $('lyricFull').classList.contains('show')) closeLyricFull();
  });

  /** 刷新全屏歌词：按模式决定显示几行，并按对齐设置排版 */
  function paintLyricFull() {
    if (!$('lyricFull').classList.contains('show')) return;
    var cur = state && state.current;
    var body = document.querySelector('.lyric-full-body');
    var mode = lyricCfg.mode || 'scroll';

    // 对齐：左右用 text-align，上下用 justify-content
    if (body) {
      body.style.justifyContent = lyricCfg.valign === 'top' ? 'flex-start' : lyricCfg.valign === 'middle' ? 'center' : 'flex-end';
      body.style.alignItems = lyricCfg.halign === 'left' ? 'flex-start' : lyricCfg.halign === 'right' ? 'flex-end' : 'center';
      body.style.textAlign = lyricCfg.halign || 'center';
    }

    $('lfTitle').textContent = cur ? cur.name + (cur.singer ? ' - ' + cur.singer : '') : '暂无播放';
    $('lfSub').textContent = cur ? cur.platformLabel + (cur.requester ? ' · 点歌人 ' + cur.requester : '') : '队列为空时进入空闲状态';

    var pos = (cur && Number(cur.position)) || 0;
    var dur = (cur && Number(cur.duration)) || 0;
    $('lfProgress').textContent = fmt(pos) + ' / ' + fmt(dur);

    var lines = lyricData.lines || [];
    var prevEl = $('lfPrev');
    var nextEl = $('lfNext');
    if (!lines.length) {
      prevEl.textContent = '';
      nextEl.textContent = '';
      $('lfCur').textContent = lyricData.loading ? '正在获取歌词…' : cur ? '这首歌没有歌词' : '等待播放…';
      return;
    }
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t <= pos) idx = i;
      else break;
    }
    if (idx < 0) idx = 0;

    $('lfCur').textContent = lines[idx].text;
    if (mode === 'single') {
      prevEl.textContent = '';
      nextEl.textContent = '';
    } else if (mode === 'scroll' || mode === 'three') {
      // 多显示几行，让人能跟着往下看
      prevEl.textContent = [lines[idx - 2], lines[idx - 1]].filter(Boolean).map(function (l) { return l.text; }).join('\n');
      nextEl.textContent = [lines[idx + 1], lines[idx + 2]].filter(Boolean).map(function (l) { return l.text; }).join('\n');
    } else {
      prevEl.textContent = idx > 0 ? lines[idx - 1].text : '';
      nextEl.textContent = idx + 1 < lines.length ? lines[idx + 1].text : '';
    }
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }

  /** 顶栏副标题：一眼看到当前状态 / 房间 / 队列概况 */
  function renderSubLine() {
    var el = $('subLine');
    if (!el || !state) return;
    var dm = state.danmaku || {};
    var parts = [];
    parts.push(state.statusText || state.phase || '');
    if (dm.state === 'connected') parts.push('弹幕已连 ' + (dm.roomId || dm.shortRoomId || ''));
    else if (dm.shortRoomId) parts.push('弹幕未连（' + dm.shortRoomId + '）');
    else parts.push('弹幕未连');
    parts.push('队列 ' + ((state.queue || []).length));
    var nAcc = accList().filter(function (a) { return a.loggedIn; }).length;
    if (nAcc) parts.push('已登录 ' + nAcc + ' 个账号');
    el.textContent = parts.filter(Boolean).join(' · ');
  }

  /**
   * 账号 + 平台优先级 合并渲染。
   * 每个平台一行：排名 / 名称 / 登录态 / 音质，操作按钮为 上移 下移 启停 登录。
   * B 站单列一行（它没有优先级概念，只决定能否显示昵称与回复弹幕）。
   */
  function renderPlatforms() {
    var cfg = state.config || {};
    var order = cfg.priority || ['netease', 'qq', 'kugou', 'kuwo'];
    var enabled = cfg.enabledPlatforms || {};
    var status = state.platformStatus || {};
    var servers = state.servers || {};
    var acc = accData || {};

    var accOf = function (key) {
      return ((acc.platforms || []).filter(function (a) { return a.key === key; })[0]) || {};
    };
    var bili = acc.bilibili || {};

    var html = '';

    // ---- B 站（登录项，不参与优先级）----
    html +=
      '<li class="platforms-no-prio" data-noprio="1">' +
      '<div class="prow">' +
      '<span class="rank">B</span>' +
      '<span class="dot ' + (bili.loggedIn ? 'ok' : '') + '"></span>' +
      '<span class="nm">哔哩哔哩（弹幕来源）</span>' +
      '<span class="st ' + (bili.loggedIn ? 'on' : 'off') + '">' + (bili.loggedIn ? '已登录' : '未登录') + '</span>' +
      '</div>' +
      (bili.loggedIn && bili.account ? '<div class="pacc" title="当前登录账号">账号：' + esc(bili.account) + '</div>' : '') +
      '<div class="pacts">' +
      '<button class="btn small primary" data-login="bilibili">' + (bili.loggedIn ? '重新登录' : 'B 站登录') + '</button>' +
      '</div>' +
      (bili.loggedIn
        ? ''
        : '<div class="pnote">未登录时 B 站会把昵称打码成 *、uid 置 0，也发不出回复弹幕。点右上「登录中心」扫码即可。</div>') +
      '</li>';

    // ---- 四个音乐平台：优先级 + 登录态 ----
    order.forEach(function (key, i) {
      var st = status[key] || {};
      var sv = servers[key] || {};
      var a = accOf(key);
      var labels = { netease: '网易云音乐', qq: 'QQ音乐', kugou: '酷狗音乐', kuwo: '酷我音乐' };
      var disabled = a.loginDisabled === true;
      var usable = st.count > 0 && !st.error;
      var dotCls = usable ? 'ok' : a.online === false || sv.state === 'error' || sv.state === 'missing' ? 'bad' : '';
      var stText = disabled ? '无需登录' : a.loggedIn ? '已登录' : a.online === false ? '服务未运行' : '未登录';
      var stCls = disabled || a.loggedIn ? 'on' : 'off';

      html +=
        '<li draggable="true" data-prio-idx="' + i + '" data-key="' + key + '">' +
        '<div class="prow">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="dot ' + dotCls + '"></span>' +
        '<span class="nm">' + esc(labels[key] || key) + '</span>' +
        '<span class="st ' + stCls + '">' + stText + '</span>' +
        '</div>' +
        (a.loggedIn && a.account
          ? '<div class="pacc" title="当前登录账号">账号：' + esc(a.account) + (a.vip ? '（VIP）' : '') + '</div>'
          : '') +
        '<div class="pacts">' +
        '<button class="btn small" data-prio="' + key + '" data-dir="-1" ' + (i === 0 ? 'disabled' : '') + '>上移</button>' +
        '<button class="btn small" data-prio="' + key + '" data-dir="1" ' + (i === order.length - 1 ? 'disabled' : '') + '>下移</button>' +
        '<button class="btn small" data-enable="' + key + '">' + (enabled[key] === false ? '启用' : '停用') + '</button>' +
        (disabled ? '' : '<button class="btn small" data-login="' + key + '">' + (a.loggedIn ? '重新登录' : '登录') + '</button>') +
        '</div>' +
        '<div class="pnote">' + esc(a.note || (sv.state ? '服务 ' + sv.state : '待检测')) + '</div>' +
        '</li>';
    });

    $('platformList').innerHTML = html;
    bindPlatformDrag();
  }

  /** 支持拖拽调整平台优先级 */
  var dragKey = null;
  function bindPlatformDrag() {
    var list = $('platformList');
    var items = list.querySelectorAll('li[draggable="true"]');
    Array.prototype.forEach.call(items, function (li) {
      li.addEventListener('dragstart', function (e) {
        dragKey = li.getAttribute('data-key');
        li.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', function () {
        li.classList.remove('dragging');
        Array.prototype.forEach.call(list.querySelectorAll('li'), function (x) { x.classList.remove('drop-target'); });
        dragKey = null;
      });
      li.addEventListener('dragover', function (e) {
        if (!dragKey || li.getAttribute('data-key') === dragKey) return;
        e.preventDefault();
        li.classList.add('drop-target');
      });
      li.addEventListener('dragleave', function () { li.classList.remove('drop-target'); });
      li.addEventListener('drop', function (e) {
        e.preventDefault();
        li.classList.remove('drop-target');
        var target = li.getAttribute('data-key');
        if (!dragKey || !target || dragKey === target) return;
        var arr = ((state.config && state.config.priority) || []).slice();
        var from = arr.indexOf(dragKey);
        var to = arr.indexOf(target);
        if (from < 0 || to < 0) return;
        arr.splice(from, 1);
        arr.splice(to, 0, dragKey);
        dragKey = null;
        $('platformList').classList.add('loading');
        post('/api/config', { platforms: { priority: arr } });
      });
    });
  }

  function renderChat() {
    var list = state.recentDanmaku || [];
    var cnt = $('chatCount');
    if (cnt) cnt.textContent = String(list.length);
    $('chatList').innerHTML = list
      .map(function (c) {
        var cls = c.kind === 'reply' ? 'reply' : c.kind === 'order' ? 'order' : '';
        var t = new Date(c.at).toLocaleTimeString('zh-CN', { hour12: false });
        return '<li class="' + cls + '"><span class="t">' + t + '</span><span class="who">' + esc(c.uname || '?') + '</span>：' + esc(c.text) + '</li>';
      })
      .join('');
  }

  function renderDanmaku(d) {
    d = d || {};
    var hint = $('danmakuHint');
    if (d.state === 'connected') {
      hint.textContent = '已连接直播间 ' + (d.roomId || d.shortRoomId || '') +
        (d.loggedIn ? '（登录态，昵称正常）' : '（未登录，B 站会把昵称打码成 *）');
    } else if (d.state === 'connecting') {
      hint.textContent = '正在连接直播间 ' + (d.roomId || d.shortRoomId || '') + '…';
    } else if (d.state === 'disconnected') {
      hint.textContent = '已断开' + (d.shortRoomId ? '（上次房间号 ' + d.shortRoomId + '，点「连接」可重连）' : '');
    } else if (d.state === 'idle') {
      hint.textContent = '未连接（填入直播间房间号后点「连接」）';
    } else if (d.state === 'stopped') {
      hint.textContent = '已停止';
    } else {
      hint.textContent = '未连接';
    }
    var s = d.stats || {};
    $('danmakuStats').innerHTML =
      '<span>弹幕 ' + (s.danmaku || 0) + '</span><span>礼物 ' + (s.gift || 0) + '</span><span>醒目留言 ' + (s.superchat || 0) + '</span><span>舰长 ' + (s.guard || 0) + '</span>' +
      (d.popularity ? '<span>人气 ' + d.popularity + '</span>' : '') +
      (d.loggedIn === false ? '<span>未登录 B 站</span>' : '');
    if (state && state.config && state.config.roomId && !$('inRoom').value) $('inRoom').value = state.config.roomId;
  }

  var rulesFilled = false;
  function fillRulesOnce() {
    if (rulesFilled || !state || !state.config) return;
    var c = state.config;
    $('inCooldown').value = Math.round((c.userCooldownMs || 0) / 1000);
    $('inQueueLimit').value = c.queueLimit || 50;
    $('inSameSong').value = c.sameSongMaxTimes || 2;
    $('inDupStrategy').value = c.duplicateStrategy || 'cooldown';
    $('inVolume').value = c.volume == null ? 80 : c.volume;
    $('inIdleSource').value = c.idleSource || 'platform';
    $('inPlaylistId').value = c.idlePlaylistId || '';
    $('inBlackUsers').value = (c.blacklistUsers || []).join(',');
    $('inBlackWords').value = (c.blacklistWords || []).join(',');
    rulesFilled = true;
  }

  // ---------------------------------------------------------------- 事件

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== 'BUTTON') return;
    var d = t.dataset || {};

    if (d.pin) {
      post('/api/queue/pin', { id: d.pin, pinned: d.pinned !== '1' });
    } else if (d.del) {
      post('/api/queue/remove', { id: d.del });
    } else if (d.up) {
      post('/api/queue/move', { id: d.up, index: Math.max(0, Number(d.index) - 1) });
    } else if (d.down) {
      post('/api/queue/move', { id: d.down, index: Number(d.index) + 1 });
    } else if (d.prio) {
      var cfg = (state.config && state.config.priority) || [];
      var arr = cfg.slice();
      var i = arr.indexOf(d.prio);
      var j = i + Number(d.dir);
      if (i >= 0 && j >= 0 && j < arr.length) {
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        post('/api/config', { platforms: { priority: arr } });
      }
    } else if (d.enable) {
      var en = Object.assign({}, (state.config && state.config.enabledPlatforms) || {});
      en[d.enable] = en[d.enable] === false;
      post('/api/config', { platforms: { enabled: en } });
    } else if (d.login) {
      // 统一走账号登录中心（B 站和音乐平台都在里面）
      openAccounts(d.login);
    }
  });

  $('swDanmaku').addEventListener('change', function () {
    post('/api/switches', { danmakuOrder: this.checked });
  });
  $('swIdle').addEventListener('change', function () {
    post('/api/switches', { idleAutoPlay: this.checked });
  });
  $('btnNext').addEventListener('click', function () { post('/api/play/next'); });
  $('btnPause').addEventListener('click', function () { post('/api/play/pause'); });
  $('btnStop').addEventListener('click', function () { post('/api/play/stop'); });
  $('btnClear').addEventListener('click', function () {
    if (confirm('确定清空未播放队列？')) post('/api/queue/clear');
  });

  $('btnChatClear').addEventListener('click', function () {
    post('/api/danmaku/clear-log').then(function () {
      if (state) { state.recentDanmaku = []; renderChat(); }
    });
  });

  $('btnOrder').addEventListener('click', function () {
    var name = $('inName').value.trim();
    if (!name) { $('orderHint').textContent = '请填写歌名'; return; }
    $('orderHint').textContent = '正在搜索与匹配（自动挑最优结果）…';
    post('/api/order', { name: name, singer: $('inSinger').value.trim() }).then(function (r) {
      if (r && r.ok) {
        $('orderHint').textContent = '已加入：' + r.matched.name + ' - ' + r.matched.singer + '（' + r.matched.platformLabel + '，' + r.tierName + '）';
        $('inName').value = '';
        $('inSinger').value = '';
      } else {
        $('orderHint').textContent = '失败：' + ((r && (r.detail || r.reason || r.error)) || '未知原因');
      }
    });
  });

  // ---------------------------------------------------------------- 手动搜索候选
  $('btnSearch').addEventListener('click', function () {
    var name = $('inName').value.trim();
    if (!name) { $('orderHint').textContent = '请填写歌名'; return; }
    var singer = $('inSinger').value.trim();
    $('orderHint').textContent = '正在搜索四个平台…';
    $('candTitle').textContent = '选择要点播的版本：' + name + (singer ? ' - ' + singer : '');
    $('candHint').innerHTML = '<span class="cand-busy"></span> 正在搜索四个平台…';
    $('candBody').innerHTML = '';
    $('candModal').classList.add('show');

    api('/api/search-candidates?keyword=' + encodeURIComponent(name) + '&singer=' + encodeURIComponent(singer) + '&per=3')
      .then(function (r) {
        if (!r || !r.ok) {
          $('candHint').textContent = '搜索失败：' + ((r && r.error) || '未知原因');
          return;
        }
        renderCandidates(r.data);
      });
  });

  function renderCandidates(data) {
    var groups = (data && data.groups) || [];
    var total = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    if (!total) {
      $('candHint').textContent = '四个平台都没有搜到结果，换个关键词或补上歌手名再试。';
      $('candBody').innerHTML = '';
      return;
    }
    $('candHint').textContent = '共 ' + total + ' 个候选。点任意一条即加入播放队列（会自动校验能否播放）。';

    $('candBody').innerHTML = groups
      .map(function (g) {
        var items = g.items
          .map(function (it, i) {
            var tierCls = it.tier === 1 || it.tier === 2 ? 't1' : it.tier === 3 ? 't2' : '';
            var tags = '<i class="' + tierCls + '">' + esc(it.tierName) + '</i>';
            if (it.album) tags += '<i>' + esc(String(it.album).slice(0, 14)) + '</i>';
            if (it.inQueue) tags += '<i class="que">已在队列</i>';
            return (
              '<button class="cand-item" data-pick="' + esc(it.platform) + '" data-song="' + esc(it.songId) + '"' +
              (it.inQueue ? '' : '') + '>' +
              '<span class="nm">' + (i + 1) + '. ' + esc(it.name) + '</span>' +
              '<span class="sub">' + esc(it.singer || '未知歌手') + '</span>' +
              '<span class="tags">' + tags + '</span>' +
              '</button>'
            );
          })
          .join('');
        return (
          '<div class="cand-col">' +
          '<div class="cand-col-head"><b>' + esc(g.label) + '</b>' +
          '<span class="cnt">命中 ' + g.total + ' 首</span></div>' +
          (g.note ? '<p class="cand-empty">' + esc(g.note) + '</p>' : '') +
          (items || '<p class="cand-empty">该平台没有可用结果</p>') +
          '</div>'
        );
      })
      .join('');
  }

  $('candBody').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-pick]') : null;
    if (!btn) return;
    var platform = btn.getAttribute('data-pick');
    var songId = btn.getAttribute('data-song');
    var label = btn.querySelector('.nm') ? btn.querySelector('.nm').textContent : songId;
    btn.disabled = true;
    var old = btn.querySelector('.sub').textContent;
    btn.querySelector('.sub').textContent = old + '  —  正在校验播放地址…';

    post('/api/order-candidate', { platform: platform, songId: songId }).then(function (r) {
      if (r && r.ok) {
        btn.querySelector('.sub').textContent = '✅ 已加入队列（' + (r.matched.qualityLabel || r.matched.platformLabel || '') + '）';
        $('candHint').textContent = '已加入：' + r.matched.name + ' - ' + r.matched.singer + '（' + r.matched.platformLabel + '）';
        $('inName').value = '';
        $('inSinger').value = '';
      } else {
        btn.disabled = false;
        btn.querySelector('.sub').textContent = old + '  —  ❌ ' + ((r && (r.detail || r.error || r.reason)) || '无法播放');
      }
    });
  });

  $('candClose').addEventListener('click', function () { $('candModal').classList.remove('show'); });
  $('candModal').addEventListener('click', function (ev) {
    if (ev.target === this) $('candModal').classList.remove('show');
  });

  $('btnConnect').addEventListener('click', function () {
    var roomId = Number($('inRoom').value.trim());
    if (!roomId) { $('danmakuHint').textContent = '请填写直播间房间号'; return; }
    $('danmakuHint').textContent = '正在连接…';
    post('/api/danmaku/connect', { roomId: roomId }).then(function (r) {
      if (!r.ok) $('danmakuHint').textContent = '连接失败：' + (r.error || '');
    });
  });
  $('btnDisconnect').addEventListener('click', function () { post('/api/danmaku/disconnect'); });

  // ================================================================
  //  账号登录中心（B 站 + 四个音乐平台）
  // ================================================================

  var ACC_META = {
    bilibili: { qr: true, tip: '弹幕来源。登录后才能显示点歌人昵称（否则 B 站会打码成 *），也才能回复弹幕。' },
    netease: { qr: true, tip: '登录 VIP 账号后可取无损 / 母带直链。' },
    qq: {
      qr: true,
      qrKind: 'wechat',
      // 两种扫码方式，微信在前（推荐）；QQ 扫码受腾讯限制，通常扫出来是下载页
      qrMethods: [
        { id: 'wx', label: '微信扫码', recommend: true },
        { id: '', label: 'QQ 扫码' },
      ],
      tip:
        'QQ 音乐提供两种扫码登录：**微信扫码**（推荐，实测可用）和 QQ 扫码。' +
        'QQ 扫码受腾讯限制，二维码常常是「下载 QQ 手机版」的链接，扫不出登录态，建议用微信。',
      cookieHelp:
        '<ol class="acc-steps" style="margin-bottom:10px">' +
        '<li>点下面的按钮打开 QQ 音乐网页版并登录</li>' +
        '<li>登录后在该页面按 <code>F12</code> → Console/控制台，粘贴执行：<br>' +
        '<code>copy(document.cookie)</code></li>' +
        '<li>回到这里粘进输入框，点「保存 Cookie」——<b>会立刻校验并给出结论</b></li>' +
        '<li>需要包含 <code>uin</code> 与 <code>qm_keyst</code>（或 <code>qqmusic_key</code>）</li>' +
        '</ol>' +
        '<div class="acc-row" style="margin-bottom:10px">' +
        '<a class="btn small primary" href="https://y.qq.com/" target="_blank" rel="noopener">打开 QQ 音乐并登录</a>' +
        '</div>' +
        '<p class="hint" style="margin:0 0 10px">补充：QQ 音乐未登录时也能取到完整直链，所以不登录一般也不影响点歌播放。</p>',
    },
    kugou: { qr: true, tip: '登录后可取无损 FLAC / 320 直链。' },
    kuwo: {
      qr: true,
      qrKind: 'wechat',
      tip: '酷我用「微信扫码」登录：手机微信扫一扫 → 手机上点确认即可。登录后取无损 FLAC / 320。',
    },
  };
  var accData = null;
  var accSelected = 'bilibili';
  var accQrTimer = null;
  // 当前正在展示的二维码：刷新账号状态时不会把它冲掉
  var accQr = { key: null, dataUrl: '', url: '', qrKey: '', state: '', stateClass: '' };
  // 当前选中的扫码方式（QQ 音乐可在 QQ / 微信之间切换）
  var qrActive = { key: '', kind: '' };

  function accList() {
    if (!accData) return [];
    return [accData.bilibili].concat(accData.platforms || []);
  }

  function accByKey(key) {
    return accList().filter(function (a) { return a.key === key; })[0] || null;
  }

  /** 设置中心的标签页切换 */
  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('#accTabs .tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tabpane'), function (p) {
      p.classList.toggle('active', p.getAttribute('data-pane') === name);
    });
    // 切到平台页时重绘一次，保证优先级与登录态是最新的
    if (name === 'platforms') renderPlatforms();
    if (name === 'room') renderDanmaku(state && state.danmaku);
  }
  $('accTabs').addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('.tab') : null;
    if (t) switchTab(t.getAttribute('data-tab'));
  });

  /** 打开设置中心（可指定平台并直接跳到对应账号） */
  function openAccounts(platform) {
    $('accModal').classList.add('show');
    switchTab('accounts');
    if (platform) accSelected = platform;
    renderAccounts();
    refreshAccounts();
  }
  function closeAccounts() {
    $('accModal').classList.remove('show');
    if (accQrTimer) { clearInterval(accQrTimer); accQrTimer = null; }
  }
  function refreshAccounts() {
    return api('/api/accounts').then(function (r) {
      if (r && r.ok) {
        accData = r.data;
        renderAccounts();
        // 账号状态也直接影响「账号与平台」卡片，这里一并刷新
        if (state) renderPlatforms();
      }
    });
  }

  function renderAccounts() {
    var list = accList();

    // 顶栏按钮上显示「登录中心 N/5」
    var btn = $('btnAccounts');
    var sum = $('accSummary');
    if (list.length) {
      var nOk = list.filter(function (a) { return a.loggedIn; }).length;
      if (sum) sum.textContent = nOk + '/' + list.length;
      if (btn) {
        btn.title =
          '已登录 ' + nOk + '/' + list.length + '：' +
          list.map(function (a) { return a.label + (a.loggedIn ? '✔' : '✘'); }).join('，');
      }
    }

    $('accList').innerHTML = list.map(function (a) {
      var meta = ACC_META[a.key] || {};
      var disabled = a.loginDisabled || meta.loginDisabled;
      var tagText = disabled ? '无需登录' : a.loggedIn ? '已登录' : meta.qr ? '可扫码' : '粘贴 Cookie';
      var tagCls = disabled ? 'tag off' : a.loggedIn ? 'tag on' : 'tag';
      return (
        '<li class="' + (a.key === accSelected ? 'active' : '') + '" data-acc="' + a.key + '">' +
        '<span class="dot ' + (disabled ? 'ok' : a.loggedIn ? 'ok' : a.online === false ? 'bad' : '') + '"></span>' +
        '<div><div class="nm">' + esc(a.label) + '</div>' +
        '<div class="sub">' + esc(a.note || (a.loggedIn ? '已登录' : '未登录')) + '</div></div>' +
        '<span class="' + tagCls + '">' + tagText + '</span>' +
        '</li>'
      );
    }).join('');

    renderAccDetail();
  }

  /** 该账号可用的扫码方式（第一个是默认推荐的） */
  function qrMethodsOf(key, meta) {
    if (meta.qrMethods) return meta.qrMethods;
    if (meta.qr) {
      return [{ id: meta.qrKind === 'wechat' ? 'wx' : '', label: meta.qrKind === 'wechat' ? '微信扫码' : '扫码登录' }];
    }
    return [];
  }

  function renderAccDetail() {
    var a = accByKey(accSelected);
    if (!a) {
      $('accDetail').innerHTML = '<div class="acc-placeholder">左侧选择一个账号开始登录</div>';
      return;
    }
    var meta = ACC_META[a.key] || {};
    var loginDisabled = a.loginDisabled || meta.loginDisabled;
    var methods = qrMethodsOf(a.key, meta);
    // 记住用户选的扫码方式（默认第一种，即推荐的那种）
    if (qrActive.key !== a.key || !methods.some(function (m) { return m.id === qrActive.kind; })) {
      qrActive = { key: a.key, kind: methods.length ? methods[0].id : '' };
    }

    // 不需要登录的平台：只展示状态，不给登录入口
    if (loginDisabled) {
      var kvs2 = [];
      if (a.port) kvs2.push('本地端口 ' + a.port);
      kvs2.push(a.online ? 'API 服务在线' : 'API 服务未运行');
      if (a.quality) kvs2.push('当前音质 ' + a.quality);
      kvs2.push('播放可用：' + (a.playable ? '是' : '否'));
      $('accDetail').innerHTML =
        '<div class="acc-section">' +
        '<h4>' + esc(a.label) + '</h4>' +
        '<div class="acc-kv">' + kvs2.map(function (k) { return '<span>' + esc(k) + '</span>'; }).join('') + '</div>' +
        '<p class="acc-note ok">' + esc(a.note || meta.tip || '') + '</p>' +
        '</div>' +
        '<div class="acc-section">' +
        '<h4>为什么不需要登录</h4>' +
        '<ol class="acc-steps">' +
        '<li>酷我网页端只开放短信验证码登录，没有对外提供扫码接口</li>' +
        '<li>当前版本直接用匿名接口取播放地址，<b>点歌、播放、队列、置顶全部正常</b></li>' +
        '<li>代价是音质为标准 128k；其余三个平台登录后仍可取无损</li>' +
        '<li>如果日后想启用酷我登录：把 <code>core\\Alogorithm-main\\tools\\login.js</code> 里 kuwo 的 <code>disabled</code> 改成 <code>false</code>，再用「粘贴 Cookie」登录</li>' +
        '</ol>' +
        '</div>';
      return;
    }

    var kvs = [];
    if (a.port) kvs.push('本地端口 ' + a.port);
    if (a.online !== undefined) kvs.push(a.online ? 'API 服务在线' : 'API 服务未运行');
    // 账号名放最前面，一眼能看到「现在登的是谁」
    if (a.loggedIn && a.account) kvs.unshift('账号 ' + a.account + (a.vip ? '（VIP）' : ''));
    if (a.uid) kvs.push('uid ' + a.uid);
    if (a.cookieMask) kvs.push('Cookie ' + a.cookieMask);
    if (a.dmState) kvs.push('弹幕连接 ' + a.dmState);
    if (a.roomId) kvs.push('房间号 ' + a.roomId);

    $('accDetail').innerHTML =
      '<div class="acc-section">' +
      '<h4>' + esc(a.label) + '</h4>' +
      '<div class="acc-kv">' + kvs.map(function (k) { return '<span>' + esc(k) + '</span>'; }).join('') + '</div>' +
      '<p class="acc-note ' + (a.loggedIn ? 'ok' : '') + '">' + esc(a.note || meta.tip || '') + '</p>' +
      '</div>' +
      (methods.length
        ? '<div class="acc-section">' +
          '<h4>方式一：扫码登录</h4>' +
          (methods.length > 1
            ? '<div class="acc-row" id="accQrTabs" style="margin-bottom:10px">' +
              methods
                .map(function (m) {
                  return '<button class="btn small' + (m.id === qrActive.kind ? ' primary' : '') +
                    '" data-qrkind="' + esc(m.id) + '">' + esc(m.label) + (m.recommend ? '（推荐）' : '') + '</button>';
                })
                .join('') +
              '</div>'
            : '') +
          (methods[0].id === 'wx'
            ? '<ol class="acc-steps" style="margin-bottom:10px">' +
              '<li>点下面按钮获取二维码</li>' +
              '<li>打开<b>手机微信 → 扫一扫</b>，扫描二维码</li>' +
              '<li>在手机上点「确认登录」，本页面会自动完成登录</li>' +
              '</ol>'
            : '') +
          '<div class="acc-qr" id="accQrBox"><div class="ph">点击下方按钮获取二维码</div></div>' +
          '<div class="acc-row"><button class="btn primary" id="accGetQr">' +
          (qrActive.kind === 'wx' ? '获取微信二维码' : '获取二维码') +
          '</button>' +
          '<button class="btn" id="accCancelQr" style="display:none">取消等待</button></div>' +
          '</div>'
        : '<div class="acc-section">' +
          '<h4>登录说明</h4>' +
          '<ol class="acc-steps">' +
          '<li>该平台未提供扫码登录，请用下面的「粘贴 Cookie」方式</li>' +
          '<li>浏览器登录该平台官网，按 <code>F12</code> 复制 Cookies 整行</li>' +
          '</ol>' +
          '</div>') +
      '<div class="acc-section">' +
      '<h4>' + (meta.qr ? '方式二：' : '') + '粘贴 Cookie（' + (meta.qr ? '备选，同样有效' : '推荐，最稳') + '）</h4>' +
      (meta.cookieHelp ? meta.cookieHelp : '') +
      '<textarea class="acc-input" id="accCookie" placeholder="' + esc(cookiePlaceholder(a.key)) + '"></textarea>' +
      '<div class="acc-row" style="margin-top:8px">' +
      '<button class="btn primary" id="accSaveCookie">保存 Cookie</button>' +
      (a.loggedIn ? '<button class="btn danger" id="accLogout">退出登录</button>' : '') +
      '</div>' +
      '<p class="acc-note" id="accHint"></p>' +
      '</div>';

    $('accGetQr') && ($('accGetQr').onclick = function () { startAccQr(a.key); });
    $('accCancelQr') && ($('accCancelQr').onclick = function () {
      stopAccQr();
      $('accHint').textContent = '已取消等待';
    });
    // 切换扫码方式（QQ 音乐：微信 / QQ）
    var tabs = $('accQrTabs');
    if (tabs) {
      tabs.onclick = function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-qrkind]') : null;
        if (!b) return;
        var kind = b.getAttribute('data-qrkind');
        if (kind === qrActive.kind) return;
        stopAccQr();
        qrActive = { key: a.key, kind: kind };
        renderAccDetail();
      };
    }
    $('accSaveCookie').onclick = function () { saveAccCookie(a.key); };
    $('accLogout') && ($('accLogout').onclick = function () { logoutAcc(a.key); });

    // 如果这个平台正有一张二维码在等待扫描，恢复它（刷新账号状态时不会丢）
    if (methods.length && accQr.key === a.key) restoreAccQr();
  }

  /** 把保存下来的二维码重新画回详情区，并继续轮询 */
  function restoreAccQr() {
    var box = $('accQrBox');
    if (!box) return;
    if (accQr.dataUrl) {
      box.innerHTML = '<img src="' + accQr.dataUrl + '" alt="二维码" />' +
        '<div class="state ' + accQr.stateClass + '" id="accQrState">' + esc(accQr.state || '请用手机扫码') + '</div>';
    } else if (accQr.url) {
      box.innerHTML = '<div class="ph">无法生成图片</div>' +
        '<a href="' + esc(accQr.url) + '" target="_blank" rel="noopener">点此打开扫码链接</a>' +
        '<div class="state ' + accQr.stateClass + '" id="accQrState">' + esc(accQr.state || '请用手机扫码') + '</div>';
    } else {
      return;
    }
    if ($('accGetQr')) $('accGetQr').style.display = 'none';
    if ($('accCancelQr')) $('accCancelQr').style.display = '';
    if (!accQrTimer && accQr.qrKey) {
      accQrTimer = setInterval(function () { pollAccQr(accQr.key, accQr.qrKey); }, 2000);
    }
  }

  function stopAccQr() {
    if (accQrTimer) { clearInterval(accQrTimer); accQrTimer = null; }
    accQr = { key: null, dataUrl: '', url: '', qrKey: '', state: '', stateClass: '' };
  }

  function cookiePlaceholder(key) {
    var map = {
      bilibili: 'SESSDATA=xxx; bili_jct=yyy; DedeUserID=zzz',
      netease: 'MUSIC_U=xxx; __csrf=yyy',
      qq: 'uin=123456; qm_keyst=xxxxx',
      kugou: 'token=xxxx; userid=123456',
      kuwo: 'userid=12345678; sid=xxxx; t3=xxxx; websid=xxxx',
    };
    return map[key] || '粘贴该平台登录后的 Cookie 字符串';
  }

  function startAccQr(key) {
    var box = $('accQrBox');
    if (!box) return;
    stopAccQr();
    accQr.key = key;
    box.innerHTML = '<div class="ph">正在获取二维码…</div>';

    var path = key === 'bilibili' ? '/api/bili/qr' : '/api/login/' + key + '/qr';
    // QQ 音乐要带上用户选的扫码方式（wx = 微信）
    if (key === 'qq' && qrActive.kind === 'wx') path += '?kind=wx';
    post(path).then(function (r) {
      if (!r.ok) {
        box.innerHTML = '<div class="ph">获取失败：' + esc(r.error || '') + '</div>';
        return;
      }
      var d = r.data || {};
      accQr.dataUrl = d.base64 || '';
      accQr.url = d.url || '';
      accQr.qrKey = d.key || '';
      accQr.state = d.qrKind === 'wechat' ? '请用微信扫一扫，并在手机上确认' : '请用手机扫码';
      accQr.stateClass = '';

      // 平台自己说「扫码链路不可用」（如 QQ 被腾讯限制成下载码）时，直接给出提示
      if (d.loginReachable === false && d.tip) {
        box.innerHTML =
          (d.base64 ? '<img src="' + d.base64 + '" alt="二维码" />' : '') +
          '<div class="ph" style="color:#ffd0da;margin-top:10px">' + esc(d.tip) + '</div>';
        return;
      }

      if (!accQr.dataUrl && !accQr.url) {
        box.innerHTML = '<div class="ph">该平台未返回二维码，请使用下方 Cookie 方式</div>';
        return;
      }
      restoreAccQr();
      accQrTimer = setInterval(function () { pollAccQr(key, accQr.qrKey); }, 2000);
    });
  }

  function pollAccQr(key, qrKey) {
    // 没有 key 说明这一步已经结束（比如刚登录成功），不再请求
    if (!key || !qrKey) return;
    var state = $('accQrState');
    var path = key === 'bilibili'
      ? '/api/bili/qr-check?key=' + encodeURIComponent(qrKey)
      : '/api/login/' + key + '/qr-check?key=' + encodeURIComponent(qrKey) +
        (key === 'qq' && qrActive.kind === 'wx' ? '&kind=wx' : '');

    api(path).then(function (r) {
      var d = (r && r.data) || {};
      var done = false;
      var text = d.message || '';
      if (key === 'bilibili') {
        if (d.status === 'scanned') text = '已扫码，请在手机上确认';
        else if (d.status === 'waiting') text = '等待扫码…';
        else if (d.status === 'expired') text = '二维码已失效，请重新获取';
        if (d.status === 'success') { done = true; text = '登录成功：' + (d.uname || ''); }
      } else if (d.loggedIn === true) {
        // 注意：必须用 === true 判断，{loggedIn:false} 也是真值对象
        done = true;
        text = d.nickname ? '登录成功：' + d.nickname : '登录成功';
      } else if (key === 'kuwo' || (key === 'qq' && qrActive.kind === 'wx')) {
        // 微信扫码：status 是微信的 errcode
        // 408 未扫码 / 404 已扫待确认 / 402 已取消 / 403 已过期 / -1 解析失败 / -2 换取登录态失败
        var s = Number(d.status);
        if (s === 404) text = '已扫码，请在手机上点确认';
        else if (s === 408 || !text) text = '等待扫码…';
        else if (s === 402 || s === 403 || d.terminal) text = text || '二维码已失效，请重新获取';
        // 换取登录态失败：把服务端步骤显示出来，否则用户只看到「失败」不知道为什么
        if (s === -2 && d.steps && d.steps.length) {
          text = text + '（' + d.steps[d.steps.length - 1] + '）';
        }
        if (s === -2) {
          if (d.raw) {
            try {
              console.warn('[QQ 微信登录] 服务端原始返回：', d.raw);
            } catch (e) {
              /* 忽略 */
            }
          }
          // 不再继续轮询：会话已经被服务端清掉了
          stopAccQr();
        }
      } else if (String(d.status) === '4' || String(d.status) === '1') {
        done = true;
        text = '登录成功';
      } else if (String(d.status) === '0') {
        text = '二维码已失效，请重新获取';
      }
      if (state) {
        state.textContent = text;
        state.className = 'state' + (done ? ' ok' : /失效|失败|错误/.test(text) ? ' bad' : '');
      }
      // 同步到持久状态，刷新账号信息后仍能显示
      accQr.state = text;
      accQr.stateClass = done ? 'ok' : /失效|失败|错误/.test(text) ? 'bad' : '';
      if (/失效|过期/.test(text)) {
        accQr.qrKey = '';
        if (accQrTimer) { clearInterval(accQrTimer); accQrTimer = null; }
        if ($('accGetQr')) $('accGetQr').style.display = '';
        if ($('accCancelQr')) $('accCancelQr').style.display = 'none';
      }
      if (done) {
        stopAccQr();
        // 登录成功后让详情区回到初始状态
        setTimeout(function () {
          refreshAccounts().then(renderAccDetail);
        }, 800);
      }    });
  }

  function saveAccCookie(key) {
    var cookie = ($('accCookie').value || '').trim();
    if (!cookie) { $('accHint').textContent = '请先粘贴 Cookie'; return; }
    $('accHint').textContent = '正在保存并验证…';
    var path = key === 'bilibili' ? '/api/bili/cookie' : '/api/login/' + key + '/cookie';
    post(path, { cookie: cookie }).then(function (r) {
      if (!r.ok) { $('accHint').textContent = '保存失败：' + (r.error || ''); return; }
      var d = r.data || {};
      var hint = $('accHint');
      if (key === 'bilibili') {
        hint.textContent = d.loggedIn ? '已登录：' + (d.uname || '') + '（uid ' + (d.uid || '') + '）' : '已保存，但服务端仍未确认登录';
      } else if (d.message) {
        // 服务端已经做过真实校验，直接显示结论（成功 / 为什么失败）
        hint.textContent = d.message;
      } else {
        hint.textContent = '已保存' + (d.loggedIn ? '，且验证通过' : '');
      }
      hint.style.color = d.validated === false ? '#ffd0da' : '';
      setTimeout(refreshAccounts, 800);
    });
  }

  function logoutAcc(key) {
    if (!confirm('确定退出该账号登录吗？')) return;
    var path = key === 'bilibili' ? '/api/bili/logout' : '/api/login/' + key + '/logout';
    post(path).then(function () {
      $('accHint').textContent = '已退出登录';
      setTimeout(refreshAccounts, 600);
    });
  }

  $('btnAccounts').addEventListener('click', function () { openAccounts(); });
  $('accClose').addEventListener('click', closeAccounts);
  $('accRefresh').addEventListener('click', function () { refreshAccounts(); });

  $('accModal').addEventListener('click', function (ev) {
    if (ev.target === this) return closeAccounts();
    var li = ev.target.closest ? ev.target.closest('[data-acc]') : null;
    if (li && li.tagName === 'LI') {
      accSelected = li.getAttribute('data-acc');
      renderAccounts();
    }
  });

  $('btnSaveRules').addEventListener('click', function () {
    var patch = {
      order: {
        userCooldownMs: Number($('inCooldown').value || 0) * 1000,
        queueLimit: Number($('inQueueLimit').value || 50),
        sameSongMaxTimes: Number($('inSameSong').value || 1),
        duplicateStrategy: $('inDupStrategy').value,
        blacklistUsers: $('inBlackUsers').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        blacklistWords: $('inBlackWords').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      },
      play: { volume: Number($('inVolume').value || 80) },
      idle: {
        source: $('inIdleSource').value,
        playlistId: $('inPlaylistId').value.trim(),
      },
    };
    post('/api/config', patch).then(function () { $('btnSaveRules').textContent = '已保存'; setTimeout(function () { $('btnSaveRules').textContent = '保存规则'; }, 1500); });
  });

  $('btnDiag').addEventListener('click', function () {
    $('modalTitle').textContent = '系统体检';
    $('modalBody').innerHTML = '正在检测 mpv 与四平台…';
    $('modal').classList.add('show');
    api('/api/diagnostics').then(function (r) {
      var d = (r && r.data) || {};
      var html = '<div class="row"><b>MPV 路径</b><span>' + esc(d.mpv.path) + '</span></div>';
      html += '<div class="row"><b>MPV 版本</b><span>' + esc(d.mpv.version) + '</span></div>';
      Object.keys(d.platforms || {}).forEach(function (k) {
        var p = d.platforms[k];
        html += '<div class="row"><b>' + esc(k) + '</b><span>' + (p.ok ? '正常' : '异常：' + esc(p.error || '')) + ' · 端口 ' + esc(p.port) + '</span></div>';
      });
      html += '<div class="row"><b>弹幕</b><span>' + esc(JSON.stringify(d.danmaku)) + '</span></div>';
      html += '<div class="row"><b>WebSocket 客户端</b><span>' + d.ws + '</span></div>';
      html += '<pre>' + esc(JSON.stringify(d.servers, null, 2)) + '</pre>';
      $('modalBody').innerHTML = html;
    });
  });

  $('modalClose').addEventListener('click', function () {
    $('modal').classList.remove('show');
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  });

  // ---------------------------------------------------------------- 启动

  loadLyricCfg();
  applyLyricCfg();
  syncLyricControls();

  api('/api/state').then(function (r) {
    if (r && r.ok) { state = r.data; render(); }
  });
  refreshAccounts();
  setInterval(refreshAccounts, 60000);
  connectWs();
  setInterval(function () {
    if (!ws || ws.readyState !== 1) {
      api('/api/state').then(function (r) { if (r && r.ok) { state = r.data; render(); } });
    }
  }, 5000);
})();
