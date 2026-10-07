let adminState = {
  clients: [],
  payments: [],
  stats: {}
};

document.addEventListener('DOMContentLoaded', () => {
  initAdminDialogFallback();
  loadAdminOverview();
});

function initAdminDialogFallback() {
  const dialog = document.getElementById('clientDialog');
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

async function loadAdminOverview() {
  try {
    const res = await fetch('/api/admin/overview');
    const data = await res.json();
    if (!data.ok) return;

    adminState.clients = data.clients || [];
    adminState.payments = data.payments || [];
    adminState.stats = data.stats || {};

    document.getElementById('kpiTotal').textContent = data.stats.totalClients;
    document.getElementById('kpiActive').textContent = data.stats.activeCount;
    document.getElementById('kpiSoon').textContent = data.stats.expiringSoonCount;
    document.getElementById('kpiBlocked').textContent = data.stats.expiredOrBlockedCount;
    document.getElementById('kpiRevenue').textContent =
      'R$ ' + Number(data.stats.monthlyRevenue || 0).toFixed(2).replace('.', ',');

    renderClientsTable();
    renderPaymentsTable();
  } catch (err) {
    console.error('Erro ao carregar painel:', err);
  }
}

function renderClientsTable() {
  const tbody = document.getElementById('clientsTableBody');
  const q = (document.getElementById('searchClientInput').value || '').toLowerCase().trim();
  tbody.innerHTML = '';

  const filtered = adminState.clients.filter(c => {
    if (!q) return true;
    return (
      (c.name || '').toLowerCase().includes(q) ||
      (c.username || '').toLowerCase().includes(q) ||
      (c.macAddress || '').toLowerCase().includes(q)
    );
  });

  filtered.forEach(c => {
    const tr = document.createElement('tr');

    let statusBadge = `<span class="badge badge-active">🟢 ATIVO</span>`;
    if (c.effectiveStatus === 'blocked') {
      statusBadge = `<span class="badge badge-blocked">🔴 BLOQUEADO</span>`;
    } else if (c.effectiveStatus === 'expired') {
      statusBadge = `<span class="badge badge-expired">⚠️ VENCIDO</span>`;
    } else if (c.isExpiringSoon) {
      statusBadge = `<span class="badge badge-soon">⏳ VENCE EM BREVE</span>`;
    }

    const sourceBadge =
      c.iptvSourceType === 'xtream'
        ? `🌐 Xtream API`
        : c.iptvSourceType === 'm3u'
        ? `📋 Lista M3U`
        : `⚡ 3A Padrão (HLS)`;

    tr.innerHTML = `
      <td>
        <div style="font-weight:700;">${c.name}</div>
        <div style="font-size:11.5px;color:#9ca3af;">${c.phone || 'Sem telefone'}</div>
      </td>
      <td>
        <div>👤 <strong>${c.username}</strong></div>
        <div style="font-size:11.5px;color:#9ca3af;">🔑 Senha: <code>${c.password}</code></div>
      </td>
      <td><code>${c.macAddress || '61:F3:CF:92:93:B1'}</code></td>
      <td>${sourceBadge}</td>
      <td>
        <div>${c.planName}</div>
        <div style="font-size:12px;color:#4ade80;font-weight:700;">R$ ${Number(c.monthlyPrice || 0).toFixed(2).replace('.', ',')}/mês</div>
      </td>
      <td><strong>${c.expiresAtFormatted}</strong></td>
      <td>${statusBadge}</td>
      <td>
        <div class="actions-cell">
          <a href="/player?user=${encodeURIComponent(c.username)}&pass=${encodeURIComponent(c.password)}" class="btn btn-blue btn-sm" title="Abrir e testar no Player Android">▶️ Testar App</a>
          <button type="button" class="btn btn-green btn-sm" onclick="renewClient('${c.id}')" title="Renovar +30 dias">+30 Dias</button>
          <button type="button" class="btn btn-dark btn-sm" onclick="editClient('${c.id}')">✏️ Editar</button>
          <button type="button" class="btn btn-dark btn-sm" onclick="copyWhatsappAccess('${c.id}')" title="Copiar dados para enviar no WhatsApp">📲 WhatsApp</button>
          <button type="button" class="btn btn-dark btn-sm" onclick="toggleClientStatus('${c.id}')">${c.status === 'active' ? '🔒 Bloquear' : '🔓 Liberar'}</button>
          <button type="button" class="btn btn-red btn-sm" onclick="deleteClient('${c.id}')">🗑️</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPaymentsTable() {
  const tbody = document.getElementById('paymentsTableBody');
  tbody.innerHTML = '';
  (adminState.payments || []).slice(0, 8).forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.date}</td>
      <td><strong>${p.clientName}</strong></td>
      <td>${p.method}</td>
      <td style="color:#4ade80;font-weight:700;">R$ ${Number(p.amount || 0).toFixed(2).replace('.', ',')}</td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleClientIptvFields() {
  const type = document.getElementById('cliSourceType').value;
  document.getElementById('adminXtreamFields').style.display = type === 'xtream' ? 'grid' : 'none';
  document.getElementById('adminM3uFields').style.display = type === 'm3u' ? 'block' : 'none';
}

function openClientModal(client = null) {
  const dialog = document.getElementById('clientDialog');
  document.getElementById('clientDialogTitle').textContent = client
    ? `Editar Cliente: ${client.name}`
    : 'Novo Cliente & Credenciais 3A Stream';

  document.getElementById('cliId').value = client ? client.id : '';
  document.getElementById('cliName').value = client ? client.name : '';
  document.getElementById('cliPhone').value = client ? client.phone : '';
  document.getElementById('cliUsername').value = client ? client.username : '';
  document.getElementById('cliPassword').value = client ? client.password : '123';
  document.getElementById('cliMac').value = client ? client.macAddress : '61:F3:CF:92:93:B1';
  document.getElementById('cliPin').value = client ? client.parentalPin || '0000' : '0000';
  document.getElementById('cliPlan').value = client ? client.planName : 'Plano 3A Completo 4K';
  document.getElementById('cliPrice').value = client ? client.monthlyPrice : '35.00';

  const defaultExp = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  document.getElementById('cliExpires').value = client ? client.expiresAt : defaultExp;
  document.getElementById('cliStatus').value = client ? client.status : 'active';
  document.getElementById('cliSourceType').value = client ? client.iptvSourceType || 'demo' : 'demo';
  document.getElementById('cliXtreamUrl').value = client ? client.xtreamUrl || '' : '';
  document.getElementById('cliXtreamUser').value = client ? client.xtreamUser || '' : '';
  document.getElementById('cliXtreamPass').value = client ? client.xtreamPass || '' : '';
  document.getElementById('cliM3uUrl').value = client ? client.m3uUrl || '' : '';

  toggleClientIptvFields();
  dialog.showModal();
}

function closeClientModal() {
  const dialog = document.getElementById('clientDialog');
  if (dialog && dialog.open) dialog.close();
}

function editClient(id) {
  const c = adminState.clients.find(item => item.id === id);
  if (c) openClientModal(c);
}

async function saveClientForm(event) {
  event.preventDefault();
  const payload = {
    id: document.getElementById('cliId').value || undefined,
    name: document.getElementById('cliName').value.trim(),
    phone: document.getElementById('cliPhone').value.trim(),
    username: document.getElementById('cliUsername').value.trim(),
    password: document.getElementById('cliPassword').value.trim(),
    macAddress: document.getElementById('cliMac').value.trim(),
    parentalPin: document.getElementById('cliPin').value.trim() || '0000',
    planName: document.getElementById('cliPlan').value.trim(),
    monthlyPrice: Number(document.getElementById('cliPrice').value || 35),
    expiresAt: document.getElementById('cliExpires').value,
    status: document.getElementById('cliStatus').value,
    iptvSourceType: document.getElementById('cliSourceType').value,
    xtreamUrl: document.getElementById('cliXtreamUrl').value.trim(),
    xtreamUser: document.getElementById('cliXtreamUser').value.trim(),
    xtreamPass: document.getElementById('cliXtreamPass').value.trim(),
    m3uUrl: document.getElementById('cliM3uUrl').value.trim()
  };

  const res = await fetch('/api/admin/clients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    showAdminToast('🚫 ' + (data.error || 'Erro ao salvar'));
    return;
  }

  closeClientModal();
  showAdminToast('✅ Cliente e credenciais salvos com sucesso!');
  loadAdminOverview();
}

async function renewClient(id) {
  const res = await fetch(`/api/admin/clients/${id}/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: 30, method: 'PIX' })
  });
  const data = await res.json();
  if (data.ok) {
    showAdminToast('🎉 Assinatura renovada por +30 dias e acesso liberado!');
    loadAdminOverview();
  }
}

