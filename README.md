# e-Sigma WhatsApp Gateway (`esigma-wa-gateway`)

Microsserviço Node.js 22 + Baileys multi-tenant (1 sessão/QR por `loja_id`) para envio e gestão de listas de confirmação via WhatsApp no ecossistema **e-Sigma / Lojas**.

## Segurança e Rede

- Escuta por padrão apenas em `127.0.0.1:8004` (ou via Docker Compose mapeado em `127.0.0.1:8004:8004`).
- `GET /health` é público para monitoramento local.
- Todas as rotas `/internal/lojas/:lojaId/*` exigem o header `X-Service-Key` igual a `WA_GATEWAY_KEY` (comparação em tempo constante).

## Endpoints

- `GET /health`
- `GET /internal/lojas/:lojaId/status`
- `POST /internal/lojas/:lojaId/connect`
- `POST /internal/lojas/:lojaId/disconnect`
- `GET /internal/lojas/:lojaId/groups`
- `POST /internal/lojas/:lojaId/send-group` (body: `{ "group_jid": "...", "message": "..." }`)

## Execução Local / VPS

```bash
cp .env.example .env
# Edite .env e defina WA_GATEWAY_KEY
docker compose up -d --build
```

Para rodar testes:

```bash
npm install
npm test
```
