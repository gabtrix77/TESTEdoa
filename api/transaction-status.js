/* =============================================================================
 * api/transaction-status.js  (Vercel Serverless Function)
 * -----------------------------------------------------------------------------
 * Consulta leve usada pela tela de PIX (modal) para saber se o pagamento já foi
 * confirmado. O status é gravado no KV pelo webhook (api/webhook.js).
 *
 * GET /api/transaction-status?id=<transaction_id>
 *   -> { ok: true, status: "pending"|"waiting_payment"|"paid"|..., paid: boolean }
 *
 * Não expõe nenhum dado sensível — apenas o status da transação.
 * ========================================================================== */

"use strict";

var kv = require("../lib/kv");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  var id = req.query && (req.query.id || req.query.transaction_id);
  if (!id) {
    res.status(400).json({ ok: false, error: "missing_id" });
    return;
  }

  try {
    var entry = await kv.getJSON(kv.statusKey(String(id)));
    if (!entry) {
      // Ainda não chegou webhook para essa transação.
      res.status(200).json({ ok: true, status: "pending", paid: false });
      return;
    }
    res.status(200).json({
      ok: true,
      status: entry.mapped || entry.raw || "pending",
      paid: !!entry.paid
    });
  } catch (err) {
    console.error("[ASF][status] Erro ao ler KV:", err && err.message);
    // Em caso de erro, não trava a tela — devolve pendente.
    res.status(200).json({ ok: true, status: "pending", paid: false });
  }
};
