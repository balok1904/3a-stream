const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

// ============================================================================
// CARREGAMENTO NATIVO E SEGURO DE VARIÁVEIS DE AMBIENTE (.env)
// ============================================================================
(function loadDotEnvIfPresent() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (_) {}
})();

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

// ============================================================================
// CAMADA DE BLINDAGEM DE SEGURANÇA (HEADERS HTTP, BLOQUEIO DE ARQUIVOS SENSÍVEIS,
// ANTI-BRUTE-FORCE RATE LIMITER, HASH SHA-256 E ANTI-SSRF)
// ============================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Accept');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Bloqueia tentativas de acesso direto a arquivos internos (.env, .git, banco JSON, server.js)
  const lowerPath = (req.path || '').toLowerCase();
  if (
    lowerPath.includes('.env') ||
    lowerPath.includes('.git') ||
    lowerPath.startsWith('/data') ||
    lowerPath.endsWith('3a_stream_db.json') ||
    lowerPath.endsWith('catalog_cache.json') ||
    lowerPath === '/server.js' ||
    lowerPath === '/package.json'
  ) {
    return res.status(403).json({ ok: false, error: 'Acesso negado.' });
  }

  next();
});
app.use(cors());
app.use(express.json({ limit: '5mb' }));

function hashSecretPassword(plainPassword) {
  return 'sha256:' + crypto
    .createHash('sha256')
    .update('3a_stream_salt_v1:' + String(plainPassword || '').trim())
    .digest('hex');
}

function verifyPasswordMatch(inputPassword, storedPasswordOrHash) {
  if (!inputPassword || !storedPasswordOrHash) return false;
  const cleanInput = String(inputPassword).trim();
  const cleanStored = String(storedPasswordOrHash).trim();
  const candidate = cleanStored.startsWith('sha256:') ? hashSecretPassword(cleanInput) : cleanInput;
  const bufA = Buffer.from(candidate);
  const bufB = Buffer.from(cleanStored);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Proteção Anti-Brute-Force por IP nas rotas de Login
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 25);
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MINUTES || 10) * 60 * 1000;
const loginAttemptsByIp = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isLoginRateLimited(req) {
  const ip = getClientIp(req);
  const entry = loginAttemptsByIp.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttemptsByIp.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLoginAttempt(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip);
  if (!entry || now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttemptsByIp.set(ip, { count: 1, firstAttemptAt: now });
  } else {
    entry.count++;
  }
}

function clearFailedLoginAttempts(req) {
  loginAttemptsByIp.delete(getClientIp(req));
}

// Proteção Anti-SSRF no Proxy de Stream (bloqueia IPs privados, loopback e metadados de nuvem)
function isSafeExternalStreamUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = (parsed.hostname || '').toLowerCase();
    if (!host) return false;
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '169.254.169.254' ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, localProxy: true });
});

