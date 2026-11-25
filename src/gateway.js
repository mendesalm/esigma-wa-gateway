import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';

let cachedBaileys = null;

async function defaultBaileysLoader() {
  if (!cachedBaileys) {
    cachedBaileys = await import('@whiskeysockets/baileys');
  }
  return cachedBaileys;
}

export class WhatsAppGatewayManager {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || './data');
    this.sessionsDir = path.join(this.dataDir, 'sessions');
    this.logger = options.logger || pino({ level: process.env.LOG_LEVEL || 'info' });
    this.baileysLoader = options.baileysLoader || defaultBaileysLoader;
    this.qrGenerator = options.qrGenerator || ((qr) => QRCode.toDataURL(qr));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.sessions = new Map();
  }

  _sanitizeLojaId(lojaId) {
    const raw = String(lojaId ?? '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
      throw new Error('loja_id inválido');
    }
    return raw;
  }

  _getSessionDir(lojaId) {
    const safeId = this._sanitizeLojaId(lojaId);
    return path.join(this.sessionsDir, `loja_${safeId}`);
  }

  _getOrCreateState(lojaId) {
    const safeId = this._sanitizeLojaId(lojaId);
    if (!this.sessions.has(safeId)) {
      this.sessions.set(safeId, {
        lojaId: safeId,
        status: 'disconnected',
        qrCodeDataUrl: null,
        phoneNumber: null,
        pushName: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
        sock: null,
        reconnectTimer: null,
        manualDisconnect: false,
      });
    }
    return this.sessions.get(safeId);
  }

  _serializeStatus(state) {
    return {
      loja_id: state.lojaId,
      status: state.status,
      connected: state.status === 'connected',
      qr_code: state.qrCodeDataUrl,
      phone_number: state.phoneNumber,
      push_name: state.pushName,
      last_error: state.lastError,
      updated_at: state.updatedAt,
    };
  }

  async ensureDirectories() {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  async restoreSavedSessions() {
    await this.ensureDirectories();
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const restored = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('loja_')) continue;
      const lojaId = entry.name.slice('loja_'.length);
      const credsPath = path.join(this.sessionsDir, entry.name, 'creds.json');
      try {
        await fs.access(credsPath);
        await this.connect(lojaId);
        restored.push(lojaId);
      } catch {
        // Sem creds.json salvo — ignora
      }
    }
    return restored;
  }

  getStatus(lojaId) {
    const state = this._getOrCreateState(lojaId);
    return this._serializeStatus(state);
  }

  async connect(lojaId) {
    const safeId = this._sanitizeLojaId(lojaId);
    const state = this._getOrCreateState(safeId);

    if (state.status === 'connected' && state.sock) {
      return this._serializeStatus(state);
    }

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    state.manualDisconnect = false;
    state.status = 'connecting';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();

    const sessionDir = this._getSessionDir(safeId);
    await fs.mkdir(sessionDir, { recursive: true });

    const baileys = await this.baileysLoader();
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try {
      if (typeof fetchLatestBaileysVersion === 'function') {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo?.version;
      }
    } catch (err) {
      this.logger.warn({ err, lojaId: safeId }, 'Falha ao buscar versão mais recente do Baileys; usando padrão');
    }

    const socketConfig = {
      auth: authState,
      logger: this.logger.child({ lojaId: safeId, component: 'baileys' }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
    };
    if (version) {
      socketConfig.version = version;
    }

    const sock = makeWASocket(socketConfig);
    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          state.qrCodeDataUrl = await this.qrGenerator(qr);
          state.status = 'qr_ready';
          state.updatedAt = new Date().toISOString();
        } catch (err) {
          this.logger.error({ err, lojaId: safeId }, 'Erro ao gerar QR Code PNG');
          state.lastError = 'Falha ao gerar QR Code';
        }
      }

      if (connection === 'open') {
        state.status = 'connected';
        state.qrCodeDataUrl = null;
        state.lastError = null;
        const rawId = sock.user?.id || '';
        state.phoneNumber = rawId.split(':')[0].split('@')[0] || null;
        state.pushName = sock.user?.name || null;
        state.updatedAt = new Date().toISOString();
        this.logger.info({ lojaId: safeId, phoneNumber: state.phoneNumber }, 'Sessão WhatsApp conectada');
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.statusCode ??
          null;
        const loggedOutCode = DisconnectReason?.loggedOut ?? 401;
        const isLoggedOut = statusCode === loggedOutCode;

        state.sock = null;
        state.qrCodeDataUrl = null;
        state.updatedAt = new Date().toISOString();

        if (state.manualDisconnect || isLoggedOut) {
          state.status = 'disconnected';
          state.phoneNumber = null;
          state.pushName = null;
          if (isLoggedOut && !state.manualDisconnect) {
            state.lastError = 'Sessão desconectada no aparelho (loggedOut). Escaneie o QR Code novamente.';
            await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
          }
        } else {
          state.status = 'connecting';
          state.lastError = lastDisconnect?.error?.message || 'Conexão interrompida; reconectando...';
          state.reconnectTimer = setTimeout(() => {
            this.connect(safeId).catch((err) => {
              this.logger.error({ err, lojaId: safeId }, 'Erro na reconexão automática');
            });
          }, this.reconnectDelayMs);
        }
      }
    });

    return this._serializeStatus(state);
  }

  async disconnect(lojaId) {
    const safeId = this._sanitizeLojaId(lojaId);
    const state = this._getOrCreateState(safeId);
    state.manualDisconnect = true;

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    if (state.sock) {
      try {
        if (typeof state.sock.logout === 'function') {
          await state.sock.logout();
        } else if (typeof state.sock.end === 'function') {
          state.sock.end();
        }
      } catch (err) {
        this.logger.warn({ err, lojaId: safeId }, 'Erro ao encerrar socket durante disconnect');
      }
    }

    const sessionDir = this._getSessionDir(safeId);
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

    state.sock = null;
    state.status = 'disconnected';
    state.qrCodeDataUrl = null;
    state.phoneNumber = null;
    state.pushName = null;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();

    return this._serializeStatus(state);
  }

  async getGroups(lojaId) {
    const safeId = this._sanitizeLojaId(lojaId);
    const state = this._getOrCreateState(safeId);
    if (state.status !== 'connected' || !state.sock) {
      const err = new Error('Sessão WhatsApp não está conectada para esta loja.');
      err.statusCode = 409;
      throw err;
    }

    const groupsMap = await state.sock.groupFetchAllParticipating();
    const groups = Object.values(groupsMap || {}).map((g) => ({
      jid: g.id,
      name: g.subject || g.id,
      participants_count: Array.isArray(g.participants) ? g.participants.length : 0,
    }));

    groups.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return groups;
  }

  async sendGroupMessage(lojaId, groupJid, message) {
    const safeId = this._sanitizeLojaId(lojaId);
    const state = this._getOrCreateState(safeId);
    if (state.status !== 'connected' || !state.sock) {
      const err = new Error('Sessão WhatsApp não está conectada para esta loja.');
      err.statusCode = 409;
      throw err;
    }

    if (!groupJid || typeof groupJid !== 'string') {
      const err = new Error('group_jid é obrigatório.');
      err.statusCode = 400;
      throw err;
    }

    if (!message || typeof message !== 'string') {
      const err = new Error('message é obrigatório.');
      err.statusCode = 400;
      throw err;
    }

    const result = await state.sock.sendMessage(groupJid, { text: message });
    return {
      ok: true,
      loja_id: safeId,
      group_jid: groupJid,
      message_id: result?.key?.id || null,
    };
  }
}
