import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WhatsAppGatewayManager } from '../src/gateway.js';
import { createApp } from '../src/server.js';

function createMockBaileys() {
  const sockets = [];
  return {
    sockets,
    DisconnectReason: { loggedOut: 401 },
    async fetchLatestBaileysVersion() {
      return { version: [2, 3000, 1] };
    },
    async useMultiFileAuthState(dir) {
      await fs.mkdir(dir, { recursive: true });
      return {
        state: { creds: {}, keys: {} },
        async saveCreds() {
          await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ saved: true }));
        },
      };
    },
    makeWASocket() {
      const ev = new EventEmitter();
      const sock = {
        ev,
        user: { id: '5511999999999:1@s.whatsapp.net', name: 'Secretaria JPJ' },
        sentMessages: [],
        async groupFetchAllParticipating() {
          return {
            '120363000001@g.us': {
              id: '120363000001@g.us',
              subject: 'ARLS João Pedro Junqueira 2181',
              participants: [{ id: '1' }, { id: '2' }],
            },
          };
        },
        async sendMessage(jid, content) {
          sock.sentMessages.push({ jid, content });
          return { key: { id: 'MSG-123' } };
        },
        async logout() {
          sock.loggedOut = true;
        },
      };
      sockets.push(sock);
      return sock;
    },
  };
}

describe('WhatsAppGatewayManager & HTTP API', () => {
  it('gerencia ciclo connect -> QR -> open -> groups -> send-group -> disconnect', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-gw-test-'));
    const mockBaileys = createMockBaileys();
    const manager = new WhatsAppGatewayManager({
      dataDir: tmpDir,
      baileysLoader: async () => mockBaileys,
    });

    const initial = manager.getStatus('10');
    assert.equal(initial.status, 'disconnected');
    assert.equal(initial.connected, false);

    await manager.connect('10');
    const sock = mockBaileys.sockets[0];
    assert.ok(sock);

    sock.ev.emit('connection.update', { qr: 'fake-qr-payload' });
    let qrStatus = manager.getStatus('10');
    for (let i = 0; i < 50 && qrStatus.status !== 'qr_ready'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      qrStatus = manager.getStatus('10');
    }
    assert.equal(qrStatus.status, 'qr_ready');
    assert.ok(qrStatus.qr_code.startsWith('data:image/png;base64,'));

    sock.ev.emit('connection.update', { connection: 'open' });
    const openStatus = manager.getStatus('10');
    assert.equal(openStatus.status, 'connected');
    assert.equal(openStatus.connected, true);
    assert.equal(openStatus.phone_number, '5511999999999');

    const groups = await manager.getGroups('10');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].jid, '120363000001@g.us');

    const sendRes = await manager.sendGroupMessage('10', '120363000001@g.us', 'Olá Irmãos!');
    assert.equal(sendRes.ok, true);
    assert.equal(sendRes.message_id, 'MSG-123');
    assert.equal(sock.sentMessages.length, 1);

    const discStatus = await manager.disconnect('10');
    assert.equal(discStatus.status, 'disconnected');
    assert.equal(sock.loggedOut, true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('protege /internal/* com X-Service-Key e libera /health', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-gw-http-'));
    const mockBaileys = createMockBaileys();
    const manager = new WhatsAppGatewayManager({
      dataDir: tmpDir,
      baileysLoader: async () => mockBaileys,
    });
    const { app } = createApp({ gatewayKey: 'segredo-teste', manager });

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);

      const unauthRes = await fetch(`${baseUrl}/internal/lojas/1/status`);
      assert.equal(unauthRes.status, 401);

      const authRes = await fetch(`${baseUrl}/internal/lojas/1/status`, {
        headers: { 'X-Service-Key': 'segredo-teste' },
      });
      assert.equal(authRes.status, 200);
      const body = await authRes.json();
      assert.equal(body.loja_id, '1');
      assert.equal(body.status, 'disconnected');
    } finally {
      server.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
