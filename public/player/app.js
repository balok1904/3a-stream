// ============================================================================
// 3A STREAM - PLAYER APPLICATION & ANDROID / TV BOX TESTBENCH
// ============================================================================

function getOrCreateDeviceMac() {
  let saved = localStorage.getItem('3a_device_mac');
  if (!saved || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(saved)) {
    const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
    saved = `3A:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
    localStorage.setItem('3a_device_mac', saved);
    localStorage.setItem('3a_mac_address', saved);
  }
  return saved;
}

const appState = {
  loggedIn: false,
  profile: null,
  catalog: null,
  currentScreen: 'screenLogin',
  currentSection: 'live', // 'live' | 'soccer' | 'vod' | 'series'
  selectedCategoryId: 'ALL',
  currentPlayingId: null,
  macAddress: getOrCreateDeviceMac(),
  preferences: {
    streamFormat: localStorage.getItem('3a_stream_format') || 'ts', // 'ts' | 'm3u8'
    timeFormat: localStorage.getItem('3a_time_format') || '24h', // '24h' | '12h'
    deviceType: localStorage.getItem('3a_device_type') || 'TV', // 'TV' | 'Mobile'
    autoStart: localStorage.getItem('3a_auto_start') !== 'false',
    externalPlayer: localStorage.getItem('3a_ext_player') || 'Interno (3A ExoPlayer/HLS)',
    subtitlesEnabled: false,
    language: localStorage.getItem('3a_lang') || 'pt',
    layoutMode: localStorage.getItem('3a_layout') || 'compact',
    hiddenCategories: {
      live: JSON.parse(localStorage.getItem('3a_hide_live') || '[]'),
      vod: JSON.parse(localStorage.getItem('3a_hide_vod') || '[]'),
      series: JSON.parse(localStorage.getItem('3a_hide_series') || '[]')
    },
    recentMovies: JSON.parse(localStorage.getItem('3a_recent_movies') || '[]'),
    adultUnlockedSession: false
  }
};

let hlsInstance = null;

// ============================================================================
// DETECÇÃO DE AMBIENTE NATIVO ANDROID (.APK) E ROTEAMENTO HÍBRIDO DE API
// ============================================================================
const IS_NATIVE_APK = Boolean(
  window.Capacitor ||
  window.location.protocol === 'capacitor:' ||
  window.location.protocol === 'file:' ||
  (window.location.hostname === 'localhost' && window.location.port !== '3000')
);

const DEFAULT_CLOUD_BACKEND = 'https://app-3a-stream.onrender.com';
const DEFAULT_LAN_BACKEND = localStorage.getItem('3a_backend_url') || DEFAULT_CLOUD_BACKEND;

let LOCAL_PC_PROXY_BASE = (
  !IS_NATIVE_APK &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.'))
) ? window.location.origin : '';

async function detectLocalPcProxy() {
  if (IS_NATIVE_APK || LOCAL_PC_PROXY_BASE) return LOCAL_PC_PROXY_BASE;
  const candidates = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  for (const base of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        LOCAL_PC_PROXY_BASE = base;
        return base;
      }
    } catch (_) {}
  }
  return '';
}
detectLocalPcProxy();

async function apiFetch(path, options = {}) {
  if (!IS_NATIVE_APK) {
    if (LOCAL_PC_PROXY_BASE && (path.startsWith('/api/proxy/') || path.startsWith('/api/player/series-info'))) {
      try {
        const localRes = await fetch(`${LOCAL_PC_PROXY_BASE}${path}`, options);
        if (localRes.ok) return localRes;
      } catch (_) {}
    }
    return fetch(path, options);
  }
  const savedUrl = localStorage.getItem('3a_backend_url');
  const candidateUrls = savedUrl
    ? [savedUrl.replace(/\/+$/, ''), 'https://app-3a-stream.onrender.com', 'https://threea-stream.onrender.com', 'http://192.168.0.12:3000']
    : ['https://app-3a-stream.onrender.com', 'https://threea-stream.onrender.com', 'http://192.168.0.12:3000'];

  let lastErr = null;
  for (const baseUrl of candidateUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok || res.status === 401 || res.status === 403 || res.status === 400) {
        return res;
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error('Servidor indisponível');
}

// Remove prefixos repetitivos como "Séries |", "Série |", "Filmes |", "Filme |", "Canais |", "VOD |" das categorias
function formatCleanCategoryName(rawName) {
  if (!rawName) return 'Geral';
  let cleaned = String(rawName).trim();
  cleaned = cleaned
    .replace(/^[\s\|\-\:\•\★\☆\▶\»\›\[\]\(\)]*(?:s[eé]ries?|filmes?|movies?|vod|canais?|tv\s*ao\s*vivo|tv)[\s\|\-\:\•\/»›]+/i, '')
    .replace(/^(?:s[eé]ries?|filmes?|movies?|vod|canais?)\s+(?=[a-zA-ZÀ-ÿ0-9]{2,})/i, '')
    .replace(/^[\s\|\-\:\•\/»›]+/, '')
    .trim();
  cleaned = cleaned
    .replace(/^(?:s[eé]ries?|filmes?|movies?|vod|canais?)[\s\|\-\:\•\/»›]+/i, '')
    .trim();
  return cleaned || String(rawName).trim() || 'Geral';
}

// Fallback Standalone Direto Xtream Codes API para quando o celular Android (.apk) estiver no 4G/5G ou fora do PC
async function standaloneXtreamFetchCatalog(host, username, password, preferredFormat = 'ts') {
  const cleanBase = host.trim().replace(/\/+$/, '');
  const apiBase = `${cleanBase}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  const authRes = await fetch(apiBase);
  const authData = await authRes.json();
  if (!authData || !authData.user_info || Number(authData.user_info.auth) === 0) {
    throw new Error('Credenciais Xtream inválidas.');
  }

  const [liveCats, vodCats, seriesCats, liveStreams, vodStreams, seriesList] = await Promise.all([
    fetch(`${apiBase}&action=get_live_categories`).then(r => r.json()).catch(() => []),
    fetch(`${apiBase}&action=get_vod_categories`).then(r => r.json()).catch(() => []),
    fetch(`${apiBase}&action=get_series_categories`).then(r => r.json()).catch(() => []),
    fetch(`${apiBase}&action=get_live_streams`).then(r => r.json()).catch(() => []),
    fetch(`${apiBase}&action=get_vod_streams`).then(r => r.json()).catch(() => []),
    fetch(`${apiBase}&action=get_series`).then(r => r.json()).catch(() => [])
  ]);

  const ext = preferredFormat === 'ts' ? 'ts' : 'm3u8';
  const soccerRegex = /(futebol|esporte|sport|premiere|combate|espn|caz[eé]|dazn|paramount|nosso futebol|band sports|ufc|nba|copa|brasileir[aã]o|champions|libertadores|jogos de hoje|ppv)/i;
  const adultRegex = /(adult|xxx|\+18|18\+|erotic|porn|sexo|hot)/i;

  const soccerCatIds = new Set();
  const adultCatIds = new Set();

  const normLiveCats = (Array.isArray(liveCats) ? liveCats : []).map(c => {
    const id = String(c.category_id);
    const rawName = c.category_name || 'Sem Categoria';
    const name = formatCleanCategoryName(rawName);
    const isSoccerCategory = soccerRegex.test(rawName);
    const isAdult = adultRegex.test(rawName);
    if (isSoccerCategory) soccerCatIds.add(id);
    if (isAdult) adultCatIds.add(id);
    return { category_id: id, category_name: name, isSoccerCategory, isAdult };
  });

  const normVodCats = (Array.isArray(vodCats) ? vodCats : []).map(c => {
    const id = String(c.category_id);
    const rawName = c.category_name || 'Filmes';
    const name = formatCleanCategoryName(rawName);
    const isAdult = adultRegex.test(rawName);
    if (isAdult) adultCatIds.add(id);
    return { category_id: id, category_name: name, isAdult };
  });

  const normSeriesCats = (Array.isArray(seriesCats) ? seriesCats : []).map(c => ({
    category_id: String(c.category_id),
    category_name: formatCleanCategoryName(c.category_name || 'Séries'),
    isAdult: adultRegex.test(c.category_name || '')
  }));

  const normLiveStreams = (Array.isArray(liveStreams) ? liveStreams : []).map(s => {
    const catId = String(s.category_id || '1');
    const name = s.name || 'Canal Ao Vivo';
    const isSoccer = soccerCatIds.has(catId) || soccerRegex.test(name);
    const isAdult = adultCatIds.has(catId) || adultRegex.test(name);
    const rawUrl = `${cleanBase}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.${ext}`;
    return {
      stream_id: s.stream_id,
      name,
      category_id: catId,
      logo: s.stream_icon || '',
      epgNow: 'Transmissão Ao Vivo',
      epgNext: 'Grade de Programação 3A Stream',
      isSoccer,
      isAdult,
      rawStreamUrl: rawUrl,
      streamUrl: rawUrl
    };
  });

  const normVodStreams = (Array.isArray(vodStreams) ? vodStreams : []).map(v => {
    const catId = String(v.category_id || '1');
    const name = v.name || 'Filme VOD';
    const vExt = v.container_extension || 'mp4';
    const rawUrl = `${cleanBase}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${v.stream_id}.${vExt}`;
    return {
      stream_id: v.stream_id,
      name,
      category_id: catId,
      year: '',
      rating: v.rating || '8.5',
      duration: vExt.toUpperCase(),
      poster: v.stream_icon || '',
      description: `Filme disponível no catálogo (${vExt.toUpperCase()})`,
      isAdult: adultCatIds.has(catId) || adultRegex.test(name),
      rawStreamUrl: rawUrl,
      streamUrl: rawUrl
    };
  });

  const normSeriesList = (Array.isArray(seriesList) ? seriesList : []).map(sr => ({
    series_id: sr.series_id,
    name: sr.name || 'Série',
    category_id: String(sr.category_id || '1'),
    rating: sr.rating || '9.0',
    poster: sr.cover || '',
    description: sr.plot || 'Série completa disponível.',
    xtreamSeriesId: sr.series_id
  }));

  return {
    isRealList: true,
    xtreamOrigin: { baseUrl: cleanBase, username, password },
    liveCategories: normLiveCats,
    vodCategories: normVodCats,
    seriesCategories: normSeriesCats,
    liveStreams: normLiveStreams,
    vodStreams: normVodStreams,
    seriesList: normSeriesList
  };
}

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  if (IS_NATIVE_APK) {
    document.body.classList.add('is-native-apk', 'mode-fullscreen');
  }
  initDialogLightDismissFallback();
  updateMacDisplays();
  syncSettingsLabels();
  startClockTimer();
  initKeyboardDpadNavigation();
  initCinemaTouchWakeup();
  initAndroidBackNavigation();

  // Restaura credenciais salvas no dispositivo se "Lembrar credenciais" estiver ativo
  const rememberPref = localStorage.getItem('3a_remember_credentials') !== 'false';
  const chkRemember = document.getElementById('chkRememberAccount');
  if (chkRemember) chkRemember.checked = rememberPref;
  if (rememberPref) {
    const savedUser = localStorage.getItem('3a_saved_username') || '';
    const savedPass = localStorage.getItem('3a_saved_password') || '';
    if (savedUser) document.getElementById('loginUsername').value = savedUser;
    if (savedPass) document.getElementById('loginPassword').value = savedPass;
  }

  // Permite login automático via querystring do Painel Admin (?user=...&pass=...)
  const params = new URLSearchParams(window.location.search);
  const qUser = params.get('user');
  const qPass = params.get('pass');
  if (qUser && qPass) {
    document.getElementById('loginUsername').value = qUser;
    document.getElementById('loginPassword').value = qPass;
    performLogin(qUser, qPass);
  }
});

// Fallback obrigatório para <dialog closedby="any"> conforme diretriz Modern Web Guidance
function initDialogLightDismissFallback() {
  const dialog = document.getElementById('appModalDialog');
  if (!dialog) return;

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (isDialogContent) return;
      dialog.close();
    });
  }
}

function updateMacDisplays() {
  const loginMacEl = document.getElementById('loginMacDisplay');
  if (loginMacEl) loginMacEl.textContent = appState.macAddress;
  const settingsMacEl = document.getElementById('settingsMacDisplay');
  if (settingsMacEl) settingsMacEl.textContent = appState.macAddress;
}

function startClockTimer() {
  const updateClock = () => {
    const now = new Date();
    const is12h = appState.preferences.timeFormat === '12h';
    const timeStr = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: is12h
    });
    const clockEl = document.getElementById('homeClock');
    if (clockEl) clockEl.textContent = timeStr;
  };
  updateClock();
  setInterval(updateClock, 10000);
}

// ============================================================================
// SIMULADOR ANDROID / TV BOX (MOLDURAS E TESTE RÁPIDO)
// ============================================================================
function setSimulatorFrame(mode) {
  document.body.classList.remove('mode-tvbox', 'mode-fullscreen', 'mode-mobile');
  const bTv = document.getElementById('btnModeTv');
  const bFull = document.getElementById('btnModeFull');
  const bMob = document.getElementById('btnModeMobile');
  if (bTv) bTv.classList.remove('active');
  if (bFull) bFull.classList.remove('active');
  if (bMob) bMob.classList.remove('active');

  if (mode === 'fullscreen') {
    document.body.classList.add('mode-fullscreen');
    if (bFull) bFull.classList.add('active');
  } else if (mode === 'mobile') {
    document.body.classList.add('mode-mobile');
    if (bMob) bMob.classList.add('active');
  } else {
    document.body.classList.add('mode-tvbox');
    if (bTv) bTv.classList.add('active');
  }
}

function quickFillLogin(username, password) {
  navigateToScreen('screenLogin');
  document.getElementById('loginUsername').value = username;
  document.getElementById('loginPassword').value = password;
  performLogin(username, password);
}

// ============================================================================
// AUTENTICAÇÃO E PROVISIONAMENTO DE LISTA IPTV (ABAS: CONTA 3A | XTREAM | M3U | DEMO)
// ============================================================================
function switchAuthTab(tabName) {
  const errBox = document.getElementById('loginErrorBox');
  if (errBox) errBox.classList.add('hidden');

  const tabMap = {
    account: { btn: 'tabAccountBtn', panel: 'loginForm' },
    xtream: { btn: 'tabXtreamBtn', panel: 'xtreamDirectForm' },
    m3u: { btn: 'tabM3uBtn', panel: 'm3uDirectForm' },
    demo: { btn: 'tabDemoBtn', panel: 'demoDirectPanel' }
  };

  Object.keys(tabMap).forEach(key => {
    const btnEl = document.getElementById(tabMap[key].btn);
    const panelEl = document.getElementById(tabMap[key].panel);
    if (btnEl) btnEl.classList.toggle('active', key === tabName);
    if (panelEl) panelEl.classList.toggle('hidden', key !== tabName);
  });
}

function handleLoginSubmit(event) {
  event.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  performLogin(username, password);
}

async function handleDirectXtreamSubmit(event) {
  event.preventDefault();
  const xtreamUrl = document.getElementById('directXtreamHost').value.trim();
  const xtreamUser = document.getElementById('directXtreamUser').value.trim();
  const xtreamPass = document.getElementById('directXtreamPass').value.trim();
  const btn = document.getElementById('btnDirectXtreamSubmit');
  const errBox = document.getElementById('loginErrorBox');
  if (errBox) errBox.classList.add('hidden');

  const origHtml = btn.innerHTML;
  btn.innerHTML = '<span>⏳</span><span>Conectando Xtream API...</span>';
  btn.disabled = true;

  try {
    const res = await apiFetch('/api/player/custom-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'xtream',
        xtreamUrl,
        xtreamUser,
        xtreamPass,
        preferredFormat: appState.preferences.streamFormat
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (errBox) {
        errBox.innerHTML = `<strong>Falha Xtream API:</strong> ${data.error || 'Verifique DNS, usuário e senha.'}`;
        errBox.classList.remove('hidden');
      }
      showToast('🚫 ' + (data.error || 'Erro ao conectar Xtream API'));
      return;
    }

    appState.loggedIn = true;
    appState.catalog = data.catalog;
    appState.profile = {
      name: `Xtream (${xtreamUser})`,
      username: xtreamUser,
      expiresAtFormatted: '15/06/2026',
      sourceLabel: data.sourceLabel
    };
    document.getElementById('homeClientName').textContent = appState.profile.name;
    document.getElementById('homeExpirationDate').textContent = appState.profile.expiresAtFormatted;
    navigateToScreen('screenHome');
    showToast(`✅ Conectado via Xtream API (${xtreamUser})!`);
  } catch (err) {
    // Fallback direto via WebView Android caso esteja no 4G/5G sem servidor PC local
    try {
      const catalog = await standaloneXtreamFetchCatalog(xtreamUrl, xtreamUser, xtreamPass, appState.preferences.streamFormat);
      appState.loggedIn = true;
      appState.catalog = catalog;
      appState.profile = {
        name: `Xtream (${xtreamUser})`,
        username: xtreamUser,
        expiresAtFormatted: '15/06/2026',
        sourceLabel: `Xtream Direto (${xtreamUrl})`
      };
      document.getElementById('homeClientName').textContent = appState.profile.name;
      document.getElementById('homeExpirationDate').textContent = appState.profile.expiresAtFormatted;
      navigateToScreen('screenHome');
      showToast(`✅ Conectado Direto via Xtream API (${xtreamUser})!`);
    } catch (directErr) {
      if (errBox) {
        errBox.textContent = 'Erro de conexão com o servidor Xtream / 3A Stream.';
        errBox.classList.remove('hidden');
      }
    }
  } finally {
    btn.innerHTML = origHtml;
    btn.disabled = false;
  }
}

async function handleDirectM3uSubmit(event) {
  event.preventDefault();
  const m3uUrl = document.getElementById('directM3uUrl').value.trim();
  const btn = document.getElementById('btnDirectM3uSubmit');
  const errBox = document.getElementById('loginErrorBox');
  if (errBox) errBox.classList.add('hidden');

  const origHtml = btn.innerHTML;
  btn.innerHTML = '<span>⏳</span><span>Processando Lista M3U...</span>';
  btn.disabled = true;

  try {
    const res = await apiFetch('/api/player/custom-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'm3u',
        m3uUrl,
        preferredFormat: appState.preferences.streamFormat
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (errBox) {
        errBox.innerHTML = `<strong>Falha M3U:</strong> ${data.error || 'Não foi possível ler a lista M3U.'}`;
        errBox.classList.remove('hidden');
      }
      showToast('🚫 ' + (data.error || 'Erro ao carregar M3U'));
      return;
    }

    appState.loggedIn = true;
    appState.catalog = data.catalog;
    appState.profile = {
      name: 'Assinante M3U',
      username: 'm3u_user',
      expiresAtFormatted: '15/06/2026',
      sourceLabel: data.sourceLabel
    };
    document.getElementById('homeClientName').textContent = appState.profile.name;
    document.getElementById('homeExpirationDate').textContent = appState.profile.expiresAtFormatted;
    navigateToScreen('screenHome');
    showToast(`✅ Lista ${data.sourceLabel} carregada com sucesso!`);
  } catch (err) {
    if (errBox) {
      errBox.textContent = 'Erro ao processar lista M3U.';
      errBox.classList.remove('hidden');
    }
  } finally {
    btn.innerHTML = origHtml;
    btn.disabled = false;
  }
}

async function startInstantDemoSession() {
  switchAuthTab('account');
  document.getElementById('loginUsername').value = 'admin';
  document.getElementById('loginPassword').value = '123';
  await performLogin('admin', '123');
}