// Diretório de dados persistentes
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, '3a_stream_db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Catálogo IPTV de Demonstração (usado quando o cliente está em modo Demo ou para testes imediatos)
const DEMO_CATALOG = {
  liveCategories: [
    { category_id: 'esportes', category_name: '⚽ ESPORTES & FUTEBOL AO VIVO', isAdult: false },
    { category_id: 'abertos', category_name: '📺 CANAIS ABERTOS HD', isAdult: false },
    { category_id: 'filmes_series', category_name: '🎬 FILMES E SÉRIES 24H', isAdult: false },
    { category_id: 'noticias', category_name: '📰 NOTÍCIAS & DOCUMENTÁRIOS', isAdult: false },
    { category_id: 'infantil', category_name: '🧸 INFANTIL & ANIMES', isAdult: false },
    { category_id: 'adulto', category_name: '🔞 ADULTO (+18)', isAdult: true }
  ],
  liveStreams: [
    {
      stream_id: 101,
      name: '3A Esportes 1 HD - Brasileirão Série A',
      category_id: 'esportes',
      isSoccer: true,
      matchInfo: 'AO VIVO • Flamengo x Palmeiras (Rodada 28)',
      logo: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Futebol Ao Vivo: Flamengo x Palmeiras',
      epgNext: 'Pós-Jogo 3A Esportes',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    },
    {
      stream_id: 102,
      name: '3A Premiere Clubes 4K',
      category_id: 'esportes',
      isSoccer: true,
      matchInfo: 'AO VIVO • São Paulo x Corinthians (Clássico Majestoso)',
      logo: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Transmissão Alternativa 4K: Majestoso',
      epgNext: 'Gols da Rodada',
      streamUrl: 'https://assets.afcdn.com/video49/20210722/v_645516.m3u8'
    },
    {
      stream_id: 103,
      name: 'Champions Sports HD',
      category_id: 'esportes',
      isSoccer: true,
      matchInfo: 'HOJE 16:00 • Real Madrid x Manchester City',
      logo: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=300&auto=format&fit=crop&q=80',
      epgNow: 'UEFA Champions League Magazine',
      epgNext: 'Pré-Jogo Champions League',
      streamUrl: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8'
    },
    {
      stream_id: 104,
      name: '3A TV Aberta Brasil FHD',
      category_id: 'abertos',
      isSoccer: false,
      logo: 'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Jornal Nacional 3A',
      epgNext: 'Novela das Nove',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    },
    {
      stream_id: 105,
      name: 'Cine Action Max FHD',
      category_id: 'filmes_series',
      isSoccer: false,
      logo: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Sessão Adrenalina: Missão Resgate',
      epgNext: 'Clássicos de Ação',
      streamUrl: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8'
    },
    {
      stream_id: 106,
      name: 'Global News 24h HD',
      category_id: 'noticias',
      isSoccer: false,
      logo: 'https://images.unsplash.com/photo-1495020689067-958852a7765e?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Plantão de Notícias Internacional',
      epgNext: 'Mercado Financeiro em Foco',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    },
    {
      stream_id: 107,
      name: 'Kids Toon Animation HD',
      category_id: 'infantil',
      isSoccer: false,
      logo: 'https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Aventuras de Big Buck Bunny',
      epgNext: 'Maratona Animada',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    },
    {
      stream_id: 108,
      name: 'Canal Adulto +18 Privé (Bloqueado por PIN)',
      category_id: 'adulto',
      isSoccer: false,
       isAdult: true,
      logo: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=300&auto=format&fit=crop&q=80',
      epgNow: 'Programação Restrita +18',
      epgNext: 'Programação Restrita +18',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    }
  ],
  vodCategories: [
    { category_id: 'lancamentos', category_name: '🔥 LANÇAMENTOS 2026', isAdult: false },
    { category_id: 'acao', category_name: '💥 AÇÃO E AVENTURA', isAdult: false },
    { category_id: 'ficcao', category_name: '🚀 FICÇÃO CIENTÍFICA', isAdult: false },
    { category_id: 'animacao', category_name: '🍿 ANIMAÇÃO & FAMÍLIA', isAdult: false }
  ],
  vodStreams: [
    {
      stream_id: 201,
      name: 'Lágrimas de Aço (Tears of Steel 4K)',
      category_id: 'ficcao',
      year: '2026',
      rating: '9.4',
      duration: '1h 54m',
      description: 'Em uma Amsterdã futurista, um grupo de guerreiros e cientistas tenta salvar o mundo de robôs destrutivos.',
      poster: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=400&auto=format&fit=crop&q=80',
      streamUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8'
    },
    {
      stream_id: 202,
      name: 'Operação Horizonte Vermelho',
      category_id: 'lancamentos',
      year: '2026',
      rating: '9.1',
      duration: '2h 12m',
      description: 'Um agente especial precisa atravessar fronteiras hostis para impedir um ataque cibernético global.',
      poster: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&auto=format&fit=crop&q=80',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    },
    {
      stream_id: 203,
      name: 'Velocidade Máxima: Circuito Noturno',
      category_id: 'acao',
      year: '2025',
      rating: '8.8',
      duration: '1h 48m',
      description: 'Pilotos clandestinos disputam a corrida mais perigosa da temporada nas ruas iluminadas por neon.',
      poster: 'https://images.unsplash.com/photo-1511919884226-fd3cad34687c?w=400&auto=format&fit=crop&q=80',
      streamUrl: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8'
    },
    {
      stream_id: 204,
      name: 'Big Buck Bunny - O Filme',
      category_id: 'animacao',
      year: '2025',
      rating: '9.0',
      duration: '1h 32m',
      description: 'Comédia animada para toda a família acompanhando as aventuras de um coelho gigante de bom coração.',
      poster: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400&auto=format&fit=crop&q=80',
      streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    }
  ],
  seriesCategories: [
    { category_id: 'series_top', category_name: '🏆 SÉRIES EM ALTA', isAdult: false },
    { category_id: 'series_crime', category_name: '🕵️ CRIME & SUSPENSE', isAdult: false },
    { category_id: 'series_doc', category_name: '⚽ DOCUMENTÁRIOS DO FUTEBOL', isAdult: false }
  ],
  seriesList: [
    {
      series_id: 301,
      name: 'Código Fantasma (1ª Temporada)',
      category_id: 'series_top',
      year: '2026',
      rating: '9.6',
      episodesCount: 3,
      description: 'Hackers de elite descobrem uma rede secreta capaz de controlar satélites globais.',
      poster: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400&auto=format&fit=crop&q=80',
      episodes: [
        { id: 3011, title: 'Ep. 01 - O Sinal Oculto', duration: '48m', streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
        { id: 3012, title: 'Ep. 02 - Chave Criptográfica', duration: '51m', streamUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8' },
        { id: 3013, title: 'Ep. 03 - Ponto Sem Retorno', duration: '55m', streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' }
      ]
    },
    {
      series_id: 302,
      name: 'Bastidores da Copa & Glória',
      category_id: 'series_doc',
      year: '2026',
      rating: '9.3',
      episodesCount: 2,
      description: 'A rotina, os treinos e as finais históricas dos maiores clubes de futebol do continente.',
      poster: 'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?w=400&auto=format&fit=crop&q=80',
      episodes: [
        { id: 3021, title: 'Ep. 01 - A Caminho da Final', duration: '45m', streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
        { id: 3022, title: 'Ep. 02 - O Gol do Título', duration: '52m', streamUrl: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8' }
      ]
    }
  ]
};

function createInitialDb() {
  return {
    settings: {
      appName: '3A Stream',
      appVersion: '1.0.0',
      supportWhatsapp: '5511999999999',
      announcement: 'Bem-vindo ao 3A Stream! Qualidade Ultra HD & Estabilidade.'
    },
    iptvServers: [
      {
        id: 'srv_demo',
        name: 'Servidor 3A Master (Catálogo Demo + HLS Integrado)',
        type: 'demo',
        xtreamUrl: 'http://dns.3astream.vip:8080',
        m3uUrl: '',
        status: 'online',
        createdAt: new Date().toISOString()
      }
    ],
    clients: [
      {
        id: 'cli_1791400458395',
        name: 'Teste',
        phone: '',
        username: 'teste',
        password: '123',
        macAddress: '61:F3:CF:92:93:B1',
        planName: 'Plano 3A Completo 4K',
        monthlyPrice: 35.0,
        expiresAt: '2026-11-06',
        status: 'active',
        parentalPin: '0000',
        iptvSourceType: 'xtream',
        xtreamUrl: 'http://sevdns.sbs',
        xtreamUser: '603279198',
        xtreamPass: '448213191',
        m3uUrl: '',
        maxConnections: 1,
        notes: '',
        lastLoginAt: null
      },
      {
        id: 'cli_balok',
        name: 'Balok',
        phone: '(11) 99999-0001',
        username: 'asmj10',
        password: 'sha256:abd2c430490bf153d05c27fbb5b9703be7153d3aaf0c61abf013d34c808b85c9',
        macAddress: '61:F3:CF:92:93:B1',
        planName: 'Plano 3A Completo 4K',
        monthlyPrice: 35.0,
        expiresAt: '2027-06-15',
        status: 'active',
        parentalPin: '1904',
        iptvSourceType: 'm3u',
        xtreamUrl: '',
        xtreamUser: '',
        xtreamPass: '',
        m3uUrl: 'http://sev3u.sbs:80/get.php?username=371047218&password=357753734&type=m3u_plus&output=mpegts',
        maxConnections: 2,
        notes: 'Conta principal para homologação do aplicativo 3A Stream.',
        lastLoginAt: null
      },
      {
        id: 'cli_1',
        name: 'Cliente Teste Admin (VIP)',
        phone: '(11) 99999-0001',
        username: 'admin',
        password: '123',
        macAddress: '61:F3:CF:92:93:B1',
        planName: 'Plano 3A Completo 4K',
        monthlyPrice: 35.0,
        expiresAt: '2027-06-15',
        status: 'active',
        parentalPin: '0000',
        iptvSourceType: 'm3u',
        xtreamUrl: '',
        xtreamUser: '',
        xtreamPass: '',
        m3uUrl: 'http://sev3u.sbs:80/get.php?username=371047218&password=357753734&type=m3u_plus&output=mpegts',
        maxConnections: 2,
        notes: 'Conta principal para homologação do aplicativo 3A Stream.',
        lastLoginAt: null
      },
      {
        id: 'cli_2',
        name: 'João Silva (Sala TV Box)',
        phone: '(11) 98888-2211',
        username: 'joao2026',
        password: '123',
        macAddress: 'AA:BB:CC:11:22:33',
        planName: 'Plano Mensal Futebol + Filmes',
        monthlyPrice: 35.0,
        expiresAt: '2026-11-10',
        status: 'active',
        parentalPin: '1234',
        iptvSourceType: 'demo',
        xtreamUrl: '',
        xtreamUser: '',
        xtreamPass: '',
        m3uUrl: '',
        maxConnections: 1,
        notes: 'Prefere canais de futebol em HLS.',
        lastLoginAt: null
      },
      {
        id: 'cli_3',
        name: 'Carlos Mendes (Mensalidade Vencida)',
        phone: '(21) 97777-3344',
        username: 'carlos',
        password: '123',
        macAddress: '44:55:66:77:88:99',
        planName: 'Plano Básico HD',
        monthlyPrice: 30.0,
        expiresAt: '2026-09-01',
        status: 'blocked',
        parentalPin: '0000',
        iptvSourceType: 'demo',
        xtreamUrl: '',
        xtreamUser: '',
        xtreamPass: '',
        m3uUrl: '',
        maxConnections: 1,
        notes: 'Exemplo de cliente bloqueado para testar tela de bloqueio no app.',
        lastLoginAt: null
      }
    ],
    payments: [
      {
        id: 'pay_1',
        clientId: 'cli_1',
        clientName: 'Cliente Teste Admin (VIP)',
        amount: 35.0,
        date: '2026-10-01',
        method: 'PIX',
        status: 'paid'
      },
      {
        id: 'pay_2',
        clientId: 'cli_2',
        clientName: 'João Silva (Sala TV Box)',
        amount: 35.0,
        date: '2026-10-05',
        method: 'PIX',
        status: 'paid'
      }
    ]
  };
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initial = createInitialDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('Erro ao ler banco de dados, recriando inicial:', err);
    return createInitialDb();
  }
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isExpired(expiresAtStr) {
  if (!expiresAtStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiresAtStr + 'T23:59:59');
  return exp < today;
}

function formatDateBr(isoDate) {
  if (!isoDate) return '--/--/----';
  const parts = isoDate.split('T')[0].split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// Parser de lista M3U / M3U8 para converter em estrutura de categorias e canais do 3A Stream
function parseM3uContent(m3uText) {
  const lines = m3uText.split(/\r?\n/);
  const liveCategoriesMap = new Map();
  const vodCategoriesMap = new Map();
  const liveStreams = [];
  const vodStreams = [];

  let currentItem = null;
  let idCounter = 1000;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const nameMatch = line.split(',');
      const title = (nameMatch[nameMatch.length - 1] || 'Canal Sem Nome').trim();
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const groupName = (groupMatch && groupMatch[1] ? groupMatch[1] : 'GERAL').trim();

      currentItem = {
        id: ++idCounter,
        name: title,
        group: groupName,
        logo: logoMatch && logoMatch[1] ? logoMatch[1] : 'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=300&auto=format&fit=crop&q=80'
      };
    } else if (!line.startsWith('#') && currentItem) {
      const url = line;
      const lowerUrl = url.toLowerCase();
      const lowerGroup = currentItem.group.toLowerCase();
      const lowerName = currentItem.name.toLowerCase();
      const isAdult = lowerGroup.includes('adult') || lowerGroup.includes('+18') || lowerGroup.includes('xxx') || lowerName.includes('+18');
      const isMovie = lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.mkv') || lowerGroup.includes('filme') || lowerGroup.includes('vod');
      const isSoccer = lowerGroup.includes('esporte') || lowerGroup.includes('futebol') || lowerGroup.includes('premiere') || lowerGroup.includes('sport') || lowerName.includes('futebol') || lowerName.includes('premiere') || lowerName.includes('espn') || lowerName.includes('sportv');

      const catId = currentItem.group.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'geral';

      if (isMovie) {
        if (!vodCategoriesMap.has(catId)) {
          vodCategoriesMap.set(catId, { category_id: catId, category_name: currentItem.group, isAdult });
        }
        vodStreams.push({
          stream_id: currentItem.id,
          name: currentItem.name,
          category_id: catId,
          year: '2026',
          rating: '9.0',
          duration: 'Filme VOD',
          description: `Grupo: ${currentItem.group}`,
          poster: currentItem.logo,
          rawStreamUrl: url,
          streamUrl: wrapProxyUrl(url)
        });
      } else {
        if (!liveCategoriesMap.has(catId)) {
          liveCategoriesMap.set(catId, { category_id: catId, category_name: currentItem.group, isAdult });
        }
        liveStreams.push({
          stream_id: currentItem.id,
          name: currentItem.name,
          category_id: catId,
          isSoccer,
          isAdult,
          matchInfo: isSoccer ? `AO VIVO • ${currentItem.group}` : '',
          logo: currentItem.logo,
          epgNow: `Programação Ao Vivo - ${currentItem.name}`,
          epgNext: 'A Seguir na Programação',
          rawStreamUrl: url,
          streamUrl: wrapProxyUrl(url)
        });
      }
      currentItem = null;
    }
  }

  return {
    liveCategories: Array.from(liveCategoriesMap.values()),
    liveStreams,
    vodCategories: Array.from(vodCategoriesMap.values()),
    vodStreams,
    seriesCategories: DEMO_CATALOG.seriesCategories,
    seriesList: DEMO_CATALOG.seriesList
  };
}

// Proteção global para que quedas de stream de vídeo nunca derrubem o servidor Node.js
process.on('uncaughtException', (err) => {
  if (err && (err.name === 'AbortError' || String(err.message).includes('aborted'))) return;
  console.error('[Servidor 3A] Erro capturado com segurança:', err.message);
});

process.on('unhandledRejection', (reason) => {
  if (reason && (reason.name === 'AbortError' || String(reason.message || reason).includes('aborted'))) return;
  console.error('[Servidor 3A] Rejeição capturada com segurança:', reason);
});

const IPTV_HEADERS = {
  'User-Agent': 'IPTVSmartersPlayer',
  'Accept': '*/*'
};

const CACHE_FILE = path.join(DATA_DIR, 'catalog_cache.json');
const catalogCache = new Map();

// Carrega cache do disco ao iniciar para login instantâneo
try {
  if (fs.existsSync(CACHE_FILE)) {
    const savedCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    Object.entries(savedCache).forEach(([k, v]) => catalogCache.set(k, v));
  }
} catch (_) {}

function saveCatalogCacheToDisk() {
  try {
    const obj = {};
    for (const [k, v] of catalogCache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch (_) {}
}

function wrapProxyUrl(rawUrl) {
  if (!rawUrl) return '';
  if (rawUrl.includes('mux.dev') || rawUrl.includes('akamaized.net') || rawUrl.includes('unified-streaming.com') || rawUrl.includes('afcdn.com')) {
    return rawUrl;
  }
  return `/api/proxy/stream?url=${encodeURIComponent(rawUrl)}`;
}

// Detecta automaticamente se um link M3U é na verdade um servidor Xtream Codes / XUI (get.php?username=...&password=...)
function extractXtreamFromM3uUrl(m3uUrl) {
  try {
    const parsed = new URL(m3uUrl.trim());
    const username = parsed.searchParams.get('username');
    const password = parsed.searchParams.get('password');
    const output = parsed.searchParams.get('output') || 'ts';
    if (username && password) {
      return {
        baseUrl: `${parsed.protocol}//${parsed.host}`,
        username,
        password,
        preferredFormat: output === 'hls' || output === 'm3u8' ? 'm3u8' : 'ts'
      };
    }
  } catch (_) {}
  return null;
}

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

// Busca dados de um servidor Xtream Codes API / XUI One real (player_api.php) de forma sequencial (respeitando max_connections=1)
async function fetchXtreamCatalog(xtreamUrl, username, password, preferredFormat = 'ts') {
  let baseUrl = xtreamUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = 'http://' + baseUrl;
  }
  const normalizedBase = baseUrl.replace(/:80$/, '');

  const cacheKey = `v3|${normalizedBase}|${username}|${password}|${preferredFormat}`;
  const cached = catalogCache.get(cacheKey) || catalogCache.get(`v3|${baseUrl}|${username}|${password}|${preferredFormat}`);
  const hasFullCachedCatalog = Boolean(
    cached &&
    cached.catalog &&
    Array.isArray(cached.catalog.liveStreams) &&
    cached.catalog.liveStreams.length > 50 &&
    Array.isArray(cached.catalog.vodStreams) &&
    cached.catalog.vodStreams.length > 50
  );

  // Em servidores Cloud (Render/AWS), retorna o catálogo completo em cache imediatamente (TTL de 7 dias com fallback perpétuo)
  if (hasFullCachedCatalog && Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000) {
    return cached.catalog;
  }

  const apiBase = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  // 1. Verifica autenticação
  const authRes = await fetch(apiBase, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => null);
  if (!authRes || (authRes.user_info && Number(authRes.user_info.auth) === 0)) {
    if (hasFullCachedCatalog) return cached.catalog;
    throw new Error('Credenciais recusadas pelo servidor IPTV.');
  }

  // 2. Busca sequencial de 100% das categorias e 100% dos itens (Live, VOD e Series)
  const liveCatsRes = await fetch(`${apiBase}&action=get_live_categories`, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => []);
  const liveStreamsRes = await fetch(`${apiBase}&action=get_live_streams`, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => []);
  const vodCatsRes = await fetch(`${apiBase}&action=get_vod_categories`, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => []);
  const vodStreamsRes = await fetch(`${apiBase}&action=get_vod_streams`, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => []);
  const seriesCatsRes = await fetch(`${apiBase}&action=get_series_categories`, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => []);
  const seriesListRes = await fetch(`${apiBase}&action=get_series`, { headers: IPTV_HEADERS }).then(r => r.json()).catch(() => []);

  // Se o servidor Cloud (IP de Datacenter EUA) sofreu bloqueio parcial do firewall IPTV, preserva o catálogo completo em cache!
  if (
    hasFullCachedCatalog &&
    (!Array.isArray(liveStreamsRes) || liveStreamsRes.length === 0 || !Array.isArray(vodStreamsRes) || vodStreamsRes.length === 0)
  ) {
    return cached.catalog;
  }

  const ext = preferredFormat === 'm3u8' ? 'm3u8' : 'ts';

  const liveCategories = (Array.isArray(liveCatsRes) ? liveCatsRes : []).map(c => {
    const rawName = c.category_name || '';
    const cname = formatCleanCategoryName(rawName);
    const isSoccerCategory = /esporte|futebol|premiere|sport|copa|champions|brasileir|dazn|caz|paramount|prime|jogos|paulist|ufc|nba|nfl|goat|nsports|apple tv|disney|hbo max/i.test(rawName);
    return {
      category_id: String(c.category_id),
      category_name: cname,
      isSoccerCategory,
      isAdult: /adult|\+18|xxx|sexo|hot|onlyfans/i.test(rawName),
      count: 0
    };
  });

  const liveCatMap = new Map(liveCategories.map(c => [c.category_id, c]));
  const soccerCatIds = new Set(liveCategories.filter(c => c.isSoccerCategory).map(c => c.category_id));

  // 100% dos canais ao vivo (sem corte)
  const liveStreams = (Array.isArray(liveStreamsRes) ? liveStreamsRes : []).map(s => {
    const name = s.name || 'Canal';
    const catId = String(s.category_id || (Array.isArray(s.category_ids) && s.category_ids[0]) || 'geral');
    if (!liveCatMap.has(catId)) {
      const newCat = {
        category_id: catId,
        category_name: catId === '16' ? '24 Horas' : `Categoria ${catId}`,
        isSoccerCategory: false,
        isAdult: false,
        count: 0
      };
      liveCategories.push(newCat);
      liveCatMap.set(catId, newCat);
    }
    liveCatMap.get(catId).count++;

    const isSoccer =
      soccerCatIds.has(catId) ||
      /futebol|esporte|premiere|sportv|espn|caz|champions|copa|brasileir|band sports|nosso futebol|goat|ufc|combate|dazn|paramount|paulist|nba|nfl/i.test(name);
    const isAdult =
      (liveCatMap.get(catId) && liveCatMap.get(catId).isAdult) ||
      /adult|\+18|xxx|playboy|sex|venus|sirena|sexy/i.test(name);

    const directTsUrl = `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.ts`;
    const directM3u8Url = `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.stream_id}.m3u8`;
    const chosenUrl = ext === 'm3u8' ? directM3u8Url : directTsUrl;

    return {
      stream_id: s.stream_id,
      name,
      category_id: catId,
      isSoccer,
      isAdult,
      matchInfo: isSoccer ? '⚽ Esportes & Futebol Ao Vivo' : '',
      logo: s.stream_icon || '',
      epgNow: 'Transmissão Ao Vivo',
      epgNext: 'Programação Normal',
      rawStreamUrl: chosenUrl,
      streamUrl: wrapProxyUrl(chosenUrl),
      fallbackTsUrl: wrapProxyUrl(directTsUrl)
    };
  });

  const vodCategories = (Array.isArray(vodCatsRes) ? vodCatsRes : []).map(c => ({
    category_id: String(c.category_id),
    category_name: formatCleanCategoryName(c.category_name),
    isAdult: /adult|\+18|xxx|sexo|erot/i.test(c.category_name || ''),
    count: 0
  }));
  const vodCatMap = new Map(vodCategories.map(c => [c.category_id, c]));

  // 100% dos Filmes VOD da lista (TODOS os 18.266+ filmes, sem .slice!)
  const vodStreams = (Array.isArray(vodStreamsRes) ? vodStreamsRes : []).map(v => {
    const catId = String(v.category_id || (Array.isArray(v.category_ids) && v.category_ids[0]) || 'geral');
    if (!vodCatMap.has(catId)) {
      const newCat = { category_id: catId, category_name: `Grupo ${catId}`, isAdult: false, count: 0 };
      vodCategories.push(newCat);
      vodCatMap.set(catId, newCat);
    }
    vodCatMap.get(catId).count++;

    const container = v.container_extension || 'mp4';
    const directVodUrl = `${baseUrl}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${v.stream_id}.${container}`;
    const isAdult = (vodCatMap.get(catId) && vodCatMap.get(catId).isAdult) || /adult|\+18|xxx/i.test(v.name || '');

    return {
      stream_id: v.stream_id,
      name: v.name || v.title || 'Filme',
      category_id: catId,
      isAdult,
      year: v.year || 'VOD',
      rating: v.rating || '8.5',
      duration: container.toUpperCase(),
      poster: v.stream_icon || '',
      rawStreamUrl: directVodUrl,
      streamUrl: wrapProxyUrl(directVodUrl)
    };
  });

  const seriesCategories = (Array.isArray(seriesCatsRes) ? seriesCatsRes : []).map(c => ({
    category_id: String(c.category_id),
    category_name: formatCleanCategoryName(c.category_name),
    isAdult: /adult|\+18|xxx|sexo/i.test(c.category_name || ''),
    count: 0
  }));
  const seriesCatMap = new Map(seriesCategories.map(c => [c.category_id, c]));

  // 100% das Séries da lista (TODAS as 8.582+ séries, sem .slice!)
  const seriesList = (Array.isArray(seriesListRes) ? seriesListRes : []).map(sr => {
    const catId = String(sr.category_id || (Array.isArray(sr.category_ids) && sr.category_ids[0]) || 'geral');
    if (!seriesCatMap.has(catId)) {
      const newCat = { category_id: catId, category_name: `Grupo ${catId}`, isAdult: false, count: 0 };
      seriesCategories.push(newCat);
      seriesCatMap.set(catId, newCat);
    }
    seriesCatMap.get(catId).count++;

    return {
      series_id: sr.series_id,
      name: sr.name || sr.title || 'Série',
      category_id: catId,
      isAdult: seriesCatMap.get(catId) ? seriesCatMap.get(catId).isAdult : false,
      year: sr.year || sr.releaseDate || 'Série',
      rating: sr.rating || '9.0',
      description: sr.plot || '',
      poster: sr.cover || ''
    };
  });

  const resultCatalog = {
    isRealList: true,
    xtreamOrigin: { baseUrl, username, password },
    counts: {
      live: liveStreams.length,
      vod: vodStreams.length,
      series: seriesList.length
    },
    liveCategories,
    liveStreams,
    vodCategories,
    vodStreams,
    seriesCategories,
    seriesList
  };

  catalogCache.set(cacheKey, { timestamp: Date.now(), catalog: resultCatalog });
  saveCatalogCacheToDisk();
  return resultCatalog;
}

// Rota para buscar Temporadas, Episódios, Capas 16:9, Elenco e Backdrop de qualquer Série
app.post('/api/player/series-info', async (req, res) => {
  const { seriesId, baseUrl, username, password } = req.body;
  if (!seriesId || !baseUrl || !username || !password) {
    return res.status(400).json({ ok: false, error: 'Parâmetros de série incompletos.' });
  }
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
    const data = await fetch(url, { headers: IPTV_HEADERS }).then(r => r.json());
    const episodesBySeason = {};
    const seriesInfo = (data && data.info) || {};

    let backdropUrl = '';
    if (Array.isArray(seriesInfo.backdrop_path) && seriesInfo.backdrop_path[0]) {
      backdropUrl = seriesInfo.backdrop_path[0];
    } else if (typeof seriesInfo.backdrop_path === 'string' && seriesInfo.backdrop_path) {
      backdropUrl = seriesInfo.backdrop_path;
    }

    let extraCast = seriesInfo.cast || seriesInfo.actors || '';
    let extraGenre = seriesInfo.genre || '';
    let extraPlot = seriesInfo.plot || '';

    if (data && data.episodes) {
      for (const [seasonNum, epList] of Object.entries(data.episodes)) {
        episodesBySeason[seasonNum] = (Array.isArray(epList) ? epList : []).map(ep => {
          const ext = ep.container_extension || 'mp4';
          const directUrl = `${baseUrl.replace(/\/+$/, '')}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${ep.id}.${ext}`;
          const epInfo = ep.info || {};

          if (!backdropUrl && Array.isArray(epInfo.backdrop_path) && epInfo.backdrop_path[0]) {
            backdropUrl = epInfo.backdrop_path[0];
          }
          if (!backdropUrl && epInfo.cover_big) {
            backdropUrl = epInfo.cover_big;
          }
          if (!extraCast && (epInfo.cast || epInfo.actors)) {
            extraCast = epInfo.cast || epInfo.actors;
          }
          if (!extraGenre && epInfo.genre) {
            extraGenre = epInfo.genre;
          }
          if (!extraPlot && (epInfo.plot || epInfo.description)) {
            extraPlot = epInfo.plot || epInfo.description;
          }

          const thumb =
            epInfo.cover_big ||
            (Array.isArray(epInfo.backdrop_path) && epInfo.backdrop_path[0]) ||
            epInfo.movie_image ||
            seriesInfo.cover ||
            'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=500&auto=format&fit=crop&q=80';

          return {
            id: ep.id,
            episode_num: ep.episode_num,
            title: ep.title || `Episódio ${ep.episode_num}`,
            season: String(seasonNum),
            duration: epInfo.duration || ext.toUpperCase(),
            plot: epInfo.plot || epInfo.description || '',
            thumbnail: thumb,
            rawStreamUrl: directUrl,
            streamUrl: wrapProxyUrl(directUrl)
          };
        });
      }
    }

    // Melhora resolução do backdrop TMDB quando disponível
    const hiResBackdrop = (backdropUrl || seriesInfo.cover || '').replace('/w500/', '/w1280/');

    return res.json({
      ok: true,
      info: {
        ...seriesInfo,
        backdrop: hiResBackdrop,
        cast: extraCast,
        genre: extraGenre,
        plot: extraPlot
      },
      seasons: episodesBySeason
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Mantém controle do stream ativo para fechar conexões antigas imediatamente (essencial para listas de 1 conexão)
let activeUpstreamAbort = null;
let activeUpstreamNodeStream = null;
let activeUpstreamTargetUrl = null;
const vodRedirectCache = new Map();
const os = require('os');

function getServerLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && (net.address.startsWith('192.168.') || net.address.startsWith('10.') || net.address.startsWith('172.'))) {
          return net.address;
        }
      }
    }
  } catch (_) {}
  return '';
}

app.get('/api/network-info', (req, res) => {
  const lanIp = getServerLanIp();
  res.json({
    ok: true,
    lanIp,
    lanOrigin: lanIp ? `http://${lanIp}:${PORT}` : ''
  });
});

// Resolve URL direta / CDN (seguindo redirecionamento 302) e URL de Proxy na rede Wi-Fi para o Chromecast
app.get('/api/proxy/resolve-cast-url', async (req, res) => {
  const targetUrl = String(req.query.url || '').trim();
  if (!targetUrl || !isSafeExternalStreamUrl(targetUrl)) {
    return res.status(400).json({ ok: false, error: 'URL inválida.' });
  }

  const lanIp = getServerLanIp();
  const lanOrigin = lanIp ? `http://${lanIp}:${PORT}` : `${req.protocol}://${req.get('host')}`;
  const lanProxyUrl = `${lanOrigin}/api/proxy/stream?url=${encodeURIComponent(targetUrl)}`;

  const cached = vodRedirectCache.get(targetUrl);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return res.json({
      ok: true,
      resolvedUrl: cached.url,
      lanProxyUrl
    });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'IPTVSmartersPlayer',
        'Accept': '*/*',
        'Range': 'bytes=0-1'
      },
      redirect: 'follow',
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const finalUrl = upstream.url || targetUrl;
    try {
      if (upstream.body) upstream.body.cancel();
    } catch (_) {}
    if (finalUrl && finalUrl !== targetUrl) {
      vodRedirectCache.set(targetUrl, { url: finalUrl, ts: Date.now() });
    }
    return res.json({
      ok: true,
      resolvedUrl: finalUrl,
      lanProxyUrl
    });
  } catch (err) {
    return res.json({
      ok: true,
      resolvedUrl: targetUrl,
      lanProxyUrl
    });
  }
});

// Descoberta de Smart TVs e Chromecasts na mesma rede Wi-Fi (SSDP / UPnP / DIAL)
const dgram = require('dgram');
const discoveredLanTvsCache = new Map();

function scanLanTvsViaSsdp(timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const locations = new Map();

    socket.on('message', (msg, rinfo) => {
      try {
        const text = msg.toString('utf8');
        const locMatch = text.match(/LOCATION:\s*(http[^\r\n]+)/i);
        if (locMatch && locMatch[1]) {
          locations.set(locMatch[1].trim(), rinfo.address);
        }
      } catch (_) {}
    });

    socket.on('error', () => {});

    socket.bind(() => {
      try {
        const targets = [
          'urn:schemas-upnp-org:service:AVTransport:1',
          'urn:schemas-upnp-org:device:MediaRenderer:1',
          'urn:dial-multiscreen-org:service:dial:1'
        ];
        for (const st of targets) {
          const payload = Buffer.from(
            `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`,
            'utf8'
          );
          socket.send(payload, 0, payload.length, 1900, '239.255.255.250');
        }
      } catch (_) {}
    });

    setTimeout(async () => {
      try {
        socket.close();
      } catch (_) {}

      const entries = Array.from(locations.entries());
      await Promise.all(
        entries.map(async ([locUrl, ip]) => {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 1500);
            const resp = await fetch(locUrl, { signal: ctrl.signal });
            clearTimeout(t);
            if (!resp.ok) return;
            const xml = await resp.text();
            const lower = xml.toLowerCase();
            if (!lower.includes('avtransport') && !lower.includes('mediarenderer') && !lower.includes('dial')) {
              return;
            }
            const fnMatch = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/i);
            const mdMatch = xml.match(/<modelName>([^<]+)<\/modelName>/i);
            if (!fnMatch || !fnMatch[1]) return;
            const friendlyName = fnMatch[1].trim();
            const modelName = mdMatch && mdMatch[1] ? mdMatch[1].trim() : 'Smart TV Wi-Fi';

            let controlUrl = '';
            const avIdx = xml.indexOf('AVTransport');
            if (avIdx !== -1) {
              const sub = xml.slice(avIdx);
              const ctrlMatch = sub.match(/<controlURL>([^<]+)<\/controlURL>/i);
              if (ctrlMatch && ctrlMatch[1]) {
                const rawCtrl = ctrlMatch[1].trim();
                const u = new URL(locUrl);
                controlUrl = rawCtrl.startsWith('http')
                  ? rawCtrl
                  : `${u.protocol}//${u.host}${rawCtrl.startsWith('/') ? '' : '/'}${rawCtrl}`;
              }
            }

            const id = `dlna:${ip}:${friendlyName}`;
            discoveredLanTvsCache.set(id, {
              id,
              name: friendlyName,
              model: modelName,
              type: controlUrl ? 'dlna' : 'chromecast',
              ip,
              controlUrl
            });
          } catch (_) {}
        })
      );

      resolve(Array.from(discoveredLanTvsCache.values()));
    }, timeoutMs);
  });
}

