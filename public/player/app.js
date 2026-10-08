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

async function apiFetch(path, options = {}) {
  if (!IS_NATIVE_APK) {
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
  document.getElementById('loginMacDisplay').textContent = appState.macAddress;
  document.getElementById('settingsMacDisplay').textContent = appState.macAddress;
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

    document.getElementById('homeClientName').textContent = data.profile.name;
    document.getElementById('homeExpirationDate').textContent = data.profile.expiresAtFormatted || '15/06/2026';

    navigateToScreen('screenHome');
    showToast(`✅ Bem-vindo, ${data.profile.name}! Lista completa carregada.`);
  } catch (err) {
    // Fallback Standalone Direto para o APK Mobile caso o servidor nuvem/PC esteja indisponível
    const standaloneAccounts = {
      'teste': { pass: '123', host: 'http://sevdns.sbs:80', xUser: '603279198', xPass: '448213191', name: 'Teste', exp: '06/11/2026', pin: '0000' },
      'asmj10': { pass: 'athena10$GA', host: 'http://sev3u.sbs:80', xUser: '371047218', xPass: '357753734', name: 'Balok', exp: '15/06/2027', pin: '1904' }
    };
    const matched = standaloneAccounts[username];
    if (matched && matched.pass === password) {
      try {
        const catalog = await standaloneXtreamFetchCatalog(
          matched.host || 'http://sev3u.sbs:80',
          matched.xUser || '371047218',
          matched.xPass || '357753734',
          appState.preferences.streamFormat
        );
        appState.loggedIn = true;
        appState.profile = {
          name: matched.name,
          username,
          expiresAtFormatted: matched.exp || '08/05/2026',
          parentalPin: matched.pin || '0000',
          sourceLabel: `Xtream Real (${matched.host})`
        };
        appState.catalog = catalog;
        document.getElementById('homeClientName').textContent = appState.profile.name;
        document.getElementById('homeExpirationDate').textContent = appState.profile.expiresAtFormatted;
        navigateToScreen('screenHome');
        showToast(`✅ Conectado (${matched.name})!`);
        return;
      } catch (e2) {
        console.warn('Standalone fallback error:', e2);
      }
    }
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

function scheduleCinemaTopbarHide() {
  const topbar = document.getElementById('cinemaTopbar');
  if (!topbar) return;
  topbar.classList.remove('topbar-hidden');
  clearTimeout(cinemaTopbarTimer);
  cinemaTopbarTimer = setTimeout(() => {
    const drawer = document.getElementById('cinemaEpisodeDrawer');
    if (drawer && !drawer.classList.contains('hidden')) return;
    if (appState.currentScreen === 'screenCinemaPlayer') {
      topbar.classList.add('topbar-hidden');
    }
  }, 3500);
}

function handleCinemaStageTap(event) {
  scheduleCinemaTopbarHide();
}

/**
 * Garante que o botão de Voltar no canto superior esquerdo apareça SEMPRE que o usuário
 * tocar na tela do vídeo (mesmo quando os controles nativos de pause/barra de tempo absorvem o toque),
 * e oculte automaticamente após 3.5 segundos sem toque.
 */
function initCinemaTouchWakeup() {
  const wrap = document.getElementById('cinemaPlayerWrap');
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  const liveVideo = document.getElementById('iptvVideoPlayer');

  const wakeTopbarOnTouch = () => {
    if (appState.currentScreen === 'screenCinemaPlayer') {
      scheduleCinemaTopbarHide();
    }
  };

  if (wrap) {
    // Fase de captura (capture: true) garante que o toque no <video controls> mostre o botão Voltar superior esquerdo!
    wrap.addEventListener('touchstart', wakeTopbarOnTouch, { capture: true, passive: true });
    wrap.addEventListener('pointerdown', wakeTopbarOnTouch, { capture: true, passive: true });
    wrap.addEventListener('mousemove', wakeTopbarOnTouch, { passive: true });
  }

  if (cinemaVideo) {
    cinemaVideo.addEventListener('touchstart', wakeTopbarOnTouch, { capture: true, passive: true });
    cinemaVideo.addEventListener('pause', wakeTopbarOnTouch);
    cinemaVideo.addEventListener('seeking', wakeTopbarOnTouch);
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
    showToast('⚠️ Carregando lista...');
    return;
  }
  appState.currentSection = section;
  appState.selectedCategoryId = 'ALL';
  document.getElementById('catalogSearchInput').value = '';

  const titles = {
    live: '📺 TV ao Vivo',
    soccer: '⚽ Futebol Ao Vivo & Esportes',
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

  if (query) {
    items = items.filter(i =>
      (i.name || '').toLowerCase().includes(query) ||
      (i.matchInfo || '').toLowerCase().includes(query)
    );
  }

  if (items.length === 0) {
    container.innerHTML = `<div style="padding:20px;color:#a1a1aa;font-size:13px;">Nenhum item encontrado nesta categoria.</div>`;
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

    if (isPosterMode) {
      card.className = `vod-poster-card focusable ${appState.currentPlayingId === itemId ? 'active' : ''}`;
      card.innerHTML = `
        <div class="vod-poster-thumb">
          <img src="${imgUrl}" alt="${item.name}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
          <span class="vod-rating-badge">⭐ ${item.rating || '8.5'}</span>
          <div class="vod-play-overlay"><span>▶</span></div>
        </div>
        <div class="vod-poster-title">${item.name}</div>
      `;
    } else {
      card.className = `channel-card focusable ${appState.currentPlayingId === itemId ? 'active' : ''}`;
      card.innerHTML = `
        <img src="${imgUrl}" alt="${item.name}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
        <div class="channel-card-info">
          <div class="channel-card-title">${item.name}</div>
          <div class="channel-card-sub">${subText}</div>
        </div>
      `;
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

  // 1. Se estiver na seção SÉRIES, abre a Tela de Detalhes Cinematográfica (igual ao Print 2 - IPTV Expert)
  if (appState.currentSection === 'series') {
    await openSeriesDetailScreen(item);
    return;
  }

  // 2. Se estiver na seção FILMES (VOD), abre direto no Player de Cinema 100% Tela Cheia!
  if (appState.currentSection === 'vod') {
    const recents = appState.preferences.recentMovies.filter(n => n !== item.name);
    recents.unshift(item.name);
    appState.preferences.recentMovies = recents.slice(0, 20);
    localStorage.setItem('3a_recent_movies', JSON.stringify(appState.preferences.recentMovies));
    syncSettingsLabels();
    startVodOrLiveInCinema(item, 'vod');
    return;
  }

  // 3. Se estiver em TV AO VIVO / FUTEBOL e clicar novamente no mesmo canal (ou se estiver em celular Retrato), abre em Tela Cheia!
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

  if (notify) {
    showToast(`▶️ Canal: ${title} (Toque em ⛶ Tela Cheia 100% para expandir)`);
  }
}

function openCurrentLiveInCinema() {
  if (appState.currentLiveItem) {
    startVodOrLiveInCinema(appState.currentLiveItem, 'live');
  } else {
    showToast('⚠️ Selecione um canal ao vivo primeiro.');
  }
}

function startVodOrLiveInCinema(item, mode = 'vod') {
  stopVideoPlayback();
  cinemaReturnScreen = 'screenCatalog';

  navigateToScreen('screenCinemaPlayer');
  scheduleCinemaTopbarHide();

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
  startStreamOnVideoElement(cinemaVideo, item.streamUrl, item);
  showToast(`▶️ Tela Cheia 100%: ${item.name}`);
}

// ============================================================================
// MOTOR DE ÁUDIO 3A STREAM: NORMALIZADOR 5.1 SURROUND -> STEREO + REALCE DE VOZ
// Corrige episódios/filmes codificados em AAC 5.1 (6 canais) onde o canal
// central de voz (FC) fica baixo ou oscila no downmix estéreo comum.
// ============================================================================
let sharedAudioContext = null;
const videoAudioPipelineMap = new WeakMap();

const AUDIO_BOOST_PRESETS = [
  { id: 'voice_180', label: '🔊 Voz 5.1 (180%)', gain: 1.85, vocalDb: 5.5, compress: true, desc: 'Normalizador 5.1 + Realce de Voz Central (180%)' },
  { id: 'max_250', label: '🔊 Boost Máx (250%)', gain: 2.5, vocalDb: 7.0, compress: true, desc: 'Amplificação Máxima 250% + Compressor de Diálogo' },
  { id: 'ultra_320', label: '🔊 Ultra (320%)', gain: 3.2, vocalDb: 8.0, compress: true, desc: 'Amplificação Ultra 320% para vídeos muito baixos' },
  { id: 'normal_100', label: '🔈 Original (100%)', gain: 1.0, vocalDb: 0.0, compress: false, desc: 'Áudio Original sem filtro 5.1 (100%)' }
];
let currentAudioPresetIndex = 0; // Padrão ativo: Voz 5.1 (180%)

function ensureVideoAudioNormalizer(video) {
  if (!video) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!sharedAudioContext) {
      sharedAudioContext = new AudioCtx();
      // Força downmix estéreo de 2 canais limpo na saída principal
      if (sharedAudioContext.destination && sharedAudioContext.destination.maxChannelCount >= 2) {
        sharedAudioContext.destination.channelCount = 2;
        sharedAudioContext.destination.channelCountMode = 'explicit';
        sharedAudioContext.destination.channelInterpretation = 'speakers';
      }
    }

    if (sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }

    if (!videoAudioPipelineMap.has(video)) {
      const source = sharedAudioContext.createMediaElementSource(video);

      // 1. Filtro High-Pass (80Hz) para remover graves excessivos do canal LFE (Subwoofer 5.1) que abafam a voz
      const highPass = sharedAudioContext.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 80;
      highPass.Q.value = 0.7;

      // 2. Filtro Peaking em 2150Hz para trazer à frente o Canal Central (FC) de diálogos e vozes humanas
      const vocalEnhancer = sharedAudioContext.createBiquadFilter();
      vocalEnhancer.type = 'peaking';
      vocalEnhancer.frequency.value = 2150;
      vocalEnhancer.Q.value = 1.05;
      vocalEnhancer.gain.value = 5.5;

      // 3. Compressor Dinâmico (DRC) para nivelar sussurros/diálogos baixos e evitar quedas bruscas em explosões
      const compressor = sharedAudioContext.createDynamicsCompressor();
      compressor.threshold.value = -28;
      compressor.knee.value = 22;
      compressor.ratio.value = 6.5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.22;

      // 4. Estágio Pré-Amplificador de Ganho (Boost de Volume)
      const gainNode = sharedAudioContext.createGain();
      gainNode.gain.value = 1.85;

      // Força conversão de 6 canais (5.1) para 2 canais (Estéreo) antes do realce vocal
      highPass.channelCount = 2;
      highPass.channelCountMode = 'explicit';
      highPass.channelInterpretation = 'speakers';

      source.connect(highPass);
      highPass.connect(vocalEnhancer);
      vocalEnhancer.connect(compressor);
      compressor.connect(gainNode);
      gainNode.connect(sharedAudioContext.destination);

      videoAudioPipelineMap.set(video, {
        source,
        highPass,
        vocalEnhancer,
        compressor,
        gainNode
      });

      video.addEventListener('play', () => {
        if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
          sharedAudioContext.resume().catch(() => {});
        }
      });
    }

    applyAudioBoostPreset(currentAudioPresetIndex, false);
  } catch (err) {
    console.warn('Aviso WebAudio Normalizer:', err);
  }
}

function applyAudioBoostPreset(presetIdx, notify = true) {
  currentAudioPresetIndex = presetIdx % AUDIO_BOOST_PRESETS.length;
  const preset = AUDIO_BOOST_PRESETS[currentAudioPresetIndex];

  const cinemaBtn = document.getElementById('btnCinemaAudioBoost');
  const catalogBtn = document.getElementById('btnCatalogAudioBoost');
  if (cinemaBtn) cinemaBtn.textContent = preset.label;
  if (catalogBtn) catalogBtn.textContent = preset.label;

  [document.getElementById('cinemaVideoElement'), document.getElementById('iptvVideoPlayer')].forEach(v => {
    if (!v) return;
    const nodes = videoAudioPipelineMap.get(v);
    if (!nodes || !sharedAudioContext) return;

    const now = sharedAudioContext.currentTime;
    nodes.gainNode.gain.setTargetAtTime(preset.gain, now, 0.05);
    nodes.vocalEnhancer.gain.setTargetAtTime(preset.vocalDb, now, 0.05);
    nodes.compressor.threshold.setTargetAtTime(preset.compress ? -28 : 0, now, 0.05);
    nodes.compressor.ratio.setTargetAtTime(preset.compress ? 6.5 : 1, now, 0.05);
  });

  if (notify) {
    showToast(`${preset.label}: ${preset.desc}`);
  }
}

function cycleAudioBoostMode() {
  const nextIdx = (currentAudioPresetIndex + 1) % AUDIO_BOOST_PRESETS.length;
  applyAudioBoostPreset(nextIdx, true);
  scheduleCinemaTopbarHide();
}

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
  return streamUrl || '';
}

function startStreamOnVideoElement(video, streamUrl, item = {}) {
  video.muted = false;
  video.volume = 1.0;
  video.onerror = null;

  const rawStreamUrl = extractRawStreamUrl(streamUrl, item);
  const rawCheck = (rawStreamUrl || streamUrl || '').toLowerCase();
  const isMovieOrSeriesVod = rawCheck.includes('/movie/') || rawCheck.includes('/series/') || rawCheck.endsWith('.mp4') || rawCheck.endsWith('.mkv');
  const isTsStream = !isMovieOrSeriesVod && (rawCheck.endsWith('.ts') || (streamUrl && streamUrl.includes('.ts')));
  const isM3u8Stream = !isMovieOrSeriesVod && (rawCheck.includes('.m3u8') || (streamUrl && streamUrl.includes('.m3u8')));

  let resolvedUrl = streamUrl;

  if (IS_NATIVE_APK) {
    if (isMovieOrSeriesVod && /^https?:\/\//i.test(rawStreamUrl)) {
      // Filmes VOD (ex: r2-auth.atlaspainel.net) redirecionam via 302 sem CORS e sem Content-Type: video/mp4.
      // O Proxy Nativo Local do APK (127.0.0.1:34567) resolve o 302 preservando Range e injeta video/mp4 + CORS!
      resolvedUrl = `http://127.0.0.1:34567/proxy?url=${encodeURIComponent(rawStreamUrl)}`;
    } else if (resolvedUrl && resolvedUrl.startsWith('/api/proxy/stream')) {
      resolvedUrl = rawStreamUrl || `${DEFAULT_LAN_BACKEND}${resolvedUrl}`;
    }
  } else {
    // No navegador Web PC, garante que Filmes/Séries HTTP passem pelo /api/proxy/stream
    if (isMovieOrSeriesVod && /^https?:\/\//i.test(rawStreamUrl) && !String(resolvedUrl).startsWith('/api/proxy/stream')) {
      resolvedUrl = `/api/proxy/stream?url=${encodeURIComponent(rawStreamUrl)}`;
    }
  }

  video.setAttribute('crossorigin', 'anonymous');
  ensureVideoAudioNormalizer(video);

  if (isTsStream && window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
    startMpegTsPlayback(video, resolvedUrl);
  } else if (isM3u8Stream && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    hlsInstance.loadSource(resolvedUrl);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal && item.fallbackTsUrl && window.mpegts) {
        destroyPlayers();
        startMpegTsPlayback(video, item.fallbackTsUrl);
      }
    });
  } else {
    let fallbackStep = 0;
    video.onerror = () => {
      if (!rawStreamUrl || !/^https?:\/\//i.test(rawStreamUrl)) return;
      fallbackStep++;
      if (fallbackStep === 1 && IS_NATIVE_APK) {
        // Fallback 1: tenta via servidor LAN se disponível
        const lanUrl = `${DEFAULT_LAN_BACKEND.replace(/\/+$/, '')}/api/proxy/stream?url=${encodeURIComponent(rawStreamUrl)}`;
        if (video.src !== lanUrl) {
          video.src = lanUrl;
          video.load();
          video.play().catch(() => {});
          return;
        }
        fallbackStep++;
      }
      if (fallbackStep === 2) {
        // Fallback 2: reprodução direta sem atributo crossorigin
        video.onerror = null;
        video.removeAttribute('crossorigin');
        video.src = rawStreamUrl;
        video.load();
        video.play().catch(() => {});
      }
    };
    video.src = resolvedUrl;
    video.play().catch(() => {});
  }
}

