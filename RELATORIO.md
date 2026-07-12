# Relatorio de Entrega - Landing + Webhook FastDepix -> UTMify/Meta

## 1. Arquitetura

```text
Facebook Ads
   -> Landing Page
   -> Pixel Meta + Pixel UTMify
   -> Botao "Doar Agora"
   -> https://fastdepix.space/p/P0A33B0B9/sos
   -> Checkout hospedado pela FastDepix
   -> Webhook FastDepix: POST /api/webhook
   -> UTMify
   -> Meta Conversion API, apenas quando houver fbc/fbp real
```

A landing continua sem checkout proprio, sem create-pix, sem QR Code local,
sem CPF na landing e sem modal PIX. A FastDepix segue responsavel por todo o
checkout hospedado.

## 2. Webhook FastDepix

O parser foi reescrito para o payload real observado. A FastDepix nao envia
`event`, `type`, `event_type` nem `data`; ela envia diretamente o objeto da
transacao.

Exemplo esperado:

```json
{
  "transaction_id": 348516,
  "status": "pending",
  "amount": 10,
  "net_amount": 9.01,
  "payer_phone": null,
  "payer_name": null,
  "created_at": "...",
  "qr_code": "...",
  "qr_code_text": "...",
  "qr_code_expires_at": "..."
}
```

Regras implementadas:

| Campo FastDepix | Uso |
|---|---|
| `transaction_id` | Identificador unico da venda/pedido |
| `status` | Estado da transacao e gatilho da integracao |
| `amount` | Valor bruto, convertido para centavos |
| `payer_name`, `payer_phone` | Dados de comprador quando existirem |

## 3. Logs

`api/webhook.js` registra:

- `HEADERS`
- `QUERY`
- `BODY`
- `RAW BODY`
- identificadores encontrados (`utm_*`, `fbclid`, `fbc`, `fbp`, `ref`,
  `external_id`, `metadata`, `origin`, etc.)
- resumo da transacao identificada: `transaction_id`, `status`,
  status enviado a UTMify e valor em centavos

## 4. UTMify

A integracao agora usa `status` da transacao, e nao evento.

| `status` FastDepix | Acao | Status enviado a UTMify |
|---|---|---|
| `pending` | Criar venda pendente | `waiting_payment` |
| `approved` | Atualizar para paga | `paid` |
| `paid` | Confirmar pagamento | `paid` |
| `refunded` | Atualizar para reembolsada | `refunded` |

O `orderId` enviado a UTMify e sempre `transaction_id`.

## 5. Meta Conversion API

O Purchase server-side so e enviado quando existe algum identificador real de
visitante recebido no webhook/query/payload (`visitor_id`, `fbc` ou `fbp`).

Regras:

- `transaction_id` nunca e usado como `external_id` da Meta.
- Quando existe `visitor_id`, ele e enviado como `external_id`.
- E-mail so e enviado quando a FastDepix fornece e-mail real. Nenhum e-mail
  ficticio e usado.
- Sem `visitor_id`, `fbc` e `fbp`, o webhook apenas registra log. Nenhuma
  correlacao e inventada.

## 6. Correlacao Landing -> venda

Antes de implementar correlacao, foi revisado o material local e feita busca
publica por documentacao da FastDepix sobre webhook, checkout hospedado `/p/...`,
UTMs, `ref`, `metadata`, `external_id` e origem da transacao.

Resultado: nao encontrei documentacao publica/indexada que confirme endpoint,
parametro ou funcionalidade oficial para repassar a origem da transacao criada
pelo checkout hospedado. Portanto, a implementacao nao criou correlacao baseada
em suposicao. Ela apenas:

- continua enviando parametros no redirecionamento, caso a FastDepix passe a
  preserva-los;
- registra todos os identificadores que eventualmente chegarem;
- usa esses identificadores somente se aparecerem de fato no webhook/query.

Nesta versao, a landing gera um `visitor_id` persistente na primeira visita,
salva em cookie (`asf_visitor_id`) e em `localStorage`, e envia esse valor para
o checkout hospedado da FastDepix como parametro `visitor_id`. O webhook tenta
recuperar esse valor da query, do corpo e tambem de strings/URLs presentes no
payload original da transacao.

## 7. Arquivos alterados

- `api/webhook.js`: parser refeito para payload direto da transacao, usando
  `transaction_id` e `status`; removida dependencia de `event`, `type`,
  `event_type` e `data`; agora extrai/loga `visitor_id`, `ref`, `fbc`, `fbp`,
  `utm_source` e `utm_campaign`, envia `visitor_id` para UTMify e usa
  `visitor_id` como `external_id` da Meta.
- `lib/identifiers.js`: ajuste nos logs de identificadores para ignorar
  objetos vazios, como `query: {}`; agora tambem extrai identificadores de
  URLs/query strings dentro do payload.
- `lib/meta-capi.js`: regra documentada para nunca usar `transaction_id` como
  `external_id`.
- `js/main.js`: cria `visitor_id` persistente em cookie/localStorage na
  primeira visita, envia para FastDepix e registra logs claros do tracking.
- `RELATORIO.md`: documentacao atualizada com o payload real, mapeamento de
  status e limitacoes da FastDepix.

## 8. Arquivos removidos

Nenhum arquivo do projeto foi removido.

## 9. Variaveis de ambiente

| Variavel | Uso |
|---|---|
| `UTMIFY_API_TOKEN` | Enviar pedidos para UTMify |
| `META_PIXEL_ID` | Pixel usado pela Conversion API |
| `META_ACCESS_TOKEN` | Token da Meta Conversion API |
| `META_TEST_EVENT_CODE` | Opcional para testes no Events Manager |

## 10. Sugestoes de melhoria

- Solicitar ao suporte da FastDepix uma confirmacao formal sobre parametros
  aceitos no checkout hospedado e campos retornados no webhook.
- Pedir documentacao sobre assinatura/segredo do webhook para validar
  autenticidade.
- Se a FastDepix oferecer oficialmente `metadata`, `external_id`, `reference`
  ou parametro equivalente no checkout hospedado, usar esse recurso para gravar
  o `ref` da landing e correlacionar a venda sem inferencias.