async function performLogin(username, password) {
  const errBox = document.getElementById('loginErrorBox');
  const btn = document.getElementById('btnLoginSubmit');
  errBox.classList.add('hidden');
  const origHtml = btn.innerHTML;
  btn.innerHTML = '<span>⏳</span><span>Conectando ao 3A Stream...</span>';
  btn.disabled = true;

  try {
    const res = await apiFetch('/api/player/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        macAddress: appState.macAddress,
        preferredFormat: appState.preferences.streamFormat
      })
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      errBox.innerHTML = `<strong>Acesso Negado:</strong> ${data.error || 'Falha ao autenticar.'}`;
      errBox.classList.remove('hidden');
      showToast('🚫 ' + (data.error || 'Acesso negado'));
      return;
    }

    let finalCatalog = data.catalog;
    const xo = data.profile && data.profile.xtreamOrigin;
    const isCatalogIncomplete =
      !finalCatalog ||
      !finalCatalog.isRealList ||
      !Array.isArray(finalCatalog.liveStreams) ||
      finalCatalog.liveStreams.length < 50 ||
      !Array.isArray(finalCatalog.vodStreams) ||
      finalCatalog.vodStreams.length < 50;

    if (xo && xo.baseUrl && xo.username && xo.password && isCatalogIncomplete) {
      try {
        finalCatalog = await standaloneXtreamFetchCatalog(
          xo.baseUrl,
          xo.username,
          xo.password,
          appState.preferences.streamFormat
        );
      } catch (directFetchErr) {
        console.warn('Aviso fallback direto:', directFetchErr);
      }
    }

    const chkRemember = document.getElementById('chkRememberAccount');
    const shouldRemember = chkRemember ? chkRemember.checked : true;
    localStorage.setItem('3a_remember_credentials', shouldRemember ? 'true' : 'false');
    if (shouldRemember) {
      localStorage.setItem('3a_saved_username', username);
      localStorage.setItem('3a_saved_password', password);
    } else {
      localStorage.removeItem('3a_saved_username');
      localStorage.removeItem('3a_saved_password');
    }

    appState.loggedIn = true;
    appState.profile = data.profile;
    appState.catalog = finalCatalog;
    appState.macAddress = getOrCreateDeviceMac();
    localStorage.setItem('3a_mac_address', appState.macAddress);
    updateMacDisplays();

    // Salva cache de sessão autenticada apenas neste dispositivo para contingência offline/wake-up do servidor
    try {
      if (xo && xo.baseUrl && xo.username && xo.password) {
        localStorage.setItem('3a_device_session_backup', JSON.stringify({
          u: String(username).toLowerCase(),
          profile: {
            name: data.profile.name,
            username: data.profile.username,
            expiresAtFormatted: data.profile.expiresAtFormatted,
            parentalPin: data.profile.parentalPin || '0000',
            sourceLabel: data.profile.sourceLabel
          },
          xo
        }));
      }
    } catch (_) {}

    document.getElementById('homeClientName').textContent = data.profile.name;
    document.getElementById('homeExpirationDate').textContent = data.profile.expiresAtFormatted || '15/06/2026';

    navigateToScreen('screenHome');
    showToast(`✅ Bem-vindo, ${data.profile.name}! Lista completa carregada.`);
  } catch (err) {
    // Contingência local segura: utiliza apenas a sessão já autenticada previamente neste próprio aparelho
    try {
      const savedBackup = JSON.parse(localStorage.getItem('3a_device_session_backup') || 'null');
      const savedUser = localStorage.getItem('3a_saved_username') || '';
      const savedPass = localStorage.getItem('3a_saved_password') || '';
      if (
        savedBackup &&
        savedBackup.u === String(username).toLowerCase() &&
        savedUser.toLowerCase() === String(username).toLowerCase() &&
        savedPass === password &&
        savedBackup.xo
      ) {
        const catalog = await standaloneXtreamFetchCatalog(
          savedBackup.xo.baseUrl,
          savedBackup.xo.username,
          savedBackup.xo.password,
          appState.preferences.streamFormat
        );
        appState.loggedIn = true;
        appState.profile = savedBackup.profile;
        appState.catalog = catalog;
        document.getElementById('homeClientName').textContent = appState.profile.name;
        document.getElementById('homeExpirationDate').textContent = appState.profile.expiresAtFormatted;
        navigateToScreen('screenHome');
        return;
      }
    } catch (_) {}

    errBox.textContent = 'Erro de conexão com o servidor 3A Stream.';
    errBox.classList.remove('hidden');
  } finally {
    btn.innerHTML = origHtml;
    btn.disabled = false;
  }
}

function logoutPlayer() {
  stopVideoPlayback();
  appState.loggedIn = false;
  appState.adultUnlockedSession = false;
  navigateToScreen('screenLogin');
  showToast('👋 Sessão encerrada.');
}

async function reloadPlaylistCatalog(fromSettings = false) {
  if (!appState.profile) {
    showToast('⚠️ Faça login primeiro.');
    return;
  }
  showToast('🔄 Recarregando canais, filmes, séries e EPG...');
  const u = document.getElementById('loginUsername').value;
  const p = document.getElementById('loginPassword').value;
  await performLogin(u, p);
  if (fromSettings) {
    navigateToScreen('screenSettings');
  }
  showToast('✅ Lista e guia atualizados com sucesso!');
}

// ============================================================================
// NAVEGAÇÃO ENTRE TELAS DO APP E BOTÃO VOLTAR DO ANDROID (VOLTAR 1 PÁGINA)
// ============================================================================
let lastBackExitToastTime = 0;

function navigateToScreen(screenId, skipHistoryPush = false) {
  document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add('active');
    appState.currentScreen = screenId;
    focusFirstElementInActiveScreen();
    if (!skipHistoryPush && window.history && window.history.pushState) {
      try {
        window.history.pushState({ screen: screenId }, '', '');
      } catch (_) {}
    }
  }
}

function initAndroidBackNavigation() {
  try {
    window.history.replaceState({ screen: appState.currentScreen || 'screenLogin' }, '', '');
  } catch (_) {}

  window.addEventListener('popstate', () => {
    const res = window.handleAndroidBackButton(true);
    if (res === 'handled') {
      try {
        window.history.pushState({ screen: appState.currentScreen }, '', '');
      } catch (_) {}
    }
  });
}

// Função global chamada pela MainActivity.java do Android ao clicar no botão Voltar (◀)
window.handleAndroidBackButton = function(fromPopstate = false) {
  // 1. Se houver um modal aberto, fecha apenas o modal
  const dialog = document.getElementById('appModalDialog');
  if (dialog && dialog.open) {
    dialog.close();
    return 'handled';
  }

  // 2. Se o navegador/WebView entrou no fullscreen nativo de algum elemento, sai dele e volta uma página se estiver no player
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    if (appState.currentScreen === 'screenCinemaPlayer') {
      closeCinemaPlayer();
    }
    return 'handled';
  }

  // 3. Se estiver no Player de Cinema em Tela Cheia (#screenCinemaPlayer):
  if (appState.currentScreen === 'screenCinemaPlayer') {
    const drawer = document.getElementById('cinemaEpisodeDrawer');
    if (drawer && !drawer.classList.contains('hidden')) {
      drawer.classList.add('hidden');
      return 'handled';
    }
    closeCinemaPlayer();
    return 'handled';
  }

  // 4. Se estiver nos Detalhes de Série (#screenMediaDetail), volta 1 página para o Catálogo de Séries (#screenCatalog)
  if (appState.currentScreen === 'screenMediaDetail') {
    backFromMediaDetail();
    return 'handled';
  }

  // 5. Se estiver no Catálogo (TV ao Vivo, Filmes, Séries, Futebol) ou Configurações, volta 1 página para a Home (#screenHome)
  if (appState.currentScreen === 'screenCatalog' || appState.currentScreen === 'screenSettings') {
    closeCatalogSection();
    return 'handled';
  }

  // 6. Se estiver na Home (#screenHome) ou Login (#screenLogin), exige duplo clique consciente para não fechar o app por engano
  const now = Date.now();
  if (now - lastBackExitToastTime < 2500) {
    return 'exit_app';
  }
  lastBackExitToastTime = now;
  showToast('↩ Toque em Voltar novamente para sair do aplicativo');
  return 'handled';
};

// ============================================================================
// CATÁLOGO E REPRODUÇÃO (TV AO VIVO, FUTEBOL, FILMES, SÉRIES)
// ============================================================================
let cinemaReturnScreen = 'screenMediaDetail';
let cinemaTopbarTimer = null;

const VIDEO_ASPECT_MODES = [
  { id: 'fill', className: 'video-fit-fill', label: '📐 Tela: Preencher 100%', desc: 'Tela Cheia 100% (Preenche toda a tela sem bordas pretas)' },
  { id: 'contain', className: 'video-fit-contain', label: '📐 Tela: Original 16:9', desc: 'Proporção Original sem cortes' },
  { id: 'cover', className: 'video-fit-cover', label: '📐 Tela: Zoom Cinema', desc: 'Zoom Cinematográfico preenchendo a tela' }
];
let currentAspectIndex = 0; // Padrão: Preencher 100% da tela

function cycleVideoAspectRatio() {
  currentAspectIndex = (currentAspectIndex + 1) % VIDEO_ASPECT_MODES.length;
  const mode = VIDEO_ASPECT_MODES[currentAspectIndex];
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const liveVideo = document.getElementById('iptvVideoPlayer');
  [cinemaVideo, liveVideo].forEach(v => {
    if (!v) return;
    v.classList.remove('video-fit-fill', 'video-fit-contain', 'video-fit-cover');
    v.classList.add(mode.className);
  });
  const btn = document.getElementById('btnCinemaAspectRatio');
  if (btn) btn.textContent = mode.label;
  showToast(mode.desc);
  scheduleCinemaTopbarHide();
}

let currentCinemaContext = {
  mode: 'vod', // 'vod' | 'series' | 'live'
  item: null,
  episode: null
};

// ============================================================================
// CACHE DE CATEGORIAS FIXADAS NO TOPO (FAVORITOS E RECENTEMENTE VISTO)
// ============================================================================
function normalizeCacheSection(section) {
  if (section === 'soccer' || section === 'live') return 'live';
  if (section === 'series') return 'series';
  return 'vod';
}

function getItemUniqueKey(item) {
  if (!item) return '';
  return String(item.stream_id || item.series_id || item.id || item.name || '').trim();
}

function serializeCatalogItemForCache(item) {
  if (!item) return null;
  return {
    stream_id: item.stream_id,
    series_id: item.series_id,
    id: item.id,
    name: item.name,
    logo: item.logo,
    poster: item.poster,
    category_id: item.category_id,
    rating: item.rating,
    year: item.year,
    duration: item.duration,
    streamUrl: item.streamUrl,
    rawStreamUrl: item.rawStreamUrl,
    fallbackTsUrl: item.fallbackTsUrl,
    epgNow: item.epgNow,
    epgNext: item.epgNext,
    matchInfo: item.matchInfo,
    isSoccer: item.isSoccer,
    isAdult: item.isAdult
  };
}

function resolveCachedItemsWithCatalog(section, cachedArray) {
  if (!Array.isArray(cachedArray)) return [];
  const norm = normalizeCacheSection(section);
  let pool = [];
  if (appState.catalog) {
    if (norm === 'live') pool = appState.catalog.liveStreams || [];
    else if (norm === 'vod') pool = appState.catalog.vodStreams || [];
    else if (norm === 'series') pool = appState.catalog.seriesList || [];
  }
  const mapByKey = new Map();
  pool.forEach(entry => {
    const k = getItemUniqueKey(entry);
    if (k) mapByKey.set(k, entry);
  });

  const resolved = [];
  cachedArray.forEach(cached => {
    if (!cached) return;
    const k = getItemUniqueKey(cached);
    const liveMatch = k && mapByKey.get(k);
    const finalItem = liveMatch || cached;
    if (section === 'soccer' && !finalItem.isSoccer) return;
    resolved.push(finalItem);
  });
  return resolved;
}

function getFavoritesList(section) {
  const norm = normalizeCacheSection(section);
  try {
    const raw = JSON.parse(localStorage.getItem(`3a_fav_${norm}`) || '[]');
    return resolveCachedItemsWithCatalog(section, raw);
  } catch (_) {
    return [];
  }
}

function isItemFavorited(section, item) {
  if (!item) return false;
  const norm = normalizeCacheSection(section);
  const targetKey = getItemUniqueKey(item);
  if (!targetKey) return false;
  try {
    const raw = JSON.parse(localStorage.getItem(`3a_fav_${norm}`) || '[]');
    return Array.isArray(raw) && raw.some(entry => getItemUniqueKey(entry) === targetKey);
  } catch (_) {
    return false;
  }
}

function toggleFavoriteItem(section, item, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (!item) return false;
  const norm = normalizeCacheSection(section);
  const targetKey = getItemUniqueKey(item);
  if (!targetKey) return false;

  let raw = [];
  try {
    raw = JSON.parse(localStorage.getItem(`3a_fav_${norm}`) || '[]');
    if (!Array.isArray(raw)) raw = [];
  } catch (_) {
    raw = [];
  }

  const existingIdx = raw.findIndex(entry => getItemUniqueKey(entry) === targetKey);
  let nowFavorited = false;
  if (existingIdx >= 0) {
    raw.splice(existingIdx, 1);
    nowFavorited = false;
  } else {
    raw.unshift(serializeCatalogItemForCache(item));
    nowFavorited = true;
  }

  localStorage.setItem(`3a_fav_${norm}`, JSON.stringify(raw.slice(0, 200)));

  if (appState.currentScreen === 'screenCatalog') {
    renderCatalogCategories();
    if (appState.selectedCategoryId === 'FAVORITES') {
      renderCatalogItems(false);
    }
  }
  syncCinemaFavoriteButton();
  syncSeriesDetailFavoriteButton();
  return nowFavorited;
}

function getRecentList(section) {
  const norm = normalizeCacheSection(section);
  try {
    const raw = JSON.parse(localStorage.getItem(`3a_recent_${norm}`) || '[]');
    return resolveCachedItemsWithCatalog(section, raw);
  } catch (_) {
    return [];
  }
}

function addRecentItem(section, item) {
  if (!item) return;
  const norm = normalizeCacheSection(section);
  const targetKey = getItemUniqueKey(item);
  if (!targetKey) return;

  let raw = [];
  try {
    raw = JSON.parse(localStorage.getItem(`3a_recent_${norm}`) || '[]');
    if (!Array.isArray(raw)) raw = [];
  } catch (_) {
    raw = [];
  }

  raw = raw.filter(entry => getItemUniqueKey(entry) !== targetKey);
  raw.unshift(serializeCatalogItemForCache(item));
  localStorage.setItem(`3a_recent_${norm}`, JSON.stringify(raw.slice(0, 60)));

  if (norm === 'vod' && item.name) {
    const recents = (appState.preferences.recentMovies || []).filter(n => n !== item.name);
    recents.unshift(item.name);
    appState.preferences.recentMovies = recents.slice(0, 40);
    localStorage.setItem('3a_recent_movies', JSON.stringify(appState.preferences.recentMovies));
    syncSettingsLabels();
  }

  if (appState.currentScreen === 'screenCatalog') {
    renderCatalogCategories();
  }
}

function syncCinemaFavoriteButton() {
  const btn = document.getElementById('btnCinemaFavorite');
  if (!btn) return;
  const targetItem = currentCinemaContext.mode === 'series' ? activeSeriesItem : currentCinemaContext.item;
  const fav = isItemFavorited(currentCinemaContext.mode, targetItem);
  btn.textContent = fav ? '⭐ Favorito' : '☆ Favorito';
}

function toggleCurrentCinemaFavorite(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const targetItem = currentCinemaContext.mode === 'series' ? activeSeriesItem : currentCinemaContext.item;
  if (!targetItem) return;
  toggleFavoriteItem(currentCinemaContext.mode, targetItem, event);
  scheduleCinemaTopbarHide();
}

function syncSeriesDetailFavoriteButton() {
  const btn = document.getElementById('btnDetailFavorite');
  if (!btn || !activeSeriesItem) return;
  const fav = isItemFavorited('series', activeSeriesItem);
  btn.textContent = fav ? '⭐' : '☆';
}

function toggleActiveSeriesFavorite() {
  if (!activeSeriesItem) return;
  toggleFavoriteItem('series', activeSeriesItem);
}

// ============================================================================
// DOWNLOAD DE VÍDEO EM .MP4 (FILMES VOD E SÉRIES)
// ============================================================================
function sanitizeMp4Filename(rawTitle) {
  const cleaned = String(rawTitle || 'Video_3A_Stream')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 95);
  return (cleaned || 'Video_3A_Stream') + '.mp4';
}

function triggerMp4Download(streamUrl, title, item = {}) {
  const rawUrl = extractRawStreamUrl(streamUrl, item);
  const filename = sanitizeMp4Filename(title || (item && item.name) || 'Video_3A_Stream');

  let downloadHref = '';
  if (IS_NATIVE_APK && /^https?:\/\//i.test(rawUrl)) {
    downloadHref = `http://127.0.0.1:34567/proxy?url=${encodeURIComponent(rawUrl)}&download=1&filename=${encodeURIComponent(filename)}`;
  } else if (LOCAL_PC_PROXY_BASE && /^https?:\/\//i.test(rawUrl)) {
    downloadHref = `${LOCAL_PC_PROXY_BASE}/api/proxy/stream?url=${encodeURIComponent(rawUrl)}&download=1&filename=${encodeURIComponent(filename)}`;
  } else if (/^https?:\/\//i.test(rawUrl)) {
    downloadHref = `/api/proxy/stream?url=${encodeURIComponent(rawUrl)}&download=1&filename=${encodeURIComponent(filename)}`;
  } else {
    downloadHref = streamUrl;
  }

  if (!downloadHref) return;
  const a = document.createElement('a');
  a.href = downloadHref;
  a.setAttribute('download', filename);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1200);
}

function downloadCurrentCinemaVideo(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (currentCinemaContext.mode === 'series' && currentCinemaContext.episode) {
    const ep = currentCinemaContext.episode;
    const seriesTitle = (activeSeriesItem && activeSeriesItem.name) || 'Serie';
    const epLabel = `S${String(activeSeasonKey).padStart(2, '0')}E${String(ep.episode_num || activeEpisodeIndex + 1).padStart(2, '0')}`;
    triggerMp4Download(ep.streamUrl, `${seriesTitle}_${epLabel}_${ep.title || ''}`, ep);
  } else if (currentCinemaContext.item) {
    const item = currentCinemaContext.item;
    triggerMp4Download(item.streamUrl, item.name, item);
  }
  scheduleCinemaTopbarHide();
}

function downloadActiveSeriesEpisode() {
  if (!activeSeriesItem || !activeSeriesItem.seasons) return;
  const seasonEps = activeSeriesItem.seasons[activeSeasonKey] || [];
  const ep = seasonEps[activeEpisodeIndex] || seasonEps[0];
  if (!ep) return;
  const epLabel = `S${String(activeSeasonKey).padStart(2, '0')}E${String(ep.episode_num || 1).padStart(2, '0')}`;
  triggerMp4Download(ep.streamUrl, `${activeSeriesItem.name}_${epLabel}_${ep.title || ''}`, ep);
}

// ============================================================================
// BARRA DE PROGRESSO DE EPISÓDIOS/FILMES + MODAL "REINICIAR OU RETOMAR"
// ============================================================================
const WATCH_PROGRESS_STORAGE_KEY = '3a_watch_progress_v1';
let isUserDraggingTimeline = false;
let lastProgressSavedAtMs = 0;

function readAllWatchProgressMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_PROGRESS_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeAllWatchProgressMap(mapObj) {
  try {
    localStorage.setItem(WATCH_PROGRESS_STORAGE_KEY, JSON.stringify(mapObj || {}));
  } catch (_) {}
}

function getEpisodeProgressKey(seriesItem, seasonKey, ep, epIdx = 0) {
  if (!seriesItem || !ep) return '';
  const sId = seriesItem.series_id || seriesItem.id || seriesItem.name || 'serie';
  const epId = ep.id || ep.episode_num || (epIdx + 1);
  return `ep_${sId}_S${seasonKey}_E${epId}`;
}

function getVodProgressKey(vodItem) {
  if (!vodItem) return '';
  const vId = vodItem.stream_id || vodItem.id || vodItem.name || 'vod';
  return `vod_${vId}`;
}

function getWatchProgressByKey(key) {
  if (!key) return null;
  const map = readAllWatchProgressMap();
  const entry = map[key];
  if (!entry || typeof entry.currentTime !== 'number' || entry.currentTime < 5) return null;
  return entry;
}

function parseFallbackDurationSeconds(durationStr, defaultSec = 2700) {
  if (!durationStr) return defaultSec;
  const str = String(durationStr).trim();
  const hms = str.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }
  const mins = str.match(/(\d+)\s*m/i);
  if (mins) {
    return Number(mins[1]) * 60;
  }
  return defaultSec;
}

function saveWatchProgressByKey(key, currentTimeSec, durationSec, fallbackDurationStr = '') {
  if (!key) return;
  const cur = Number(currentTimeSec || 0);
  if (!Number.isFinite(cur) || cur < 5) return;

  let dur = Number(durationSec || 0);
  if (!Number.isFinite(dur) || dur <= 0) {
    dur = parseFallbackDurationSeconds(fallbackDurationStr, key.startsWith('vod_') ? 5400 : 2700);
  }
  if (dur < cur) dur = Math.max(cur * 1.15, 2700);

  const percent = Math.min(100, Math.max(3, Math.round((cur / dur) * 100)));
  const map = readAllWatchProgressMap();
  map[key] = {
    currentTime: Math.floor(cur),
    duration: Math.floor(dur),
    percent,
    updatedAt: Date.now()
  };

  // Mantém até 300 registros mais recentes no cache
  const keys = Object.keys(map);
  if (keys.length > 300) {
    keys
      .sort((a, b) => (map[b].updatedAt || 0) - (map[a].updatedAt || 0))
      .slice(300)
      .forEach(k => delete map[k]);
  }
  writeAllWatchProgressMap(map);
}

function clearWatchProgressByKey(key) {
  if (!key) return;
  const map = readAllWatchProgressMap();
  if (map[key]) {
    delete map[key];
    writeAllWatchProgressMap(map);
  }
}