// ============================================================================
// TELA DE DETALHES DE SÉRIE (IDÊNTICA AO PRINT 2 - IPTV EXPERT) + PLAYER DE CINEMA
// ============================================================================
let activeSeriesItem = null;
let activeSeasonKey = '1';
let activeEpisodeIndex = 0;
let activeDetailTab = 'season_1';

async function openSeriesDetailScreen(seriesItem) {
  stopVideoPlayback();
  activeSeriesItem = seriesItem;

  // Se for uma Série real Xtream e ainda não carregou temporadas/episódios/backdrop, busca na API
  if (seriesItem.series_id && !seriesItem.seasons && appState.catalog.xtreamOrigin) {
    showToast(`⏳ Carregando detalhes e episódios de ${seriesItem.name}...`);
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
      if (data.ok) {
        seriesItem.seasons = data.seasons || {};
        seriesItem.richInfo = data.info || {};
      }
    } catch (err) {
      // Fallback direto Xtream Series Info para APK Mobile Standalone
      try {
        const { baseUrl, username, password } = appState.catalog.xtreamOrigin;
        const cleanBase = baseUrl.trim().replace(/\/+$/, '');
        const url = `${cleanBase}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesItem.series_id)}`;
        const rawData = await fetch(url).then(r => r.json());
        const episodesBySeason = rawData.episodes || {};
        const seasons = {};
        Object.keys(episodesBySeason).forEach(seasonNum => {
          seasons[seasonNum] = (episodesBySeason[seasonNum] || []).map(ep => {
            const ext = ep.container_extension || 'mp4';
            const rawUrl = `${cleanBase}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${ep.id}.${ext}`;
            return {
              id: ep.id,
              episode_num: ep.episode_num || 1,
              title: ep.title || `Episódio ${ep.episode_num || 1}`,
              season: seasonNum,
              duration: (ep.info && ep.info.duration) || ext.toUpperCase(),
              plot: (ep.info && ep.info.plot) || '',
              thumbnail: (ep.info && ep.info.movie_image) || '',
              rawStreamUrl: rawUrl,
              streamUrl: rawUrl
            };
          });
        });
        const info = rawData.info || {};
        const backdropList = Array.isArray(info.backdrop_path) ? info.backdrop_path : [];
        seriesItem.seasons = seasons;
        seriesItem.richInfo = {
          name: info.name || seriesItem.name || '',
          cover: info.cover || seriesItem.poster || '',
          backdrop: backdropList[0] || info.cover || seriesItem.poster || '',
          plot: info.plot || '',
          cast: info.cast || '',
          genre: info.genre || '',
          releaseDate: info.releaseDate || info.release_date || '',
          rating: info.rating || '8.5'
        };
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

  const firstSeasonEps = seriesItem.seasons[activeSeasonKey] || [];
  const firstEp = firstSeasonEps[0];
  const watchBtn = document.getElementById('btnDetailPrimaryWatch');
  if (firstEp) {
    const epCode = `S${String(activeSeasonKey).padStart(2, '0')}E${String(firstEp.episode_num || 1).padStart(2, '0')}`;
    const cleanEpLabel = firstEp.title.includes(epCode) ? firstEp.title.replace(seriesItem.name, '').trim() : `${epCode} - Episodio ${firstEp.episode_num || 1}`;
    watchBtn.textContent = `▶ Assistir ${cleanEpLabel}`;
    watchBtn.onclick = () => startSeriesEpisodeInCinema(activeSeasonKey, 0);
  } else {
    watchBtn.textContent = `▶ Sem episódios disponíveis`;
    watchBtn.onclick = null;
  }

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
      card.onclick = () => openSeriesDetailScreen(rec);
      grid.appendChild(card);
    });
    return;
  }

  // Aba de Temporada (Exibe todos os Episódios em Cards 16:9 como no Print 2)
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

    card.innerHTML = `
      <div class="ep-thumb-wrap">
        <img src="${thumb}" alt="${ep.title}" loading="lazy" onerror="this.src='logo-3a-stream.jpg'" />
        <div class="ep-play-badge">
          <div class="ep-play-circle">▶</div>
        </div>
        <div class="ep-corner-badge">▶</div>
      </div>
      <div class="ep-card-caption">${ep.title}</div>
    `;

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
function startSeriesEpisodeInCinema(seasonKey, epIndex) {
  if (!activeSeriesItem || !activeSeriesItem.seasons) return;
  const seasonEps = activeSeriesItem.seasons[seasonKey] || [];
  const ep = seasonEps[epIndex];
  if (!ep) return;

  cinemaReturnScreen = 'screenMediaDetail';
  activeSeasonKey = String(seasonKey);
  activeEpisodeIndex = epIndex;

  // Mostra controles de episódios para séries
  ['btnPrevEpisode', 'btnNextEpisode', 'btnToggleEpDrawer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  });

  // Atualiza botão principal da tela de detalhes para continuar do episódio atual
  const watchBtn = document.getElementById('btnDetailPrimaryWatch');
  if (watchBtn) {
    watchBtn.textContent = `▶ Continuar S${String(seasonKey).padStart(2, '0')}E${String(ep.episode_num || epIndex + 1).padStart(2, '0')} - Episodio ${ep.episode_num || epIndex + 1}`;
    watchBtn.onclick = () => startSeriesEpisodeInCinema(activeSeasonKey, activeEpisodeIndex);
  }

  navigateToScreen('screenCinemaPlayer');
  scheduleCinemaTopbarHide();

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
  startStreamOnVideoElement(cinemaVideo, ep.streamUrl, ep);

  // Auto-avança para o próximo episódio ao terminar o vídeo!
  cinemaVideo.onended = () => {
    showToast('⏭️ Episódio concluído! Iniciando próximo episódio...');
    skipSeriesEpisode(1);
  };

  showToast(`▶️ Reproduzindo: ${ep.title}`);
}

function skipSeriesEpisode(delta) {
  if (!activeSeriesItem || !activeSeriesItem.seasons) return;
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `drawer-ep-item focusable ${idx === activeEpisodeIndex ? 'active' : ''}`;
    btn.innerHTML = `<strong>Ep. ${ep.episode_num || idx + 1}</strong> — ${ep.title}`;
    btn.onclick = () => {
      startSeriesEpisodeInCinema(activeSeasonKey, idx);
    };
    listEl.appendChild(btn);
  });
}

