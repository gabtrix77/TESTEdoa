/* =============================================================================
 * api/webhook.js  (Vercel Serverless Function)
 * -----------------------------------------------------------------------------
 * Recebe o webhook da FastDepix e repassa a venda para:
 *   - UTMify  (sempre, usando o status da transação)
 *   - Meta Conversion API (somente quando há visitor_id/fbc/fbp reais)
 *
 * A FastDepix envia DIRETAMENTE o objeto da transação (sem event/type/data).
 * Exemplo de payload:
 *   {
 *     "transaction_id": 348516,
 *     "status": "pending",
 *     "amount": 10,
 *     "net_amount": 9.01,
 *     "payer_phone": null,
 *     "payer_name": null,
 *     "created_at": "...",
 *     "qr_code": "...",
 *     "qr_code_text": "...",
 *     "qr_code_expires_at": "..."
 *   }
 * ========================================================================== */

"use strict";

var crypto = require("crypto");
var identifiersLib = require("../lib/identifiers");
var utmify = require("../lib/utmify");
var metaCapi = require("../lib/meta-capi");
var kv = require("../lib/kv");

/* ---------------------------------------------------------------------------
 * Validação da assinatura HMAC-SHA256 do webhook (segurança), conforme a doc
 * oficial da FastDepix:
 *   Header:  X-Webhook-Signature: sha256=<hash>
 *   hash  =  HMAC_SHA256(rawBody, FASTDEPIX_WEBHOOK_SECRET)
 *
 * - Se FASTDEPIX_WEBHOOK_SECRET estiver configurada, a assinatura é EXIGIDA:
 *   requisições sem assinatura ou com assinatura inválida são rejeitadas (401).
 * - Se o segredo NÃO estiver configurado, a validação é apenas registrada em
 *   log (permite testar antes de cadastrar o segredo no painel/Vercel).
 * ------------------------------------------------------------------------- */
function verifyWebhookSignature(req, rawBody) {
  var secret = process.env.FASTDEPIX_WEBHOOK_SECRET || "";
  if (!secret) {
    console.warn("[ASF][Webhook] FASTDEPIX_WEBHOOK_SECRET ausente — assinatura NÃO verificada (configure para produção).");
    return { ok: true, verified: false, reason: "no_secret" };
  }

  var received = req.headers["x-webhook-signature"] || req.headers["X-Webhook-Signature"] || "";
  if (!received) {
    return { ok: false, verified: false, reason: "missing_signature" };
  }

  var expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody || "", "utf8").digest("hex");

  // Comparação em tempo constante (evita timing attacks).
  var a = Buffer.from(String(received));
  var b = Buffer.from(expected);
  var valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return { ok: valid, verified: valid, reason: valid ? "valid" : "invalid_signature" };
}

/* ---------------------------------------------------------------------------
 * Mapeamento de status FastDepix -> UTMify
 * ------------------------------------------------------------------------- */
var STATUS_MAP = {
  pending: "waiting_payment",
  waiting_payment: "waiting_payment",
  approved: "paid",
  paid: "paid",
  completed: "paid",
  refunded: "refunded",
  chargeback: "refunded",
  refused: "refused",
  canceled: "refused",
  cancelled: "refused",
  failed: "refused",
  expired: "refused"
};

function mapStatus(rawStatus) {
  if (!rawStatus) return null;
  var key = String(rawStatus).trim().toLowerCase();
  return STATUS_MAP[key] || null;
}

/* ---------------------------------------------------------------------------
 * Lê o corpo bruto da requisição (stream).
 * ------------------------------------------------------------------------- */
function readRawBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", function () { resolve(""); });
  });
}

function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}

/* ---------------------------------------------------------------------------
 * Extrai o objeto da transação do payload.
 * A FastDepix manda o objeto direto, mas por segurança lidamos com o caso de
 * vir aninhado (data/transaction/order).
 * ------------------------------------------------------------------------- */
function extractTransaction(body) {
  if (!body || typeof body !== "object") return {};
  if (body.transaction_id !== undefined || body.status !== undefined) return body;
  if (body.data && typeof body.data === "object") return body.data;
  if (body.transaction && typeof body.transaction === "object") return body.transaction;
  if (body.order && typeof body.order === "object") return body.order;
  return body;
}