async function toggleClientStatus(id) {
  const res = await fetch(`/api/admin/clients/${id}/toggle-status`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    showAdminToast(`🔄 Status do cliente atualizado para: ${data.client.status.toUpperCase()}`);
    loadAdminOverview();
  }
}

async function deleteClient(id) {
  await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' });
  showAdminToast('🗑️ Cliente removido.');
  loadAdminOverview();
}

function copyWhatsappAccess(id) {
  const c = adminState.clients.find(item => item.id === id);
  if (!c) return;
  const text = [
    `🎬 *BEM-VINDO AO 3A STREAM!*`,
    ``,
    `👤 *Cliente:* ${c.name}`,
    `🔑 *Usuário no App:* ${c.username}`,
    `🔒 *Senha:* ${c.password}`,
    `📺 *Plano:* ${c.planName}`,
    `📅 *Vencimento:* ${c.expiresAtFormatted}`,
    `📟 *MAC Vinculado:* ${c.macAddress}`
  ].join('\n');

  navigator.clipboard.writeText(text).then(() => {
    showAdminToast('📲 Dados de acesso copiados! Cole no WhatsApp do cliente.');
  });
}

let adminToastTimer = null;
function showAdminToast(msg) {
  const el = document.getElementById('adminToast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(adminToastTimer);
  adminToastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, 3200);
}