function closeCinemaPlayer() {
  clearTimeout(cinemaTopbarTimer);
  const cinemaVideo = document.getElementById('cinemaVideoElement');
  destroyPlayers();
  if (cinemaVideo) {
    cinemaVideo.pause();
    cinemaVideo.removeAttribute('src');
    cinemaVideo.load();
  }
  navigateToScreen(cinemaReturnScreen || 'screenCatalog');
}

function toggleCinemaFullscreen() {
  cycleVideoAspectRatio();
}

let mpegtsPlayer = null;

function startMpegTsPlayback(videoElement, tsUrl) {
  try {
    mpegtsPlayer = mpegts.createPlayer({
      type: 'mse',
      isLive: true,
      url: tsUrl
    });
    mpegtsPlayer.attachMediaElement(videoElement);
    mpegtsPlayer.load();
    mpegtsPlayer.play().catch(() => {});
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
        <input type="text" id="modalSwitchUser" value="${appState.profile ? appState.profile.username : 'admin'}" />
        <label>Senha</label>
        <input type="password" id="modalSwitchPass" value="123" />
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
      syncSettingsLabels();
      showToast('🗑️ Histórico de filmes vistos recentemente limpo!');
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
    pt: { live_tv: 'TV ao Vivo', movies: 'Filmes', series: 'Séries', soccer: 'Futebol', playlists: 'Playlits', settings: 'Configurações', reload: 'recarregar', exit: 'Sair' },
    en: { live_tv: 'Live TV', movies: 'Movies', series: 'Series', soccer: 'Soccer Live', playlists: 'Playlists', settings: 'Settings', reload: 'Reload', exit: 'Exit' },
    es: { live_tv: 'TV en Vivo', movies: 'Películas', series: 'Series', soccer: 'Fútbol', playlists: 'Listas', settings: 'Ajustes', reload: 'Recargar', exit: 'Salir' }
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
function showToast(msg) {
  const toast = document.getElementById('appToast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3200);
}
