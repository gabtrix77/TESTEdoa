/* =============================================================================
 * api/create-transaction.js  (Vercel Serverless Function)
 * -----------------------------------------------------------------------------
 * Nova rota que SUBSTITUI o redirecionamento para o checkout hospedado.
 *
 * Fluxo:
 *   1. O frontend faz POST aqui com { amount, tracking }.
 *   2. Chamamos a API da FastDepix para criar a transação (gerar o PIX).
 *   3. Recebemos o transaction_id.
 *   4. Salvamos o tracking (visitor_id, fbc, fbp, UTMs) no KV, ligado ao
 *      transaction_id, com TTL. É isso que o webhook vai recuperar depois.
 *   5. Devolvemos ao frontend o PIX (copia-e-cola / QR) + transaction_id.
 *
 * Não retornamos NENHUM segredo da API ao navegador.
 * ========================================================================== */

"use strict";

var fastdepix = require("../lib/fastdepix");
var kv = require("../lib/kv");

// Faixa alinhada à API da FastDepix: mínimo oficial R$ 10,00.
// Máximo limitado a R$ 499,99 — a partir de R$ 500 a API exige nome + CPF/CNPJ,
// que esta landing não coleta.
var MIN_VALUE = 10;
var MAX_VALUE = 499.99;

function readRawBody(req) {
  return new Promise(function (resolve) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", function () { resolve(""); });
  });
}

function firstIp(req) {
  var xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

function buildWebhookUrl(req) {
  if (process.env.FASTDEPIX_WEBHOOK_URL) return process.env.FASTDEPIX_WEBHOOK_URL;
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "") + "/api/webhook";
  }
  var proto = req.headers["x-forwarded-proto"] || "https";
  var host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return null;
  return proto + "://" + host + "/api/webhook";
}

function sanitizeTracking(t) {
  t = t || {};
  var keys = ["visitor_id", "fbc", "fbp", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"];
  var out = {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (t[k] != null && String(t[k]).trim() !== "") {
      out[k] = String(t[k]).slice(0, 512); // limite defensivo
    }
  }
  return out;
}

// A DePix (motor da FastDepix) exige nome + CPF/CNPJ do pagador em toda transação.
// Sanitiza e valida o mínimo antes de chamar a API (evita ida desnecessária).
function sanitizeCustomer(c) {
  c = c || {};
  var name = String(c.name || "").trim().slice(0, 80);
  var doc = String(c.cpf_cnpj || c.document || "").replace(/\D/g, "");
  var out = { name: name, cpf_cnpj: doc };
  out.valid = name.length >= 3 && name.indexOf(" ") !== -1 && (doc.length === 11 || doc.length === 14);
  return out;
}

module.exports = async function handler(req, res) {
  // CORS básico (mesma origem em produção; libera preflight).
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  var raw = await readRawBody(req);
  var body;
  try { body = JSON.parse(raw); } catch (e) { body = null; }
  if (!body || typeof body !== "object") {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  // Valor em reais.
  var amount = Number(body.amount);
  if (isNaN(amount) || amount < MIN_VALUE || amount > MAX_VALUE) {
    res.status(400).json({ ok: false, error: "invalid_amount", min: MIN_VALUE, max: MAX_VALUE });
    return;
  }
  amount = Math.round(amount * 100) / 100;

  // Dados obrigatórios do pagador (requisito DePix).
  var customer = sanitizeCustomer(body.customer);
  if (!customer.valid) {
    res.status(400).json({ ok: false, error: "invalid_customer", detail: "Nome e CPF/CNPJ válidos são obrigatórios." });
    return;
  }

  var tracking = sanitizeTracking(body.tracking);
  var webhookUrl = buildWebhookUrl(req);

  console.log("[ASF][create-transaction] amount:", amount, "customer:", customer.name, "doc:", customer.cpf_cnpj.length + " dígitos", "tracking:", JSON.stringify(tracking));

  // 1-3) Cria a transação na FastDepix.
  var created = await fastdepix.createTransaction({
    amount: amount,
    tracking: tracking,
    customer: { name: customer.name, cpf_cnpj: customer.cpf_cnpj },
    webhookUrl: webhookUrl
  });

  if (!created.ok || !created.result || !created.result.transactionId) {
    console.error("[ASF][create-transaction] Falha na FastDepix:", created.error);
    res.status(502).json({
      ok: false,
      error: "fastdepix_failed",
      detail: created.error || "sem transaction_id"
    });
    return;
  }

  var transactionId = created.result.transactionId;

  // 4) Salva o tracking no KV, ligado ao transaction_id.
  try {
    await kv.setJSON(
      kv.trackingKey(transactionId),
      {
        transaction_id: transactionId,
        amount: amount,
        tracking: tracking,
        ip: firstIp(req),
        user_agent: req.headers["user-agent"] || null,
        created_at: new Date().toISOString()
      },
      60 * 60 * 24 // 24h
    );
  } catch (err) {
    // Não falha a criação do PIX se o KV der erro — apenas loga.
    console.error("[ASF][create-transaction] Erro ao salvar no KV:", err && err.message);
  }

  // 5) Devolve o PIX ao frontend (sem segredos).
  res.status(200).json({
    ok: true,
    transaction_id: transactionId,
    status: created.result.status,
    pix: {
      qr_code_text: created.result.pix.qrCodeText,   // copia-e-cola
      qr_code_image: created.result.pix.qrCodeImage, // base64 quando houver
      expires_at: created.result.pix.expiresAt
    }
  });
};

module.exports.config = { api: { bodyParser: false } };