app.get('/api/cast/discover-tvs', async (req, res) => {
  try {
    const devices = await scanLanTvsViaSsdp(1600);
    res.json({ ok: true, devices });
  } catch (err) {
    res.json({ ok: true, devices: Array.from(discoveredLanTvsCache.values()) });
  }
});

app.post('/api/cast/play-dlna', async (req, res) => {
  const { deviceId, streamUrl, title, mimeType } = req.body || {};
  const dev = discoveredLanTvsCache.get(String(deviceId || ''));
  if (!dev || !dev.controlUrl) {
    return res.status(404).json({ ok: false, error: 'TV DLNA não encontrada ou exige conexão via Google Cast.' });
  }
  try {
    const escUrl = String(streamUrl || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escTitle = String(title || '3A Stream').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const mime = mimeType || 'video/mp4';
    const setUriXml = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escUrl}</CurrentURI>
      <CurrentURIMetaData>&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;&lt;item id="0" parentID="-1" restricted="1"&gt;&lt;dc:title&gt;${escTitle}&lt;/dc:title&gt;&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;&lt;res protocolInfo="http-get:*:${mime}:*"&gt;${escUrl}&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;

    const r1 = await fetch(dev.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"'
      },
      body: setUriXml
    });

    if (r1.ok) {
      const playXml = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;
      await fetch(dev.controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': '"urn:schemas-upnp-org:service:AVTransport:1#Play"'
        },
        body: playXml
      });
      return res.json({ ok: true, deviceName: dev.name });
    }
    return res.status(502).json({ ok: false, error: 'A Smart TV recusou o comando UPnP.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy de Stream Anti-CORS para listas reais (.ts, .m3u8 e .mp4)
app.get('/api/proxy/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');
  if (!isSafeExternalStreamUrl(targetUrl)) {
    return res.status(403).send('Forbidden target URL');
  }

  const isVodOrSeries = targetUrl.includes('/movie/') || targetUrl.includes('/series/') || targetUrl.endsWith('.mp4') || targetUrl.endsWith('.mkv');
  const isSameVodTarget = isVodOrSeries && activeUpstreamTargetUrl === targetUrl;

  // Encerra imediatamente o stream anterior ao trocar de canal/filme/episódio ou em canais ao vivo (respeita max_connections=1 sem quebrar múltiplos Range requests do mesmo MP4)
  if (!isSameVodTarget) {
    if (activeUpstreamNodeStream) {
      try { activeUpstreamNodeStream.destroy(); } catch (_) {}
      activeUpstreamNodeStream = null;
    }
    if (activeUpstreamAbort) {
      try { activeUpstreamAbort.abort(); } catch (_) {}
      activeUpstreamAbort = null;
    }
  }

  const abortController = new AbortController();
  activeUpstreamAbort = abortController;
  activeUpstreamTargetUrl = targetUrl;

  req.on('close', () => {
    try { abortController.abort(); } catch (_) {}
  });

  try {
    const headers = {
      'User-Agent': 'IPTVSmartersPlayer',
      'Accept': '*/*',
      'Connection': 'keep-alive'
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    // Reutiliza URL final de redirecionamento em cache para Filmes e Séries (evita gerar múltiplos tokens em Range requests simultâneos)
    let fetchUrl = targetUrl;
    const cachedRedirect = vodRedirectCache.get(targetUrl);
    if (cachedRedirect && Date.now() - cachedRedirect.ts < 5 * 60 * 1000) {
      fetchUrl = cachedRedirect.url;
    }

    let upstream = await fetch(fetchUrl, {
      headers,
      redirect: 'follow',
      signal: abortController.signal
    });

    // Se o token em cache expirou, refaz a partir da URL original
    if (!upstream.ok && upstream.status !== 206 && fetchUrl !== targetUrl) {
      vodRedirectCache.delete(targetUrl);
      fetchUrl = targetUrl;
      upstream = await fetch(targetUrl, {
        headers,
        redirect: 'follow',
        signal: abortController.signal
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || fetchUrl;
    if (finalUrl && finalUrl !== targetUrl && isVodOrSeries) {
      vodRedirectCache.set(targetUrl, { url: finalUrl, ts: Date.now() });
    }

    const proxyHostPrefix = `${req.protocol}://${req.get('host')}`;

    // Se for playlist HLS (.m3u8), reescreve os caminhos relativos para passarem pelo proxy
    if (
      (targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegurl')) &&
      !contentType.includes('mp2t')
    ) {
      const m3u8Text = await upstream.text();
      const baseOriginUrl = new URL(finalUrl);
      const basePath = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

      const rewritten = m3u8Text
        .split(/\r?\n/)
        .map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          let absUrl = trimmed;
          if (/^https?:\/\//i.test(trimmed)) {
            absUrl = trimmed;
          } else if (trimmed.startsWith('/')) {
            absUrl = `${baseOriginUrl.origin}${trimmed}`;
          } else {
            absUrl = `${basePath}${trimmed}`;
          }
          return `${proxyHostPrefix}/api/proxy/stream?url=${encodeURIComponent(absUrl)}`;
        })
        .join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewritten);
    }

    // Stream binário contínuo (.ts, .mp4, .mkv, segmentos HLS)
    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    const urlLower = (`${finalUrl} ${targetUrl}`).toLowerCase();
    let resolvedMime = contentType;
    if (
      !resolvedMime ||
      resolvedMime === 'application/octet-stream' ||
      resolvedMime === 'binary/octet-stream' ||
      resolvedMime.includes('text/html') ||
      resolvedMime.includes('text/plain')
    ) {
      if (urlLower.includes('.mkv')) resolvedMime = 'video/x-matroska';
      else if (urlLower.includes('.webm')) resolvedMime = 'video/webm';
      else if (urlLower.includes('.mp4') || urlLower.includes('.m4v') || urlLower.includes('/movie/') || urlLower.includes('/series/')) resolvedMime = 'video/mp4';
      else resolvedMime = 'video/mp2t';
    }
    res.setHeader('Content-Type', resolvedMime);

    // Sempre normaliza Accept-Ranges para 'bytes' (corrige servidores XUI que enviam '0-735130532' inválido)
    if (
      upstream.headers.get('accept-ranges') ||
      urlLower.includes('.mp4') ||
      urlLower.includes('.mkv') ||
      urlLower.includes('/movie/') ||
      urlLower.includes('/series/')
    ) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    if (String(req.query.download || '') === '1') {
      const rawName = String(req.query.filename || 'Video_3A_Stream.mp4')
        .replace(/["\r\n\\/:*?<>|]+/g, '_')
        .trim();
      const finalFilename = rawName.toLowerCase().endsWith('.mp4') ? rawName : `${rawName}.mp4`;
      res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);
    }

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      activeUpstreamNodeStream = nodeStream;
      nodeStream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      res.on('close', () => {
        try { nodeStream.destroy(); } catch (_) {}
      });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send('Stream encerrado ou erro: ' + err.message);
    }
  }
});

// Função unificada para resolver a lista IPTV de um cliente (seja Xtream, M3U com get.php ou M3U puro)
async function resolveIptvCatalog({ iptvSourceType, xtreamUrl, xtreamUser, xtreamPass, m3uUrl, preferredFormat }) {
  if (iptvSourceType === 'xtream' && xtreamUrl && xtreamUser && xtreamPass) {
    const catalog = await fetchXtreamCatalog(xtreamUrl, xtreamUser, xtreamPass, preferredFormat || 'ts');
    return { catalog, sourceLabel: `Xtream API (${xtreamUrl})` };
  }

  if (iptvSourceType === 'm3u' && m3uUrl) {
    // 1. Verifica se o link M3U é um link Xtream/XUI (ex: http://sev3u.sbs:80/get.php?username=...&password=...)
    const detectedXtream = extractXtreamFromM3uUrl(m3uUrl);
    if (detectedXtream) {
      const catalog = await fetchXtreamCatalog(
        detectedXtream.baseUrl,
        detectedXtream.username,
        detectedXtream.password,
        preferredFormat || detectedXtream.preferredFormat
      );
      return {
        catalog,
        sourceLabel: `Servidor IPTV (${detectedXtream.baseUrl} • ${catalog.liveStreams.length} Canais)`
      };
    }

    // 2. Caso seja um arquivo .m3u estático comum
    const response = await fetch(m3uUrl, { headers: IPTV_HEADERS });
    const text = await response.text();
    const parsed = parseM3uContent(text);
    if (parsed.liveStreams.length === 0 && parsed.vodStreams.length === 0) {
      throw new Error('A URL M3U não retornou canais válidos.');
    }
    return {
      catalog: parsed,
      sourceLabel: `Lista M3U (${parsed.liveStreams.length} Canais)`
    };
  }

  return { catalog: DEMO_CATALOG, sourceLabel: 'Servidor 3A Stream Oficial (Demo)' };
}

// ============================================================================
// ROTAS DA API DO PLAYER (3A STREAM APP)
// ============================================================================

// 1. Login do Cliente no Aplicativo 3A Stream (ou Login por MAC Address)
app.post('/api/player/login', async (req, res) => {
  if (isLoginRateLimited(req)) {
    return res.status(429).json({
      ok: false,
      error: 'Muitas tentativas de login seguidas. Aguarde alguns minutos e tente novamente.'
    });
  }

  const { username, password, macAddress, preferredFormat } = req.body || {};
  const db = loadDb();

  let client = null;
  if (username && password) {
    client = db.clients.find(
      c => c.username.toLowerCase() === String(username).trim().toLowerCase() && verifyPasswordMatch(password, c.password)
    );
  } else if (macAddress) {
    client = db.clients.find(
      c => (c.macAddress || '').toUpperCase() === String(macAddress).trim().toUpperCase()
    );
  }

  if (!client) {
    recordFailedLoginAttempt(req);
    return res.status(401).json({
      ok: false,
      error: 'Usuário ou senha inválidos. Verifique seus dados com o suporte 3A Stream.'
    });
  }

  clearFailedLoginAttempts(req);

  const expired = isExpired(client.expiresAt);
  if (client.status === 'blocked' || expired) {
    return res.status(403).json({
      ok: false,
      code: 'SUBSCRIPTION_INACTIVE',
      error: expired
        ? `Sua assinatura venceu em ${formatDateBr(client.expiresAt)}. Entre em contato para renovar.`
        : 'Sua conta está temporariamente suspensa. Contate o administrador 3A Stream.',
      expiresAtFormatted: formatDateBr(client.expiresAt),
      supportWhatsapp: db.settings.supportWhatsapp
    });
  }

  if (macAddress && String(macAddress).trim() !== 'AUTO') {
    client.macAddress = String(macAddress).trim().toUpperCase();
  }
  client.lastLoginAt = new Date().toISOString();
  saveDb(db);

  let catalog = DEMO_CATALOG;
  let sourceLabel = 'Servidor 3A Stream Oficial (Integrado)';

  try {
    const resolved = await resolveIptvCatalog({
      iptvSourceType: client.iptvSourceType,
      xtreamUrl: client.xtreamUrl,
      xtreamUser: client.xtreamUser,
      xtreamPass: client.xtreamPass,
      m3uUrl: client.m3uUrl,
      preferredFormat: preferredFormat || 'ts'
    });
    catalog = resolved.catalog;
    sourceLabel = resolved.sourceLabel;
  } catch (err) {
    console.warn('Aviso: Falha ao carregar fonte externa:', err.message);
  }

  let resolvedXtreamOrigin = catalog && catalog.xtreamOrigin ? catalog.xtreamOrigin : null;
  if (!resolvedXtreamOrigin) {
    if (client.xtreamUrl && client.xtreamUser && client.xtreamPass) {
      resolvedXtreamOrigin = {
        baseUrl: client.xtreamUrl.trim().replace(/\/+$/, ''),
        username: client.xtreamUser.trim(),
        password: client.xtreamPass.trim()
      };
    } else if (client.m3uUrl) {
      const extX = extractXtreamFromM3uUrl(client.m3uUrl);
      if (extX) {
        resolvedXtreamOrigin = {
          baseUrl: extX.baseUrl,
          username: extX.username,
          password: extX.password
        };
      }
    }
  }

  return res.json({
    ok: true,
    profile: {
      id: client.id,
      name: client.name,
      username: client.username,
      macAddress: client.macAddress || macAddress || '61:F3:CF:92:93:B1',
      planName: client.planName,
      expiresAt: client.expiresAt,
      expiresAtFormatted: formatDateBr(client.expiresAt),
      parentalPin: client.parentalPin || '0000',
      iptvSourceType: client.iptvSourceType || 'demo',
      sourceLabel,
      maxConnections: client.maxConnections || 1,
      xtreamOrigin: resolvedXtreamOrigin
    },
    settings: db.settings,
    catalog
  });
});

// 2. Testar / Carregar Lista Manual Xtream API ou M3U (para função "Add Conta / Playlists" no app)
app.post('/api/player/custom-playlist', async (req, res) => {
  const { mode, xtreamUrl, xtreamUser, xtreamPass, m3uUrl, preferredFormat } = req.body;
  try {
    const resolved = await resolveIptvCatalog({
      iptvSourceType: mode,
      xtreamUrl,
      xtreamUser,
      xtreamPass,
      m3uUrl,
      preferredFormat: preferredFormat || 'ts'
    });
    return res.json({ ok: true, sourceLabel: resolved.sourceLabel, catalog: resolved.catalog });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `Não foi possível conectar ao servidor informado: ${err.message}`
    });
  }
});

