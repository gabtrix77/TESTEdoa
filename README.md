# Abrigo São Francisco — Landing + API FastDepix → UTMify / Meta CAPI

Landing page de doação que **cria o PIX via API da FastDepix no nosso próprio
backend** (não redireciona mais para o checkout hospedado), guarda o tracking da
doação num **KV** e, quando o **webhook** da FastDepix chega, recupera esse
tracking e repassa a venda para a **UTMify** e a **Meta Conversion API**.

A landing continua sem CPF e sem coletar dados financeiros — quem gera e processa
o PIX é a FastDepix; nós só orquestramos e atribuímos.

## Fluxo novo (via API)

```
Facebook Ads
  -> Landing (Pixel + UTMify + visitor_id)
  -> Clica em "Doar"
  -> POST /api/create-transaction { amount, tracking }
       -> chama a API da FastDepix (cria PIX) -> recebe transaction_id
       -> salva tracking no KV: asf:tx:<transaction_id>  (TTL 24h)
       -> devolve o PIX (QR + copia-e-cola) para o navegador
  -> Modal exibe o QR Code / copia-e-cola (sem sair da página)
  -> Doador paga
  -> Webhook FastDepix: POST /api/webhook
       -> lê transaction_id -> busca tracking no KV
       -> UTMify (sempre, pelo status)
       -> Meta CAPI (Purchase, só quando pago e com visitor_id/fbc/fbp real)
```

## Estrutura

```
.
├── index.html
├── obrigado.html
├── css/style.css              # inclui os estilos do modal de PIX
├── js/main.js                 # cria o PIX via API e exibe o modal
├── api/
│   ├── create-transaction.js  # NOVA rota: cria PIX + salva tracking no KV
│   └── webhook.js             # webhook: recupera tracking no KV, envia p/ UTMify + Meta
├── lib/
│   ├── fastdepix.js           # cliente da API da FastDepix (configurável)
│   ├── kv.js                  # KV (Vercel KV/Upstash REST) + fallback memória
│   ├── identifiers.js
│   ├── utmify.js
│   └── meta-capi.js
├── images/
├── vercel.json
├── package.json
└── .env.example
```

## Variáveis de ambiente (Vercel)

| Variável | Uso |
|---|---|
| `FASTDEPIX_API_URL` | Base da API da FastDepix (ex.: `https://api.fastdepix.space`) |
| `FASTDEPIX_CREATE_PATH` | Caminho do endpoint de criação (default `/v1/transactions`) |
| `FASTDEPIX_API_KEY` | **Secret** da API da FastDepix (nunca commitar) |
| `FASTDEPIX_AUTH_SCHEME` | `bearer` \| `apikey` \| `basic` (default `bearer`) |
| `FASTDEPIX_AUTH_HEADER` | header p/ `apikey` (default `Authorization`) |
| `FASTDEPIX_WEBHOOK_URL` | (opcional) URL do webhook para postback |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV / Upstash Redis (REST) |
| `PUBLIC_BASE_URL` | (opcional) base pública, p/ montar a URL do webhook |
| `UTMIFY_API_TOKEN` | Token da API da UTMify |
| `META_PIXEL_ID` | Pixel da Conversion API |
| `META_ACCESS_TOKEN` | Token da Meta Conversion API |
| `META_TEST_EVENT_CODE` | (opcional) Test Events |

### Criar o KV na Vercel

No projeto: **Storage → Create Database → KV**. A Vercel injeta automaticamente
`KV_REST_API_URL` e `KV_REST_API_TOKEN`. Sem KV configurado, `lib/kv.js` usa um
fallback **em memória** que serve só para desenvolvimento (não persiste entre
invocações serverless).

## ⚠️ Ajustar o contrato da FastDepix

Como não há documentação pública confirmada, o cliente `lib/fastdepix.js` foi
feito **configurável** e com um payload/parse em formato padrão. Ao ter o contrato
oficial, confira/ajuste:

1. **Endpoint**: `FASTDEPIX_API_URL` + `FASTDEPIX_CREATE_PATH`.
2. **Auth**: `FASTDEPIX_AUTH_SCHEME` (bearer/apikey/basic).
3. **Corpo da requisição**: função `buildRequestBody()` (hoje envia `amount` em
   centavos, `payment_method: "pix"`, `metadata` com o tracking e `external_id`).
4. **Resposta**: função `normalizeResponse()` (hoje tenta várias chaves para
   `transaction_id`, `status`, `qr_code_text` e `qr_code_image`).

O webhook já lê o payload direto da transação (`transaction_id`, `status`,
`amount`), então essa parte segue igual ao que a FastDepix já enviava.

## Rodar localmente

```bash
npm install -g vercel
npm start          # vercel dev
```

## Deploy

```bash
npm run deploy     # vercel deploy --prod
```

Depois configure as variáveis de ambiente no painel da Vercel e cadastre a URL do
webhook (`https://SEU-DOMINIO/api/webhook`) no painel da FastDepix.

## Segurança

- O `FASTDEPIX_API_KEY` e o `META_ACCESS_TOKEN` são **secrets** — ficam só nas
  variáveis de ambiente da Vercel, nunca no código ou no repositório.
- A rota `/api/create-transaction` nunca devolve segredos ao navegador; só o PIX.
