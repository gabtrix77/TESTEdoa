/* =============================================================================
 * lib/utmify.js
 * -----------------------------------------------------------------------------
 * Envio de pedidos para a UTMify via API de credenciais.
 * Endpoint: POST https://api.utmify.com.br/api-credentials/orders
 * Header:   x-api-token: <UTMIFY_API_TOKEN>
 *
 * A UTMify trabalha com "status" de pedido, então o webhook mapeia o status
 * da FastDepix para o status esperado pela UTMify antes de chamar aqui.
 * ========================================================================== */

"use strict";

var UTMIFY_ENDPOINT = "https://api.utmify.com.br/api-credentials/orders";

/**
 * Formata uma data para "YYYY-MM-DD HH:MM:SS" em UTC (formato aceito pela UTMify).
 */
function toUtmifyDate(dateInput) {
  var d;
  if (dateInput instanceof Date) {
    d = dateInput;
  } else if (dateInput) {
    d = new Date(dateInput);
    if (isNaN(d.getTime())) d = new Date();
  } else {
    d = new Date();
  }
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return (
    d.getUTCFullYear() + "-" +
    pad(d.getUTCMonth() + 1) + "-" +
    pad(d.getUTCDate()) + " " +
    pad(d.getUTCHours()) + ":" +
    pad(d.getUTCMinutes()) + ":" +
    pad(d.getUTCSeconds())
  );
}

/**
 * Monta o corpo do pedido no formato da UTMify.
 *
 * @param {Object} p
 * @param {string} p.orderId          - sempre o transaction_id da FastDepix
 * @param {string} p.status           - waiting_payment | paid | refunded | refused
 * @param {number} p.valueInCents      - valor bruto em centavos
 * @param {Object} p.customer          - { name, email, phone, document, ip }
 * @param {Object} p.tracking          - { utm_source, utm_medium, ... , src, sck }
 * @param {Date|string} p.createdAt    - data de criação
 * @param {Date|string} [p.approvedDate] - data de aprovação (quando pago)
 * @param {boolean} [p.isTest]         - marca como teste na UTMify
 * @returns {Object}
 */
// A UTMify EXIGE customer.email (não aceita null — SCHEMA_VALIDATION_FAILED).
// Como a FastDepix não envia e-mail do pagador, geramos um e-mail sintético
// e determinístico por pedido, usado SOMENTE aqui na UTMify (nunca no Meta).
function syntheticEmail(orderId) {
  var id = String(orderId || "sem-id").replace(/[^a-zA-Z0-9]/g, "");
  return "doador-" + id + "@doeagoraesalveoscaes.com";
}

function buildOrderPayload(p) {
  var tracking = p.tracking || {};
  var customer = p.customer || {};
  var valueInCents = p.valueInCents || 0;

  var status = p.status;
  var approvedDate = null;
  if (status === "paid") {
    approvedDate = toUtmifyDate(p.approvedDate || new Date());
  }
  var refundedAt = null;
  if (status === "refunded") {
    refundedAt = toUtmifyDate(p.approvedDate || new Date());
  }

  return {
    orderId: String(p.orderId),
    platform: "FastDepix",
    paymentMethod: "pix",
    status: status,
    createdAt: toUtmifyDate(p.createdAt),
    approvedDate: approvedDate,
    refundedAt: refundedAt,
    customer: {
      name: customer.name || "Doador",
      email: customer.email || syntheticEmail(p.orderId),
      phone: customer.phone || null,
      document: customer.document || null,
      country: "BR",
      ip: customer.ip || null
    },
    products: [
      {
        id: "doacao-abrigo-sao-francisco",
        name: "Doação — Abrigo São Francisco",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: valueInCents
      }
    ],
    trackingParameters: {
      src: tracking.src || null,
      sck: tracking.sck || null,
      utm_source: tracking.utm_source || null,
      utm_medium: tracking.utm_medium || null,
      utm_campaign: tracking.utm_campaign || null,
      utm_content: tracking.utm_content || null,
      utm_term: tracking.utm_term || null
    },
    commission: {
      totalPriceInCents: valueInCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: valueInCents,
      currency: "BRL"
    },
    isTest: !!p.isTest
  };
}

/**
 * Envia o pedido para a UTMify.
 * Usa fetch nativo (Node 18+).
 *
 * @param {Object} order  - payload já montado por buildOrderPayload
 * @param {string} token  - UTMIFY_API_TOKEN
 * @returns {Promise<{ok:boolean, status:number, body:any}>}
 */
async function sendOrder(order, token) {
  if (!token) {
    console.warn("[ASF][UTMify] UTMIFY_API_TOKEN ausente — pulando envio.");
    return { ok: false, status: 0, body: "missing_token" };
  }

  try {
    var res = await fetch(UTMIFY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": token
      },
      body: JSON.stringify(order)
    });

    var text = await res.text();
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }

    if (!res.ok) {
      console.error("[ASF][UTMify] Falha", res.status, parsed);
    } else {
      console.log("[ASF][UTMify] OK", res.status, "orderId:", order.orderId, "status:", order.status);
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    console.error("[ASF][UTMify] Erro de rede:", err && err.message);
    return { ok: false, status: 0, body: String(err && err.message) };
  }
}

module.exports = {
  UTMIFY_ENDPOINT: UTMIFY_ENDPOINT,
  toUtmifyDate: toUtmifyDate,
  syntheticEmail: syntheticEmail,
  buildOrderPayload: buildOrderPayload,
  sendOrder: sendOrder
};