// ============================================================================
// AUTENTICAÇÃO E ROTAS PROTEGIDAS DO PAINEL DE CONTROLE (ADMIN DASHBOARD)
// ============================================================================
const ADMIN_MASTER_USER = process.env.ADMIN_USER || 'asmj10';
// Hash criptográfico SHA-256 com salt (a senha em texto plano NUNCA fica exposta no código-fonte)
const ADMIN_MASTER_PASS_HASH = 'sha256:abd2c430490bf153d05c27fbb5b9703be7153d3aaf0c61abf013d34c808b85c9';
const ADMIN_TOKEN_SECRET = process.env.ADMIN_SECRET || '3a_stream_master_secret_2026_balok_v2_shield';
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function generateAdminToken(username) {
  const cleanUser = String(username).trim().toLowerCase();
  const issuedAt = Date.now();
  const payload = `${cleanUser}.${issuedAt}`;
  const sig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [user, issuedAtStr, sig] = parts;
  if (user !== ADMIN_MASTER_USER.toLowerCase()) return false;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > ADMIN_TOKEN_TTL_MS) return false;

  const expected = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(`${user}.${issuedAtStr}`).digest('hex');
  const bufA = Buffer.from(sig);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!verifyAdminToken(token)) {
    return res.status(401).json({
      ok: false,
      error: 'Acesso restrito ou sessão expirada. Faça login como Administrador.'
    });
  }
  next();
}