function toCents(amount) {
  var n = Number(amount);
  if (isNaN(n)) return 0;
  return Math.round(n * 100);
}

function firstIp(req) {
  var xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

/* ---------------------------------------------------------------------------
 * Handler principal
 * ------------------------------------------------------------------------- */
module.exports = async function handler(req, res) {
  // A FastDepix pode fazer um GET/HEAD de verificação — respondemos 200.
  if (req.method !== "POST") {
    res.status(200).json({ ok: true, message: "Webhook ativo. Use POST." });
    return;
  }

  var rawBody = await readRawBody(req);

  // --- Segurança: valida a assinatura HMAC ANTES de qualquer processamento ---
  var sig = verifyWebhookSignature(req, rawBody);
  if (!sig.ok) {
    console.warn("[ASF][Webhook] Assinatura rejeitada:", sig.reason);
    res.status(401).json({ ok: false, error: "invalid_signature" });
    return;
  }
  console.log("[ASF][Webhook] Assinatura:", sig.reason);

  var parsedBody = safeJsonParse(rawBody);

  // Se não for JSON, tenta como form-urlencoded.
  if (!parsedBody && rawBody && rawBody.indexOf("=") !== -1) {
    parsedBody = identifiersLib.parseQueryString(rawBody);
  }

  var query = req.query || {};

  /* ----------------------------- LOGS ---------------------------------- */
  console.log("[ASF][Webhook] ===== NOVO WEBHOOK =====");
  console.log("[ASF][Webhook] HEADERS:", JSON.stringify(req.headers));
  var compactQuery = identifiersLib.compact(query);
  console.log("[ASF][Webhook] QUERY:", compactQuery ? JSON.stringify(compactQuery) : "(vazio)");
  console.log("[ASF][Webhook] BODY:", parsedBody ? JSON.stringify(parsedBody) : "(não-JSON)");
  console.log("[ASF][Webhook] RAW BODY:", rawBody || "(vazio)");

  /* ----------------------- Transação + identificadores ------------------ */
  var tx = extractTransaction(parsedBody || {});

  var identifiers = identifiersLib.collectIdentifiers({
    query: query,
    body: parsedBody,
    payload: tx
  });
  var compactIds = identifiersLib.compact(identifiers);
  console.log("[ASF][Webhook] IDENTIFICADORES:", compactIds ? JSON.stringify(compactIds) : "(nenhum)");

  var transactionId = tx.transaction_id != null ? String(tx.transaction_id) : null;
  var rawStatus = tx.status || null;
  var mappedStatus = mapStatus(rawStatus);
  var valueInCents = toCents(tx.amount);
  var valueInReais = Number(tx.amount) || 0;

  console.log(
    "[ASF][Webhook] RESUMO -> transaction_id:", transactionId,
    "| status FastDepix:", rawStatus,
    "| status UTMify:", mappedStatus,
    "| valor(centavos):", valueInCents
  );

  // Sem transaction_id ou status reconhecível, não temos o que processar.
  if (!transactionId || !mappedStatus) {
    console.warn("[ASF][Webhook] transaction_id ou status ausente/desconhecido — apenas logado.");
    res.status(200).json({ ok: true, ignored: true, reason: "missing_transaction_or_status" });
    return;
  }

  /* --------------------- Recupera tracking do KV ----------------------- */
  // O tracking foi salvo por api/create-transaction.js no momento da criação
  // do PIX. Aqui recuperamos por transaction_id e mesclamos.
  // Prioridade: o que já veio no payload/query (mais fresco) vence; o KV
  // preenche o que estiver faltando (que é o caso normal, pois a FastDepix
  // normalmente não devolve visitor_id/fbc/fbp no webhook).
  var kvSource = "none";
  try {
    var stored = await kv.getJSON(kv.trackingKey(transactionId));
    if (stored && stored.tracking) {
      kvSource = "kv";
      Object.keys(stored.tracking).forEach(function (k) {
        var v = stored.tracking[k];
        if (v != null && String(v).trim() !== "" && (identifiers[k] == null || String(identifiers[k]).trim() === "")) {
          identifiers[k] = v;
        }
      });
      console.log("[ASF][Webhook] Tracking recuperado do KV:", JSON.stringify(stored.tracking));
    } else {
      console.log("[ASF][Webhook] Nenhum tracking no KV para", transactionId);
    }
  } catch (err) {
    console.error("[ASF][Webhook] Erro ao ler KV:", err && err.message);
  }
  console.log("[ASF][Webhook] IDENTIFICADORES (pós-KV / origem=" + kvSource + "):",
    JSON.stringify(identifiersLib.compact(identifiers) || {}));

  /* --------------------- Grava status p/ a tela de obrigado ------------ */
  // A landing consulta esse status (via /api/transaction-status) e troca para
  // a tela de agradecimento quando o pagamento é confirmado.
  var isPaidConfirmed = (rawStatus === "paid" || rawStatus === "completed");
  try {
    await kv.setJSON(
      kv.statusKey(transactionId),
      { raw: rawStatus, mapped: mappedStatus, paid: isPaidConfirmed, at: new Date().toISOString() },
      60 * 60 * 2 // 2h
    );
  } catch (err) {
    console.error("[ASF][Webhook] Erro ao gravar status no KV:", err && err.message);
  }

  /* ------------------------------- UTMify ------------------------------ */
  var order = utmify.buildOrderPayload({
    orderId: transactionId,
    status: mappedStatus,
    valueInCents: valueInCents,
    createdAt: tx.created_at || new Date(),
    approvedDate: tx.paid_at || tx.approved_at || tx.updated_at || new Date(),
    customer: {
      name: tx.payer_name || null,
      email: tx.payer_email || tx.email || null,
      phone: tx.payer_phone || null,
      document: tx.payer_document || tx.document || null,
      ip: firstIp(req)
    },
    tracking: {
      utm_source: identifiers.utm_source || null,
      utm_medium: identifiers.utm_medium || null,
      utm_campaign: identifiers.utm_campaign || null,
      utm_content: identifiers.utm_content || null,
      utm_term: identifiers.utm_term || null,
      src: identifiers.src || null,
      sck: identifiers.sck || null
    },
    isTest: false
  });

  // Envia visitor_id como referência extra dentro do pedido (rastreável nos logs).
  if (identifiers.visitor_id) {
    order.visitor_id = identifiers.visitor_id;
  }

  var utmifyResult = await utmify.sendOrder(order, process.env.UTMIFY_API_TOKEN);

  /* ---------------------------- Meta CAPI ------------------------------ */
  // Purchase server-side SOMENTE quando pago e com identificador real.
  var metaResult = { skipped: true, reason: "not_paid" };
  if (mappedStatus === "paid") {
    metaResult = await metaCapi.sendPurchase({
      pixelId: process.env.META_PIXEL_ID,
      accessToken: process.env.META_ACCESS_TOKEN,
      testEventCode: process.env.META_TEST_EVENT_CODE || null,
      identifiers: {
        visitor_id: identifiers.visitor_id || null,
        fbc: identifiers.fbc || null,
        fbp: identifiers.fbp || null
      },
      value: valueInReais,
      currency: "BRL",
      // event_id = transaction_id para deduplicar com o Pixel (mas NUNCA como external_id).
      eventId: transactionId,
      email: tx.payer_email || tx.email || null,
      phone: tx.payer_phone || null,
      name: tx.payer_name || null,
      clientIp: firstIp(req),
      clientUserAgent: req.headers["user-agent"] || null
    });
  } else {
    console.log("[ASF][Meta] Status não é 'paid' (" + mappedStatus + ") — Purchase não enviado.");
  }

  /* ------------------------------ Resposta ----------------------------- */
  res.status(200).json({
    ok: true,
    transaction_id: transactionId,
    status_fastdepix: rawStatus,
    status_utmify: mappedStatus,
    value_cents: valueInCents,
    utmify: { ok: utmifyResult.ok, status: utmifyResult.status },
    meta: metaResult.skipped
      ? { skipped: true, reason: metaResult.reason }
      : { ok: metaResult.ok, status: metaResult.status }
  });
};

// Desliga o body parser padrão do Vercel para conseguirmos ler o RAW BODY.
// (Definido DEPOIS do module.exports do handler para não ser sobrescrito.)
module.exports.config = {
  api: {
    bodyParser: false
  }
};
