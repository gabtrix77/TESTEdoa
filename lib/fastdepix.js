/* =============================================================================
 * lib/fastdepix.js
 * -----------------------------------------------------------------------------
 * Cliente da API oficial da FastDepix para CRIAR uma transação (gerar PIX).
 *
 * Implementado 100% conforme a documentação oficial:
 *   https://fastdepix.space/api/docs.php
 *
 * Contrato oficial (sem suposições):
 *   - Base URL .......: https://fastdepix.space/api/v1/
 *   - Endpoint .......: POST /transactions
 *   - Auth ...........: Authorization: Bearer <FASTDEPIX_API_KEY>   (formato fdpx_...)
 *   - Headers ........: Authorization + Content-Type: application/json
 *   - Body ...........: { amount, user?, payer_phone?, notification_url?, custom_page_id?, vip? }
 *                       amount em REAIS (mínimo R$ 10,00). `user` é obrigatório
 *                       quando amount >= R$ 500,00.
 *   - Resposta (201) .: { success, message, data: { id, status, qr_code,
 *                       qr_code_text, qr_code_expires_at, ... }, timestamp }
 *   - Rate limit .....: POST /transactions = 4 req/min
 *
 * Observação: o contrato oficial NÃO possui campos de metadata/external_id.
 * O tracking (visitor_id, fbc, fbp, UTMs) NÃO é enviado aqui — ele é guardado
 * no KV por api/create-transaction.js e recuperado no webhook pelo transaction_id.
 * ========================================================================== */

"use strict";

// Endpoint oficial (fixo, conforme documentação). Apenas o SECRET vem de env.
var API_ENDPOINT = "https://fastdepix.space/api/v1/transactions";

function apiKey() {
  return process.env.FASTDEPIX_API_KEY || "";
}

/**
 * Headers oficiais.
 */