// Login do Administrador no Painel (/admin)
app.post('/api/admin/login', (req, res) => {
  if (isLoginRateLimited(req)) {
    return res.status(429).json({
      ok: false,
      error: 'Muitas tentativas de login. Aguarde alguns minutos antes de tentar novamente.'
    });
  }

  const { username, password } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '').trim();

  const expectedAuth = process.env.ADMIN_PASS ? process.env.ADMIN_PASS : ADMIN_MASTER_PASS_HASH;
  if (u.toLowerCase() === ADMIN_MASTER_USER.toLowerCase() && verifyPasswordMatch(p, expectedAuth)) {
    clearFailedLoginAttempts(req);
    return res.json({
      ok: true,
      token: generateAdminToken(u),
      adminName: 'Balok (Administrador 3A)'
    });
  }

  recordFailedLoginAttempt(req);
  return res.status(401).json({
    ok: false,
    error: 'Credenciais de Administrador inválidas.'
  });
});

app.get('/api/admin/overview', requireAdminAuth, (req, res) => {
  const db = loadDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const in7Days = new Date(today);
  in7Days.setDate(in7Days.getDate() + 7);

  let activeCount = 0;
  let expiringSoonCount = 0;
  let expiredOrBlockedCount = 0;
  let monthlyRevenue = 0;

  const enrichedClients = db.clients.map(c => {
    const expired = isExpired(c.expiresAt);
    const expDate = new Date(c.expiresAt + 'T23:59:59');
    const isExpiringSoon = !expired && expDate <= in7Days && c.status === 'active';
    const effectiveStatus = c.status === 'blocked' ? 'blocked' : expired ? 'expired' : 'active';

    if (effectiveStatus === 'active') {
      activeCount++;
      monthlyRevenue += Number(c.monthlyPrice || 0);
    } else {
      expiredOrBlockedCount++;
    }
    if (isExpiringSoon) {
      expiringSoonCount++;
    }

    const displayPassword = String(c.password || '').startsWith('sha256:')
      ? '••••••••'
      : c.password;

    return {
      ...c,
      password: displayPassword,
      effectiveStatus,
      isExpiringSoon,
      expiresAtFormatted: formatDateBr(c.expiresAt)
    };
  });

  const enrichedPayments = (db.payments || []).map(p => ({
    ...p,
    dateFormatted: formatDateBr(p.date)
  }));

  res.json({
    ok: true,
    stats: {
      totalClients: db.clients.length,
      activeCount,
      expiringSoonCount,
      expiredOrBlockedCount,
      monthlyRevenue
    },
    settings: db.settings,
    iptvServers: db.iptvServers,
    clients: enrichedClients,
    payments: enrichedPayments
  });
});

