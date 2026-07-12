/* =============================================================================
 * lib/kv.js
 * -----------------------------------------------------------------------------
 * Armazenamento temporário (KV) para guardar o tracking da doação (visitor_id,
 * fbc, fbp, UTMs) ligado ao transaction_id enquanto o PIX não é pago.
 *
 * Usa o REST do Vercel KV / Upstash Redis (sem dependência npm):
 *   - KV_REST_API_URL
 *   - KV_REST_API_TOKEN
 *
 * Se essas variáveis não existirem (ex.: rodando local sem KV), cai num
 * fallback EM MEMÓRIA — bom apenas para desenvolvimento, NÃO para produção
 * (cada invocação serverless tem sua própria memória).
 * ========================================================================== */

"use strict";

var MEM = new Map(); // fallback dev

/**
 * Resolve as credenciais REST aceitando os dois padrões de nome que a Vercel /
 * Upstash podem injetar:
 *   - KV_REST_API_URL / KV_REST_API_TOKEN            (compatível com Vercel KV)
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (integração Upstash)
 */
function restCreds() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
  };
}

function hasRest() {
  var c = restCreds();
  return !!(c.url && c.token);
}

/**
 * Executa um comando Redis via REST do Upstash/Vercel KV.
 * Ex.: command(["SET", "k", "v", "EX", "86400"])
 */
async function command(args) {
  var creds = restCreds();
  var url = creds.url;
  var token = creds.token;

  var res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { result: text }; }

  if (!res.ok || (data && data.error)) {
    throw new Error("KV REST error: " + res.status + " " + (data && data.error ? data.error : text));
  }
  return data ? data.result : null;
}

/**
 * Salva um valor (objeto) com expiração em segundos.
 * @param {string} key
 * @param {any} value  - será serializado em JSON
 * @param {number} ttlSeconds - default 24h
 */
async function setJSON(key, value, ttlSeconds) {
  var ttl = ttlSeconds || 60 * 60 * 24; // 24h
  var payload = JSON.stringify(value);

  if (!hasRest()) {
    MEM.set(key, { payload: payload, exp: Date.now() + ttl * 1000 });
    console.warn("[ASF][KV] (fallback memória) SET", key, "ttl=" + ttl + "s");
    return true;
  }

  await command(["SET", key, payload, "EX", String(ttl)]);
  console.log("[ASF][KV] SET", key, "ttl=" + ttl + "s");
  return true;
}

/**
 * Recupera e faz parse de um valor salvo.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function getJSON(key) {
  if (!hasRest()) {
    var entry = MEM.get(key);
    if (!entry) return null;
    if (entry.exp && entry.exp < Date.now()) {
      MEM.delete(key);
      return null;
    }
    try { return JSON.parse(entry.payload); } catch (e) { return null; }
  }

  var result = await command(["GET", key]);
  if (result === null || result === undefined) return null;
  try {
    return typeof result === "string" ? JSON.parse(result) : result;
  } catch (e) {
    return null;
  }
}

/**
 * Remove uma chave (opcional — o TTL já limpa sozinho).
 */
async function del(key) {
  if (!hasRest()) {
    MEM.delete(key);
    return true;
  }
  await command(["DEL", key]);
  return true;
}

/**
 * Monta a chave padrão para o tracking de uma transação.
 */
function trackingKey(transactionId) {
  return "asf:tx:" + String(transactionId);
}

/**
 * Chave para guardar o status atual de uma transação (usada pela tela de
 * obrigado, que consulta se o pagamento já foi confirmado).
 */
function statusKey(transactionId) {
  return "asf:status:" + String(transactionId);
}

module.exports = {
  hasRest: hasRest,
  setJSON: setJSON,
  getJSON: getJSON,
  del: del,
  trackingKey: trackingKey,
  statusKey: statusKey
};
