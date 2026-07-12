/* =============================================================================
 * lib/identifiers.js
 * -----------------------------------------------------------------------------
 * Extrai identificadores de tracking (visitor_id, fbc, fbp, fbclid, utm_*, ref,
 * external_id, metadata, origin, etc.) de qualquer origem que a FastDepix possa
 * usar: query string do webhook, corpo (body) da requisição e strings/URLs
 * embutidas no próprio payload da transação.
 *
 * Princípio: NÃO inventa correlação. Só reporta o que realmente chegou.
 * ========================================================================== */

"use strict";

// Chaves que consideramos identificadores relevantes.
var TRACKING_KEYS = [
  "visitor_id",
  "fbc",
  "fbp",
  "fbclid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
  "external_id",
  "origin",
  "sck",
  "src"
];

/**
 * Remove valores vazios/nulos de um objeto e devolve apenas o que tem conteúdo.
 * Se não sobrar nada, devolve null (para não logar `{}`).
 */
function compact(obj) {
  if (!obj || typeof obj !== "object") return null;
  var out = {};
  var found = false;
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (v === null || v === undefined) return;
    if (typeof v === "string" && v.trim() === "") return;
    out[k] = v;
    found = true;
  });
  return found ? out : null;
}

/**
 * Faz o parse de uma query string ("a=1&b=2") em objeto.
 */
function parseQueryString(qs) {
  var out = {};
  if (!qs || typeof qs !== "string") return out;
  qs = qs.replace(/^[?#]/, "");
  var pairs = qs.split("&");
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var idx = pairs[i].indexOf("=");
    var key, val;
    if (idx === -1) {
      key = pairs[i];
      val = "";
    } else {
      key = pairs[i].slice(0, idx);
      val = pairs[i].slice(idx + 1);
    }
    try {
      key = decodeURIComponent(key.replace(/\+/g, " "));
      val = decodeURIComponent(val.replace(/\+/g, " "));
    } catch (e) {
      /* mantém como veio se der erro de decode */
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Percorre recursivamente qualquer estrutura (objeto, array, string) procurando
 * identificadores conhecidos:
 *   - chaves que batem com TRACKING_KEYS
 *   - strings que sejam URLs ou query strings contendo esses parâmetros
 */
function deepExtract(node, acc, depth) {
  if (depth > 6 || node === null || node === undefined) return;

  if (typeof node === "string") {
    // Se a string parece uma URL ou query string, extrai parâmetros dela.
    if (node.indexOf("=") !== -1 && (node.indexOf("&") !== -1 || node.indexOf("?") !== -1 || node.indexOf("http") === 0)) {
      var qs = node;
      var qIdx = node.indexOf("?");
      if (node.indexOf("http") === 0 && qIdx !== -1) {
        qs = node.slice(qIdx + 1);
      }
      var parsed = parseQueryString(qs);
      Object.keys(parsed).forEach(function (k) {
        if (TRACKING_KEYS.indexOf(k) !== -1 && !acc[k]) {
          acc[k] = parsed[k];
        }
      });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) {
      deepExtract(node[i], acc, depth + 1);
    }
    return;
  }

  if (typeof node === "object") {
    Object.keys(node).forEach(function (key) {
      var value = node[key];
      // Chave diretamente reconhecida.
      if (TRACKING_KEYS.indexOf(key) !== -1) {
        if (value !== null && value !== undefined && String(value).trim() !== "" && !acc[key]) {
          acc[key] = value;
        }
      }
      // metadata é guardado inteiro (pode conter o que a landing enviou).
      if (key === "metadata" && value && typeof value === "object") {
        acc.metadata = value;
      }
      deepExtract(value, acc, depth + 1);
    });
  }
}

/**
 * Coleta identificadores de query, body e payload.
 *
 * @param {Object} sources
 * @param {Object} sources.query  - req.query (objeto)
 * @param {Object} sources.body   - corpo já parseado (objeto) OU string
 * @param {Object} sources.payload- objeto da transação (geralmente = body)
 * @returns {Object} identificadores encontrados (sem chaves vazias)
 */
function collectIdentifiers(sources) {
  sources = sources || {};
  var acc = {};

  // 1) Query string do webhook.
  if (sources.query && typeof sources.query === "object") {
    Object.keys(sources.query).forEach(function (k) {
      if (TRACKING_KEYS.indexOf(k) !== -1 && sources.query[k]) {
        acc[k] = sources.query[k];
      }
    });
    deepExtract(sources.query, acc, 0);
  }

  // 2) Body (objeto ou string).
  if (sources.body) {
    deepExtract(sources.body, acc, 0);
  }

  // 3) Payload da transação (busca profunda por URLs/strings).
  if (sources.payload) {
    deepExtract(sources.payload, acc, 0);
  }

  return acc;
}

module.exports = {
  TRACKING_KEYS: TRACKING_KEYS,
  compact: compact,
  parseQueryString: parseQueryString,
  collectIdentifiers: collectIdentifiers
};