// Criar ou Atualizar Cliente no Painel Admin
app.post('/api/admin/clients', requireAdminAuth, (req, res) => {
  const db = loadDb();
  const payload = req.body;

  if (!payload.name || !payload.username || !payload.password) {
    return res.status(400).json({ ok: false, error: 'Nome, Usuário e Senha são obrigatórios.' });
  }

  if (payload.id) {
    const idx = db.clients.findIndex(c => c.id === payload.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Cliente não encontrado.' });
    const preservedPassword = payload.password === '••••••••'
      ? db.clients[idx].password
      : payload.password.trim();
    db.clients[idx] = { ...db.clients[idx], ...payload, password: preservedPassword };
    saveDb(db);
    return res.json({ ok: true, client: db.clients[idx] });
  }

  const duplicate = db.clients.find(c => c.username.toLowerCase() === payload.username.toLowerCase());
  if (duplicate) {
    return res.status(400).json({ ok: false, error: 'Já existe um cliente com este nome de usuário.' });
  }

  const newClient = {
    id: 'cli_' + Date.now(),
    name: payload.name,
    phone: payload.phone || '',
    username: payload.username.trim(),
    password: payload.password.trim(),
    macAddress: (payload.macAddress || '61:F3:CF:92:93:B1').toUpperCase(),
    planName: payload.planName || 'Plano 3A Completo 4K',
    monthlyPrice: Number(payload.monthlyPrice || 35),
    expiresAt: payload.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    status: payload.status || 'active',
    parentalPin: payload.parentalPin || '0000',
    iptvSourceType: payload.iptvSourceType || 'demo',
    xtreamUrl: payload.xtreamUrl || '',
    xtreamUser: payload.xtreamUser || '',
    xtreamPass: payload.xtreamPass || '',
    m3uUrl: payload.m3uUrl || '',
    maxConnections: Number(payload.maxConnections || 1),
    notes: payload.notes || '',
    lastLoginAt: null
  };

  db.clients.unshift(newClient);
  saveDb(db);
  res.json({ ok: true, client: newClient });
});

// Renovar Mensalidade (+30 dias) e registrar pagamento
app.post('/api/admin/clients/:id/renew', requireAdminAuth, (req, res) => {
  const db = loadDb();
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'Cliente não encontrado.' });

  const days = Number(req.body.days || 30);
  const today = new Date();
  const currentExp = client.expiresAt ? new Date(client.expiresAt + 'T12:00:00') : today;
  const baseDate = currentExp > today ? currentExp : today;
  baseDate.setDate(baseDate.getDate() + days);

  client.expiresAt = baseDate.toISOString().split('T')[0];
  client.status = 'active';

  db.payments.unshift({
    id: 'pay_' + Date.now(),
    clientId: client.id,
    clientName: client.name,
    amount: Number(client.monthlyPrice || 35),
    date: new Date().toISOString().split('T')[0],
    method: req.body.method || 'PIX',
    status: 'paid'
  });

  saveDb(db);
  res.json({ ok: true, client });
});