function saveCurrentCinemaWatchProgress() {
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (!cinemaVideo) return;
  const cur = Number(cinemaVideo.currentTime || 0);
  const dur = Number(cinemaVideo.duration || 0);
  if (cur < 5) return;

  if (currentCinemaContext.mode === 'series' && activeSeriesItem && currentCinemaContext.episode) {
    const ep = currentCinemaContext.episode;
    const key = getEpisodeProgressKey(activeSeriesItem, activeSeasonKey, ep, activeEpisodeIndex);
    saveWatchProgressByKey(key, cur, dur, ep.duration);
  } else if (currentCinemaContext.mode === 'vod' && currentCinemaContext.item) {
    const item = currentCinemaContext.item;
    const key = getVodProgressKey(item);
    saveWatchProgressByKey(key, cur, dur, item.duration);
  }
}

function formatClockTime(totalSeconds) {
  const secNum = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hrs = Math.floor(secNum / 3600);
  const mins = Math.floor((secNum % 3600) / 60);
  const secs = secNum % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatMinutesWatchedLabel(totalSeconds) {
  const secNum = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (secNum < 60) {
    return `${secNum}s`;
  }
  const mins = Math.floor(secNum / 60);
  return `${mins} min`;
}

let activeResumeChoiceCallback = null;

function promptResumeOrRestartPlayback(itemTitle, savedProgress, onChoice) {
  activeResumeChoiceCallback = onChoice;
  const watchedTimeLabel = formatMinutesWatchedLabel(savedProgress.currentTime);
  const clockStamp = formatClockTime(savedProgress.currentTime);
  const pct = savedProgress.percent || 10;

  openAppModal('Continuar Assistindo?', `
    <div class="resume-prompt-box">
      <div class="resume-prompt-info">
        Você já assistiu <strong>${watchedTimeLabel}</strong> (<strong>${clockStamp}</strong> • ${pct}%) de:<br/>
        <span style="color:#f4f4f5;font-weight:700;">${itemTitle}</span>
        <div class="ep-watch-underbar" style="margin-top:8px;height:6px;">
          <div class="ep-watch-underbar-fill" style="width:${pct}%;"></div>
        </div>
      </div>
      <div class="resume-choice-grid">
        <button type="button" class="btn-restart-play focusable" onclick="handleResumeModalDecision('restart')">
          🔄 Reiniciar
        </button>
        <button type="button" class="btn-resume-play focusable" onclick="handleResumeModalDecision('resume')">
          ▶️ Retomar (${clockStamp})
        </button>
      </div>
    </div>
  `);
}

function handleResumeModalDecision(decision) {
  const cb = activeResumeChoiceCallback;
  activeResumeChoiceCallback = null;
  closeAppModal();
  if (typeof cb === 'function') {
    cb(decision);
  }
}

// ============================================================================
// CONTROLES CENTRAIS DO PLAYER DE CINEMA (-10s, ANTERIOR, PLAY/PAUSE, PRÓXIMO, +10s)
// ============================================================================
function syncCenterPlayPauseIcon() {
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const playIcon = document.getElementById('iconCenterPlay');
  const pauseIcon = document.getElementById('iconCenterPause');
  if (!cinemaVideo || !playIcon || !pauseIcon) return;
  const isPaused = cinemaVideo.paused || cinemaVideo.ended;
  playIcon.classList.toggle('hidden', !isPaused);
  pauseIcon.classList.toggle('hidden', isPaused);
}

function setCinemaBufferingState(isBuffering) {
  const centerBtn = document.getElementById('btnCenterPlayPause');
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (cinemaVideo) {
    cinemaVideo.removeAttribute('poster');
  }
  if (centerBtn) {
    centerBtn.classList.toggle('is-buffering', Boolean(isBuffering));
  }
}

let timelineSeekLockUntilMs = 0;

function getEffectiveCinemaDuration(cinemaVideo) {
  if (!cinemaVideo) return 0;
  const dur = Number(cinemaVideo.duration);
  if (Number.isFinite(dur) && dur > 0) return dur;
  try {
    if (cinemaVideo.seekable && cinemaVideo.seekable.length > 0) {
      const seekEnd = Number(cinemaVideo.seekable.end(cinemaVideo.seekable.length - 1));
      if (Number.isFinite(seekEnd) && seekEnd > 0) return seekEnd;
    }
  } catch (_) {}
  if (currentCinemaContext.mode === 'series' && currentCinemaContext.episode && currentCinemaContext.episode.duration) {
    const parsed = parseFallbackDurationSeconds(currentCinemaContext.episode.duration, 0);
    if (parsed > 0) return parsed;
  }
  if (currentCinemaContext.mode === 'vod' && currentCinemaContext.item && currentCinemaContext.item.duration) {
    const parsed = parseFallbackDurationSeconds(currentCinemaContext.item.duration, 0);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function extractTimelinePermille(sliderValOrEvent, maybeEvent) {
  const slider = document.getElementById('cinemaSeekSlider');
  if (typeof sliderValOrEvent === 'number' || typeof sliderValOrEvent === 'string') {
    const num = Number(sliderValOrEvent);
    if (Number.isFinite(num)) {
      return Math.min(1000, Math.max(0, Math.round(num)));
    }
  }
  const ev = (sliderValOrEvent && typeof sliderValOrEvent === 'object') ? sliderValOrEvent : maybeEvent;
  if (ev && ev.target && ev.target.value !== undefined) {
    const num = Number(ev.target.value);
    if (Number.isFinite(num)) {
      return Math.min(1000, Math.max(0, Math.round(num)));
    }
  }
  if (slider && slider.value !== undefined) {
    const num = Number(slider.value);
    if (Number.isFinite(num)) {
      return Math.min(1000, Math.max(0, Math.round(num)));
    }
  }
  return 0;
}

function computePermilleFromPointerPosition(ev, sliderEl) {
  if (!ev || !sliderEl) return null;
  let clientX = null;
  if (ev.touches && ev.touches.length > 0) {
    clientX = ev.touches[0].clientX;
  } else if (ev.changedTouches && ev.changedTouches.length > 0) {
    clientX = ev.changedTouches[0].clientX;
  } else if (typeof ev.clientX === 'number') {
    clientX = ev.clientX;
  }
  if (typeof clientX !== 'number') return null;
  const rect = sliderEl.getBoundingClientRect();
  if (!rect || rect.width <= 0) return null;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.round(ratio * 1000);
}

function syncCinemaBottomTimeline() {
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const curEl = document.getElementById('cinemaTimeCurrent');
  const durEl = document.getElementById('cinemaTimeDuration');
  const slider = document.getElementById('cinemaSeekSlider');
  if (!cinemaVideo || !curEl || !durEl || !slider) return;

  const dur = getEffectiveCinemaDuration(cinemaVideo);
  if (dur > 0) {
    durEl.textContent = formatClockTime(dur);
  } else {
    durEl.textContent = '--:--';
  }

  // Enquanto o usuário estiver clicando/arrastando a barra ou o vídeo estiver buscando o novo ponto, mantém a posição escolhida
  if (isUserDraggingTimeline || cinemaVideo.seeking || Date.now() < timelineSeekLockUntilMs) {
    return;
  }

  const cur = Number(cinemaVideo.currentTime || 0);
  curEl.textContent = formatClockTime(cur);

  if (dur > 0) {
    const val = Math.min(1000, Math.max(0, Math.round((cur / dur) * 1000)));
    slider.value = String(val);
    slider.style.setProperty('--seek-pct', `${(val / 10).toFixed(1)}%`);
  } else {
    slider.value = '0';
    slider.style.setProperty('--seek-pct', '0%');
  }
}

function applyCinemaTimelineSeekPermille(permille, commitToVideo = false) {
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const curEl = document.getElementById('cinemaTimeCurrent');
  const slider = document.getElementById('cinemaSeekSlider');
  const pct = Math.min(1000, Math.max(0, Math.round(Number(permille) || 0)));

  if (slider) {
    slider.value = String(pct);
    slider.style.setProperty('--seek-pct', `${(pct / 10).toFixed(1)}%`);
  }

  const dur = getEffectiveCinemaDuration(cinemaVideo);
  if (dur > 0) {
    const targetSec = Math.max(0, Math.min(dur - 0.25, (pct / 1000) * dur));
    if (curEl) {
      curEl.textContent = formatClockTime(targetSec);
    }
    if (commitToVideo && cinemaVideo) {
      timelineSeekLockUntilMs = Date.now() + 900;
      try {
        cinemaVideo.currentTime = targetSec;
      } catch (_) {}
      saveWatchProgressByKey(
        currentCinemaContext.mode === 'series' && activeSeriesItem && currentCinemaContext.episode
          ? getEpisodeProgressKey(activeSeriesItem, activeSeasonKey, currentCinemaContext.episode, activeEpisodeIndex)
          : getVodProgressKey(currentCinemaContext.item),
        targetSec,
        dur
      );
    }
  }
}

function handleCinemaTimelinePointerDown(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  isUserDraggingTimeline = true;

  const slider = document.getElementById('cinemaSeekSlider');
  let latestPermille = computePermilleFromPointerPosition(event, slider);
  if (latestPermille !== null) {
    // Aplica imediatamente na posição exata clicada/tocada na barra
    applyCinemaTimelineSeekPermille(latestPermille, true);
  }

  const onMove = (moveEv) => {
    if (!isUserDraggingTimeline) return;
    const movePermille = computePermilleFromPointerPosition(moveEv, slider);
    if (movePermille !== null) {
      latestPermille = movePermille;
      applyCinemaTimelineSeekPermille(movePermille, false);
    }
  };

  const onRelease = (upEv) => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('touchmove', onMove, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('touchend', onRelease, true);
    window.removeEventListener('mouseup', onRelease, true);
    if (isUserDraggingTimeline) {
      const upPermille = computePermilleFromPointerPosition(upEv, slider);
      const finalPermille = upPermille !== null
        ? upPermille
        : (latestPermille !== null ? latestPermille : extractTimelinePermille(slider ? slider.value : 0));
      applyCinemaTimelineSeekPermille(finalPermille, true);
      isUserDraggingTimeline = false;
      scheduleCinemaTopbarHide(false);
    }
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('touchmove', onMove, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('touchend', onRelease, true);
  window.addEventListener('mouseup', onRelease, true);
  scheduleCinemaTopbarHide(false);
}

function handleCinemaTimelineInput(sliderValOrEvent, maybeEvent) {
  const ev = (sliderValOrEvent && typeof sliderValOrEvent === 'object') ? sliderValOrEvent : maybeEvent;
  if (ev && ev.stopPropagation) ev.stopPropagation();
  isUserDraggingTimeline = true;
  const pct = extractTimelinePermille(sliderValOrEvent, maybeEvent);
  applyCinemaTimelineSeekPermille(pct, false);
  scheduleCinemaTopbarHide(false);
}

function handleCinemaTimelineCommit(sliderValOrEvent, maybeEvent) {
  const ev = (sliderValOrEvent && typeof sliderValOrEvent === 'object') ? sliderValOrEvent : maybeEvent;
  if (ev && ev.stopPropagation) ev.stopPropagation();
  const pct = extractTimelinePermille(sliderValOrEvent, maybeEvent);
  applyCinemaTimelineSeekPermille(pct, true);
  isUserDraggingTimeline = false;
  scheduleCinemaTopbarHide(false);
}

let cinemaSavedVolume = 1.0;

function handleCinemaVolumeInput(val, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const slider = document.getElementById('cinemaVolumeSlider');
  const muteBtn = document.getElementById('btnCinemaMute');
  const num = Math.max(0, Math.min(1, parseFloat(val) || 0));

  if (cinemaVideo) {
    cinemaVideo.volume = num;
    cinemaVideo.muted = num === 0;
  }
  if (num > 0) {
    cinemaSavedVolume = num;
  }
  if (slider && Math.abs(parseFloat(slider.value) - num) > 0.01) {
    slider.value = num;
  }
  if (muteBtn) {
    muteBtn.textContent = num === 0 ? '🔇' : (num < 0.5 ? '🔉' : '🔊');
  }
  scheduleCinemaTopbarHide();
}

function handleCinemaVolumeCommit(val, event) {
  handleCinemaVolumeInput(val, event);
}

function toggleCinemaMute(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const slider = document.getElementById('cinemaVolumeSlider');
  const muteBtn = document.getElementById('btnCinemaMute');
  if (!cinemaVideo) return;

  if (cinemaVideo.muted || cinemaVideo.volume === 0) {
    cinemaVideo.muted = false;
    const restore = cinemaSavedVolume > 0.05 ? cinemaSavedVolume : 1.0;
    cinemaVideo.volume = restore;
    if (slider) slider.value = restore;
    if (muteBtn) muteBtn.textContent = restore < 0.5 ? '🔉' : '🔊';
  } else {
    cinemaSavedVolume = cinemaVideo.volume > 0 ? cinemaVideo.volume : 1.0;
    cinemaVideo.muted = true;
    cinemaVideo.volume = 0;
    if (slider) slider.value = 0;
    if (muteBtn) muteBtn.textContent = '🔇';
  }
  scheduleCinemaTopbarHide();
}

function toggleCinemaPlayPause(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (!cinemaVideo) return;
  if (cinemaVideo.paused || cinemaVideo.ended) {
    cinemaVideo.play().catch(() => {});
  } else {
    cinemaVideo.pause();
    saveCurrentCinemaWatchProgress();
  }
  syncCenterPlayPauseIcon();
  scheduleCinemaTopbarHide();
}

function seekCinemaVideo(deltaSeconds, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (!cinemaVideo) return;
  try {
    const cur = Number(cinemaVideo.currentTime || 0);
    const dur = getEffectiveCinemaDuration(cinemaVideo);
    const target = dur > 0
      ? Math.max(0, Math.min(dur - 0.5, cur + deltaSeconds))
      : Math.max(0, cur + deltaSeconds);
    timelineSeekLockUntilMs = Date.now() + 700;
    cinemaVideo.currentTime = target;
    if (dur > 0) {
      const permille = Math.round((target / dur) * 1000);
      applyCinemaTimelineSeekPermille(permille, false);
    }
  } catch (_) {}
  saveCurrentCinemaWatchProgress();
  scheduleCinemaTopbarHide(false);
}

function handleCinemaSkip(delta, event) {
  if (event && event.stopPropagation) event.stopPropagation();
  saveCurrentCinemaWatchProgress();
  if (currentCinemaContext.mode === 'series') {
    skipSeriesEpisode(delta);
    scheduleCinemaTopbarHide();
    return;
  }

  // Se estiver em Filme (VOD) ou Canal Ao Vivo, avança/volta para o próximo/anterior da lista
  const list = currentCinemaContext.mode === 'live'
    ? (appState.catalog && appState.catalog.liveStreams) || []
    : (appState.catalog && appState.catalog.vodStreams) || [];
  if (!list.length || !currentCinemaContext.item) return;

  const curKey = getItemUniqueKey(currentCinemaContext.item);
  const idx = list.findIndex(entry => getItemUniqueKey(entry) === curKey);
  if (idx === -1) return;
  const nextIdx = (idx + delta + list.length) % list.length;
  const nextItem = list[nextIdx];
  if (nextItem) {
    startVodOrLiveInCinema(nextItem, currentCinemaContext.mode);
  }
}

function scheduleCinemaTopbarHide(shouldSyncTimeline = true) {
  const topbar = document.getElementById('cinemaTopbar');
  const centerControls = document.getElementById('cinemaCenterControls');
  const bottomBar = document.getElementById('cinemaBottomBar');
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (topbar) topbar.classList.remove('topbar-hidden');
  if (centerControls) centerControls.classList.remove('controls-hidden');
  if (bottomBar) {
    bottomBar.classList.toggle('hidden', currentCinemaContext.mode === 'live');
    bottomBar.classList.remove('bar-hidden');
  }
  syncCenterPlayPauseIcon();
  if (shouldSyncTimeline && !isUserDraggingTimeline) {
    syncCinemaBottomTimeline();
  }

  clearTimeout(cinemaTopbarTimer);
  cinemaTopbarTimer = setTimeout(() => {
    const drawer = document.getElementById('cinemaEpisodeDrawer');
    if (drawer && !drawer.classList.contains('hidden')) return;
    if (isUserDraggingTimeline) return;
    if (cinemaVideo && cinemaVideo.paused) return;
    if (appState.currentScreen === 'screenCinemaPlayer') {
      if (topbar) topbar.classList.add('topbar-hidden');
      if (centerControls) centerControls.classList.add('controls-hidden');
      if (bottomBar) bottomBar.classList.add('bar-hidden');
    }
  }, 3500);
}

function handleCinemaStageTap(event) {
  scheduleCinemaTopbarHide();
}

/**
 * Garante que o botão de Voltar no canto superior esquerdo, controles centrais e barra inferior apareçam SEMPRE
 * que o usuário tocar na tela do vídeo e ocultem automaticamente após 3.5 segundos sem toque.
 */
function initCinemaTouchWakeup() {
  const wrap = document.getElementById('cinemaPlayerWrap');
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const liveVideo = document.getElementById('iptvVideoPlayer');

  const wakeTopbarOnTouch = (e) => {
    if (appState.currentScreen === 'screenCinemaPlayer') {
      const isTouchingBottomBar = Boolean(
        e && e.target && typeof e.target.closest === 'function' && e.target.closest('#cinemaBottomBar')
      );
      scheduleCinemaTopbarHide(!isTouchingBottomBar);
    }
  };

  if (wrap) {
    wrap.addEventListener('touchstart', wakeTopbarOnTouch, { capture: true, passive: true });
    wrap.addEventListener('pointerdown', wakeTopbarOnTouch, { capture: true, passive: true });
    wrap.addEventListener('mousemove', wakeTopbarOnTouch, { passive: true });
  }

  if (cinemaVideo) {
    cinemaVideo.addEventListener('touchstart', wakeTopbarOnTouch, { capture: true, passive: true });
    cinemaVideo.addEventListener('loadstart', () => setCinemaBufferingState(true));
    cinemaVideo.addEventListener('waiting', () => setCinemaBufferingState(true));
    cinemaVideo.addEventListener('canplay', () => {
      setCinemaBufferingState(false);
      syncCinemaBottomTimeline();
    });
    cinemaVideo.addEventListener('playing', () => {
      setCinemaBufferingState(false);
      syncCenterPlayPauseIcon();
      scheduleCinemaTopbarHide();
    });
    cinemaVideo.addEventListener('loadedmetadata', () => {
      syncCinemaBottomTimeline();
    });
    cinemaVideo.addEventListener('durationchange', () => {
      syncCinemaBottomTimeline();
    });
    cinemaVideo.addEventListener('timeupdate', () => {
      syncCinemaBottomTimeline();
      const now = Date.now();
      if (now - lastProgressSavedAtMs >= 3000) {
        lastProgressSavedAtMs = now;
        saveCurrentCinemaWatchProgress();
      }
    });
    cinemaVideo.addEventListener('play', () => {
      updateNativeVideoPlayingState(true);
      syncCenterPlayPauseIcon();
      scheduleCinemaTopbarHide();
    });
    cinemaVideo.addEventListener('playing', () => {
      updateNativeVideoPlayingState(true);
      setCinemaBufferingState(false);
      syncCenterPlayPauseIcon();
      scheduleCinemaTopbarHide();
    });
    cinemaVideo.addEventListener('pause', () => {
      updateNativeVideoPlayingState(false);
      setCinemaBufferingState(false);
      syncCenterPlayPauseIcon();
      saveCurrentCinemaWatchProgress();
      wakeTopbarOnTouch();
    });
    cinemaVideo.addEventListener('ended', () => {
      updateNativeVideoPlayingState(false);
    });
    cinemaVideo.addEventListener('enterpictureinpicture', () => {
      document.body.classList.add('native-pip-active');
      document.documentElement.classList.add('native-pip-active');
    });
    cinemaVideo.addEventListener('leavepictureinpicture', () => {
      document.body.classList.remove('native-pip-active');
      document.documentElement.classList.remove('native-pip-active');
    });
    cinemaVideo.addEventListener('seeking', wakeTopbarOnTouch);
    cinemaVideo.addEventListener('seeked', () => {
      setCinemaBufferingState(false);
      syncCinemaBottomTimeline();
      saveCurrentCinemaWatchProgress();
    });
  }

  // Impede que o fullscreen nativo isolado do <video> esconda o nosso botão de Voltar superior esquerdo
  const onFullscreenChange = () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl === liveVideo) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      openCurrentLiveInCinema();
    } else if (fsEl === cinemaVideo) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      scheduleCinemaTopbarHide();
    }
  };

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

function openCatalogSection(section) {
  if (!appState.catalog) {
    return;
  }
  appState.currentSection = section;
  appState.selectedCategoryId = 'ALL';
  document.getElementById('catalogSearchInput').value = '';

  const titles = {
    live: '📺 TV ao Vivo',
    soccer: '⚽ Esportes',
    vod: '🍿 Filmes (VOD)',
    series: '🎬 Séries'
  };
  document.getElementById('catalogSectionTitle').textContent = titles[section] || 'Catálogo';

  const screenCatalog = document.getElementById('screenCatalog');
  const isPosterSection = section === 'vod' || section === 'series';
  if (screenCatalog) {
    screenCatalog.classList.toggle('catalog-mode-vod', isPosterSection);
  }

  if (isPosterSection) {
    stopVideoPlayback();
  }

  navigateToScreen('screenCatalog');
  appState.visibleLimit = 200;
  renderCatalogCategories();
  renderCatalogItems(true);
}

function closeCatalogSection() {
  stopVideoPlayback();
  navigateToScreen('screenHome');
}

function renderCatalogCategories() {
  const container = document.getElementById('catalogCategoriesList');
  container.innerHTML = '';

  let rawCategories = [];
  let hiddenList = [];
  let totalCount = 0;

  if (appState.currentSection === 'live') {
    rawCategories = appState.catalog.liveCategories || [];
    hiddenList = appState.preferences.hiddenCategories.live || [];
    totalCount = (appState.catalog.liveStreams || []).filter(i => !hiddenList.includes(String(i.category_id))).length;
  } else if (appState.currentSection === 'soccer') {
    rawCategories = (appState.catalog.liveCategories || []).filter(c => c.isSoccerCategory);
    hiddenList = appState.preferences.hiddenCategories.live || [];
    totalCount = (appState.catalog.liveStreams || []).filter(i => i.isSoccer).length;
  } else if (appState.currentSection === 'vod') {
    rawCategories = appState.catalog.vodCategories || [];
    hiddenList = appState.preferences.hiddenCategories.vod || [];
    totalCount = (appState.catalog.vodStreams || []).filter(i => !hiddenList.includes(String(i.category_id))).length;
  } else if (appState.currentSection === 'series') {
    rawCategories = appState.catalog.seriesCategories || [];
    hiddenList = appState.preferences.hiddenCategories.series || [];
    totalCount = (appState.catalog.seriesList || []).filter(i => !hiddenList.includes(String(i.category_id))).length;
  }

  // 1. Categoria TODOS
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `cat-btn focusable ${appState.selectedCategoryId === 'ALL' ? 'active' : ''}`;
  allBtn.innerHTML = `<span class="cat-btn-label">TODOS</span> <span class="cat-btn-count">${totalCount}</span>`;
  allBtn.onclick = () => {
    appState.selectedCategoryId = 'ALL';
    appState.visibleLimit = 200;
    renderCatalogCategories();
    renderCatalogItems(true);
  };
  container.appendChild(allBtn);

  // 2. Categorias Fixadas no Topo: ⭐ FAVORITOS e 🕒 RECENTEMENTE VISTO (para Filmes, Séries e Ao Vivo)
  const favCount = getFavoritesList(appState.currentSection).length;
  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = `cat-btn cat-btn-pinned focusable ${appState.selectedCategoryId === 'FAVORITES' ? 'active' : ''}`;
  favBtn.innerHTML = `<span class="cat-btn-label">⭐ Favoritos</span> <span class="cat-btn-count">${favCount}</span>`;
  favBtn.onclick = () => {
    appState.selectedCategoryId = 'FAVORITES';
    appState.visibleLimit = 200;
    renderCatalogCategories();
    renderCatalogItems(true);
  };
  container.appendChild(favBtn);

  const recentCount = getRecentList(appState.currentSection).length;
  const recentBtn = document.createElement('button');
  recentBtn.type = 'button';
  recentBtn.className = `cat-btn cat-btn-pinned focusable ${appState.selectedCategoryId === 'RECENT' ? 'active' : ''}`;
  recentBtn.innerHTML = `<span class="cat-btn-label">🕒 Recentemente Visto</span> <span class="cat-btn-count">${recentCount}</span>`;
  recentBtn.onclick = () => {
    appState.selectedCategoryId = 'RECENT';
    appState.visibleLimit = 200;
    renderCatalogCategories();
    renderCatalogItems(true);
  };
  container.appendChild(recentBtn);

  rawCategories
    .filter(cat => !hiddenList.includes(String(cat.category_id)))
    .forEach(cat => {
      if (appState.currentSection === 'soccer' && cat.isAdult) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cat-btn focusable ${appState.selectedCategoryId === String(cat.category_id) ? 'active' : ''}`;
      const cleanName = formatCleanCategoryName(cat.category_name);
      const countBadge = typeof cat.count === 'number'
        ? `<span class="cat-btn-count">${cat.count}</span>`
        : '';
      btn.innerHTML = `<span class="cat-btn-label">${cleanName}</span> <span style="display:flex;align-items:center;gap:4px;flex-shrink:0;">${cat.isAdult ? '🔒' : ''}${countBadge}</span>`;
      btn.onclick = () => {
        if (cat.isAdult && !appState.preferences.adultUnlockedSession) {
          promptParentalPinUnlock(() => {
            appState.selectedCategoryId = String(cat.category_id);
            appState.visibleLimit = 200;
            renderCatalogCategories();
            renderCatalogItems(true);
          });
          return;
        }
        appState.selectedCategoryId = String(cat.category_id);
        appState.visibleLimit = 200;
        renderCatalogCategories();
        renderCatalogItems(true);
      };
      container.appendChild(btn);
    });
}

function renderCatalogItems(resetScroll = false) {
  const container = document.getElementById('catalogItemsContainer');
  const query = (document.getElementById('catalogSearchInput').value || '').toLowerCase().trim();
  if (resetScroll) {
    container.scrollTop = 0;
  }
  container.innerHTML = '';

  const isPosterMode = appState.currentSection === 'vod' || appState.currentSection === 'series';
  container.classList.toggle('vod-poster-grid-mode', isPosterMode);

  let items = [];
  if (appState.selectedCategoryId === 'FAVORITES') {
    items = getFavoritesList(appState.currentSection);
  } else if (appState.selectedCategoryId === 'RECENT') {
    items = getRecentList(appState.currentSection);
  } else {
    if (appState.currentSection === 'live') {
      const hidden = appState.preferences.hiddenCategories.live || [];
      items = (appState.catalog.liveStreams || []).filter(i => !hidden.includes(String(i.category_id)));
    } else if (appState.currentSection === 'soccer') {
      items = (appState.catalog.liveStreams || []).filter(i => i.isSoccer);
    } else if (appState.currentSection === 'vod') {
      const hidden = appState.preferences.hiddenCategories.vod || [];
      items = (appState.catalog.vodStreams || []).filter(i => !hidden.includes(String(i.category_id)));
    } else if (appState.currentSection === 'series') {
      const hidden = appState.preferences.hiddenCategories.series || [];
      items = (appState.catalog.seriesList || []).filter(i => !hidden.includes(String(i.category_id)));
    }

    if (appState.selectedCategoryId !== 'ALL') {
      items = items.filter(i => String(i.category_id) === String(appState.selectedCategoryId));
    }
  }

  if (query) {
    items = items.filter(i =>
      (i.name || '').toLowerCase().includes(query) ||
      (i.matchInfo || '').toLowerCase().includes(query)
    );
  }

  if (items.length === 0) {
    const emptyMsg = appState.selectedCategoryId === 'FAVORITES'
      ? 'Você ainda não adicionou itens aos ⭐ Favoritos nesta seção. Clique na estrela (☆) em qualquer card para favoritar!'
      : appState.selectedCategoryId === 'RECENT'
      ? 'Nenhum item visto recentemente nesta seção.'
      : 'Nenhum item encontrado nesta categoria.';
    container.innerHTML = `<div style="padding:20px;color:#a1a1aa;font-size:13px;">${emptyMsg}</div>`;
    return;
  }

  const maxVisible = appState.visibleLimit || 200;
  const visibleItems = items.slice(0, maxVisible);

  visibleItems.forEach((item, index) => {
    const itemId = item.stream_id || item.series_id;
    const card = document.createElement('button');
    card.type = 'button';

    const imgUrl = item.logo || item.poster || 'logo-3a-stream.jpg';
    const subText = item.matchInfo || item.epgNow || (item.duration ? `${item.year ? item.year + ' • ' : ''}⭐ ${item.rating || '8.5'} • ${item.duration}` : `Série • ⭐ ${item.rating || '9.0'}`);
    const fav = isItemFavorited(appState.currentSection, item);

    if (isPosterMode) {
      const vodProg = appState.currentSection === 'vod' ? getWatchProgressByKey(getVodProgressKey(item)) : null;
      const vodProgHtml = vodProg
        ? `<div class="ep-watch-progress-bar"><div class="ep-watch-progress-fill" style="width:${vodProg.percent}%;"></div></div>`
        : '';

      card.className = `vod-poster-card focusable ${appState.currentPlayingId === itemId ? 'active' : ''}`;
      card.innerHTML = `
        <div class="vod-poster-thumb">
          <img src="${imgUrl}" alt="${item.name}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
          <span class="card-fav-btn ${fav ? 'is-favorited' : ''}" title="Favoritar">${fav ? '⭐' : '☆'}</span>
          <span class="vod-rating-badge">⭐ ${item.rating || '8.5'}</span>
          ${appState.currentSection === 'vod' ? '<span class="card-dl-btn" title="Baixar MP4">⬇ MP4</span>' : ''}
          <div class="vod-play-overlay"><span>▶</span></div>
          ${vodProgHtml}
        </div>
        <div class="vod-poster-title">${item.name}</div>
      `;

      const favBtnEl = card.querySelector('.card-fav-btn');
      if (favBtnEl) {
        favBtnEl.onclick = (e) => {
          e.stopPropagation();
          const nextState = toggleFavoriteItem(appState.currentSection, item, e);
          favBtnEl.classList.toggle('is-favorited', nextState);
          favBtnEl.textContent = nextState ? '⭐' : '☆';
        };
      }

      const dlBtnEl = card.querySelector('.card-dl-btn');
      if (dlBtnEl) {
        dlBtnEl.onclick = (e) => {
          e.stopPropagation();
          triggerMp4Download(item.streamUrl, item.name, item);
        };
      }
    } else {
      card.className = `channel-card focusable ${appState.currentPlayingId === itemId ? 'active' : ''}`;
      card.innerHTML = `
        <img src="${imgUrl}" alt="${item.name}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
        <div class="channel-card-info">
          <div class="channel-card-title">${item.name}</div>
          <div class="channel-card-sub">${subText}</div>
        </div>
        <span class="channel-fav-btn ${fav ? 'is-favorited' : ''}" title="Favoritar">${fav ? '⭐' : '☆'}</span>
      `;

      const favBtnEl = card.querySelector('.channel-fav-btn');
      if (favBtnEl) {
        favBtnEl.onclick = (e) => {
          e.stopPropagation();
          const nextState = toggleFavoriteItem('live', item, e);
          favBtnEl.classList.toggle('is-favorited', nextState);
          favBtnEl.textContent = nextState ? '⭐' : '☆';
        };
      }
    }

    card.onclick = () => {
      if (item.isAdult && !appState.preferences.adultUnlockedSession) {
        promptParentalPinUnlock(() => playCatalogItem(item));
        return;
      }
      playCatalogItem(item);
    };

    container.appendChild(card);

    if (!isPosterMode && index === 0 && !appState.currentPlayingId && appState.preferences.autoStart && !item.isAdult && !appState.catalog.isRealList) {
      playCatalogItem(item, false);
    }
  });

  if (items.length > maxVisible) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.type = 'button';
    loadMoreBtn.className = 'btn-primary-green focusable';
    loadMoreBtn.style = 'grid-column: 1 / -1; margin:10px 0;padding:10px;font-size:12.5px;';
    loadMoreBtn.textContent = `➕ Mostrar mais (+200) — Exibindo ${maxVisible} de ${items.length}`;
    loadMoreBtn.onclick = () => {
      appState.visibleLimit = (appState.visibleLimit || 200) + 200;
      renderCatalogItems(false);
    };
    container.appendChild(loadMoreBtn);
  }

  // Scroll infinito automático ao chegar perto do final da lista
  container.onscroll = () => {
    if (items.length > (appState.visibleLimit || 200)) {
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 80) {
        appState.visibleLimit = (appState.visibleLimit || 200) + 200;
        renderCatalogItems(false);
      }
    }
  };
}

async function playCatalogItem(item, notify = true) {
  const itemId = item.stream_id || item.series_id;
  const wasAlreadyPlaying = appState.currentPlayingId === itemId;
  appState.currentPlayingId = itemId;

  // 1. Se estiver na seção SÉRIES, registra em Recentemente Visto e abre a Tela de Detalhes Cinematográfica
  if (appState.currentSection === 'series') {
    addRecentItem('series', item);
    await openSeriesDetailScreen(item);
    return;
  }

  // 2. Se estiver na seção FILMES (VOD), registra em Recentemente Visto e abre direto no Player de Cinema 100% Tela Cheia!
  if (appState.currentSection === 'vod') {
    addRecentItem('vod', item);
    startVodOrLiveInCinema(item, 'vod');
    return;
  }

  // 3. Se estiver em TV AO VIVO / FUTEBOL, registra em Recentemente Visto
  addRecentItem('live', item);
  appState.currentLiveItem = item;
  if (wasAlreadyPlaying && notify) {
    startVodOrLiveInCinema(item, 'live');
    return;
  }

  let streamUrl = item.streamUrl;
  let title = item.name;
  let epgNow = item.epgNow || item.description || 'Transmissão Ao Vivo 3A Stream';
  let epgNext = item.epgNext || (item.duration ? `Formato: ${item.duration}` : 'Clique novamente no canal ou em ⛶ Tela Cheia para expandir');

  document.getElementById('nowPlayingTitle').textContent = title;
  document.getElementById('nowPlayingEpgNow').textContent = `🟢 Agora: ${epgNow}`;
  document.getElementById('nowPlayingEpgNext').textContent = `⏭️ Info: ${epgNext}`;

  const idleOverlay = document.getElementById('videoIdlePlaceholder');
  if (idleOverlay) idleOverlay.classList.add('hidden');
  const playerPanel = document.getElementById('catalogPlayerPanel');
  if (playerPanel) playerPanel.classList.add('has-active-stream');

  // Atualiza destaque visual do card ativo sem perder a posição do scroll
  document.querySelectorAll('#catalogItemsContainer .channel-card').forEach(btn => {
    const titleEl = btn.querySelector('.channel-card-title');
    btn.classList.toggle('active', Boolean(titleEl && titleEl.textContent === item.name));
  });

  const video = document.getElementById('iptvVideoPlayer');
  if (!video || !streamUrl) return;

  destroyPlayers();
  startStreamOnVideoElement(video, streamUrl, item);
}

function openCurrentLiveInCinema() {
  if (appState.currentLiveItem) {
    startVodOrLiveInCinema(appState.currentLiveItem, 'live');
  }
}

function startVodOrLiveInCinema(item, mode = 'vod', forceChoice = null) {
  if (mode === 'vod' && !forceChoice) {
    const vodKey = getVodProgressKey(item);
    const savedProg = getWatchProgressByKey(vodKey);
    if (savedProg && savedProg.currentTime >= 5 && savedProg.percent < 98) {
      promptResumeOrRestartPlayback(item.name || 'Filme', savedProg, (decision) => {
        if (decision === 'restart') {
          clearWatchProgressByKey(vodKey);
          startVodOrLiveInCinema(item, mode, 'restart');
        } else {
          startVodOrLiveInCinema(item, mode, 'resume');
        }
      });
      return;
    }
  }

  let resumeTimeSeconds = 0;
  if (mode === 'vod' && forceChoice === 'resume') {
    const savedProg = getWatchProgressByKey(getVodProgressKey(item));
    if (savedProg) resumeTimeSeconds = savedProg.currentTime;
  }

  stopVideoPlayback();
  cinemaReturnScreen = 'screenCatalog';
  currentCinemaContext = { mode, item, episode: null };

  navigateToScreen('screenCinemaPlayer');
  scheduleCinemaTopbarHide();
  syncCinemaFavoriteButton();

  const dlBtn = document.getElementById('btnCinemaDownloadMp4');
  if (dlBtn) dlBtn.classList.toggle('hidden', mode === 'live');

  document.getElementById('cinemaNowTitle').textContent = item.name || 'Reproduzindo no 3A Stream';
  document.getElementById('cinemaNowSub').textContent =
    mode === 'live'
      ? `📺 TV ao Vivo • ${item.epgNow || 'Transmissão em Tempo Real'}`
      : `🍿 Filme VOD • ⭐ ${item.rating || '8.5'} • ${item.duration || 'MP4'}`;

  // Oculta botões exclusivos de episódios de séries quando estiver reproduzindo Filme ou TV ao Vivo
  ['btnPrevEpisode', 'btnNextEpisode', 'btnToggleEpDrawer', 'cinemaEpisodeDrawer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (!cinemaVideo) return;
  cinemaVideo.onended = null;

  destroyPlayers();
  startStreamOnVideoElement(cinemaVideo, item.streamUrl, item, resumeTimeSeconds);
}

// Áudio mantido 100% original em todos os vídeos (sem WebAudio MediaElementSource para nunca mutar streams)
function cycleAudioBoostMode() {}

function extractRawStreamUrl(streamUrl, item = {}) {
  if (item && item.rawStreamUrl && /^https?:\/\//i.test(item.rawStreamUrl)) {
    return item.rawStreamUrl;
  }
  if (streamUrl && streamUrl.includes('url=')) {
    try {
      const qIndex = streamUrl.indexOf('url=');
      const rawParam = streamUrl.substring(qIndex + 4).split('&')[0];
      const decoded = decodeURIComponent(rawParam);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (_) {}
  }
  if (item && item.stream_id && appState.catalog && appState.catalog.xtreamOrigin) {
    const { baseUrl, username, password } = appState.catalog.xtreamOrigin;
    const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (cleanBase && username && password) {
      if (appState.currentSection === 'vod') {
        const ext = (item.duration || 'mp4').toLowerCase();
        return `${cleanBase}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${item.stream_id}.${ext}`;
      }
      const ext = appState.preferences.streamFormat === 'm3u8' ? 'm3u8' : 'ts';
      return `${cleanBase}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${item.stream_id}.${ext}`;
    }
  }
  return streamUrl || '';
}

function buildStreamCandidateUrls(rawStreamUrl, streamUrl, isMovieOrSeriesVod) {
  const candidates = [];
  const addUnique = (u) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  if (IS_NATIVE_APK && /^https?:\/\//i.test(rawStreamUrl)) {
    // No APK Android, 100% dos streams (Live, VOD e Séries) passam pelo Proxy Nativo Local (127.0.0.1:34567) no IP brasileiro do aparelho!
    addUnique(`http://127.0.0.1:34567/proxy?url=${encodeURIComponent(rawStreamUrl)}`);
    addUnique(rawStreamUrl.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/'));
    addUnique(rawStreamUrl);
    return candidates;
  }

  // No navegador Web: se o servidor local do PC (localhost:3000) estiver ativo, usa ele como prioridade máxima (IP brasileiro sem bloqueio 403!)
  if (LOCAL_PC_PROXY_BASE && /^https?:\/\//i.test(rawStreamUrl)) {
    addUnique(`${LOCAL_PC_PROXY_BASE}/api/proxy/stream?url=${encodeURIComponent(rawStreamUrl)}`);
  }

  if (/^https?:\/\//i.test(rawStreamUrl)) {
    // Se estiver hospedado no Render (HTTPS) sem localhost:3000, tenta também localhost:3000 e HTTPS direto (evita 403 do IP americano do Render)
    if (window.location.hostname.includes('onrender.com')) {
      if (isMovieOrSeriesVod) {
        addUnique(rawStreamUrl.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/'));
      }
      addUnique(`http://localhost:3000/api/proxy/stream?url=${encodeURIComponent(rawStreamUrl)}`);
      addUnique(`/api/proxy/stream?url=${encodeURIComponent(rawStreamUrl)}`);
      addUnique(rawStreamUrl.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/'));
      addUnique(rawStreamUrl);
    } else {
      addUnique(`/api/proxy/stream?url=${encodeURIComponent(rawStreamUrl)}`);
      addUnique(rawStreamUrl.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/'));
      addUnique(rawStreamUrl);
    }
  } else {
    addUnique(streamUrl);
  }

  return candidates;
}

function startStreamOnVideoElement(video, streamUrl, item = {}, resumeTimeSeconds = 0) {
  video.removeAttribute('poster');
  video.removeAttribute('crossorigin');
  video.onerror = null;

  if (video.id === 'cinemaVideoElement') {
    video.volume = typeof cinemaSavedVolume === 'number' ? cinemaSavedVolume : 1.0;
    video.muted = video.volume === 0;
    const volSlider = document.getElementById('cinemaVolumeSlider');
    if (volSlider) volSlider.value = video.volume;
    setCinemaBufferingState(true);
  } else {
    video.muted = false;
    video.volume = 1.0;
  }

  let hasAppliedResumeSeek = false;
  const applyResumeSeekIfNeeded = () => {
    if (hasAppliedResumeSeek || !(resumeTimeSeconds > 2)) return;
    try {
      if (video.readyState >= 1) {
        hasAppliedResumeSeek = true;
        video.currentTime = resumeTimeSeconds;
      }
    } catch (_) {}
  };

  if (resumeTimeSeconds > 2) {
    const onceSeekHandler = () => {
      applyResumeSeekIfNeeded();
      if (hasAppliedResumeSeek) {
        video.removeEventListener('loadedmetadata', onceSeekHandler);
        video.removeEventListener('canplay', onceSeekHandler);
      }
    };
    video.addEventListener('loadedmetadata', onceSeekHandler);
    video.addEventListener('canplay', onceSeekHandler);
  }

  const rawStreamUrl = extractRawStreamUrl(streamUrl, item);
  const rawCheck = (rawStreamUrl || streamUrl || '').toLowerCase();
  const isMovieOrSeriesVod = rawCheck.includes('/movie/') || rawCheck.includes('/series/') || rawCheck.endsWith('.mp4') || rawCheck.endsWith('.mkv');
  const isTsStream = !isMovieOrSeriesVod && (
    rawCheck.endsWith('.ts') ||
    (streamUrl && streamUrl.includes('.ts')) ||
    (appState.preferences && appState.preferences.streamFormat === 'ts')
  );
  const isM3u8Stream = !isMovieOrSeriesVod && (
    rawCheck.includes('.m3u8') ||
    (streamUrl && streamUrl.includes('.m3u8')) ||
    (appState.preferences && appState.preferences.streamFormat !== 'ts')
  );

  const candidates = buildStreamCandidateUrls(rawStreamUrl, streamUrl, isMovieOrSeriesVod);
  const primaryUrl = candidates[0] || streamUrl;
  const fallbackUrls = candidates.slice(1);

  if (isTsStream && window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
    startMpegTsPlayback(video, primaryUrl, fallbackUrls, rawStreamUrl);
  } else if (isM3u8Stream && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    hlsInstance.loadSource(primaryUrl);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      applyResumeSeekIfNeeded();
      video.play().catch(() => {});
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        const tsRaw = rawStreamUrl ? rawStreamUrl.replace(/\.m3u8$/i, '.ts') : '';
        const tsCands = tsRaw ? buildStreamCandidateUrls(tsRaw, item.fallbackTsUrl || '', false) : fallbackUrls;
        if (tsCands.length > 0 && window.mpegts) {
          destroyPlayers();
          startMpegTsPlayback(video, tsCands[0], tsCands.slice(1), tsRaw);
        }
      }
    });
  } else {
    let candidateIdx = 0;
    video.onerror = () => {
      candidateIdx++;
      if (candidateIdx < candidates.length) {
        const nextUrl = candidates[candidateIdx];
        video.removeAttribute('crossorigin');
        video.src = nextUrl;
        video.load();
        video.play().catch(() => {});
      } else {
        video.onerror = null;
        if (video.id === 'cinemaVideoElement') {
          setCinemaBufferingState(false);
        }
      }
    };
    video.src = primaryUrl;
    video.play().catch(() => {});
  }

  // Se o usuário já estiver com uma sessão ativa no Chromecast e trocar de canal/episódio/filme, envia automaticamente para a TV!
  if (typeof isGoogleCastConnected === 'function' && isGoogleCastConnected()) {
    setTimeout(() => {
      const ctx = getCurrentCastTargetContext();
      if (ctx) {
        if (resumeTimeSeconds > 2) ctx.currentTime = resumeTimeSeconds;
        startGoogleCastMedia(ctx).catch(() => {});
      }
    }, 150);
  }
}

// ============================================================================
// TELA DE DETALHES DE SÉRIE (IDÊNTICA AO PRINT 2 - IPTV EXPERT) + PLAYER DE CINEMA
// ============================================================================
let activeSeriesItem = null;
let activeSeasonKey = '1';
let activeEpisodeIndex = 0;
let activeDetailTab = 'season_1';

function parseRawXtreamSeriesData(rawData, seriesItem, cleanBase, username, password) {
  if (!rawData || !rawData.episodes) return false;
  const episodesBySeason = rawData.episodes || {};
  const seasons = {};
  Object.keys(episodesBySeason).forEach(seasonNum => {
    seasons[seasonNum] = (episodesBySeason[seasonNum] || []).map(ep => {
      const ext = ep.container_extension || 'mp4';
      const rawUrl = `${cleanBase}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${ep.id}.${ext}`;
      const epInfo = ep.info || {};
      return {
        id: ep.id,
        episode_num: ep.episode_num || 1,
        title: ep.title || `Episódio ${ep.episode_num || 1}`,
        season: String(seasonNum),
        duration: epInfo.duration || ext.toUpperCase(),
        plot: epInfo.plot || epInfo.description || '',
        thumbnail: epInfo.cover_big || (Array.isArray(epInfo.backdrop_path) && epInfo.backdrop_path[0]) || epInfo.movie_image || seriesItem.poster || '',
        rawStreamUrl: rawUrl,
        streamUrl: IS_NATIVE_APK
          ? `http://127.0.0.1:34567/proxy?url=${encodeURIComponent(rawUrl)}`
          : `/api/proxy/stream?url=${encodeURIComponent(rawUrl)}`
      };
    });
  });

  if (Object.keys(seasons).length === 0) return false;

  const info = rawData.info || {};
  const backdropList = Array.isArray(info.backdrop_path) ? info.backdrop_path : [];
  seriesItem.seasons = seasons;
  seriesItem.richInfo = {
    name: info.name || seriesItem.name || '',
    cover: info.cover || seriesItem.poster || '',
    backdrop: (backdropList[0] || info.cover || seriesItem.poster || '').replace('/w500/', '/w1280/'),
    plot: info.plot || '',
    cast: info.cast || info.actors || '',
    genre: info.genre || '',
    releaseDate: info.releaseDate || info.release_date || '',
    rating: info.rating || '8.5'
  };
  return true;
}

function updateSeriesHeroWatchButton() {
  if (!activeSeriesItem || !activeSeriesItem.seasons) return;
  const watchBtn = document.getElementById('btnDetailPrimaryWatch');
  if (!watchBtn) return;

  const seasonKeys = Object.keys(activeSeriesItem.seasons);
  if (seasonKeys.length === 0) {
    watchBtn.textContent = '▶ Sem episódios disponíveis';
    watchBtn.onclick = null;
    return;
  }

  // Verifica se há algum episódio assistido recentemente nesta série para destacar no botão principal
  let targetSeason = activeSeasonKey || seasonKeys[0];
  let targetIdx = activeEpisodeIndex || 0;
  let latestTimestamp = 0;

  seasonKeys.forEach(sk => {
    const eps = activeSeriesItem.seasons[sk] || [];
    eps.forEach((ep, idx) => {
      const prog = getWatchProgressByKey(getEpisodeProgressKey(activeSeriesItem, sk, ep, idx));
      if (prog && prog.updatedAt && prog.updatedAt > latestTimestamp) {
        latestTimestamp = prog.updatedAt;
        targetSeason = sk;
        targetIdx = idx;
      }
    });
  });

  const seasonEps = activeSeriesItem.seasons[targetSeason] || [];
  const ep = seasonEps[targetIdx] || seasonEps[0];
  if (!ep) {
    watchBtn.textContent = '▶ Sem episódios disponíveis';
    watchBtn.onclick = null;
    return;
  }

  const epNum = ep.episode_num || (targetIdx + 1);
  const epCode = `S${String(targetSeason).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
  const cleanEpLabel = ep.title && ep.title.includes(epCode)
    ? ep.title.replace(activeSeriesItem.name, '').trim()
    : `${epCode} - Episodio ${epNum}`;
  const prog = getWatchProgressByKey(getEpisodeProgressKey(activeSeriesItem, targetSeason, ep, targetIdx));

  if (prog && prog.currentTime >= 5) {
    watchBtn.textContent = `▶ Continuar ${cleanEpLabel} (${formatMinutesWatchedLabel(prog.currentTime)})`;
  } else {
    watchBtn.textContent = `▶ Assistir ${cleanEpLabel}`;
  }
  watchBtn.onclick = () => startSeriesEpisodeInCinema(targetSeason, targetIdx);
}

async function openSeriesDetailScreen(seriesItem) {
  stopVideoPlayback();
  activeSeriesItem = seriesItem;

  // Se for uma Série real Xtream e ainda não carregou temporadas/episódios/backdrop, busca com fallback multi-camada
  if (seriesItem.series_id && !seriesItem.seasons && appState.catalog.xtreamOrigin) {
    showToast(`⏳ Carregando detalhes e episódios de ${seriesItem.name}...`);
    const { baseUrl, username, password } = appState.catalog.xtreamOrigin;
    const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
    const httpApiUrl = `${cleanBase}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesItem.series_id)}`;
    const httpsApiUrl = httpApiUrl.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/');

    let loaded = false;

    // 1. Se estiver no APK Android, tenta via Proxy Nativo Local (127.0.0.1:34567)
    if (IS_NATIVE_APK && !loaded) {
      try {
        const res = await fetch(`http://127.0.0.1:34567/proxy?url=${encodeURIComponent(httpApiUrl)}`);
        if (res.ok) {
          const rawData = await res.json();
          loaded = parseRawXtreamSeriesData(rawData, seriesItem, cleanBase, username, password);
        }
      } catch (_) {}
    }

    // 2. Tenta busca direta HTTPS no próprio navegador/aparelho do usuário (IP brasileiro, CORS habilitado no Cloudflare do servidor IPTV!)
    if (!loaded) {
      try {
        const res = await fetch(httpsApiUrl);
        if (res.ok) {
          const rawData = await res.json();
          loaded = parseRawXtreamSeriesData(rawData, seriesItem, cleanBase, username, password);
        }
      } catch (_) {}
    }

    // 3. Fallback via API Backend (/api/player/series-info no localhost:3000 ou Render)
    if (!loaded) {
      try {
        const res = await apiFetch('/api/player/series-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seriesId: seriesItem.series_id,
            ...appState.catalog.xtreamOrigin
          })
        });
        const data = await res.json();
        if (data && data.ok && data.seasons && Object.keys(data.seasons).length > 0) {
          seriesItem.seasons = data.seasons;
          seriesItem.richInfo = data.info || {};
          loaded = true;
        }
      } catch (_) {}
    }

    // 4. Fallback HTTP direto caso esteja em contexto HTTP
    if (!loaded) {
      try {
        const res = await fetch(httpApiUrl);
        if (res.ok) {
          const rawData = await res.json();
          loaded = parseRawXtreamSeriesData(rawData, seriesItem, cleanBase, username, password);
        }
      } catch (e2) {
        console.error('Erro ao carregar série:', e2);
      }
    }
  }

  // Fallback caso seja uma série do catálogo Demo
  if (!seriesItem.seasons) {
    seriesItem.seasons = {
      '1': (seriesItem.episodes || []).map((ep, i) => ({
        id: ep.id || i + 1,
        episode_num: i + 1,
        title: ep.title || `Episódio ${i + 1}`,
        season: '1',
        duration: ep.duration || '45m',
        thumbnail: seriesItem.poster,
        streamUrl: ep.streamUrl
      }))
    };
  }

  const info = seriesItem.richInfo || {};
  const backdrop =
    info.backdrop ||
    seriesItem.poster ||
    'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1200&auto=format&fit=crop&q=80';

  const rating = Number(info.rating || seriesItem.rating || 7.0).toFixed(1);
  const year = info.year || info.release_date || seriesItem.year || '2026';
  const genre = info.genre || 'Série Original';
  const plot =
    info.plot ||
    seriesItem.description ||
    'Assista a todos os episódios completos em alta definição no 3A Stream.';

  const heroEl = document.getElementById('mediaHeroBanner');
  heroEl.style.backgroundImage = `url('${backdrop}')`;

  document.getElementById('detailRatingPill').textContent = `${rating} ★`;
  document.getElementById('detailYearPill').textContent = year;
  document.getElementById('detailGenrePill').textContent = genre;
  document.getElementById('detailTitle').textContent = seriesItem.name;
  document.getElementById('detailPlot').textContent = plot;

  const seasonKeys = Object.keys(seriesItem.seasons);
  activeSeasonKey = seasonKeys.length > 0 ? seasonKeys[0] : '1';
  activeEpisodeIndex = 0;
  activeDetailTab = `season_${activeSeasonKey}`;

  updateSeriesHeroWatchButton();
  syncSeriesDetailFavoriteButton();
  renderMediaDetailTabs();
  navigateToScreen('screenMediaDetail');
  const scrollWrap = document.getElementById('mediaDetailScrollContainer');
  if (scrollWrap) scrollWrap.scrollTop = 0;
}

