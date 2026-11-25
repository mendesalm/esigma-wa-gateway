import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pino from 'pino';
import { WhatsAppGatewayManager } from './gateway.js';

function constantTimeCompare(provided, expected) {
  if (!provided || !expected) return false;
  const bufA = Buffer.from(String(provided), 'utf8');
  const bufB = Buffer.from(String(expected), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createApp(options = {}) {
  const logger = options.logger || pino({ level: process.env.LOG_LEVEL || 'info' });
  const gatewayKey = options.gatewayKey ?? process.env.WA_GATEWAY_KEY ?? '';
  const manager = options.manager || new WhatsAppGatewayManager({ logger });

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Rota pública de saúde
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'esigma-wa-gateway' });
  });

  // Middleware de autenticação serviço-a-serviço para /internal/*
  app.use('/internal', (req, res, next) => {
    if (!gatewayKey) {
      return res.status(500).json({
        detail: 'WA_GATEWAY_KEY não configurada no serviço.',
      });
    }
    const providedKey = req.header('X-Service-Key');
    if (!constantTimeCompare(providedKey, gatewayKey)) {
      return res.status(401).json({ detail: 'Chave de serviço inválida.' });
    }
    next();
  });

  app.get('/internal/lojas/:lojaId/status', (req, res) => {
    try {
      const status = manager.getStatus(req.params.lojaId);
      res.json(status);
    } catch (err) {
      res.status(400).json({ detail: err.message });
    }
  });

  app.post('/internal/lojas/:lojaId/connect', async (req, res) => {
    try {
      const status = await manager.connect(req.params.lojaId);
      res.json(status);
    } catch (err) {
      logger.error({ err, lojaId: req.params.lojaId }, 'Erro ao iniciar conexão WhatsApp');
      res.status(err.statusCode || 500).json({ detail: err.message });
    }
  });

  app.post('/internal/lojas/:lojaId/disconnect', async (req, res) => {
    try {
      const status = await manager.disconnect(req.params.lojaId);
      res.json(status);
    } catch (err) {
      logger.error({ err, lojaId: req.params.lojaId }, 'Erro ao desconectar WhatsApp');
      res.status(err.statusCode || 500).json({ detail: err.message });
    }
  });

  app.get('/internal/lojas/:lojaId/groups', async (req, res) => {
    try {
      const groups = await manager.getGroups(req.params.lojaId);
      res.json({ groups });
    } catch (err) {
      res.status(err.statusCode || 500).json({ detail: err.message });
    }
  });

  app.post('/internal/lojas/:lojaId/send-group', async (req, res) => {
    try {
      const { group_jid: groupJid, message } = req.body || {};
      const result = await manager.sendGroupMessage(req.params.lojaId, groupJid, message);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ detail: err.message });
    }
  });

  return { app, manager };
}

export async function startServer() {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8004);
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  const { app, manager } = createApp({ logger });

  await manager.restoreSavedSessions();

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      logger.info({ host, port }, 'esigma-wa-gateway iniciado');
      resolve({ server, app, manager });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    console.error('Falha ao iniciar esigma-wa-gateway:', err);
    process.exit(1);
  });
}
