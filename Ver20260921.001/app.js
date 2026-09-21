(function () {
  'use strict';

  var APP_VERSION = 'Ver20260921.001';
  var HISTORY_KEY = 'elements16_diagnosis_history';
  var ADMIN_KEY = 'elements16_admin_mode';
  var NOTE_CATALOG_URL = 'https://note.com/catalog_note';

  // ============================================================
  // アクセス制限（配布リンク対策）
  // 64-スペクトラムWEB版と同じ仕組み。指定リンク以外からのアクセスは
  // ブロックし、管理者モードでは無視してどこからでも起動できる。
  // ============================================================
  var EXPECTED_REFERRER_PREFIX = 'https://com-nurse-code.github.io/16elements/link.html';
  var ADMIN_BYPASS_WORD = 'ADMINUSER';

  function isAdminMode() {
    try { return localStorage.getItem(ADMIN_KEY) === 'true'; } catch (e) { return false; }
  }
  function setAdminMode(v) {
    try { localStorage.setItem(ADMIN_KEY, v ? 'true' : 'false'); } catch (e) { /* noop */ }
  }
  function checkAccess() {
    if (isAdminMode()) return true;
    if (!EXPECTED_REFERRER_PREFIX) return true;
    var referrer = document.referrer || '';
    return referrer.indexOf(EXPECTED_REFERRER_PREFIX) === 0;
  }

  var root = document.getElementById('app');

  var state = {
    screen: 'menu',
    name: '',
    questions: [],
    currentIndex: 0,
    answers: [],
    times: [],
    questionStartTime: 0,
    aspirationMode: 'text',
  };

  // ---------------- utilities ----------------
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function sampleOne(arr) { return shuffle(arr)[0]; }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function countOccurrences(text, sub) {
    if (!sub) return 0;
    var count = 0, pos = 0;
    while ((pos = text.indexOf(sub, pos)) !== -1) { count++; pos += sub.length; }
    return count;
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function saveHistoryEntry(entry) {
    var hist = loadHistory();
    hist.push(entry);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist)); } catch (e) { /* noop */ }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function formatDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function formatDateJp(d) {
    return d.getFullYear() + '年' + pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日 ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ---------------- データロジック（questions.py 相当） ----------------
  // 全36問(4軸×9問)を返す。各要素は [axis, text, direction]。
  // 軸ごとに「8問の固有問題」+「そのうち1問を再度出題する重複問題」で
  // 9問のまとまりを作る(重複問題は回答の一貫性チェックに使う)。
  function buildQuestions() {
    var questions = [];
    var axes = shuffle(Object.keys(DATA.RAW_QUESTIONS));
    axes.forEach(function (axis) {
      var items = shuffle(DATA.RAW_QUESTIONS[axis]);
      items.forEach(function (it) { questions.push([axis, it[0], it[1]]); });
      var dup = sampleOne(items);
      questions.push([axis, dup[0], dup[1]]);
    });
    return questions;
  }

  function typeDetails(type) {
    var info = DATA.TYPE_INFO[type] || ['', '該当するタイプ説明が見つかりませんでした。'];
    return {
      accent: DATA.TYPE_COLORS[type] || '#3B82F6',
      nickname: info[0],
      description: info[1],
      strengths: DATA.TYPE_STRENGTHS[type] || [],
      growth: DATA.TYPE_GROWTH[type] || [],
      tips: DATA.TRAINING_TIPS[type] || [],
    };
  }

  function extendedVariantTypes(core) {
    return DATA.EXTENDED_VARIANT_CODES.map(function (code) { return core + '-' + code; });
  }

  function timeBandFor(sec) {
    var table = DATA.TIME_BAND_TABLE;
    for (var i = 0; i < table.length; i++) {
      var row = table[i];
      if (sec >= row[0] && (row[1] === null || sec < row[1])) {
        return { key: row[2], label: row[3], desc: row[4] };
      }
    }
    var last = table[table.length - 1];
    return { key: last[2], label: last[3], desc: last[4] };
  }

  function detectNoise(bands) {
    var n = bands.length;
    var isNoise = new Array(n).fill(false);
    var streakStart = null;
    for (var i = 0; i <= n; i++) {
      var b = i < n ? bands[i] : null;
      if (b && b.key === 'reflex') {
        if (streakStart === null) streakStart = i;
      } else {
        if (streakStart !== null && i - streakStart >= DATA.RAPID_STREAK_THRESHOLD) {
          for (var j = streakStart; j < i; j++) isNoise[j] = true;
        }
        streakStart = null;
      }
    }
    return isNoise;
  }

  function computeConsistency(questions, answers) {
    var seen = {};
    var pairs = [];
    questions.forEach(function (q, i) {
      var key = q[0] + '||' + q[1];
      if (seen.hasOwnProperty(key)) {
        var firstI = seen[key];
        pairs.push(Math.abs(answers[firstI] - answers[i]) === 0);
      } else {
        seen[key] = i;
      }
    });
    if (!pairs.length) return null;
    var matches = pairs.filter(Boolean).length;
    return Math.round(matches / pairs.length * 100);
  }

  function computeAxisPercentages(questions, answers) {
    var scores = {}, counts = {};
    DATA.CORE_AXIS_KEYS.forEach(function (a) { scores[a] = 0; counts[a] = 0; });
    questions.forEach(function (q, i) {
      var axis = q[0], direction = q[2], val = answers[i];
      scores[axis] += direction === 1 ? val : (6 - val);
      counts[axis]++;
    });
    var percentages = [], chosen = {};
    Object.keys(DATA.AXIS_PAIRS).forEach(function (primary) {
      var opposite = DATA.AXIS_PAIRS[primary];
      var n = counts[primary], total = scores[primary];
      var pct = (total - n) / (n * 5 - n) * 100;
      pct = Math.max(0, Math.min(100, pct));
      chosen[primary] = pct >= 50 ? primary : opposite;
      percentages.push([primary, opposite, pct]);
    });
    var type = DATA.CORE_AXIS_KEYS.map(function (a) { return chosen[a]; }).join('');
    return { percentages: percentages, type: type, counts: counts };
  }

  function guessTypeFromText(text) {
    var counts = {}, total = 0;
    Object.keys(DATA.ASPIRATION_KEYWORDS).forEach(function (axis) {
      var kws = DATA.ASPIRATION_KEYWORDS[axis];
      var primary = kws[0].reduce(function (s, k) { return s + countOccurrences(text, k); }, 0);
      var opposite = kws[1].reduce(function (s, k) { return s + countOccurrences(text, k); }, 0);
      counts[axis] = { primary: primary, opposite: opposite };
      total += primary + opposite;
    });
    if (total === 0) return { type: null, counts: counts };
    var letters = DATA.CORE_AXIS_KEYS.map(function (axis) {
      var c = counts[axis];
      return c.opposite > c.primary ? DATA.AXIS_PAIRS[axis] : axis;
    });
    return { type: letters.join(''), counts: counts };
  }

  function buildQuickAspirationQuestions() {
    var items = [];
    Object.keys(DATA.ASPIRATION_QUICK_QUESTIONS).forEach(function (axis) {
      DATA.ASPIRATION_QUICK_QUESTIONS[axis].forEach(function (pair) {
        items.push([axis, pair[0], pair[1]]);
      });
    });
    return items;
  }

  function typeFromQuickAnswers(answers) {
    var votes = {};
    Object.keys(DATA.AXIS_PAIRS).forEach(function (a) { votes[a] = { primary: 0, opposite: 0 }; });
    answers.forEach(function (pair) {
      var axis = pair[0], chosen = pair[1];
      if (chosen === axis) votes[axis].primary++; else votes[axis].opposite++;
    });
    var letters = DATA.CORE_AXIS_KEYS.map(function (axis) {
      var v = votes[axis];
      return v.opposite > v.primary ? DATA.AXIS_PAIRS[axis] : axis;
    });
    return letters.join('');
  }

  function compatibilityInfo(a, b) {
    var match = 0;
    for (var i = 0; i < 4; i++) if (a[i] === b[i]) match++;
    var displayValue = match + 1;
    var lv = DATA.COMPATIBILITY_LEVELS[String(displayValue)];
    return [displayValue, lv[0], lv[1]];
  }

  // ---------------- ナビゲーション ----------------
  function navigateTo(screen) {
    state.screen = screen;
    render();
    window.scrollTo(0, 0);
  }

  function headerStrip() {
    return '<div class="header-strip"><span></span><span></span><span></span><span></span></div>';
  }

  function backButton() {
    return '<button class="back-btn" data-nav="menu">☰ メニューに戻る</button>';
  }

  function bindNavButtons() {
    root.querySelectorAll('[data-nav]').forEach(function (el) {
      el.addEventListener('click', function () { navigateTo(el.dataset.nav); });
    });
  }

  // ---------------- アクセス表示・管理者モードの隠し入口 ----------------
  function renderAccessIndicator() {
    var referrer = document.referrer || '';
    var watermarkText = isAdminMode() ? '👑 管理者モード' : '🌐 Web版';
    var logoutHtml = isAdminMode()
      ? ' <button class="admin-logout-btn" id="admin-logout-btn" type="button">（解除）</button>' : '';
    return (
      '<div class="access-row">' +
      '<span class="watermark" id="watermark-label">' + watermarkText + '</span>' + logoutHtml +
      '<span class="access-url-label">直前のURL</span>' +
      '<input type="text" class="access-url-field" id="referrer-field" value="' +
      escapeHtml(referrer) + '" readonly placeholder="（直接アクセス）">' +
      '</div>' +
      '<div class="hidden-admin-box" id="hidden-admin-box" hidden>' +
      '<input type="password" class="admin-word-input" id="admin-word-input" placeholder="合言葉">' +
      '<button class="admin-auth-btn" id="admin-auth-btn" type="button">認証する</button>' +
      '<span class="admin-error" id="admin-error"></span>' +
      '</div>'
    );
  }

  function bindAccessIndicator() {
    var watermark = document.getElementById('watermark-label');
    var hiddenBox = document.getElementById('hidden-admin-box');
    if (watermark && hiddenBox) {
      watermark.addEventListener('click', function () {
        if (!hiddenBox.hidden) return;
        hiddenBox.hidden = false;
        var input = document.getElementById('admin-word-input');
        if (input) input.focus();
      });
    }
    var authBtn = document.getElementById('admin-auth-btn');
    var wordInput = document.getElementById('admin-word-input');
    if (authBtn && wordInput) {
      var tryAuth = function () {
        var errorEl = document.getElementById('admin-error');
        if (wordInput.value.trim() === ADMIN_BYPASS_WORD) {
          setAdminMode(true);
          navigateTo('menu');
        } else {
          if (errorEl) errorEl.textContent = '合言葉が違います。';
          wordInput.value = '';
        }
      };
      authBtn.addEventListener('click', tryAuth);
      wordInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryAuth(); });
    }
    var logoutBtn = document.getElementById('admin-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        setAdminMode(false);
        navigateTo(checkAccess() ? 'menu' : 'blocked');
      });
    }
  }

  // ---------------- ブロック画面 ----------------
  function renderBlocked() {
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px;color:#DC2626">🔒 このページは現在ご利用いただけません</h2>' +
      '<p class="sub-text">指定されたリンクを経由してアクセスした場合のみご利用いただけます。<br>' +
      'URLを直接開いた場合や、別のページから来られた場合はご利用いただけません。<br>' +
      '正規のリンクからもう一度お試しください。</p>' +
      renderAccessIndicator() +
      '</div>';
    bindAccessIndicator();
  }

  // ---------------- ① メインメニュー ----------------
  function renderMenu() {
    var menuItems = [
      ['①  📝  診断する（36問）', '#3B82F6', function () { state.name = ''; navigateTo('nameEntry'); }],
      ['②  📜  診断履歴を見る', '#D97706', function () { navigateTo('history'); }],
      ['③  💭  なりたい自分から診断する', '#EC4899', function () { state.aspirationMode = 'text'; navigateTo('aspiration'); }],
      ['④  🧭  お悩みから目指すタイプを見る', '#7C3AED', function () { navigateTo('concern'); }],
      ['⑤  📚  16タイプの特徴を見る', '#059669', function () { navigateTo('library'); }],
      ['⑥  🤝  タイプ別相性表を見る', '#0891B2', function () { navigateTo('compatibility'); }],
    ];

    var html =
      headerStrip() +
      '<div class="screen">' +
      '<div class="title-row"><span class="app-title">🔥 16-エレメント</span>' +
      '<span class="app-version">' + APP_VERSION + '</span></div>' +
      renderAccessIndicator() +
      '<p class="access-note">' +
      '※ このアプリは、指定されたリンクを経由してアクセスした場合（「直前のURL」がこのアプリの' +
      '設定URLと一致する場合）のみ開始できます。<br>' +
      '※ ご利用のパソコン・スマートフォンやブラウザの設定によっては、リンク元の情報（リファラー）' +
      'が正しく送信されず、正規のリンクからアクセスしてもご利用いただけない場合があります。' +
      'あらかじめご了承ください。' +
      '</p>' +
      '<a class="note-link" href="' + NOTE_CATALOG_URL + '" target="_blank" rel="noopener">' +
      '📖 他のコンテンツ一覧はこちら (note.com)</a>' +
      '<div class="menu-grid">' +
      menuItems.map(function (item, i) {
        return '<button class="menu-btn" style="color:' + item[1] + '" data-menu-idx="' + i + '">' +
          escapeHtml(item[0]) + '</button>';
      }).join('') +
      '</div>' +
      '</div>';

    root.innerHTML = html;
    bindAccessIndicator();
    root.querySelectorAll('[data-menu-idx]').forEach(function (el) {
      el.addEventListener('click', function () { menuItems[Number(el.dataset.menuIdx)][2](); });
    });
  }

  // ---------------- ① 診断: 名前入力 ----------------
  function renderNameEntry() {
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px">📝 診断を始める</h2>' +
      '<p class="sub-text">お名前を入力してください。診断履歴に記録されます<br>' +
      '（空欄のまま始めることもできます）。</p>' +
      '<input type="text" class="name-input" id="name-input" value="' + escapeHtml(state.name) + '">' +
      '<button class="primary-btn" id="start-btn" style="margin-top:0">ここをクリックして始める</button>' +
      backButton() +
      '</div>';

    var input = document.getElementById('name-input');
    input.focus();
    var start = function () {
      state.name = input.value.trim() || '名無しさん';
      state.questions = buildQuestions();
      state.currentIndex = 0;
      state.answers = new Array(state.questions.length).fill(null);
      state.times = new Array(state.questions.length).fill(null);
      navigateTo('question');
    };
    document.getElementById('start-btn').addEventListener('click', start);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
    bindNavButtons();
  }

  // ---------------- ① 診断: 質問画面 ----------------
  function renderQuestion() {
    var index = state.currentIndex;
    var q = state.questions[index];
    var text = q[1];
    var total = state.questions.length;
    var frac = index / total;

    var scaleItems = shuffle([1, 2, 3, 4, 5]);

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<div class="q-top-row"><span>Q' + (index + 1) + ' / ' + total + '</span></div>' +
      '<div class="q-progress-bg"><div class="q-progress-fill" style="width:' + Math.max(1, frac * 100) + '%"></div></div>' +
      '<p class="q-text">' + escapeHtml(text) + '</p>' +
      '<div class="q-scale">' +
      scaleItems.map(function (val) {
        return '<button class="scale-btn" style="background:' + DATA.SCALE_COLORS[val - 1] + '" data-val="' + val + '">' +
          escapeHtml(DATA.SCALE_LABELS[String(val)]) + '</button>';
      }).join('') +
      '</div>' +
      backButton() +
      '</div>';

    state.questionStartTime = Date.now();
    root.querySelectorAll('.scale-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var val = Number(btn.dataset.val);
        // コンマ1秒まで内部計測する(画面には表示しない)
        var elapsed = Math.round((Date.now() - state.questionStartTime) / 100) / 10;
        state.answers[index] = val;
        state.times[index] = elapsed;
        if (index + 1 < total) {
          state.currentIndex = index + 1;
          navigateTo('question');
        } else {
          finishQuestions();
        }
      });
    });
    bindNavButtons();
  }

  // ---------------- ① 診断: 集計 → 結果画面へ ----------------
  function finishQuestions() {
    var questions = state.questions, answers = state.answers, times = state.times;
    var n = questions.length;

    var axisResult = computeAxisPercentages(questions, answers);
    var mbtiType = axisResult.type;

    var bands = times.map(timeBandFor);
    var isNoise = detectNoise(bands);
    var isNeglect = bands.map(function (b) { return b.key === 'divergence'; });

    var consistency = computeConsistency(questions, answers);

    var lowQualityCount = 0;
    for (var i = 0; i < n; i++) if (isNoise[i] || isNeglect[i]) lowQualityCount++;
    var reliability = Math.round(100 * (1 - lowQualityCount / n));

    var coreCount = bands.filter(function (b) { return b.key === 'core'; }).length;
    var purity = Math.round(100 * coreCount / n);

    var conflictKeys = { conflict: 1, context: 1, divergence: 1 };
    var axisConflictCounts = {}, axisBandHits = {}, axisQuestionCounts = {};
    DATA.CORE_AXIS_KEYS.forEach(function (a) { axisConflictCounts[a] = 0; axisBandHits[a] = {}; axisQuestionCounts[a] = 0; });
    questions.forEach(function (q) { axisQuestionCounts[q[0]]++; });
    questions.forEach(function (q, i) {
      var b = bands[i];
      if (conflictKeys[b.key]) {
        axisConflictCounts[q[0]]++;
        axisBandHits[q[0]][b.key] = (axisBandHits[q[0]][b.key] || 0) + 1;
      }
    });
    var conflictZones = [];
    DATA.CORE_AXIS_KEYS.forEach(function (axis) {
      var nQ = axisQuestionCounts[axis];
      var ratio = nQ ? axisConflictCounts[axis] / nQ : 0;
      if (ratio >= 0.34) {
        var hits = axisBandHits[axis];
        var dominantKey = Object.keys(hits).reduce(function (a, b) { return hits[a] >= hits[b] ? a : b; });
        var dominantRow = DATA.TIME_BAND_TABLE.filter(function (r) { return r[2] === dominantKey; })[0];
        conflictZones.push([axis, ratio, dominantRow[3]]);
      }
    });
    conflictZones.sort(function (a, b) { return b[1] - a[1]; });
    conflictZones = conflictZones.slice(0, 2);

    var now = new Date();
    saveHistoryEntry({
      date: formatDate(now),
      name: state.name || '名無しさん',
      type: mbtiType,
      percentages: axisResult.percentages.reduce(function (acc, p) { acc[p[0]] = Math.round(p[2] * 10) / 10; return acc; }, {}),
      reliability: reliability,
      purity: purity,
      consistency: consistency,
    });

    renderResult({
      mbtiType: mbtiType,
      axisPercentages: axisResult.percentages,
      dateText: formatDateJp(now),
      reliability: reliability,
      consistency: consistency,
      purity: purity,
      conflictZones: conflictZones,
    });
  }

  function scoreCardsHtml(reliability, consistency, purity) {
    if (reliability == null && consistency == null && purity == null) return '';
    var defs = [
      ['🎯', '診断の信頼度', reliability, '極端に速い連打的な回答や、極端に長く迷った回答が\n少ないほど高くなります。', 'threshold'],
      ['🔁', '回答の一貫性', consistency, '回答のブレを見るために2回出題した設問の答えが\n揃っているほど高くなります。', 'threshold'],
      ['🔬', 'タイプ純度', purity, '迷いなく即答できた設問の割合です。高いほど、\n生まれ持った特性がそのまま出ていると言えます。', 'fixed'],
    ];
    var cards = defs.filter(function (d) { return d[2] != null; }).map(function (d) {
      var color = d[4] === 'threshold'
        ? (d[2] >= 80 ? '#16A34A' : d[2] >= 50 ? '#CA8A04' : '#DC2626')
        : '#7C3AED';
      return '<div class="score-card">' +
        '<div class="score-card-label">' + d[0] + ' ' + d[1] + '</div>' +
        '<div class="score-card-value" style="color:' + color + '">' + d[2] + '%</div>' +
        '<div class="score-card-desc">' + escapeHtml(d[3]) + '</div>' +
        '</div>';
    }).join('');
    return '<h3 class="strengths-title" style="margin-top:0">診断スコア</h3><div class="score-grid">' + cards + '</div>';
  }

  function strengthsGrowthHtml(strengths, growth) {
    if (!strengths.length && !growth.length) return '';
    var html = '<h3 class="strengths-title">強み・伸びしろ</h3>';
    if (strengths.length) {
      html += '<p class="perspective-title" style="color:#16A34A">💪 強み</p><ul class="trait-list">' +
        strengths.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ul>';
    }
    if (growth.length) {
      html += '<p class="perspective-title" style="color:#CA8A04">🌱 伸びしろ</p><ul class="trait-list">' +
        growth.map(function (g) { return '<li>' + escapeHtml(g) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  function extendedTeaserHtml(mbtiType) {
    var codes = extendedVariantTypes(mbtiType);
    return (
      '<h3 class="strengths-title" style="color:#7C3AED">🔮 もっと詳しく知りたい方へ</h3>' +
      '<p class="sub-text">今回診断した基本タイプ「' + mbtiType + '」は、自己主張・慎重、協調型・独立型という' +
      '2つの傾向軸を加えた、より詳しい64タイプ診断では、次の4パターンのいずれかにさらに分かれます。</p>' +
      '<div class="teaser-chips">' +
      codes.map(function (c) { return '<span class="teaser-chip">' + c + '</span>'; }).join('') +
      '</div>' +
      '<p class="sub-text" style="font-weight:700;color:var(--text-main)">詳細版「64-スペクトラム」は現在準備中です。公開までしばらくお待ちください。</p>'
    );
  }

  // ---------------- ① 診断: 結果画面 ----------------
  function renderResult(r) {
    var details = typeDetails(r.mbtiType);

    var axisCardsHtml = r.axisPercentages.map(function (p) {
      var primary = p[0], opposite = p[1], pct = p[2];
      var color = DATA.AXIS_COLORS[primary];
      var labels = DATA.AXIS_LABELS[primary];
      return '<div class="axis-card">' +
        '<div class="axis-label-row"><span style="color:' + color + '">' + labels[0] + '　' + pct.toFixed(0) + '%</span>' +
        '<span style="color:var(--text-sub)">' + (100 - pct).toFixed(0) + '%　' + labels[1] + '</span></div>' +
        '<div class="axis-bar-bg"><div class="axis-bar-fill" style="width:' + Math.max(1, pct) + '%;background:' + color + '"></div></div>' +
        '</div>';
    }).join('');

    var conflictHtml = '';
    if (r.conflictZones.length) {
      conflictHtml = '<p class="perspective-title">⚡ 今ゆらいでいる可能性がある軸</p>' +
        r.conflictZones.map(function (z) {
          var labels = DATA.AXIS_LABELS[z[0]];
          return '<p class="sub-text" style="margin-bottom:2px">・' + labels[0] + ' ⇄ ' + labels[1] + '（' + z[2] + '）</p>';
        }).join('') +
        '<p class="sub-text">環境や相手によって、この軸の答え方が変わりやすい可能性があります。</p>';
    }

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<div class="result-top-row"><span>診断結果</span><span>診断日: ' + r.dateText + '</span></div>' +
      '<div class="type-badge-outer" style="background:' + details.accent + '">' +
      '<span class="type-badge" style="color:' + details.accent + '">' + r.mbtiType + '</span></div>' +
      '<p class="result-nickname">✨ ' + escapeHtml(details.nickname) + '</p>' +
      '<p class="result-desc">' + escapeHtml(details.description) + '</p>' +
      scoreCardsHtml(r.reliability, r.consistency, r.purity) +
      conflictHtml +
      '<h3 class="strengths-title" style="margin-top:20px">各軸の傾向</h3>' +
      axisCardsHtml +
      strengthsGrowthHtml(details.strengths, details.growth) +
      extendedTeaserHtml(r.mbtiType) +
      '<button class="primary-btn" id="share-btn" style="background:#1DA1F2;color:#fff;margin-top:20px">🐦 結果をXでシェアする</button>' +
      '<button class="primary-btn" id="retry-btn" style="background:var(--btn-off);color:var(--text-main)">🔄 もう一度診断する</button>' +
      backButton() +
      '</div>';

    document.getElementById('share-btn').addEventListener('click', function () {
      var text = '性格診断の結果は「' + r.mbtiType + ' ' + details.nickname + '」でした！\n' +
        '#性格診断 #16エレメント\n' + NOTE_CATALOG_URL;
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text), '_blank', 'noopener');
    });
    document.getElementById('retry-btn').addEventListener('click', function () { navigateTo('nameEntry'); });
    bindNavButtons();
  }

  // ---------------- ⑤ 16タイプの特徴を見る ----------------
  function renderLibrary() {
    var axisTableHtml = DATA.CORE_AXIS_KEYS.map(function (axis) {
      var name = DATA.AXIS_PAIR_NAMES[axis];
      var labels = DATA.AXIS_LABELS[axis];
      var descs = DATA.AXIS_DESCRIPTIONS[axis];
      var color = DATA.AXIS_COLORS[axis];
      return '<div class="axis-desc-card">' +
        '<p class="axis-desc-name" style="color:' + color + '">' + name + '</p>' +
        '<p class="axis-desc-pole">' + labels[0] + '</p><p class="axis-desc-text">' + escapeHtml(descs[0]) + '</p>' +
        '<p class="axis-desc-pole">' + labels[1] + '</p><p class="axis-desc-text">' + escapeHtml(descs[1]) + '</p>' +
        '</div>';
    }).join('');

    var typesHtml = Object.keys(DATA.TYPE_GROUPS).map(function (groupName) {
      var color = DATA.GROUP_COLORS[groupName];
      var types = DATA.TYPE_GROUPS[groupName];
      var cards = types.map(function (t) {
        var info = DATA.TYPE_INFO[t];
        return '<div class="card"><p style="margin:0"><span style="text-decoration:underline;font-weight:700;color:' + color + '">' + t +
          '</span> <strong>' + info[0] + '</strong></p>' +
          '<p class="sub-text" style="margin:6px 0 0">' + escapeHtml(info[1]) + '</p></div>';
      }).join('');
      return '<h3 class="group-heading" style="color:' + color + '">' + groupName + ' のエレメント</h3>' + cards;
    }).join('');

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px">📚 16タイプの特徴</h2>' +
      '<p class="sub-text">4つの軸の組み合わせで、「INTJ」のように合計16タイプになります。<br>' +
      'タイプは「火・水・風・土」の4エレメントに分類されます。</p>' +
      '<h3 class="section-title" style="font-size:18px">文字の意味 一覧表</h3>' +
      axisTableHtml +
      '<h3 class="section-title" style="font-size:18px;margin-top:24px">16タイプ一覧</h3>' +
      typesHtml +
      backButton() +
      '</div>';
    bindNavButtons();
  }

  // ---------------- ② 診断履歴を見る ----------------
  function renderHistory() {
    var history = loadHistory();
    var html = headerStrip() + '<div class="screen">' +
      '<h2 class="section-title">📜 診断履歴</h2>';
    if (!history.length) {
      html += '<p class="sub-text">まだ診断履歴がありません。「診断する」から最初の診断をしてみましょう。</p>';
    } else {
      html += history.slice().reverse().map(function (entry) {
        var details = typeDetails(entry.type || '----');
        var name = entry.name || '名無しさん';
        return '<div class="history-row">' +
          '<div class="history-top"><span class="history-name">' + escapeHtml(name) + '</span>' +
          '<span class="history-result"><span style="text-decoration:underline;color:' + details.accent + '">' +
          (entry.type || '----') + '</span> ' + escapeHtml(details.nickname) + '</span></div>' +
          '<div class="history-date">' + escapeHtml(entry.date || '') + '</div>' +
          '</div>';
      }).join('');
    }
    html += backButton() + '</div>';
    root.innerHTML = html;
    bindNavButtons();
  }

  // ---------------- ③ なりたい自分から診断する ----------------
  function renderAspiration() {
    var mode = state.aspirationMode;
    var html = headerStrip() + '<div class="screen">' +
      '<h2 class="section-title">💭 なりたい自分から診断する</h2>' +
      '<div class="mode-toggle">' +
      '<button class="' + (mode === 'text' ? 'active' : '') + '" data-mode="text">文章で入力する</button>' +
      '<button class="' + (mode === 'quick' ? 'active' : '') + '" data-mode="quick">質問に答える（12問）</button>' +
      '</div>';

    if (mode === 'quick') {
      var quickQuestions = buildQuickAspirationQuestions();
      html += '<p class="sub-text">文章にしづらい人向けの、12個の簡単な質問です。<br>なりたい自分に近い方をそれぞれ選んでください。</p>';
      html += quickQuestions.map(function (q, i) {
        return '<div class="quick-q-card" data-q-idx="' + i + '">' +
          '<div class="quick-q-label">Q' + (i + 1) + '</div>' +
          '<button class="quick-choice" data-letter="' + q[0] + '">' + escapeHtml(q[1]) + '</button>' +
          '<button class="quick-choice" data-letter="' + DATA.AXIS_PAIRS[q[0]] + '">' + escapeHtml(q[2]) + '</button>' +
          '</div>';
      }).join('');
      html += '<button class="primary-btn" id="quick-check-btn">診断する</button>';
      html += '<div id="aspiration-result"></div>';
    } else {
      html += '<p class="sub-text">「どんな自分になりたいか」を自由に書いてください。<br>' +
        '内容から近いタイプを推測し、そのタイプに近づくためのヒントを表示します。</p>' +
        '<textarea class="free-text" id="aspiration-text"></textarea>' +
        '<button class="primary-btn" id="text-check-btn">判定する</button>' +
        '<div id="aspiration-result"></div>';
    }
    html += backButton() + '</div>';
    root.innerHTML = html;

    root.querySelectorAll('[data-mode]').forEach(function (el) {
      el.addEventListener('click', function () { state.aspirationMode = el.dataset.mode; navigateTo('aspiration'); });
    });

    var resultHolder = document.getElementById('aspiration-result');

    if (mode === 'quick') {
      var quickQuestions2 = buildQuickAspirationQuestions();
      var selections = new Array(quickQuestions2.length).fill(null);
      root.querySelectorAll('.quick-q-card').forEach(function (card) {
        var idx = Number(card.dataset.qIdx);
        card.querySelectorAll('.quick-choice').forEach(function (btn) {
          btn.addEventListener('click', function () {
            selections[idx] = btn.dataset.letter;
            card.querySelectorAll('.quick-choice').forEach(function (b) { b.classList.remove('selected'); });
            btn.classList.add('selected');
          });
        });
      });
      document.getElementById('quick-check-btn').addEventListener('click', function () {
        if (selections.some(function (s) { return s === null; })) {
          alert('すべての質問に答えてください。');
          return;
        }
        var answers = quickQuestions2.map(function (q, i) { return [q[0], selections[i]]; });
        var type = typeFromQuickAnswers(answers);
        resultHolder.innerHTML = renderAspirationResultHtml(type, '近いタイプ:');
      });
    } else {
      document.getElementById('text-check-btn').addEventListener('click', function () {
        var text = document.getElementById('aspiration-text').value.trim();
        if (!text) { alert('なりたい自分について、少し書いてみてください。'); return; }
        var res = guessTypeFromText(text);
        if (res.type === null) {
          resultHolder.innerHTML = '<p class="warn-text">うまく判定できませんでした。もう少し具体的に書いてみてください。<br>' +
            '（例: 「もっと人前で堂々と話せるようになりたい」など）</p>';
          return;
        }
        resultHolder.innerHTML = renderAspirationResultHtml(res.type, '近いタイプ:');
      });
    }
    bindNavButtons();
  }

  function renderAspirationResultHtml(type, labelText) {
    var details = typeDetails(type);
    var html = '<div class="card" style="margin-top:16px">' +
      '<p style="margin:0"><span class="sub-text" style="margin:0">' + labelText + '</span> ' +
      '<span style="text-decoration:underline;font-weight:700;color:' + details.accent + '">' + type + '</span> ' +
      '<strong>' + escapeHtml(details.nickname) + '</strong></p>' +
      '<p class="sub-text" style="margin:6px 0 0">' + escapeHtml(details.description) + '</p>';
    if (details.tips.length) {
      html += '<p class="perspective-title" style="color:#16A34A">🏋 近づくためのトレーニング</p><ul class="trait-list">' +
        details.tips.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>';
    }
    html += '</div>';
    return html;
  }

  // ---------------- ④ お悩みから目指すタイプを見る ----------------
  function renderConcern() {
    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title">🧭 お悩みから目指すタイプを見る</h2>' +
      '<p class="sub-text">今困っていること・悩んでいることを自由に書いてください。<br>' +
      '外向・内向、直観、思考など8の観点から分析し、目指すとよいタイプの方向性を簡易的に示します。</p>' +
      '<textarea class="free-text" id="concern-text"></textarea>' +
      '<button class="primary-btn" id="concern-check-btn">診断する</button>' +
      '<div id="concern-result"></div>' +
      backButton() +
      '</div>';

    var resultHolder = document.getElementById('concern-result');
    document.getElementById('concern-check-btn').addEventListener('click', function () {
      var text = document.getElementById('concern-text').value.trim();
      if (!text) { alert('今困っていることについて、少し書いてみてください。'); return; }
      var res = guessTypeFromText(text);
      if (res.type === null) {
        resultHolder.innerHTML = '<p class="warn-text">うまく判定できませんでした。もう少し具体的に書いてみてください。<br>' +
          '（例: 「人前で意見を言うのが苦手で悩んでいる」など）</p>';
        return;
      }
      var details = typeDetails(res.type);
      var html = renderAspirationResultHtml(res.type, '目指すとよいタイプ:');
      var perspectiveRows = DATA.CORE_AXIS_KEYS.map(function (axis) {
        var name = DATA.AXIS_PAIR_NAMES[axis];
        var labels = DATA.AXIS_LABELS[axis];
        var c = res.counts[axis];
        var primaryWins = c.primary >= c.opposite;
        return '<div class="perspective-row"><span class="perspective-axis">' + name + '</span>' +
          '<span class="' + (primaryWins ? 'perspective-win' : 'perspective-lose') + '">' + labels[0] + '</span>' +
          '<span class="perspective-lose"> / </span>' +
          '<span class="' + (!primaryWins ? 'perspective-win' : 'perspective-lose') + '">' + labels[1] + '</span></div>';
      }).join('');
      resultHolder.innerHTML = html.replace('</div>',
        '<p class="perspective-title">🔍 観点からの分析</p>' + perspectiveRows + '</div>');
    });
    bindNavButtons();
  }

  // ---------------- ⑥ タイプ別相性表を見る ----------------
  function renderCompatibility() {
    var baseTypes = [].concat.apply([], Object.values(DATA.TYPE_GROUPS));

    var legendHtml = [5, 4, 3, 2, 1].map(function (n) {
      var lv = DATA.COMPATIBILITY_LEVELS[String(n)];
      return '<span class="legend-chip" style="background:' + lv[1] + '">' + n + ' ' + lv[0] + '</span>';
    }).join('');

    var headerRow = '<tr><th></th>' + baseTypes.map(function (t) {
      return '<th style="color:' + DATA.TYPE_COLORS[t] + '">' + t + '</th>';
    }).join('') + '</tr>';

    var bodyRows = baseTypes.map(function (rowType) {
      var cells = baseTypes.map(function (colType) {
        var info = compatibilityInfo(rowType, colType);
        return '<td style="background:' + info[2] + '">' + info[0] + '</td>';
      }).join('');
      return '<tr><th style="color:' + DATA.TYPE_COLORS[rowType] + '">' + rowType + '</th>' + cells + '</tr>';
    }).join('');

    root.innerHTML =
      headerStrip() +
      '<div class="screen">' +
      '<h2 class="section-title" style="font-size:20px">🤝 タイプ別相性表</h2>' +
      '<p class="sub-text">16タイプ同士の相性を、4つの軸のうち一致する文字数から簡易的に示した表です。' +
      'あくまで簡易的な目安としてご覧ください。</p>' +
      '<div class="legend-chips">' + legendHtml + '</div>' +
      '<div class="compat-table-wrap"><table class="compat-table">' + headerRow + bodyRows + '</table></div>' +
      '<p class="sub-text">※ 縦・横それぞれのタイプの組み合わせを表しています。数字が大きいほど一致する文字が多く、' +
      '価値観や物事の進め方が近い傾向にあります。数字が小さい組み合わせは考え方が対照的で、刺激的な反面、' +
      '理解に工夫が必要な場合があります。</p>' +
      backButton() +
      '</div>';
    bindNavButtons();
  }

  // ---------------- ルーター ----------------
  function render() {
    switch (state.screen) {
      case 'blocked': renderBlocked(); break;
      case 'menu': renderMenu(); break;
      case 'nameEntry': renderNameEntry(); break;
      case 'question': renderQuestion(); break;
      case 'library': renderLibrary(); break;
      case 'history': renderHistory(); break;
      case 'aspiration': renderAspiration(); break;
      case 'concern': renderConcern(); break;
      case 'compatibility': renderCompatibility(); break;
      default: renderMenu();
    }
  }

  navigateTo(checkAccess() ? 'menu' : 'blocked');
})();