function renderMediaDetailTabs() {
  if (!activeSeriesItem) return;
  const tabsBar = document.getElementById('detailTabsBar');
  const contentPanel = document.getElementById('detailTabContent');
  tabsBar.innerHTML = '';
  contentPanel.innerHTML = '';

  const seasonKeys = Object.keys(activeSeriesItem.seasons || {});

  // Cria abas na mesma ordem visual do Print 2: Elenco | Recomendações | Temporada 1 | Temporada 2...
  const tabs = [
    { id: 'cast', label: 'Elenco' },
    { id: 'recommendations', label: 'Recomendações' },
    ...seasonKeys.map(sk => ({ id: `season_${sk}`, label: `Temporada ${sk}`, seasonKey: sk }))
  ];

  tabs.forEach(tab => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `media-tab-btn focusable ${activeDetailTab === tab.id ? 'active' : ''}`;
    btn.textContent = tab.label;
    btn.onclick = () => {
      activeDetailTab = tab.id;
      if (tab.seasonKey) activeSeasonKey = tab.seasonKey;
      renderMediaDetailTabs();
    };
    tabsBar.appendChild(btn);
  });

  if (activeDetailTab === 'cast') {
    const castStr = (activeSeriesItem.richInfo && activeSeriesItem.richInfo.cast) || 'Elenco principal não informado pelo servidor.';
    const castMembers = castStr.split(',').map(s => s.trim()).filter(Boolean);
    contentPanel.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:12px;padding-top:8px;">
        ${castMembers.map(actor => `
          <div style="background:#12151e;border:1px solid #252a3a;padding:12px 16px;border-radius:10px;font-size:13px;font-weight:600;">
            🎭 ${actor}
          </div>
        `).join('')}
      </div>
    `;
    return;
  }

  if (activeDetailTab === 'recommendations') {
    const sameCat = (appState.catalog.seriesList || [])
      .filter(s => String(s.category_id) === String(activeSeriesItem.category_id) && s.series_id !== activeSeriesItem.series_id)
      .slice(0, 12);

    contentPanel.innerHTML = `<div class="episodes-grid-row" id="recSeriesGrid"></div>`;
    const grid = document.getElementById('recSeriesGrid');
    sameCat.forEach(rec => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ep-card-16x9 focusable';
      card.innerHTML = `
        <div class="ep-thumb-wrap">
          <img src="${rec.poster || ''}" alt="${rec.name}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
          <div class="ep-play-badge"><div class="ep-play-circle">▶</div></div>
        </div>
        <div class="ep-card-caption">${rec.name}</div>
      `;
      card.onclick = () => {
        addRecentItem('series', rec);
        openSeriesDetailScreen(rec);
      };
      grid.appendChild(card);
    });
    return;
  }

  // Aba de Temporada (Exibe todos os Episódios em Cards 16:9 + Barra de Progresso + Download MP4)
  const episodes = (activeSeriesItem.seasons && activeSeriesItem.seasons[activeSeasonKey]) || [];
  if (episodes.length === 0) {
    contentPanel.innerHTML = `<p style="color:#9ca3af;font-size:13px;">Nenhum episódio encontrado nesta temporada.</p>`;
    return;
  }

  const infoRow = document.createElement('div');
  infoRow.style = 'display:flex;align-items:center;gap:8px;color:#d4d4d8;font-size:12.5px;font-weight:700;margin-bottom:4px;';
  infoRow.innerHTML = `<span>🎬 Temporada ${activeSeasonKey} • ${episodes.length} episódio(s) disponíveis</span>`;
  contentPanel.appendChild(infoRow);

  const grid = document.createElement('div');
  grid.className = 'episodes-grid-row';

  episodes.forEach((ep, idx) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ep-card-16x9 focusable';
    const thumb = ep.thumbnail || activeSeriesItem.poster || 'logo-3a-stream.jpg';
    const progKey = getEpisodeProgressKey(activeSeriesItem, activeSeasonKey, ep, idx);
    const prog = getWatchProgressByKey(progKey);

    const underCardProgressHtml = prog
      ? `
        <div class="ep-watch-status-row">
          <div class="ep-watch-underbar">
            <div class="ep-watch-underbar-fill" style="width:${prog.percent}%;"></div>
          </div>
          <div class="ep-watch-time-label">
            <span>⏱ ${formatMinutesWatchedLabel(prog.currentTime)} assistidos</span>
            <span>${prog.percent}%</span>
          </div>
        </div>
      `
      : '';

    card.innerHTML = `
      <div class="ep-thumb-wrap">
        <img src="${thumb}" alt="${ep.title}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
        <div class="ep-play-badge">
          <div class="ep-play-circle">▶</div>
        </div>
        <div class="ep-corner-badge">▶</div>
        <span class="card-dl-btn" title="Baixar Episódio em MP4">⬇ MP4</span>
      </div>
      <div class="ep-card-caption">${ep.title}</div>
      ${underCardProgressHtml}
    `;

    const dlBtnEl = card.querySelector('.card-dl-btn');
    if (dlBtnEl) {
      dlBtnEl.onclick = (e) => {
        e.stopPropagation();
        const epLabel = `S${String(activeSeasonKey).padStart(2, '0')}E${String(ep.episode_num || idx + 1).padStart(2, '0')}`;
        triggerMp4Download(ep.streamUrl, `${activeSeriesItem.name}_${epLabel}_${ep.title || ''}`, ep);
      };
    }

    card.onclick = () => startSeriesEpisodeInCinema(activeSeasonKey, idx);
    grid.appendChild(card);
  });

  contentPanel.appendChild(grid);
}

function backFromMediaDetail() {
  navigateToScreen('screenCatalog');
}

// ============================================================================
// PLAYER DE CINEMA DEDICADO COM BOTÃO "PULAR EPISÓDIO" E GAVETA LATERAL
// ============================================================================
function startSeriesEpisodeInCinema(seasonKey, epIndex, forceChoice = null) {
  if (!activeSeriesItem || !activeSeriesItem.seasons) return;
  const seasonEps = activeSeriesItem.seasons[seasonKey] || [];
  const ep = seasonEps[epIndex];
  if (!ep) return;

  const progKey = getEpisodeProgressKey(activeSeriesItem, seasonKey, ep, epIndex);
  const savedProg = getWatchProgressByKey(progKey);

  // Se o episódio já possui progresso salvo e o usuário ainda não escolheu Reiniciar ou Retomar, exibe a pergunta com 2 botões!
  if (!forceChoice && savedProg && savedProg.currentTime >= 5 && savedProg.percent < 98) {
    const epTitleLabel = ep.title || `${activeSeriesItem.name} - Episódio ${ep.episode_num || epIndex + 1}`;
    promptResumeOrRestartPlayback(epTitleLabel, savedProg, (decision) => {
      if (decision === 'restart') {
        clearWatchProgressByKey(progKey);
        renderMediaDetailTabs();
        updateSeriesHeroWatchButton();
        startSeriesEpisodeInCinema(seasonKey, epIndex, 'restart');
      } else {
        startSeriesEpisodeInCinema(seasonKey, epIndex, 'resume');
      }
    });
    return;
  }

  let resumeTimeSeconds = 0;
  if (forceChoice === 'resume' && savedProg) {
    resumeTimeSeconds = savedProg.currentTime;
  }

  addRecentItem('series', activeSeriesItem);
  cinemaReturnScreen = 'screenMediaDetail';
  activeSeasonKey = String(seasonKey);
  activeEpisodeIndex = epIndex;
  currentCinemaContext = { mode: 'series', item: activeSeriesItem, episode: ep };

  // Mostra controles de episódios, download e PiP para séries
  ['btnToggleEpDrawer', 'btnCinemaDownloadMp4', 'btnCinemaPip'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  });

  updateSeriesHeroWatchButton();

  navigateToScreen('screenCinemaPlayer');
  scheduleCinemaTopbarHide();
  syncCinemaFavoriteButton();

  document.getElementById('cinemaNowTitle').textContent = ep.title || `${activeSeriesItem.name} - Episódio ${epIndex + 1}`;
  document.getElementById('cinemaNowSub').textContent = `${activeSeriesItem.name} • Temporada ${seasonKey} • Episódio ${ep.episode_num || epIndex + 1} de ${seasonEps.length}`;

  // Atualiza estado dos botões Anterior / Pular Episódio
  const prevBtn = document.getElementById('btnPrevEpisode');
  const nextBtn = document.getElementById('btnNextEpisode');
  if (prevBtn) prevBtn.disabled = epIndex <= 0;
  if (nextBtn) {
    const hasNextInSeason = epIndex + 1 < seasonEps.length;
    const seasonKeys = Object.keys(activeSeriesItem.seasons);
    const nextSeasonIdx = seasonKeys.indexOf(String(seasonKey)) + 1;
    const hasNextSeason = nextSeasonIdx > 0 && nextSeasonIdx < seasonKeys.length;
    nextBtn.disabled = !hasNextInSeason && !hasNextSeason;
  }

  renderCinemaDrawerEpisodes();

  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (!cinemaVideo) return;

  destroyPlayers();
  startStreamOnVideoElement(cinemaVideo, ep.streamUrl, ep, resumeTimeSeconds);

  // Auto-avança para o próximo episódio ao terminar o vídeo!
  cinemaVideo.onended = () => {
    skipSeriesEpisode(1);
  };
}

function skipSeriesEpisode(delta) {
  if (!activeSeriesItem || !activeSeriesItem.seasons) return;
  saveCurrentCinemaWatchProgress();
  const seasonEps = activeSeriesItem.seasons[activeSeasonKey] || [];
  const targetIndex = activeEpisodeIndex + delta;

  if (targetIndex >= 0 && targetIndex < seasonEps.length) {
    startSeriesEpisodeInCinema(activeSeasonKey, targetIndex);
    return;
  }

  // Se clicou em Pular no último episódio da temporada, avança para a próxima temporada se existir
  if (delta > 0) {
    const seasonKeys = Object.keys(activeSeriesItem.seasons);
    const curSeasonIdx = seasonKeys.indexOf(String(activeSeasonKey));
    if (curSeasonIdx !== -1 && curSeasonIdx + 1 < seasonKeys.length) {
      const nextSeasonKey = seasonKeys[curSeasonIdx + 1];
      startSeriesEpisodeInCinema(nextSeasonKey, 0);
      return;
    }
    showToast('✅ Você já está no último episódio disponível desta série.');
  } else {
    showToast('ℹ️ Este é o primeiro episódio da temporada.');
  }
}

function toggleCinemaEpisodeDrawer() {
  const drawer = document.getElementById('cinemaEpisodeDrawer');
  if (!drawer) return;
  drawer.classList.toggle('hidden');
  if (!drawer.classList.contains('hidden')) {
    renderCinemaDrawerEpisodes();
  }
}

function renderCinemaDrawerEpisodes() {
  const listEl = document.getElementById('cinemaDrawerList');
  if (!listEl || !activeSeriesItem || !activeSeriesItem.seasons) return;
  listEl.innerHTML = '';

  const seasonEps = activeSeriesItem.seasons[activeSeasonKey] || [];
  seasonEps.forEach((ep, idx) => {
    const prog = getWatchProgressByKey(getEpisodeProgressKey(activeSeriesItem, activeSeasonKey, ep, idx));
    const progBadge = prog ? ` <span style="color:#4ade80;font-size:11px;font-weight:700;">(${prog.percent}%)</span>` : '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `drawer-ep-item focusable ${idx === activeEpisodeIndex ? 'active' : ''}`;
    btn.innerHTML = `<strong>Ep. ${ep.episode_num || idx + 1}</strong> — ${ep.title}${progBadge}`;
    btn.onclick = () => {
      saveCurrentCinemaWatchProgress();
      startSeriesEpisodeInCinema(activeSeasonKey, idx);
    };
    listEl.appendChild(btn);
  });
}

let isPipModeActive = false;
let pipDragState = {
  isDragging: false,
  startX: 0,
  startY: 0,
  initialLeft: 0,
  initialTop: 0
};

function setupPipDraggable(pipEl) {
  const handle = document.getElementById('cinemaPipTopControls') || pipEl;

  const onPointerDown = (e) => {
    if (e.target.closest('button')) return;
    if (e.button !== undefined && e.button !== 0) return;

    pipDragState.isDragging = true;
    const rect = pipEl.getBoundingClientRect();
    pipDragState.startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    pipDragState.startY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
    pipDragState.initialLeft = rect.left;
    pipDragState.initialTop = rect.top;

    pipEl.style.bottom = 'auto';
    pipEl.style.right = 'auto';
    pipEl.style.left = `${rect.left}px`;
    pipEl.style.top = `${rect.top}px`;

    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('touchend', onPointerUp);
  };

  const onPointerMove = (e) => {
    if (!pipDragState.isDragging) return;
    if (e.cancelable) e.preventDefault();

    const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    const clientY = e.clientY || (e.touches && e.touches[0].clientY) || 0;

    const deltaX = clientX - pipDragState.startX;
    const deltaY = clientY - pipDragState.startY;

    const newLeft = Math.max(8, Math.min(window.innerWidth - pipEl.offsetWidth - 8, pipDragState.initialLeft + deltaX));
    const newTop = Math.max(8, Math.min(window.innerHeight - pipEl.offsetHeight - 8, pipDragState.initialTop + deltaY));

    pipEl.style.left = `${newLeft}px`;
    pipEl.style.top = `${newTop}px`;
  };

  const onPointerUp = () => {
    pipDragState.isDragging = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('touchmove', onPointerMove);
    document.removeEventListener('touchend', onPointerUp);
  };

  handle.onpointerdown = onPointerDown;
  handle.ontouchstart = onPointerDown;
}

function updateNativeVideoPlayingState(isPlaying) {
  if (window.AndroidCastBridge && typeof window.AndroidCastBridge.setVideoPlayingState === 'function') {
    try {
      window.AndroidCastBridge.setVideoPlayingState(Boolean(isPlaying));
    } catch (_) {}
  }
}

window.handleNativePipModeChange = function(isInPip) {
  document.body.classList.toggle('native-pip-active', Boolean(isInPip));
  document.documentElement.classList.toggle('native-pip-active', Boolean(isInPip));
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (isInPip && cinemaVideo && cinemaVideo.paused) {
    cinemaVideo.play().catch(() => {});
  }
};

function triggerNativeOrAppPip(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  if (!cinemaVideo) return;

  // 1. No APK Android, aciona o PiP nativo do Android OS (como YouTube!)
  if (window.AndroidCastBridge && typeof window.AndroidCastBridge.enterNativePip === 'function') {
    try {
      const ok = window.AndroidCastBridge.enterNativePip();
      if (ok) return;
    } catch (_) {}
  }

  // 2. No navegador Web com suporte a Picture-in-Picture nativo
  if (document.pictureInPictureEnabled && cinemaVideo.requestPictureInPicture) {
    try {
      cinemaVideo.requestPictureInPicture().catch(() => {
        enterFloatingPipMode(event);
      });
      return;
    } catch (_) {}
  }

  // 3. Fallback: PiP flutuante na tela
  enterFloatingPipMode(event);
}

function enterFloatingPipMode(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const cinemaWrap = document.getElementById('cinemaPlayerWrap');
  const cinemaScreen = document.getElementById('screenCinemaPlayer');
  if (!cinemaVideo || !cinemaWrap || !cinemaScreen) return;

  isPipModeActive = true;
  clearTimeout(cinemaTopbarTimer);

  const targetScreen = cinemaReturnScreen || 'screenHome';
  navigateToScreen(targetScreen);

  cinemaScreen.classList.add('has-pip-active');
  cinemaWrap.classList.add('pip-mode');

  if (!cinemaWrap.style.left && !cinemaWrap.style.top) {
    cinemaWrap.style.bottom = '24px';
    cinemaWrap.style.right = '24px';
  }

  setupPipDraggable(cinemaWrap);
}

function restoreFromPipToCinema(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaWrap = document.getElementById('cinemaPlayerWrap');
  const cinemaScreen = document.getElementById('screenCinemaPlayer');
  if (!cinemaWrap || !cinemaScreen) return;

  isPipModeActive = false;
  cinemaScreen.classList.remove('has-pip-active');
  cinemaWrap.classList.remove('pip-mode');

  navigateToScreen('screenCinemaPlayer');
  scheduleCinemaTopbarHide();
}

function closeCinemaPlayer(forceStop = false, event = null) {
  if (event && event.stopPropagation) event.stopPropagation();
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const cinemaWrap = document.getElementById('cinemaPlayerWrap');
  const cinemaScreen = document.getElementById('screenCinemaPlayer');

  // Se o usuário clicou em Voltar enquanto o vídeo estava rodando (e não foi clique explícito de parar):
  if (!forceStop && !isPipModeActive && cinemaVideo && !cinemaVideo.paused && cinemaVideo.readyState >= 2) {
    if (window.AndroidCastBridge && typeof window.AndroidCastBridge.enterNativePip === 'function') {
      try {
        const ok = window.AndroidCastBridge.enterNativePip();
        if (ok) return;
      } catch (_) {}
    }
    if (document.pictureInPictureEnabled && cinemaVideo.requestPictureInPicture) {
      try {
        cinemaVideo.requestPictureInPicture().catch(() => {});
        return;
      } catch (_) {}
    }
    enterFloatingPipMode(event);
    return;
  }

  isPipModeActive = false;
  if (cinemaScreen) cinemaScreen.classList.remove('has-pip-active');
  if (cinemaWrap) {
    cinemaWrap.classList.remove('pip-mode');
    cinemaWrap.style.left = '';
    cinemaWrap.style.top = '';
    cinemaWrap.style.right = '';
    cinemaWrap.style.bottom = '';
    cinemaWrap.style.width = '';
    cinemaWrap.style.height = '';
  }

  clearTimeout(cinemaTopbarTimer);
  saveCurrentCinemaWatchProgress();
  setCinemaBufferingState(false);
  destroyPlayers();

  if (cinemaVideo) {
    cinemaVideo.pause();
    cinemaVideo.removeAttribute('src');
    cinemaVideo.removeAttribute('poster');
    cinemaVideo.load();
  }

  const targetScreen = cinemaReturnScreen || 'screenCatalog';
  navigateToScreen(targetScreen);
  if (targetScreen === 'screenMediaDetail') {
    updateSeriesHeroWatchButton();
    renderMediaDetailTabs();
  } else if (targetScreen === 'screenCatalog') {
    renderCatalogItems(false);
  }
}

function toggleWebBrowserFullscreen(event) {
  if (event) event.stopPropagation();
  const doc = document;
  const isFull = Boolean(
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement
  );

  if (!isFull) {
    const el = doc.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else if (el.msRequestFullscreen) {
      el.msRequestFullscreen();
    }
  } else {
    if (doc.exitFullscreen) {
      doc.exitFullscreen().catch(() => {});
    } else if (doc.webkitExitFullscreen) {
      doc.webkitExitFullscreen();
    } else if (doc.msExitFullscreen) {
      doc.msExitFullscreen();
    }
  }
}

function syncFullscreenIcons() {
  const isFull = Boolean(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );

  const topBtn = document.getElementById('btnCinemaFullscreenTop');
  if (topBtn) {
    topBtn.innerHTML = isFull ? '🗗 Sair da Tela Cheia' : '⛶ Tela Cheia';
    topBtn.classList.toggle('active', isFull);
    topBtn.title = isFull ? 'Sair da Tela Cheia (F / Esc)' : 'Tela Cheia do Navegador (F)';
  }

  const iconEnter = document.getElementById('iconCinemaEnterFullscreen');
  const iconExit = document.getElementById('iconCinemaExitFullscreen');
  if (iconEnter && iconExit) {
    iconEnter.classList.toggle('hidden', isFull);
    iconExit.classList.toggle('hidden', !isFull);
  }

  const bottomBtn = document.getElementById('btnCinemaFullscreenBottom');
  if (bottomBtn) {
    bottomBtn.title = isFull ? 'Sair da Tela Cheia (F / Esc)' : 'Tela Cheia (F)';
  }
}

['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
  document.addEventListener(evt, syncFullscreenIcons);
});

function toggleCinemaFullscreen() {
  toggleWebBrowserFullscreen();
}

let mpegtsPlayer = null;

function startMpegTsPlayback(videoElement, tsUrl, fallbackUrls = [], rawStreamUrl = '') {
  try {
    mpegtsPlayer = mpegts.createPlayer({
      type: 'mse',
      isLive: true,
      url: tsUrl
    });
    mpegtsPlayer.attachMediaElement(videoElement);
    mpegtsPlayer.load();
    mpegtsPlayer.play().catch(() => {});

    if (mpegts.Events && mpegts.Events.ERROR) {
      mpegtsPlayer.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
        if (Array.isArray(fallbackUrls) && fallbackUrls.length > 0) {
          const nextUrl = fallbackUrls[0];
          const remaining = fallbackUrls.slice(1);
          destroyPlayers();
          startMpegTsPlayback(videoElement, nextUrl, remaining, rawStreamUrl);
        }
      });
    }
  } catch (err) {
    console.error('Erro mpegts:', err);
  }
}

function destroyPlayers() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  if (mpegtsPlayer) {
    mpegtsPlayer.pause();
    mpegtsPlayer.unload();
    mpegtsPlayer.detachMediaElement();
    mpegtsPlayer.destroy();
    mpegtsPlayer = null;
  }
}

function stopVideoPlayback() {
  updateNativeVideoPlayingState(false);
  saveCurrentCinemaWatchProgress();
  setCinemaBufferingState(false);
  appState.currentPlayingId = null;
  const video = document.getElementById('iptvVideoPlayer');
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  destroyPlayers();
  [video, cinemaVideo].forEach(v => {
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  });
  const idleOverlay = document.getElementById('videoIdlePlaceholder');
  if (idleOverlay) idleOverlay.classList.remove('hidden');
  const playerPanel = document.getElementById('catalogPlayerPanel');
  if (playerPanel) playerPanel.classList.remove('has-active-stream');
}

function toggleVideoFullscreen() {
  const video = document.getElementById('iptvVideoPlayer');
  if (!video) return;
  if (video.requestFullscreen) {
    video.requestFullscreen();
  }
}

// ============================================================================
// AS 17 FUNÇÕES DA TELA DE CONFIGURAÇÕES (PRINT 2)
// ============================================================================
function syncSettingsLabels() {
  document.getElementById('lblStreamFormat').textContent =
    appState.preferences.streamFormat === 'ts' ? 'MPEGTS (.ts)' : 'HLS (.m3u8)';
  document.getElementById('lblTimeFormat').textContent = appState.preferences.timeFormat;
  document.getElementById('lblDeviceType').textContent = appState.preferences.deviceType;
  document.getElementById('lblAutoStart').textContent = appState.preferences.autoStart ? 'ON' : 'OFF';

  const count = appState.preferences.recentMovies.length;
  document.getElementById('recentMoviesLabel').textContent =
    count > 0 ? `${count} filme(s) visto(s) recentemente` : 'Não há filmes vistos recentemente.';
}

function openSettingAction(actionKey) {
  switch (actionKey) {
    case 'add_account':
      openAppModal('Add Conta (Trocar Usuário 3A)', `
        <p style="font-size:13px;color:#a1a1aa;margin-bottom:8px;">
          Conectado atualmente como: <strong>${appState.profile ? appState.profile.name : 'Convidado'}</strong>
        </p>
        <label>Usuário 3A Stream</label>
        <input type="text" id="modalSwitchUser" value="${appState.profile ? appState.profile.username : ''}" placeholder="Digite o usuário" />
        <label>Senha</label>
        <input type="password" id="modalSwitchPass" value="" placeholder="Digite a senha" />
        <div class="dialog-actions">
          <button type="button" class="btn-primary-green" onclick="submitSwitchAccount()">Trocar Conta</button>
        </div>
      `);
      break;

    case 'parental_control':
      openAppModal('🔒 Controle dos Pais (PIN)', `
        <p style="font-size:13px;color:#a1a1aa;margin-bottom:8px;">
          Protege categorias Adulto (+18) com senha de 4 dígitos. (Padrão: 0000)
        </p>
        <label>PIN Atual</label>
        <input type="password" id="modalCurrentPin" maxlength="4" placeholder="0000" />
        <label>Novo PIN (4 dígitos)</label>
        <input type="password" id="modalNewPin" maxlength="4" placeholder="Ex: 1234" />
        <div class="dialog-actions">
          <button type="button" class="btn-primary-green" onclick="saveParentalPin()">Salvar PIN</button>
        </div>
      `);
      break;

    case 'language': {
      const langs = ['pt', 'en', 'es'];
      const next = langs[(langs.indexOf(appState.preferences.language) + 1) % langs.length];
      appState.preferences.language = next;
      localStorage.setItem('3a_lang', next);
      applyTranslations(next);
      showToast(`🈯 Idioma alterado para: ${next.toUpperCase()}`);
      break;
    }

    case 'layout':
      appState.preferences.layoutMode = appState.preferences.layoutMode === 'compact' ? 'grid' : 'compact';
      localStorage.setItem('3a_layout', appState.preferences.layoutMode);
      showToast(`⊞ Layout alterado para: ${appState.preferences.layoutMode.toUpperCase()}`);
      break;

    case 'clear_movie_history':
    case 'clear_recent':
      appState.preferences.recentMovies = [];
      localStorage.setItem('3a_recent_movies', '[]');
      localStorage.setItem('3a_recent_vod', '[]');
      localStorage.setItem('3a_recent_series', '[]');
      localStorage.setItem('3a_recent_live', '[]');
      syncSettingsLabels();
      break;

    case 'stream_format':
      appState.preferences.streamFormat = appState.preferences.streamFormat === 'm3u8' ? 'ts' : 'm3u8';
      localStorage.setItem('3a_stream_format', appState.preferences.streamFormat);
      syncSettingsLabels();
      showToast(`📺 Formato Live alterado para: ${appState.preferences.streamFormat.toUpperCase()}`);
      break;

    case 'external_player':
      openAppModal('▶️ Jogador Externo (Android)', `
        <label>Selecione o reprodutor de vídeo padrão no Android</label>
        <select id="modalExtPlayerSelect">
          <option value="Interno (3A ExoPlayer/HLS)">Player Nativo Interno (3A ExoPlayer / HLS)</option>
          <option value="VLC for Android">VLC Player (Intent Android)</option>
          <option value="MX Player">MX Player (Intent Android)</option>
        </select>
        <div class="dialog-actions">
          <button type="button" class="btn-primary-green" onclick="saveExternalPlayer()">Confirmar</button>
        </div>
      `);
      break;

    case 'auto_start':
      appState.preferences.autoStart = !appState.preferences.autoStart;
      localStorage.setItem('3a_auto_start', String(appState.preferences.autoStart));
      syncSettingsLabels();
      showToast(`🔄 Reprodução automática: ${appState.preferences.autoStart ? 'ATIVADA' : 'DESATIVADA'}`);
      break;

    case 'time_format':
      appState.preferences.timeFormat = appState.preferences.timeFormat === '24h' ? '12h' : '24h';
      localStorage.setItem('3a_time_format', appState.preferences.timeFormat);
      syncSettingsLabels();
      startClockTimer();
      showToast(`🕒 Formato da hora alterado para ${appState.preferences.timeFormat}`);
      break;

    case 'subtitles':
      appState.preferences.subtitlesEnabled = !appState.preferences.subtitlesEnabled;
      document.getElementById('videoSubtitleOverlay').classList.toggle('hidden', !appState.preferences.subtitlesEnabled);
      showToast(`💬 Legendas: ${appState.preferences.subtitlesEnabled ? 'ATIVADAS' : 'DESATIVADAS'}`);
      break;

    case 'device_type':
      appState.preferences.deviceType = appState.preferences.deviceType === 'TV' ? 'Mobile' : 'TV';
      localStorage.setItem('3a_device_type', appState.preferences.deviceType);
      syncSettingsLabels();
      setSimulatorFrame(appState.preferences.deviceType === 'Mobile' ? 'mobile' : 'tvbox');
      showToast(`🖥️ Device Type alterado para: ${appState.preferences.deviceType}`);
      break;
  }
}

function submitSwitchAccount() {
  const u = document.getElementById('modalSwitchUser').value.trim();
  const p = document.getElementById('modalSwitchPass').value.trim();
  closeAppModal();
  document.getElementById('loginUsername').value = u;
  document.getElementById('loginPassword').value = p;
  performLogin(u, p);
}

function saveParentalPin() {
  const cur = document.getElementById('modalCurrentPin').value;
  const nw = document.getElementById('modalNewPin').value;
  const expected = (appState.profile && appState.profile.parentalPin) || '0000';
  if (cur !== expected) {
    showToast('🚫 PIN atual incorreto!');
    return;
  }
  if (!nw || nw.length < 4) {
    showToast('⚠️ O novo PIN deve ter 4 dígitos.');
    return;
  }
  if (appState.profile) appState.profile.parentalPin = nw;
  closeAppModal();
  showToast('✅ PIN do Controle dos Pais atualizado!');
}

function promptParentalPinUnlock(onSuccess) {
  openAppModal('🔒 Conteúdo Protegido (+18)', `
    <p style="font-size:13px;color:#a1a1aa;">Digite o PIN do Controle dos Pais para liberar esta categoria (Padrão: 0000):</p>
    <label>PIN de 4 dígitos</label>
    <input type="password" id="modalUnlockPinInput" maxlength="4" placeholder="0000" />
    <div class="dialog-actions">
      <button type="button" class="btn-primary-green" id="btnConfirmUnlockPin">Liberar Acesso</button>
    </div>
  `);
  setTimeout(() => {
    const btn = document.getElementById('btnConfirmUnlockPin');
    if (btn) {
      btn.onclick = () => {
        const typed = document.getElementById('modalUnlockPinInput').value;
        const expected = (appState.profile && appState.profile.parentalPin) || '0000';
        if (typed === expected) {
          appState.preferences.adultUnlockedSession = true;
          closeAppModal();
          showToast('🔓 Controle dos Pais desbloqueado nesta sessão.');
          onSuccess();
        } else {
          showToast('🚫 PIN incorreto!');
        }
      };
    }
  }, 50);
}

function saveExternalPlayer() {
  const sel = document.getElementById('modalExtPlayerSelect').value;
  appState.preferences.externalPlayer = sel;
  localStorage.setItem('3a_ext_player', sel);
  closeAppModal();
  showToast(`▶️ Player definido: ${sel}`);
}

// Ocultar Categorias (Ao Vivo, VOD, Séries)
function openHideCategoriesModal(type) {
  if (!appState.catalog) {
    showToast('⚠️ Faça login primeiro.');
    return;
  }
  const mapTitle = {
    live: '🙈 Ocultar Categorias ao Vivo',
    vod: '🙈 Ocultar Categorias VOD (Filmes)',
    series: '🙈 Ocultar Categorias Séries'
  };
  const cats =
    type === 'live'
      ? appState.catalog.liveCategories
      : type === 'vod'
      ? appState.catalog.vodCategories
      : appState.catalog.seriesCategories;

  const hiddenIds = appState.preferences.hiddenCategories[type] || [];

  const checkboxesHtml = (cats || [])
    .map(c => {
      const checked = hiddenIds.includes(String(c.category_id)) ? 'checked' : '';
      return `
        <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;">
          <input type="checkbox" class="hide-cat-cb" value="${c.category_id}" ${checked} />
          <span>${formatCleanCategoryName(c.category_name)}</span>
        </label>
      `;
    })
    .join('');

  openAppModal(mapTitle[type], `
    <p style="font-size:12.5px;color:#a1a1aa;margin-bottom:8px;">Marque as categorias que deseja ocultar no aplicativo:</p>
    <div style="max-height:220px;overflow-y:auto;border:1px solid #27272f;padding:10px;border-radius:6px;">
      ${checkboxesHtml}
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn-primary-green" onclick="saveHiddenCategories('${type}')">Salvar Preferências</button>
    </div>
  `);
}

function saveHiddenCategories(type) {
  const selected = Array.from(document.querySelectorAll('.hide-cat-cb:checked')).map(cb => cb.value);
  appState.preferences.hiddenCategories[type] = selected;
  localStorage.setItem(`3a_hide_${type}`, JSON.stringify(selected));
  closeAppModal();
  showToast(`✅ Categorias ocultadas (${selected.length}) salvas com sucesso!`);
}

// Modal de Playlists (Xtream Codes API ou Link M3U)
function openCustomPlaylistModal() {
  const currentSource = appState.profile ? appState.profile.sourceLabel : 'Servidor 3A Stream Oficial';
  openAppModal('📋 Gerenciar Playlists (Xtream API / M3U)', `
    <p style="font-size:12.5px;color:#38bdf8;margin-bottom:10px;">
      💎 Lista Ativa: <strong>${currentSource}</strong>
    </p>
    <label>Modo de Conexão IPTV</label>
    <select id="playlistModeSelect" onchange="togglePlaylistInputs()">
      <option value="xtream">Xtream Codes API (URL DNS + Usuário + Senha)</option>
      <option value="m3u">Link de Lista M3U / M3U8</option>
    </select>

    <div id="xtreamFieldsBox">
      <label>URL do Servidor (DNS:Porta)</label>
      <input type="text" id="customXtreamUrl" placeholder="http://seu-dns.com:8080" />
      <label>Usuário Xtream</label>
      <input type="text" id="customXtreamUser" placeholder="Usuário da lista" />
      <label>Senha Xtream</label>
      <input type="password" id="customXtreamPass" placeholder="Senha da lista" />
    </div>

    <div id="m3uFieldsBox" class="hidden">
      <label>URL da Lista M3U / M3U8</label>
      <input type="text" id="customM3uUrl" placeholder="https://exemplo.com/lista.m3u8" />
    </div>

    <div class="dialog-actions">
      <button type="button" class="btn-primary-green" onclick="loadCustomPlaylistFromModal()">Carregar Lista no Player</button>
    </div>
  `);
}

function togglePlaylistInputs() {
  const mode = document.getElementById('playlistModeSelect').value;
  document.getElementById('xtreamFieldsBox').classList.toggle('hidden', mode !== 'xtream');
  document.getElementById('m3uFieldsBox').classList.toggle('hidden', mode !== 'm3u');
}

async function loadCustomPlaylistFromModal() {
  const mode = document.getElementById('playlistModeSelect').value;
  const xtreamUrl = document.getElementById('customXtreamUrl').value.trim();
  const xtreamUser = document.getElementById('customXtreamUser').value.trim();
  const xtreamPass = document.getElementById('customXtreamPass').value.trim();
  const m3uUrl = document.getElementById('customM3uUrl').value.trim();

  showToast('⏳ Conectando e processando lista IPTV...');
  try {
    const res = await apiFetch('/api/player/custom-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        xtreamUrl,
        xtreamUser,
        xtreamPass,
        m3uUrl,
        preferredFormat: appState.preferences.streamFormat
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showToast('🚫 ' + (data.error || 'Erro ao carregar lista.'));
      return;
    }
    appState.catalog = data.catalog;
    if (!appState.profile) {
      appState.profile = {
        name: xtreamUser || 'Cliente Lista Manual',
        username: xtreamUser || 'manual',
        expiresAtFormatted: '15/06/2026',
        sourceLabel: data.sourceLabel
      };
    } else {
      appState.profile.sourceLabel = data.sourceLabel;
    }
    closeAppModal();
    navigateToScreen('screenHome');
    showToast(`✅ Lista ${data.sourceLabel} carregada!`);
  } catch (err) {
    if (mode === 'xtream' && xtreamUrl && xtreamUser && xtreamPass) {
      try {
        const catalog = await standaloneXtreamFetchCatalog(xtreamUrl, xtreamUser, xtreamPass, appState.preferences.streamFormat);
        appState.catalog = catalog;
        closeAppModal();
        navigateToScreen('screenHome');
        showToast(`✅ Lista Xtream (${xtreamUser}) carregada no modo Mobile!`);
        return;
      } catch (e2) {}
    }
    showToast('🚫 Erro ao buscar lista externa.');
  }
}

// Traduções rápidas (PT / EN / ES)
function applyTranslations(lang) {
  const dict = {
    pt: { live_tv: 'TV ao Vivo', movies: 'Filmes', series: 'Séries', soccer: 'Esportes', settings: 'Configurações', reload: 'recarregar', exit: 'Sair' },
    en: { live_tv: 'Live TV', movies: 'Movies', series: 'Series', soccer: 'Sports', settings: 'Settings', reload: 'Reload', exit: 'Exit' },
    es: { live_tv: 'TV en Vivo', movies: 'Películas', series: 'Series', soccer: 'Deportes', settings: 'Ajustes', reload: 'Recargar', exit: 'Salir' }
  };
  const t = dict[lang] || dict.pt;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (t[k]) el.textContent = t[k];
  });
}

// ============================================================================
// CONTROLE REMOTO D-PAD (NAVEGAÇÃO POR SETAS DE TV BOX)
// ============================================================================
function getActiveScreenFocusableElements() {
  const activeScreen = document.querySelector('.app-screen.active');
  if (!activeScreen) return [];
  return Array.from(activeScreen.querySelectorAll('.focusable')).filter(el => el.offsetParent !== null);
}

function focusFirstElementInActiveScreen() {
  const els = getActiveScreenFocusableElements();
  if (els.length > 0) {
    els.forEach(e => e.classList.remove('dpad-focused'));
    els[0].classList.add('dpad-focused');
    els[0].focus();
  }
}

function moveDpadFocus(direction) {
  const els = getActiveScreenFocusableElements();
  if (els.length === 0) return;

  let currentIndex = els.findIndex(el => el === document.activeElement || el.classList.contains('dpad-focused'));
  if (currentIndex === -1) currentIndex = 0;

  let nextIndex = currentIndex;
  if (direction === 'right' || direction === 'down') {
    nextIndex = (currentIndex + 1) % els.length;
  } else if (direction === 'left' || direction === 'up') {
    nextIndex = (currentIndex - 1 + els.length) % els.length;
  }

  els.forEach(e => e.classList.remove('dpad-focused'));
  const target = els[nextIndex];
  target.classList.add('dpad-focused');
  target.focus();
}

function triggerDpadOk() {
  const active = document.activeElement;
  if (active && active.classList.contains('focusable')) {
    active.click();
  }
}

function triggerDpadBack() {
  const dialog = document.getElementById('appModalDialog');
  if (dialog && dialog.open) {
    dialog.close();
    return;
  }
  if (appState.currentScreen === 'screenCinemaPlayer') {
    closeCinemaPlayer();
    return;
  }
  if (appState.currentScreen === 'screenMediaDetail') {
    backFromMediaDetail();
    return;
  }
  if (appState.currentScreen === 'screenSettings' || appState.currentScreen === 'screenCatalog') {
    stopVideoPlayback();
    navigateToScreen('screenHome');
  }
}

function initKeyboardDpadNavigation() {
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT') {
      if (e.key === 'Escape') triggerDpadBack();
      return;
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveDpadFocus('right');
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveDpadFocus('left');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveDpadFocus('down');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveDpadFocus('up');
    } else if (e.key === 'Backspace' || e.key === 'Escape') {
      e.preventDefault();
      triggerDpadBack();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (typeof toggleWebBrowserFullscreen === 'function') {
        toggleWebBrowserFullscreen();
      }
    }
  });
}

// ============================================================================
// UTILITÁRIOS DE MODAL E TOAST
// ============================================================================
function openAppModal(title, htmlContent) {
  const dialog = document.getElementById('appModalDialog');
  document.getElementById('modalDialogTitle').textContent = title;
  document.getElementById('modalDialogBody').innerHTML = htmlContent;
  dialog.showModal();
}

function closeAppModal() {
  const dialog = document.getElementById('appModalDialog');
  if (dialog && dialog.open) dialog.close();
}

let toastTimer = null;
function showToast(_msg) {
  // Tooltips no canto inferior direito removidas conforme solicitado
  const toast = document.getElementById('appToast');
  if (toast) toast.classList.add('hidden');
}

// ============================================================================
// MOTOR CHROMECAST & SMART TV 3A STREAM (WEB + ANDROID APK NATIVO)
// Suporta:
// 1. Descoberta Automática de TVs e Chromecasts na mesma Rede Wi-Fi (MediaRouter + mDNS _googlecast._tcp + SSDP/UPnP DLNA)
// 2. Conexão Direta ao Chromecast / Google TV via Google Cast SDK Nativo (Android) e CAF SDK (Web)
// 3. Conexão Direta a Smart TVs (Samsung, LG, TCL, Roku, Philips, Sony) via UPnP/DLNA AVTransport
// ============================================================================
const castEngineState = {
  sdkReady: false,
  isConnected: false,
  nativeConnected: false,
  deviceName: 'Chromecast / Smart TV',
  remotePlayer: null,
  remoteController: null,
  activeMediaInfo: null,
  lastResolvedInfo: null,
  discoveryPollTimer: null,
  discoveredDevices: []
};

window.__onGCastApiAvailable = function (isAvailable) {
  if (isAvailable && window.cast && window.cast.framework) {
    initGoogleCastFramework();
  }
};

// Callback disparado pelo MainActivity.java quando o Cast Nativo do Android ou DLNA conecta/desconecta
window.onAndroidNativeCastStateChanged = function (connected, deviceName) {
  castEngineState.nativeConnected = Boolean(connected);
  castEngineState.isConnected = Boolean(connected) || isWebGoogleCastConnected();
  if (deviceName) {
    castEngineState.deviceName = deviceName;
  }
  if (connected) {
    [document.getElementById('cinemaVideoElement'), document.getElementById('iptvVideoPlayer')].forEach((v) => {
      if (v && !v.paused) v.pause();
    });
  }
  syncAllCastButtonsUI();
};

function initGoogleCastFramework() {
  if (castEngineState.sdkReady) return;
  try {
    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });

    const remotePlayer = new cast.framework.RemotePlayer();
    const remoteController = new cast.framework.RemotePlayerController(remotePlayer);
    castEngineState.remotePlayer = remotePlayer;
    castEngineState.remoteController = remoteController;
    castEngineState.sdkReady = true;

    context.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (event) => {
        const state = event.sessionState;
        if (
          state === cast.framework.SessionState.SESSION_STARTED ||
          state === cast.framework.SessionState.SESSION_RESUMED
        ) {
          const session = context.getCurrentSession();
          castEngineState.isConnected = true;
          castEngineState.deviceName =
            (session && session.getCastDevice && session.getCastDevice().friendlyName) ||
            'Chromecast';
          syncAllCastButtonsUI();
        } else if (state === cast.framework.SessionState.SESSION_ENDED) {
          castEngineState.isConnected = Boolean(castEngineState.nativeConnected);
          syncAllCastButtonsUI();
        }
      }
    );

    if (remoteController && cast.framework.RemotePlayerEventType) {
      remoteController.addEventListener(
        cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
        () => {
          castEngineState.isConnected = Boolean(remotePlayer.isConnected) || Boolean(castEngineState.nativeConnected);
          syncAllCastButtonsUI();
        }
      );
    }
  } catch (err) {
    console.warn('Aviso ao inicializar Google Cast SDK:', err);
  }
}

if (window.cast && window.cast.framework && !castEngineState.sdkReady) {
  initGoogleCastFramework();
}

function isWebGoogleCastConnected() {
  try {
    if (castEngineState.sdkReady && window.cast && window.cast.framework) {
      const session = cast.framework.CastContext.getInstance().getCurrentSession();
      return Boolean(session);
    }
  } catch (_) {}
  return false;
}

function isGoogleCastConnected() {
  return Boolean(castEngineState.nativeConnected) || isWebGoogleCastConnected();
}

function syncAllCastButtonsUI() {
  const connected = isGoogleCastConnected();
  castEngineState.isConnected = connected;

  const ids = ['btnCinemaCast', 'btnCinemaBottomCast', 'btnCatalogCast', 'btnDetailCastEpisode'];
  ids.forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.classList.toggle('is-casting', connected);
    }
  });

  const lblCinema = document.getElementById('lblCinemaCastBtn');
  if (lblCinema) {
    lblCinema.textContent = connected ? `Na TV (${castEngineState.deviceName})` : 'Chromecast';
  }
}

function getCurrentCastTargetContext() {
  // 1. Se estiver no Cinema Player
  if (appState.currentScreen === 'screenCinemaPlayer' && currentCinemaContext) {
    const cinemaVideo = document.getElementById('cinemaVideoElement');
    const currentTime = cinemaVideo && Number.isFinite(cinemaVideo.currentTime) ? Math.floor(cinemaVideo.currentTime) : 0;
    const { mode, item, episode } = currentCinemaContext;
    if (mode === 'series' && episode) {
      const epNum = episode.episode_num || activeEpisodeIndex + 1;
      return {
        mode: 'series',
        title: `${item ? item.name : 'Série'} — T${activeSeasonKey}:E${epNum}`,
        subtitle: episode.title || `Episódio ${epNum}`,
        poster: (episode && episode.thumbnail) || (item && item.poster) || '',
        streamUrl: episode.streamUrl || (cinemaVideo ? cinemaVideo.currentSrc || cinemaVideo.src : ''),
        item: episode,
        currentTime,
        videoElement: cinemaVideo
      };
    }
    if (item) {
      return {
        mode: mode || 'vod',
        title: item.name || '3A Stream',
        subtitle: mode === 'live' ? (item.epgNow || 'TV ao Vivo') : 'Filme em Alta Definição',
        poster: item.poster || item.logo || '',
        streamUrl: item.streamUrl || (cinemaVideo ? cinemaVideo.currentSrc || cinemaVideo.src : ''),
        item,
        currentTime: mode === 'live' ? 0 : currentTime,
        videoElement: cinemaVideo
      };
    }
  }

  // 2. Se estiver na tela de Detalhes da Série
  if (appState.currentScreen === 'screenMediaDetail' && activeSeriesItem && activeSeriesItem.seasons) {
    const seasonEps = activeSeriesItem.seasons[activeSeasonKey] || [];
    const ep = seasonEps[activeEpisodeIndex] || seasonEps[0];
    if (ep) {
      const progKey = getEpisodeProgressKey(activeSeriesItem, activeSeasonKey, ep, activeEpisodeIndex);
      const savedProg = getWatchProgressByKey(progKey);
      return {
        mode: 'series',
        title: `${activeSeriesItem.name} — T${activeSeasonKey}:E${ep.episode_num || activeEpisodeIndex + 1}`,
        subtitle: ep.title || 'Episódio da Série',
        poster: ep.thumbnail || activeSeriesItem.poster || '',
        streamUrl: ep.streamUrl,
        item: ep,
        currentTime: savedProg && savedProg.currentTime > 5 ? Math.floor(savedProg.currentTime) : 0,
        videoElement: document.getElementById('cinemaVideoElement')
      };
    }
  }

  // 3. Se estiver no Catálogo de TV ao Vivo
  const liveItem = appState.currentLiveItem;
  const liveVideo = document.getElementById('iptvVideoPlayer');
  if (liveItem) {
    return {
      mode: 'live',
      title: liveItem.name || 'Canal Ao Vivo',
      subtitle: liveItem.epgNow || 'Transmissão Ao Vivo 3A Stream',
      poster: liveItem.logo || liveItem.poster || '',
      streamUrl: liveItem.streamUrl || (liveVideo ? liveVideo.currentSrc || liveVideo.src : ''),
      item: liveItem,
      currentTime: 0,
      videoElement: liveVideo
    };
  }

  return null;
}

async function resolveCastableStreamInfo(targetCtx) {
  if (!targetCtx) return null;
  let rawUrl = extractRawStreamUrl(targetCtx.streamUrl, targetCtx.item);
  if (!rawUrl) rawUrl = targetCtx.streamUrl || '';

  const isLive = targetCtx.mode === 'live';
  let castRawUrl = rawUrl;
  if (isLive && /\.ts(\?|$)/i.test(castRawUrl)) {
    castRawUrl = castRawUrl.replace(/\.ts(\?|$)/i, '.m3u8$1');
  }

  const contentType = isLive || /\.m3u8(\?|$)/i.test(castRawUrl) ? 'application/x-mpegurl' : 'video/mp4';
  const httpsDirectUrl = castRawUrl.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/');

  let lanProxyUrl = '';
  let resolvedCdnUrl = '';

  if (window.AndroidCastBridge) {
    try {
      const lanBase = window.AndroidCastBridge.getLanProxyBaseUrl();
      if (lanBase && /^http:\/\/\d+\.\d+\.\d+\.\d+/i.test(lanBase)) {
        lanProxyUrl = `${lanBase}/proxy?url=${encodeURIComponent(castRawUrl)}`;
      }
      let cached = window.AndroidCastBridge.getCachedRedirectUrl(castRawUrl);
      if ((!cached || cached === castRawUrl) && !isLive) {
        try {
          await fetch(`http://127.0.0.1:34567/proxy?url=${encodeURIComponent(castRawUrl)}`, {
            method: 'GET',
            headers: { Range: 'bytes=0-1' }
          });
          cached = window.AndroidCastBridge.getCachedRedirectUrl(castRawUrl);
        } catch (_) {}
      }
      if (cached && /^https?:\/\//i.test(cached)) {
        resolvedCdnUrl = cached;
      }
    } catch (_) {}
  }

  if (!resolvedCdnUrl && !IS_NATIVE_APK) {
    try {
      const endpoint = LOCAL_PC_PROXY_BASE
        ? `${LOCAL_PC_PROXY_BASE}/api/proxy/resolve-cast-url?url=${encodeURIComponent(castRawUrl)}`
        : `/api/proxy/resolve-cast-url?url=${encodeURIComponent(castRawUrl)}`;
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          if (data.resolvedUrl) resolvedCdnUrl = data.resolvedUrl;
          if (data.lanProxyUrl && !window.location.hostname.includes('onrender.com')) {
            lanProxyUrl = data.lanProxyUrl;
          }
        }
      }
    } catch (_) {}
  }

  const candidateUrls = [];
  const pushUnique = (u) => {
    if (u && /^https?:\/\//i.test(u) && !candidateUrls.includes(u)) {
      candidateUrls.push(u);
    }
  };

  if (lanProxyUrl) pushUnique(lanProxyUrl);
  if (resolvedCdnUrl) pushUnique(resolvedCdnUrl);
  pushUnique(httpsDirectUrl);
  pushUnique(castRawUrl);

  const info = {
    primaryUrl: candidateUrls[0] || httpsDirectUrl || castRawUrl,
    fallbackUrls: candidateUrls.slice(1),
    externalAppUrl: resolvedCdnUrl || lanProxyUrl || httpsDirectUrl || castRawUrl,
    lanProxyUrl,
    resolvedCdnUrl,
    httpsDirectUrl,
    rawUrl: castRawUrl,
    contentType,
    isLive
  };
  castEngineState.lastResolvedInfo = info;
  return info;
}