function officialHeaders() {
  return {
    "Authorization": "Bearer " + apiKey(),
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}

/**
 * Monta o objeto `user` conforme o contrato oficial, a partir dos dados de
 * comprador recebidos (quando existirem). Retorna null se não houver nada.
 *
 * Campos oficiais de `user`: name, cpf_cnpj, user_type, company_name.
 */
function buildUser(customer) {
  customer = customer || {};
  var user = {};

  if (customer.name) user.name = String(customer.name);

  var doc = customer.cpf_cnpj || customer.document;
  if (doc) user.cpf_cnpj = String(doc).replace(/\D/g, "");

  // user_type: explícito quando informado; caso contrário inferido pelo documento.
  // CNPJ (14 dígitos) => company (a doc exige company_name nesse caso).
  if (customer.user_type) {
    user.user_type = String(customer.user_type);
  } else if (user.cpf_cnpj && user.cpf_cnpj.length === 14) {
    user.user_type = "company";
  }

  if (customer.company_name) {
    user.company_name = String(customer.company_name);
  } else if (user.user_type === "company" && user.name) {
    // company_name é obrigatório para pessoa jurídica; usa o nome informado.
    user.company_name = user.name;
  }

  return Object.keys(user).length ? user : null;
}

/**
 * Monta o corpo da requisição estritamente com os campos oficiais.
 *
 * @param {Object} p
 * @param {number} p.amount               - valor em REAIS (ex.: 150.00)
 * @param {Object} [p.customer]           - { name, cpf_cnpj/document, user_type, company_name, phone }
 * @param {string} [p.notificationUrl]    - URL HTTPS do nosso webhook (per-transaction)
 * @param {number} [p.customPageId]
 * @param {boolean} [p.vip]
 */
function buildRequestBody(p) {
  var body = {
    // amount em reais, número decimal (conforme doc).
    amount: Number(p.amount)
  };

  var user = buildUser(p.customer);
  if (user) body.user = user;

  // payer_phone (opcional) — apenas dígitos.
  var phone = p.customer && (p.customer.payer_phone || p.customer.phone);
  if (phone) {
    var digits = String(phone).replace(/\D/g, "");
    if (digits) body.payer_phone = digits;
  }

  // notification_url (opcional) — a doc exige HTTPS. Só enviamos se for https.
  if (p.notificationUrl && /^https:\/\//i.test(p.notificationUrl)) {
    body.notification_url = p.notificationUrl;
  }

  // Campos opcionais adicionais, só quando explicitamente informados.
  if (p.customPageId != null) body.custom_page_id = p.customPageId;
  if (p.vip === true) body.vip = true;

  return body;
}

/**
 * Normaliza a resposta oficial para o formato estável usado por
 * api/create-transaction.js. A transação vem dentro de `data`.
 *
 * Campos oficiais da resposta (data):
 *   id, amount, net_amount, commission_amount, status, depix_transaction_id,
 *   blockchain_tx_id, qr_code (URL da imagem), qr_code_text (copia-e-cola),
 *   qr_code_expires_at, custom_page_id, payer_phone, notification_url, user,
 *   created_at, updated_at
 */
function normalizeResponse(json) {
  var data = (json && json.data && typeof json.data === "object") ? json.data : {};

  return {
    transactionId: data.id != null ? String(data.id) : null,
    status: data.status || null,
    pix: {
      // copia-e-cola (string EMV) — campo oficial qr_code_text.
      qrCodeText: data.qr_code_text || null,
      // A imagem do QR oficial é uma URL (data.qr_code), não base64. O frontend
      // desenha o QR a partir do copia-e-cola, então mantemos qrCodeImage nulo
      // e expomos a URL oficial separadamente em qrCodeUrl.
      qrCodeImage: null,
      qrCodeUrl: data.qr_code || null,
      expiresAt: data.qr_code_expires_at || null
    },
    // Campos oficiais úteis, disponíveis para quem precisar.
    netAmount: data.net_amount != null ? data.net_amount : null,
    depixTransactionId: data.depix_transaction_id || null,
    raw: json
  };
}

/**
 * Cria a transação na FastDepix (POST /transactions).
 *
 * @param {Object} p
 * @param {number} p.amount            - valor em REAIS
 * @param {Object} [p.customer]        - dados do comprador (opcional; obrigatório se amount>=500)
 * @param {string} [p.webhookUrl]      - URL HTTPS do nosso webhook (vira notification_url)
 * @param {Object} [p.tracking]        - IGNORADO no corpo (não existe no contrato oficial);
 *                                       o tracking é salvo no KV por create-transaction.js
 * @returns {Promise<{ok:boolean, error?:string, status?:number, result?:object}>}
 */
async function createTransaction(p) {
  if (!apiKey()) {
    return { ok: false, error: "FASTDEPIX_API_KEY não configurada" };
  }

  var body = buildRequestBody({
    amount: p.amount,
    customer: p.customer,
    notificationUrl: p.webhookUrl,
    customPageId: p.customPageId,
    vip: p.vip
  });

  try {
    var res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: officialHeaders(),
      body: JSON.stringify(body)
    });

    var text = await res.text();
    var json;
    try { json = JSON.parse(text); } catch (e) { json = text; }

    // Erro HTTP (400/401/403/422/429/...): surfaça a mensagem oficial.
    if (!res.ok) {
      var msg = (json && typeof json === "object" && (json.message || json.error)) || ("http_" + res.status);
      console.error("[ASF][FastDepix] Falha ao criar transação", res.status, json);
      return { ok: false, status: res.status, error: String(msg), result: normalizeResponse(json) };
    }

    // Sucesso oficial: 201 Created, success:true, data.id presente.
    if (json && typeof json === "object" && json.success === false) {
      console.error("[ASF][FastDepix] success=false:", json.message);
      return { ok: false, status: res.status, error: json.message || "success_false", result: normalizeResponse(json) };
    }

    var normalized = normalizeResponse(json);
    if (!normalized.transactionId) {
      console.error("[ASF][FastDepix] Resposta sem data.id:", json);
      return { ok: false, status: res.status, error: "missing_transaction_id", result: normalized };
    }

    console.log("[ASF][FastDepix] Transação criada:", normalized.transactionId, "status:", normalized.status);
    return { ok: true, status: res.status, result: normalized };
  } catch (err) {
    console.error("[ASF][FastDepix] Erro de rede:", err && err.message);
    return { ok: false, error: String(err && err.message) };
  }
}

module.exports = {
  API_ENDPOINT: API_ENDPOINT,
  officialHeaders: officialHeaders,
  buildUser: buildUser,
  buildRequestBody: buildRequestBody,
  normalizeResponse: normalizeResponse,
  createTransaction: createTransaction
};
