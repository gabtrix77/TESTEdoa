/* =============================================================================
 * lib/meta-capi.js
 * -----------------------------------------------------------------------------
 * Envio do evento Purchase server-side para a Meta Conversion API (CAPI).
 * Endpoint: POST https://graph.facebook.com/v19.0/<PIXEL_ID>/events
 *
 * REGRAS CRÍTICAS (conforme RELATORIO.md):
 *   - O Purchase só é enviado quando existe um identificador REAL do visitante
 *     (visitor_id, fbc ou fbp). Sem isso, não enviamos nada.
 *   - `transaction_id` NUNCA é usado como external_id.
 *   - `external_id` recebe o visitor_id quando ele existe.
 *   - E-mail só é enviado quando a FastDepix fornece um e-mail real.
 *     Nenhum e-mail fictício é usado.
 * ========================================================================== */

"use strict";

var crypto = require("crypto");

var GRAPH_VERSION = "v19.0";

/**
 * SHA-256 em minúsculas/trim, como a Meta exige para dados de PII.
 */
function sha256(value) {
  if (value === null || value === undefined) return null;
  var normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Normaliza telefone: só dígitos (com DDI). Ex.: "+55 (71) 99999-9999" -> "5571999999999".
 */
function normalizePhone(phone) {
  if (!phone) return null;
  var digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  // Se vier sem DDI (menos de 12 dígitos) e parecer BR, prefixa 55.
  if (digits.length <= 11) digits = "55" + digits;
  return digits;
}

function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Decide se há identificador real de visitante suficiente para enviar o Purchase.
 */
function hasRealVisitorSignal(ids) {
  ids = ids || {};
  return !!(ids.visitor_id || ids.fbc || ids.fbp);
}

/**
 * Monta o user_data respeitando todas as regras.
 */
function buildUserData(opts) {
  var ids = opts.identifiers || {};
  var userData = {};

  // fbc / fbp diretos (não são hasheados).
  if (ids.fbc) userData.fbc = ids.fbc;
  if (ids.fbp) userData.fbp = ids.fbp;

  // external_id = visitor_id (NUNCA transaction_id). Hasheado.
  if (ids.visitor_id) {
    userData.external_id = sha256(ids.visitor_id);
  }

  // E-mail somente se real.
  if (isValidEmail(opts.email)) {
    userData.em = [sha256(opts.email)];
  }

  // Telefone somente se real.
  var phone = normalizePhone(opts.phone);
  if (phone) {
    userData.ph = [sha256(phone)];
  }

  // Nome (opcional) — primeiro/último nome hasheados.
  if (opts.name && typeof opts.name === "string") {
    var parts = opts.name.trim().split(/\s+/);
    if (parts.length >= 1 && parts[0]) userData.fn = [sha256(parts[0])];
    if (parts.length >= 2 && parts[parts.length - 1]) {
      userData.ln = [sha256(parts[parts.length - 1])];
    }
  }

  // IP e user agent quando disponíveis (melhoram o match).
  if (opts.clientIp) userData.client_ip_address = opts.clientIp;
  if (opts.clientUserAgent) userData.client_user_agent = opts.clientUserAgent;

  return userData;
}

/**
 * Envia o evento Purchase para a Meta CAPI.
 *
 * @param {Object} opts
 * @param {string} opts.pixelId
 * @param {string} opts.accessToken
 * @param {string} [opts.testEventCode]
 * @param {Object} opts.identifiers   - { visitor_id, fbc, fbp }
 * @param {number} opts.value         - valor em reais (ex.: 10.00)
 * @param {string} [opts.currency]    - default BRL
 * @param {string} [opts.eventId]     - para deduplicação com o Pixel (ex.: transaction_id)
 * @param {string} [opts.email]
 * @param {string} [opts.phone]
 * @param {string} [opts.name]
 * @param {string} [opts.eventSourceUrl]
 * @param {number} [opts.eventTime]   - unix seconds
 * @param {string} [opts.clientIp]
 * @param {string} [opts.clientUserAgent]
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, status?:number, body?:any}>}
 */
async function sendPurchase(opts) {
  opts = opts || {};

  if (!opts.pixelId || !opts.accessToken) {
    console.warn("[ASF][Meta] META_PIXEL_ID/META_ACCESS_TOKEN ausentes — pulando Purchase.");
    return { ok: false, skipped: true, reason: "missing_credentials" };
  }

  // Guard-rail principal: sem identificador real, não envia nada.
  if (!hasRealVisitorSignal(opts.identifiers)) {
    console.log("[ASF][Meta] Sem visitor_id/fbc/fbp reais — Purchase NÃO enviado (apenas log).");
    return { ok: false, skipped: true, reason: "no_real_visitor_signal" };
  }

  var userData = buildUserData(opts);

  var eventTime = opts.eventTime || Math.floor(Date.now() / 1000);

  var eventObj = {
    event_name: "Purchase",
    event_time: eventTime,
    action_source: "website",
    user_data: userData,
    custom_data: {
      currency: opts.currency || "BRL",
      value: Number(opts.value || 0)
    }
  };

  // event_id para deduplicar com o Pixel do navegador (se você disparar Purchase lá também).
  if (opts.eventId) eventObj.event_id = String(opts.eventId);
  if (opts.eventSourceUrl) eventObj.event_source_url = opts.eventSourceUrl;

  var payload = { data: [eventObj] };
  if (opts.testEventCode) payload.test_event_code = opts.testEventCode;

  var url =
    "https://graph.facebook.com/" +
    GRAPH_VERSION +
    "/" +
    encodeURIComponent(opts.pixelId) +
    "/events?access_token=" +
    encodeURIComponent(opts.accessToken);

  try {
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    var text = await res.text();
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }

    if (!res.ok) {
      console.error("[ASF][Meta] Falha", res.status, parsed);
    } else {
      console.log("[ASF][Meta] Purchase OK", res.status, "value:", eventObj.custom_data.value);
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    console.error("[ASF][Meta] Erro de rede:", err && err.message);
    return { ok: false, status: 0, body: String(err && err.message) };
  }
}

module.exports = {
  GRAPH_VERSION: GRAPH_VERSION,
  sha256: sha256,
  normalizePhone: normalizePhone,
  isValidEmail: isValidEmail,
  hasRealVisitorSignal: hasRealVisitorSignal,
  buildUserData: buildUserData,
  sendPurchase: sendPurchase
};