async function startGoogleCastMedia(targetCtx, urlOverride = null) {
  if (!targetCtx) return false;

  // 1. No APK Android Nativo: abre o seletor nativo MediaRouteChooserDialog do Google Cast (que lista as TVs da rede Wi-Fi!)
  if (window.AndroidCastBridge && typeof window.AndroidCastBridge.openNativeCastChooserDialog === 'function') {
    if (targetCtx.videoElement && !targetCtx.videoElement.paused) {
      targetCtx.videoElement.pause();
    }
    const streamInfo = await resolveCastableStreamInfo(targetCtx);
    const castUrl = urlOverride || streamInfo.primaryUrl || streamInfo.externalAppUrl;
    window.AndroidCastBridge.openNativeCastChooserDialog(
      castUrl,
      targetCtx.title || '3A Stream',
      targetCtx.subtitle || 'Transmitindo pelo 3A Stream',
      targetCtx.poster || '',
      streamInfo.contentType,
      Math.floor(targetCtx.currentTime || 0)
    );
    return true;
  }

  // 2. No navegador Chrome / Edge Desktop com Google Cast SDK
  if (window.cast && window.cast.framework && window.chrome && window.chrome.cast) {
    try {
      if (!castEngineState.sdkReady) initGoogleCastFramework();
      const context = cast.framework.CastContext.getInstance();
      let session = context.getCurrentSession();
      if (!session) {
        await context.requestSession();
        session = context.getCurrentSession();
      }
      if (!session) return false;

      const streamInfo = await resolveCastableStreamInfo(targetCtx);
      const urlsToTry = urlOverride
        ? [urlOverride]
        : [streamInfo.primaryUrl, ...(streamInfo.fallbackUrls || [])].filter(Boolean);

      for (let i = 0; i < urlsToTry.length; i++) {
        const mediaUrl = urlsToTry[i];
        try {
          const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, streamInfo.contentType);
          mediaInfo.streamType = streamInfo.isLive
            ? chrome.cast.media.StreamType.LIVE
            : chrome.cast.media.StreamType.BUFFERED;

          const metadata = new chrome.cast.media.GenericMediaMetadata();
          metadata.metadataType = chrome.cast.media.MetadataType.GENERIC;
          metadata.title = targetCtx.title || '3A Stream';
          metadata.subtitle = targetCtx.subtitle || 'Transmitindo pelo 3A Stream';
          if (targetCtx.poster && /^https?:\/\//i.test(targetCtx.poster)) {
            metadata.images = [new chrome.cast.Image(targetCtx.poster)];
          }
          mediaInfo.metadata = metadata;

          const request = new chrome.cast.media.LoadRequest(mediaInfo);
          request.autoplay = true;
          if (!streamInfo.isLive && targetCtx.currentTime > 3) {
            request.currentTime = targetCtx.currentTime;
          }

          await session.loadMedia(request);

          if (targetCtx.videoElement && !targetCtx.videoElement.paused) {
            targetCtx.videoElement.pause();
          }

          castEngineState.isConnected = true;
          castEngineState.deviceName =
            (session.getCastDevice && session.getCastDevice().friendlyName) || 'Chromecast';
          syncAllCastButtonsUI();
          return true;
        } catch (loadErr) {
          console.warn(`Tentativa Cast URL [${i + 1}/${urlsToTry.length}] falhou:`, mediaUrl, loadErr);
        }
      }
    } catch (err) {
      console.warn('Sessão Google Cast não iniciada ou cancelada:', err);
    }
  }

  // 3. Fallback HTML5 RemotePlayback API (Navegadores Mobile / AirPlay)
  const videoEl = targetCtx.videoElement || document.getElementById('cinemaVideoElement') || document.getElementById('iptvVideoPlayer');
  if (videoEl) {
    if (videoEl.remote && typeof videoEl.remote.prompt === 'function') {
      try {
        await videoEl.remote.prompt();
        return true;
      } catch (_) {}
    }
    if (typeof videoEl.webkitShowPlaybackTargetPicker === 'function') {
      try {
        videoEl.webkitShowPlaybackTargetPicker();
        return true;
      } catch (_) {}
    }
  }

  return false;
}

