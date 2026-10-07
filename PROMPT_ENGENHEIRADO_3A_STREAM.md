# Prompt Engenheirado Mestre — Ecossistema 3A Stream (IPTV Player + Painel Admin SaaS)

> **Como usar este prompt:** Você pode utilizar o prompt abaixo sempre que quiser expandir módulos, solicitar novas funcionalidades a uma IA ou documentar a arquitetura oficial do projeto **3A Stream**.

---

## 🎯 PROMPT OTIMIZADO (COPIE E USE QUANDO PRECISAR)

```markdown
### 1. PAPÉIS E ESPECIALIDADES (PERSONAS ATIVAS)
Atue simultaneamente como:
1. **Arquiteto de Sistemas de Streaming & IPTV**: Especialista nos protocolos Xtream Codes API (`player_api.php`, `get.php`, live/vod/series streams), parsing avançado de listas M3U/M3U8 (tags `#EXTINF`, `tvg-id`, `tvg-logo`, `group-title`), reprodução adaptativa HLS (`.m3u8`) e MPEG-TS (`.ts`), EPG (XMLTV) e proxy seguro de credenciais.
2. **Engenheiro Sênior Android & Android TV (Hybrid/Capacitor & Leanback)**: Especialista em aplicativos para TV Box, Smart TVs Android, Fire TV Stick e Smartphones, com foco em navegação por Controle Remoto (D-Pad Spatial Navigation / Focus Management), aceleração de hardware de vídeo, geração de APK otimizado e identificação de dispositivo (MAC Address virtual/físico).
3. **Engenheiro Full-Stack Web & Segurança (Node.js + SQLite/Prisma + REST API)**: Especialista em autenticação centralizada, provisionamento remoto de listas (Zero-Exposure DNS: o cliente loga com usuário/senha do próprio aplicativo 3A Stream e o backend injeta a lista IPTV correspondente sem expor o servidor matriz), controle de assinaturas, bloqueio automático por inadimplência/vencimento e limite de conexões.
4. **Designer UI/UX de Interfaces 10-Foot (TV) & Dark Mode**: Especialista em interfaces de alto contraste para telas grandes (inspirado no layout Xcloud TV), com paleta Dark (`#050505`) e Verde Esmeralda/Neon (`#0E6B0E` a `#1DB954`), tipografia legível à distância e estados claros de foco (outline/scale) para controle remoto.

---

### 2. VISÃO GERAL DO PRODUTO: "3A STREAM"
Desenvolver um ecossistema completo composto por **3 módulos integrados**:
1. **Aplicativo Player "3A Stream" (Android / TV Box / Web Testbench)**:
   - O cliente final baixa o APK do **3A Stream** e faz login utilizando **exclusivamente o Usuário e Senha criados pelo Administrador** (ou ativação via endereço MAC exibido na tela).
   - O aplicativo autentica na API do **3A Stream**, verifica se a mensalidade está em dia e recebe automaticamente as credenciais da lista IPTV (Xtream Codes API: `DNS/URL`, `username`, `password` ou link `M3U`) configuradas para aquele cliente no painel.
2. **Dashboard Administrativo Local/Web ("3A Stream Control Panel")**:
   - Sistema de gestão de clientes, planos, mensalidades, datas de vencimento, renovação rápida (+30 dias), bloqueio/desbloqueio instantâneo e vinculação de listas Xtream/M3U e endereço MAC.
3. **Ambiente de Testes Android / Simulador TV Box Integrado**:
   - Ambiente executável localmente no navegador e empacotável em `.APK` via Capacitor/Android, contendo emulador de tela TV Box/Mobile e controle remoto virtual (D-Pad) para homologação antes da distribuição do APK.

---

### 3. REQUISITOS FUNCIONAIS E DE INTERFACE DO APLICATIVO (BASEADO NAS REFERÊNCIAS VISUAIS)

#### A. Tela de Login & Provisionamento
- Campos: `Usuário` e `Senha` do cliente 3A Stream + exibição do `Endereço MAC` único do aparelho no rodapé.
- Validação em tempo real com o Backend Admin:
  - Se **Ativo e Dentro da Validade**: autentica, sincroniza categorias/canais e exibe a Home.
  - Se **Vencido ou Bloqueado**: exibe modal informativo com a data de vencimento e instrução para renovação com o suporte.