// Alternar Status Ativo / Bloqueado
app.post('/api/admin/clients/:id/toggle-status', requireAdminAuth, (req, res) => {
  const db = loadDb();
  const client = db.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ ok: false, error: 'Cliente não encontrado.' });

  client.status = client.status === 'active' ? 'blocked' : 'active';
  saveDb(db);
  res.json({ ok: true, client });
});

// Excluir Cliente
app.delete('/api/admin/clients/:id', requireAdminAuth, (req, res) => {
  const db = loadDb();
  db.clients = db.clients.filter(c => c.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// Excluir Registro de Mensalidade / Pagamento
app.delete('/api/admin/payments/:id', requireAdminAuth, (req, res) => {
  const db = loadDb();
  db.payments = (db.payments || []).filter(p => p.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// Health-check para Render.com / Koyeb e monitor anti-hibernação (UptimeRobot / cron-job.org)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    service: '3A Stream Cloud Server',
    timestamp: new Date().toISOString()
  });
});

// Servir arquivos estáticos do Player e do Painel Admin
app.use('/player', express.static(path.join(__dirname, 'public', 'player')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// Rota direta para download do APK Mobile compilado
app.get('/3A-Stream-Mobile.apk', (req, res) => {
  const apkPath = path.join(__dirname, '3A-Stream-Mobile.apk');
  if (fs.existsSync(apkPath)) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="3A-Stream-Mobile.apk"');
    return res.sendFile(apkPath);
  }
  res.status(404).send('APK ainda não encontrado na raiz do projeto.');
});

// Rota raiz redireciona para o Player (Login do Cliente)
app.get('/', (req, res) => {
  res.redirect('/player');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=============================================================`);
  console.log(`🚀 3A STREAM ECOSYSTEM RODANDO COM SUCESSO!`);
  console.log(`📊 Painel de Controle (Admin): http://localhost:${PORT}/admin`);
  console.log(`📺 App Android / Player 3A:    http://localhost:${PORT}/player`);
  console.log(`📲 Download APK Mobile:        http://localhost:${PORT}/3A-Stream-Mobile.apk`);
  console.log(`=============================================================\n`);
});