function triggerChromecastAction(event) {
  if (event) event.stopPropagation();
  const ctx = getCurrentCastTargetContext();
  openCastControlModal(ctx);
}

function triggerCatalogLiveChromecast(event) {
  if (event) event.stopPropagation();
  if (!appState.currentLiveItem && appState.catalog && appState.catalog.liveStreams && appState.catalog.liveStreams.length > 0) {
    playStreamItem(appState.catalog.liveStreams[0], false);
  }
  const ctx = getCurrentCastTargetContext();
  openCastControlModal(ctx);
}

function castActiveSeriesEpisode(event) {
  if (event) event.stopPropagation();
  const ctx = getCurrentCastTargetContext();
  openCastControlModal(ctx);
}

function stopCastDiscoveryPolling() {
  if (castEngineState.discoveryPollTimer) {
    clearInterval(castEngineState.discoveryPollTimer);
    castEngineState.discoveryPollTimer = null;
  }
}

async function refreshWifiTvDevicesListUI() {
  const container = document.getElementById('castWifiTvsListContainer');
  if (!container) {
    stopCastDiscoveryPolling();
    return;
  }

  let devices = [];
  if (window.AndroidCastBridge && typeof window.AndroidCastBridge.getDiscoveredTvsJson === 'function') {
    try {
      const rawJson = window.AndroidCastBridge.getDiscoveredTvsJson();
      devices = JSON.parse(rawJson || '[]');
    } catch (_) {}
  } else {
    try {
      const endpoint = LOCAL_PC_PROXY_BASE
        ? `${LOCAL_PC_PROXY_BASE}/api/cast/discover-tvs`
        : '/api/cast/discover-tvs';
      const res = await fetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.devices)) {
          devices = data.devices;
        }
      }
    } catch (_) {}
  }

  castEngineState.discoveredDevices = devices;

  if (!devices || devices.length === 0) {
    container.innerHTML = `
      <div style="padding:12px;border-radius:9px;background:rgba(15,23,42,0.65);border:1px dashed rgba(56,189,248,0.3);color:#94a3b8;font-size:12px;text-align:center;">
        🔍 Procurando TVs e Chromecasts na sua rede Wi-Fi...<br/>
        <span style="font-size:11px;color:#64748b;">Certifique-se de que a TV / Chromecast está ligada no mesmo Wi-Fi.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = devices
    .map((dev, idx) => {
      const badgeLabel = dev.type === 'dlna' ? 'Smart TV Wi-Fi' : 'Chromecast / Google TV';
      const ipText = dev.ip ? ` • ${dev.ip}` : '';
      return `
        <button type="button" class="cast-option-btn" style="border-color:rgba(16,185,129,0.5);background:linear-gradient(135deg,rgba(5,150,105,0.18),rgba(14,165,233,0.18));" onclick="connectToDiscoveredWifiTv(${idx})">
          <div class="cast-option-left">
            <div class="cast-option-icon" style="background:linear-gradient(135deg,#059669,#0284c7);">📺</div>
            <div>
              <div class="cast-option-title">${dev.name || 'Smart TV'}</div>
              <div class="cast-option-desc" style="color:#6ee7b7;">${badgeLabel}${dev.model ? ` (${dev.model})` : ''}${ipText}</div>
            </div>
          </div>
          <span style="background:#059669;color:#fff;padding:5px 10px;border-radius:7px;font-weight:800;font-size:11.5px;white-space:nowrap;">Conectar</span>
        </button>
      `;
    })
    .join('');
}

async function connectToDiscoveredWifiTv(deviceIndex) {
  const dev = castEngineState.discoveredDevices[deviceIndex];
  const targetCtx = castEngineState.activeMediaInfo || getCurrentCastTargetContext();
  if (!dev || !targetCtx) return;

  const container = document.getElementById('castWifiTvsListContainer');
  if (container) {
    container.innerHTML = `
      <div style="padding:14px;border-radius:9px;background:rgba(5,150,105,0.2);border:1px solid rgba(16,185,129,0.5);color:#ecfdf5;font-size:13px;font-weight:700;text-align:center;">
        ⏳ Conectando e enviando vídeo para <strong>${dev.name}</strong>...
      </div>
    `;
  }

  // Pausa imediatamente o vídeo local para liberar a conexão única do servidor IPTV para a TV!
  if (targetCtx.videoElement && !targetCtx.videoElement.paused) {
    targetCtx.videoElement.pause();
  }

  const streamInfo = await resolveCastableStreamInfo(targetCtx);
  const castUrl = streamInfo.primaryUrl || streamInfo.externalAppUrl;

  if (window.AndroidCastBridge && typeof window.AndroidCastBridge.connectAndCastToTv === 'function') {
    window.AndroidCastBridge.connectAndCastToTv(
      dev.id,
      castUrl,
      targetCtx.title || '3A Stream',
      targetCtx.subtitle || 'Transmitindo pelo 3A Stream',
      targetCtx.poster || '',
      streamInfo.contentType,
      Math.floor(targetCtx.currentTime || 0)
    );
    setTimeout(() => {
      stopCastDiscoveryPolling();
      closeAppModal();
    }, 900);
    return;
  }

  // No Navegador Web / PC: se for Smart TV DLNA, envia via /api/cast/play-dlna
  if (dev.type === 'dlna') {
    try {
      const endpoint = LOCAL_PC_PROXY_BASE
        ? `${LOCAL_PC_PROXY_BASE}/api/cast/play-dlna`
        : '/api/cast/play-dlna';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: dev.id,
          streamUrl: castUrl,
          title: targetCtx.title || '3A Stream',
          mimeType: streamInfo.contentType
        })
      });
      const data = await res.json();
      if (data && data.ok) {
        castEngineState.nativeConnected = true;
        castEngineState.deviceName = dev.name;
        syncAllCastButtonsUI();
        stopCastDiscoveryPolling();
        closeAppModal();
        return;
      }
    } catch (_) {}
  }

  // Fallback para Google Cast SDK no navegador
  await startGoogleCastMedia(targetCtx, castUrl);
  stopCastDiscoveryPolling();
  closeAppModal();
}

function rescanWifiTvsNow() {
  if (window.AndroidCastBridge && typeof window.AndroidCastBridge.startTvDiscovery === 'function') {
    window.AndroidCastBridge.startTvDiscovery();
  }
  refreshWifiTvDevicesListUI();
}

async function openCastControlModal(targetCtx) {
  stopCastDiscoveryPolling();

  if (!targetCtx) {
    openAppModal('📺 Transmitir para Chromecast / Smart TV', `
      <p style="font-size:13px;color:#cbd5e1;line-height:1.5;">
        Selecione primeiro um <strong>Canal ao Vivo</strong>, <strong>Filme</strong> ou <strong>Episódio de Série</strong> para iniciar a transmissão para a sua TV.
      </p>
      ${window.AndroidCastBridge ? `
        <div class="dialog-actions" style="margin-top:14px;">
          <button type="button" class="btn-primary-green" onclick="window.AndroidCastBridge.openSystemCastSettings(); closeAppModal();">
            📡 Abrir Espelhamento Sem Fio do Android
          </button>
        </div>
      ` : ''}
    `);
    return;
  }

  castEngineState.activeMediaInfo = targetCtx;
  const connected = isGoogleCastConnected();
  const hasNativeBridge = Boolean(window.AndroidCastBridge);

  if (hasNativeBridge && typeof window.AndroidCastBridge.startTvDiscovery === 'function') {
    window.AndroidCastBridge.startTvDiscovery();
  }

  openAppModal('📺 Conectar ao Chromecast / Smart TV', `
    <div class="cast-modal-box">
      <div class="cast-media-banner">
        <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#0284c7,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0;">
          📺
        </div>
        <div class="cast-media-banner-info">
          <div class="cast-media-banner-title">${targetCtx.title || '3A Stream'}</div>
          <div class="cast-media-banner-sub">
            ${connected ? `🟢 Conectado a: ${castEngineState.deviceName}` : `📡 Escolha sua TV abaixo (${targetCtx.mode === 'live' ? 'Ao Vivo HLS' : 'Vídeo MP4 HD'})`}
          </div>
        </div>
      </div>

      ${connected ? `
        <div class="cast-remote-controls">
          <button type="button" class="cinema-ctrl-btn" onclick="controlActiveCastSession('rewind10')">⏪ -10s</button>
          <button type="button" class="cinema-ctrl-btn" onclick="controlActiveCastSession('togglePlay')">⏯ Play / Pause</button>
          <button type="button" class="cinema-ctrl-btn" onclick="controlActiveCastSession('forward10')">⏩ +10s</button>
          <button type="button" class="cinema-ctrl-btn" style="background:rgba(239,68,68,0.25);border-color:rgba(248,113,113,0.5);color:#fecaca;" onclick="controlActiveCastSession('disconnect')">⏹ Desconectar</button>
        </div>
      ` : ''}

      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:2px;">
        <span style="font-size:12px;font-weight:800;color:#38bdf8;text-transform:uppercase;letter-spacing:0.5px;">
          📡 TVs e Chromecasts na Mesma Rede Wi-Fi
        </span>
        <button type="button" onclick="rescanWifiTvsNow()" style="background:rgba(14,165,233,0.18);border:1px solid rgba(56,189,248,0.4);color:#e0f2fe;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;">
          🔄 Buscar TVs
        </button>
      </div>

      <div id="castWifiTvsListContainer" class="cast-options-grid">
        <div style="padding:12px;border-radius:9px;background:rgba(15,23,42,0.65);border:1px dashed rgba(56,189,248,0.3);color:#94a3b8;font-size:12px;text-align:center;">
          🔍 Buscando TVs e Chromecasts na sua rede Wi-Fi...
        </div>
      </div>

      <div class="cast-options-grid" style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.08);padding-top:10px;">
        <button type="button" class="cast-option-btn" id="btnModalStartGoogleCast" onclick="handleModalCastOption('google_cast')">
          <div class="cast-option-left">
            <div class="cast-option-icon">📺</div>
            <div>
              <div class="cast-option-title">${connected ? 'Reenviar Vídeo para a TV Conectada' : 'Abrir Seletor Google Cast do Sistema'}</div>
              <div class="cast-option-desc">Abre a janela nativa do Google Cast para selecionar o Chromecast</div>
            </div>
          </div>
          <span style="color:#38bdf8;font-weight:800;font-size:13px;">▶</span>
        </button>

        ${hasNativeBridge ? `
          <button type="button" class="cast-option-btn" onclick="handleModalCastOption('system_cast_settings')">
            <div class="cast-option-left">
              <div class="cast-option-icon">📡</div>
              <div>
                <div class="cast-option-title">Transmitir Tela / Smart View do Android</div>
                <div class="cast-option-desc">Lista todas as TVs Sem Fio / Miracast / Chromecast nas configurações do Android</div>
              </div>
            </div>
            <span style="color:#38bdf8;font-weight:800;font-size:13px;">⚙️</span>
          </button>
        ` : ''}

        <button type="button" class="cast-option-btn" onclick="handleModalCastOption('external_cast_app')">
          <div class="cast-option-left">
            <div class="cast-option-icon">📲</div>
            <div>
              <div class="cast-option-title">Transmitir via App Externo (VLC / Web Video Cast)</div>
              <div class="cast-option-desc">Abre o vídeo em outro aplicativo instalado no aparelho</div>
            </div>
          </div>
          <span style="color:#38bdf8;font-weight:800;font-size:13px;">↗</span>
        </button>

        <button type="button" class="cast-option-btn" id="btnModalCopyCastUrl" onclick="handleModalCastOption('copy_url')">
          <div class="cast-option-left">
            <div class="cast-option-icon">🔗</div>
            <div>
              <div class="cast-option-title" id="lblModalCopyCastTitle">Copiar Link Direto do Stream (Rede Wi-Fi)</div>
              <div class="cast-option-desc" id="lblModalCopyCastDesc">Gera o link desbloqueado na sua rede Wi-Fi</div>
            </div>
          </div>
          <span style="color:#38bdf8;font-weight:800;font-size:13px;">📋</span>
        </button>
      </div>
    </div>
  `);

  refreshWifiTvDevicesListUI();
  castEngineState.discoveryPollTimer = setInterval(refreshWifiTvDevicesListUI, 1000);
}

async function handleModalCastOption(option) {
  const targetCtx = castEngineState.activeMediaInfo || getCurrentCastTargetContext();
  if (!targetCtx && option !== 'system_cast_settings') return;

  if (option === 'google_cast') {
    const btn = document.getElementById('btnModalStartGoogleCast');
    if (btn) {
      const titleEl = btn.querySelector('.cast-option-title');
      if (titleEl) titleEl.textContent = '⏳ Abrindo seletor Google Cast...';
    }
    const ok = await startGoogleCastMedia(targetCtx);
    if (ok) {
      stopCastDiscoveryPolling();
      closeAppModal();
    } else if (btn) {
      const titleEl = btn.querySelector('.cast-option-title');
      if (titleEl) titleEl.textContent = 'Abrir Seletor Google Cast do Sistema';
    }
    return;
  }

  if (option === 'external_cast_app') {
    const streamInfo = await resolveCastableStreamInfo(targetCtx);
    const targetUrl = streamInfo.externalAppUrl || streamInfo.primaryUrl;
    if (window.AndroidCastBridge) {
      stopCastDiscoveryPolling();
      closeAppModal();
      window.AndroidCastBridge.launchExternalCastIntent(
        targetUrl,
        targetCtx.title || '3A Stream',
        streamInfo.contentType
      );
      return;
    }
    if (/Android/i.test(navigator.userAgent || '')) {
      const cleanNoProto = targetUrl.replace(/^https?:\/\//i, '');
      const scheme = /^https:\/\//i.test(targetUrl) ? 'https' : 'http';
      const intentUrl = `intent://${cleanNoProto}#Intent;scheme=${scheme};type=${streamInfo.contentType};S.title=${encodeURIComponent(targetCtx.title || '3A Stream')};end`;
      stopCastDiscoveryPolling();
      closeAppModal();
      window.location.href = intentUrl;
      return;
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  if (option === 'system_cast_settings') {
    if (window.AndroidCastBridge) {
      stopCastDiscoveryPolling();
      closeAppModal();
      window.AndroidCastBridge.openSystemCastSettings();
    }
    return;
  }

  if (option === 'copy_url') {
    const titleEl = document.getElementById('lblModalCopyCastTitle');
    const descEl = document.getElementById('lblModalCopyCastDesc');
    if (titleEl) titleEl.textContent = '⏳ Gerando link otimizado para rede Wi-Fi...';
    const streamInfo = await resolveCastableStreamInfo(targetCtx);
    const urlToCopy = streamInfo.externalAppUrl || streamInfo.primaryUrl;
    try {
      await navigator.clipboard.writeText(urlToCopy);
      if (titleEl) titleEl.textContent = '✅ Link de Transmissão Copiado!';
      if (descEl) descEl.textContent = urlToCopy;
    } catch (_) {
      if (titleEl) titleEl.textContent = '🔗 Link Direto Pronto:';
      if (descEl) descEl.textContent = urlToCopy;
    }
  }
}