#### B. Tela Inicial (Home Dashboard - Estilo Xcloud TV)
- **Topo Central**: Logotipo moderno **3A STREAM**.
- **Layout Principal em 3 Colunas (Navegável via D-Pad / Setas / Toque)**:
  1. **Coluna Esquerda (Destaque Grande Verde `#0E6B0E`)**:
     - Botão **TV ao Vivo** (ícone de TV com sinal ao vivo e controle remoto).
  2. **Coluna Central (Grid 2x2 de Cards Verdes)**:
     - **Filmes** (VOD / Catálogo sob demanda com capas, sinopse e busca).
     - **Séries** (Organizadas por Categorias -> Temporadas -> Episódios).
     - **Futebol** (Atalho dedicado que filtra automaticamente canais de esportes/futebol ao vivo e jogos do dia).
     - **Playlists** (Gerenciamento/alternância de listas ativas vinculadas à conta).
  3. **Coluna Direita (3 Botões Horizontais Empilhados Verdes)**:
     - **Configurações** (Abre o painel de 17 funções administrativas do app).
     - **Recarregar** (Força a ressincronização da lista Xtream/M3U e EPG com feedback visual).
     - **Sair** (Encerra a sessão ou fecha o aplicativo com confirmação).
- **Rodapé Central**: Exibe a **Data de Vencimento da Assinatura** do cliente (formato `DD/MM/AAAA`, ex: `15/06/2026`).

#### C. Tela de Configurações (Grid 4 Colunas - Fundo Escuro `#000000` e Botões `#2B2B2B`)
Deve conter exatamente os 17 módulos funcionais dispostos em grade:
1. `Add Conta`: Adicionar/trocar conta ou perfil autorizado.
2. `Controle dos Pais`: Definir/alterar senha PIN de 4 dígitos para bloquear categorias adultas (`+18` / `Adult` / `XXX`) ou canais específicos.
3. `Playlists`: Visualizar status da lista ativa (Xtream API ou M3U) ou alternar entre listas liberadas pelo admin.
4. `Mudar idioma`: Alternar idioma da interface (Português PT-BR, Inglês, Espanhol).
5. `Alterar layout`: Alternar estilo de visualização de canais (Lista com EPG lateral vs Grade de Pôsteres).
6. `Ocultar Categorias ao Vivo`: Modal com checkboxes para ocultar/exibir grupos de canais ao vivo.
7. `Ocultar Categorias Vod`: Modal com checkboxes para ocultar/exibir categorias de Filmes.
8. `Ocultar Categorias Series`: Modal com checkboxes para ocultar/exibir categorias de Séries.
9. `Limpar histórico de filmes`: Limpar progresso e histórico de filmes assistidos.
10. `Limpar vistos recentemente` ("Não há filmes vistos recentemente"): Limpar fila de canais/conteúdos recentes.
11. `Live Stream Format`: Alternar formato preferencial de fluxo ao vivo entre `MPEGTS (.ts)` e `HLS (.m3u8)` / `Auto`.
12. `Jogador externo`: Configurar abertura em player nativo interno ou intent para player externo (VLC / MX Player no Android).
13. `Automática`: Configurar inicialização automática / reconexão automática de stream em caso de queda.
14. `Formato da hora`: Alternar relógio do player entre `24h` e `12h (AM/PM)`.
15. `Configurações de legenda`: Tamanho da fonte, cor e fundo das legendas.
16. `Select Device Type`: Alternar modo de interface e foco entre `TV (D-Pad / Controle Remoto)` e `Mobile (Touch)`.
17. `Atualize agora`: Verificar versão do app e atualizar catálogo/configurações remotas do servidor.
- **Rodapé da Tela de Configurações**: Exibir em destaque `endereço MAC: XX:XX:XX:XX:XX:XX`.

---

### 4. REQUISITOS DO PAINEL DE CONTROLE (ADMIN DASHBOARD)
- **KPIs Financeiros e Operacionais**: Total de clientes, clientes ativos, assinaturas vencendo nos próximos 7 dias, clientes vencidos/bloqueados e faturamento mensal recorrente (MRR).
- **CRUD de Clientes & Mensalidades**:
  - Cadastro de Nome, WhatsApp/Observação, Usuário 3A, Senha 3A, MAC Address do aparelho, Plano/Valor (R$), Data de Vencimento e Limite de Telas.
  - Ações rápidas: **Renovar +30 dias**, **Bloquear/Desbloquear**, **Copiar dados de acesso para enviar no WhatsApp**.
- **Provisionamento de Listas IPTV (Xtream Codes API & M3U)**:
  - Suporte a **Servidor Mestre (DNS Padrão)** ou **Lista Individual por Cliente**:
    - Modo **Xtream API**: `Server URL (DNS)`, `Xtream Username`, `Xtream Password`.
    - Modo **M3U**: `URL da Lista M3U/M3U8` ou upload de conteúdo M3U.
- **Proxy de Reprodução e CORS**: O backend deve intermediar chamadas `player_api.php` e listas `.m3u` para evitar bloqueios de CORS ou Mixed Content (HTTP/HTTPS) no WebView/Android.
```
---