function controlActiveCastSession(command) {
  try {
    if (window.AndroidCastBridge && typeof window.AndroidCastBridge.controlNativeCast === 'function' && castEngineState.nativeConnected) {
      window.AndroidCastBridge.controlNativeCast(command);
      if (command === 'disconnect') {
        castEngineState.nativeConnected = false;
        castEngineState.isConnected = false;
        syncAllCastButtonsUI();
        stopCastDiscoveryPolling();
        closeAppModal();
      }
      return;
    }

    if (!window.cast || !window.cast.framework) return;
    const context = cast.framework.CastContext.getInstance();
    const session = context.getCurrentSession();
    const player = castEngineState.remotePlayer;
    const controller = castEngineState.remoteController;

    if (command === 'disconnect') {
      if (session) session.endSession(true);
      castEngineState.isConnected = false;
      syncAllCastButtonsUI();
      stopCastDiscoveryPolling();
      closeAppModal();
      return;
    }

    if (!player || !controller || !player.isConnected) return;

    if (command === 'togglePlay') {
      controller.playOrPause();
    } else if (command === 'rewind10') {
      player.currentTime = Math.max(0, (player.currentTime || 0) - 10);
      controller.seek();
    } else if (command === 'forward10') {
      player.currentTime = (player.currentTime || 0) + 10;
      controller.seek();
    }
  } catch (err) {
    console.warn('Erro no controle remoto Chromecast:', err);
  }
}


