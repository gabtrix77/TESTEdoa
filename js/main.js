/* =============================================================================
 * Abrigo São Francisco — main.js  (integração via API da FastDepix)
 * -----------------------------------------------------------------------------
 * NOVO FLUXO (substitui o redirecionamento para o checkout hospedado):
 *   1. Gera/persiste visitor_id (cookie asf_visitor_id + localStorage)
 *   2. Captura UTMs, fbclid, fbc, fbp
 *   3. Ao doar, faz POST para /api/create-transaction com { amount, tracking }
 *   4. O backend cria o PIX na FastDepix, salva o tracking no KV e devolve o PIX
 *   5. Exibimos um MODAL com o QR Code + copia-e-cola, sem sair da página
 *
 * A landing continua sem CPF e sem checkout próprio — quem gera o PIX é a
 * FastDepix (agora via API, no nosso backend).
 * ========================================================================== */

(function () {
  "use strict";

  var CONFIG = {
    // Rota do nosso backend que cria a transação na FastDepix.
    CREATE_ENDPOINT: "/api/create-transaction",

    // Rota que informa se o pagamento já foi confirmado (tela de obrigado).
    STATUS_ENDPOINT: "/api/transaction-status",
    POLL_MS: 4000,     // consulta o status a cada 4s
    POLL_MAX: 225,     // ~15 min (cobre o tempo de expiração do QR)

    // Cookie/localStorage do visitor_id.
    VISITOR_COOKIE: "asf_visitor_id",
    VISITOR_COOKIE_DAYS: 365,

    // Faixa de valor aceita pela API da FastDepix e pela landing (reais).
    // Mínimo oficial da FastDepix: R$ 10,00.
    // Máximo aqui limitado a R$ 499,99 (>= R$ 500 a API exige nome + CPF/CNPJ).
    MIN_VALUE: 10,
    MAX_VALUE: 499.99,

    // Lib para desenhar o QR Code a partir do copia-e-cola (carregada sob demanda).
    QR_LIB_URL: "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"
  };

  /* ----------------------------- logging ------------------------------- */
  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[ASF]");
    try { console.log.apply(console, args); } catch (e) {}
  }

  /* ----------------------------- cookies ------------------------------- */
  function setCookie(name, value, days) {
    var expires = "";
    if (days) {
      var d = new Date();
      d.setTime(d.getTime() + days * 864e5);
      expires = "; expires=" + d.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/; SameSite=Lax";
  }
  function getCookie(name) {
    var target = name + "=";
    var parts = document.cookie ? document.cookie.split(";") : [];
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].replace(/^\s+/, "");
      if (c.indexOf(target) === 0) return decodeURIComponent(c.substring(target.length));
    }
    return null;
  }

  /* --------------------------- visitor_id ------------------------------ */
  function generateVisitorId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      if (window.crypto && window.crypto.getRandomValues) {
        var buf = new Uint8Array(16);
        window.crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        var hex = [];
        for (var i = 0; i < 16; i++) hex.push((buf[i] + 0x100).toString(16).substr(1));
        return hex[0]+hex[1]+hex[2]+hex[3]+"-"+hex[4]+hex[5]+"-"+hex[6]+hex[7]+"-"+hex[8]+hex[9]+"-"+hex[10]+hex[11]+hex[12]+hex[13]+hex[14]+hex[15];
      }
    } catch (e) {}
    return "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function getOrCreateVisitorId() {
    var id = null;
    try { id = window.localStorage.getItem(CONFIG.VISITOR_COOKIE); } catch (e) {}
    if (!id) id = getCookie(CONFIG.VISITOR_COOKIE);
    if (!id) { id = generateVisitorId(); log("Novo visitor_id:", id); }
    setCookie(CONFIG.VISITOR_COOKIE, id, CONFIG.VISITOR_COOKIE_DAYS);
    try { window.localStorage.setItem(CONFIG.VISITOR_COOKIE, id); } catch (e) {}
    return id;
  }

  /* ---------------------------- tracking ------------------------------- */
  function getQueryParams() {
    var params = {};
    var query = window.location.search.replace(/^\?/, "");
    if (!query) return params;
    var pairs = query.split("&");
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      var kv = pairs[i].split("=");
      var key = decodeURIComponent(kv[0]);
      var val = kv.length > 1 ? decodeURIComponent(kv[1].replace(/\+/g, " ")) : "";
      if (key) params[key] = val;
    }
    return params;
  }
  function buildFbcFromFbclid(fbclid) {
    if (!fbclid) return null;
    return "fb.1." + Date.now() + "." + fbclid;
  }
  function collectTracking() {
    var q = getQueryParams();
    var t = {};
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term"].forEach(function (k) {
      if (q[k]) t[k] = q[k];
    });
    if (q.fbclid) t.fbclid = q.fbclid;
    var fbc = getCookie("_fbc");
    var fbp = getCookie("_fbp");
    if (!fbc && q.fbclid) fbc = buildFbcFromFbclid(q.fbclid);
    if (fbc) t.fbc = fbc;
    if (fbp) t.fbp = fbp;
    if (q.ref) t.ref = q.ref;
    t.visitor_id = getOrCreateVisitorId();
    return t;
  }

  /* ------------------------------ modal PIX ---------------------------- */
  var modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    var overlay = document.createElement("div");
    overlay.className = "pix-modal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML =
      '<div class="pix-modal__box">' +
        '<button class="pix-modal__close" aria-label="Fechar" data-pix-close>&times;</button>' +
        '<div class="pix-modal__body" data-pix-body></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.hasAttribute("data-pix-close")) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if ((e.key === "Escape" || e.keyCode === 27) && overlay.classList.contains("is-open")) closeModal();
    });

    modalEl = overlay;
    return overlay;
  }
  function openModal(html) {
    var m = ensureModal();
    m.querySelector("[data-pix-body]").innerHTML = html;
    m.classList.add("is-open");
    document.body.style.overflow = "hidden";
    return m;
  }
  function closeModal() {
    if (!modalEl) return;
    stopPolling();
    modalEl.classList.remove("is-open");
    document.body.style.overflow = "";
  }
  function setModalBody(html) {
    if (!modalEl) return openModal(html);
    modalEl.querySelector("[data-pix-body]").innerHTML = html;
    return modalEl;
  }

  function loadingHtml(valueInReais) {
    return (
      '<div class="pix-loading">' +
        '<span class="spinner spinner--dark"></span>' +
        '<p>Gerando seu PIX de <strong>R$ ' + formatBRL(valueInReais) + '</strong>…</p>' +
      '</div>'
    );
  }
  function errorHtml(msg) {
    return (
      '<div class="pix-error">' +
        '<h3>Não consegui gerar o PIX 😢</h3>' +
        '<p>' + (msg || "Tente novamente em instantes.") + '</p>' +
        '<button class="btn-primary" data-pix-close>Fechar</button>' +
      '</div>'
    );
  }

  function formatBRL(v) {
    var n = Number(v) || 0;
    return n.toFixed(2).replace(".", ",");
  }

  function thankYouHtml(valueInReais) {
    return (
      '<div class="pix-thanks">' +
        '<div class="pix-thanks__icon">🙌</div>' +
        '<span class="eyebrow">Pagamento confirmado</span>' +
        '<h3>Recebemos sua ajuda, obrigado!</h3>' +
        '<p>Sua doação de <strong>R$ ' + formatBRL(valueInReais) + '</strong> já está ajudando a encher barriguinhas e cuidar dos nossos resgatados. ❤️🐾</p>' +
        '<button class="btn-primary" data-pix-close type="button">Fechar</button>' +
      '</div>'
    );
  }

  function successHtml(data, valueInReais) {
    var pix = data.pix || {};
    var code = pix.qr_code_text || "";
    var img = pix.qr_code_image || "";

    var qrBlock;
    if (img) {
      var src = img.indexOf("data:") === 0 ? img : ("data:image/png;base64," + img);
      qrBlock = '<div class="pix-qr"><img alt="QR Code do PIX" src="' + src + '"></div>';
    } else {
      qrBlock = '<div class="pix-qr" id="pix-qr-canvas"></div>';
    }

    return (
      '<div class="pix-success">' +
        '<span class="eyebrow">PIX gerado</span>' +
        '<h3>Falta pouco para ajudar 🐾</h3>' +
        '<p>Escaneie o QR Code ou copie o código para pagar <strong>R$ ' + formatBRL(valueInReais) + '</strong>.</p>' +
        qrBlock +
        (code
          ? '<label class="pix-copy-label">Código copia-e-cola</label>' +
            '<div class="pix-copy">' +
              '<input type="text" readonly value="' + escapeHtml(code) + '" id="pix-code-input">' +
              '<button class="btn-secondary" id="pix-copy-btn" type="button">Copiar</button>' +
            '</div>'
          : '') +
        '<p class="pix-hint">Assim que o pagamento for confirmado, a atribuição é registrada automaticamente. Obrigado! ❤️</p>' +
      '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function renderQr(code) {
    var holder = document.getElementById("pix-qr-canvas");
    if (!holder || !code) return;
    function draw() {
      try {
        holder.innerHTML = "";
        /* global QRCode */
        new QRCode(holder, { text: code, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
      } catch (e) { log("Falha ao desenhar QR:", e && e.message); }
    }
    if (typeof window.QRCode !== "undefined") { draw(); return; }
    loadScript(CONFIG.QR_LIB_URL).then(draw).catch(function () {
      holder.innerHTML = '<p class="pix-hint">Use o código copia-e-cola abaixo.</p>';
    });
  }

  function wireCopyButton() {
    var btn = document.getElementById("pix-copy-btn");
    var input = document.getElementById("pix-code-input");
    if (!btn || !input) return;
    btn.addEventListener("click", function () {
      input.select();
      input.setSelectionRange(0, 99999);
      var done = function () { btn.textContent = "Copiado ✓"; setTimeout(function () { btn.textContent = "Copiar"; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () { document.execCommand("copy"); done(); });
      } else {
        try { document.execCommand("copy"); } catch (e) {}
        done();
      }
    });
  }

  /* ------------------- coleta de dados exigidos pela API --------------- */
  // A DePix (motor da FastDepix) exige Nome + CPF/CNPJ do pagador em TODA
  // transação. Coletamos apenas o mínimo, num passo enxuto dentro do modal.

  // Só dígitos.
  function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }

  // Máscara CPF (000.000.000-00) / CNPJ (00.000.000/0000-00) conforme digita.
  function maskCpfCnpj(v) {
    var d = onlyDigits(v).slice(0, 14);
    if (d.length <= 11) {
      return d
        .replace(/^(\d{3})(\d)/, "$1.$2")
        .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
        .replace(/\.(\d{3})(\d)/, ".$1-$2");
    }
    return d
      .replace(/^(\d{2})(\d)/, "$1.$2")
      .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1/$2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  }

  // Validação de CPF (dígitos verificadores).
  function isValidCPF(cpf) {
    cpf = onlyDigits(cpf);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    var i, sum = 0, rest;
    for (i = 1; i <= 9; i++) sum += parseInt(cpf.substring(i - 1, i), 10) * (11 - i);
    rest = (sum * 10) % 11; if (rest === 10 || rest === 11) rest = 0;
    if (rest !== parseInt(cpf.substring(9, 10), 10)) return false;
    sum = 0;
    for (i = 1; i <= 10; i++) sum += parseInt(cpf.substring(i - 1, i), 10) * (12 - i);
    rest = (sum * 10) % 11; if (rest === 10 || rest === 11) rest = 0;
    return rest === parseInt(cpf.substring(10, 11), 10);
  }

  // Validação de CNPJ (dígitos verificadores).
  function isValidCNPJ(cnpj) {
    cnpj = onlyDigits(cnpj);
    if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
    var calc = function (base) {
      var len = base.length, pos = len - 7, sum = 0, i;
      for (i = len; i >= 1; i--) {
        sum += parseInt(base.charAt(len - i), 10) * pos--;
        if (pos < 2) pos = 9;
      }
      var r = sum % 11;
      return r < 2 ? 0 : 11 - r;
    };
    var d1 = calc(cnpj.substring(0, 12));
    if (d1 !== parseInt(cnpj.charAt(12), 10)) return false;
    var d2 = calc(cnpj.substring(0, 13));
    return d2 === parseInt(cnpj.charAt(13), 10);
  }

  function isValidDoc(v) {
    var d = onlyDigits(v);
    if (d.length === 11) return isValidCPF(d);
    if (d.length === 14) return isValidCNPJ(d);
    return false;
  }

  function formHtml(valueInReais) {
    return (
      '<div class="pix-form">' +
        '<span class="eyebrow">Quase lá</span>' +
        '<h3>Doação de R$ ' + formatBRL(valueInReais) + '</h3>' +
        '<p>Precisamos só do seu nome e CPF/CNPJ para gerar o PIX com segurança.</p>' +
        '<label class="pix-field">' +
          '<span>Nome completo</span>' +
          '<input type="text" id="pix-name" autocomplete="name" placeholder="Seu nome" maxlength="80">' +
        '</label>' +
        '<label class="pix-field">' +
          '<span>CPF ou CNPJ</span>' +
          '<input type="text" id="pix-doc" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00" maxlength="18">' +
        '</label>' +
        '<p class="pix-form-error" id="pix-form-error" hidden></p>' +
        '<button class="btn-primary" id="pix-form-submit" type="button" style="width:100%">Gerar PIX</button>' +
        '<p class="pix-hint">🔒 Seus dados vão direto e com segurança para o processador de pagamento.</p>' +
      '</div>'
    );
  }

  function startDonation(valueInReais) {
    var value = Number(valueInReais);
    if (isNaN(value) || value < CONFIG.MIN_VALUE || value > CONFIG.MAX_VALUE) return;

    openModal(formHtml(value));

    var nameInput = document.getElementById("pix-name");
    var docInput = document.getElementById("pix-doc");
    var errEl = document.getElementById("pix-form-error");
    var submit = document.getElementById("pix-form-submit");

    if (docInput) {
      docInput.addEventListener("input", function () {
        var pos = docInput.value.length;
        docInput.value = maskCpfCnpj(docInput.value);
        if (pos >= docInput.value.length) docInput.setSelectionRange(docInput.value.length, docInput.value.length);
      });
    }

    function showErr(msg) {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.hidden = false;
    }

    function trySubmit() {
      var name = (nameInput && nameInput.value || "").trim();
      var doc = onlyDigits(docInput && docInput.value);

      if (name.length < 3 || name.indexOf(" ") === -1) {
        showErr("Digite seu nome completo.");
        if (nameInput) nameInput.focus();
        return;
      }
      if (!isValidDoc(doc)) {
        showErr("CPF/CNPJ inválido. Confira os números.");
        if (docInput) docInput.focus();
        return;
      }
      if (errEl) errEl.hidden = true;
      createPix(value, { name: name, cpf_cnpj: doc });
    }

    if (submit) submit.addEventListener("click", trySubmit);
    if (docInput) {
      docInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); trySubmit(); }
      });
    }
    if (nameInput) setTimeout(function () { nameInput.focus(); }, 100);
  }

  /* ---------- consulta de status + tela de obrigado (polling) ---------- */
  var pollTimer = null;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling(transactionId, valueInReais) {
    stopPolling();
    if (!transactionId) return;
    var attempts = 0;

    pollTimer = setInterval(function () {
      attempts++;
      if (attempts > CONFIG.POLL_MAX) { stopPolling(); return; }

      fetch(CONFIG.STATUS_ENDPOINT + "?id=" + encodeURIComponent(transactionId), {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      })
        .then(function (res) { return res.json(); })
        .then(function (json) {
          if (json && json.paid) {
            stopPolling();
            log("Pagamento confirmado:", transactionId);
            setModalBody(thankYouHtml(valueInReais));
          }
        })
        .catch(function () { /* silencioso — tenta de novo no próximo ciclo */ });
    }, CONFIG.POLL_MS);
  }

  /* ------------------------ criação do PIX (API) ----------------------- */
  var creating = false;

  function createPix(valueInReais, customer) {
    if (creating) return;
    creating = true;

    openModal(loadingHtml(valueInReais));

    var tracking = collectTracking();

    // Evento de intenção no Pixel.
    try {
      if (typeof window.fbq === "function") {
        window.fbq("track", "InitiateCheckout", { currency: "BRL", value: Number(valueInReais) });
      }
    } catch (e) {}

    fetch(CONFIG.CREATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: Number(valueInReais), tracking: tracking, customer: customer || {} })
    })
      .then(function (res) {
        return res.json().then(function (json) { return { ok: res.ok, json: json }; });
      })
      .then(function (r) {
        creating = false;
        if (!r.ok || !r.json || !r.json.ok) {
          var detail = r.json && (r.json.detail || r.json.error) ? (r.json.detail || r.json.error) : "";
          log("Falha na criação do PIX:", detail);
          setModalBody(errorHtml("Não foi possível gerar o PIX agora. " + (detail ? "(" + detail + ")" : "")));
          return;
        }
        log("PIX criado. transaction_id:", r.json.transaction_id);
        setModalBody(successHtml(r.json, valueInReais));
        if (!(r.json.pix && r.json.pix.qr_code_image)) {
          renderQr(r.json.pix && r.json.pix.qr_code_text);
        }
        wireCopyButton();
        // Passa a checar se o pagamento foi confirmado -> tela de obrigado.
        startPolling(r.json.transaction_id, valueInReais);
      })
      .catch(function (err) {
        creating = false;
        log("Erro de rede ao criar PIX:", err && err.message);
        setModalBody(errorHtml("Erro de conexão. Verifique sua internet e tente de novo."));
      });
  }

  /* ---------------------- valor personalizado -------------------------- */
  function getCustomValue() {
    var input = document.getElementById("custom-donation-value");
    if (!input) return null;
    var raw = (input.value || "").toString().replace(",", ".").trim();
    var num = parseFloat(raw);
    if (isNaN(num) || num < CONFIG.MIN_VALUE || num > CONFIG.MAX_VALUE) return null;
    return Math.round(num * 100) / 100;
  }
  function flagInvalidCustom() {
    var input = document.getElementById("custom-donation-value");
    if (!input) return;
    input.classList.add("is-invalid");
    input.focus();
    setTimeout(function () { input.classList.remove("is-invalid"); }, 1500);
  }

  /* --------------------------- binds da página ------------------------- */
  function scrollToDoar() {
    var target = document.getElementById("doar");
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function initValueButtons() {
    var buttons = document.querySelectorAll("[data-donate-value]");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () { startDonation(btn.getAttribute("data-donate-value")); });
      })(buttons[i]);
    }
  }
  function initCustomDonate() {
    var genericBtn = document.querySelector("[data-donate-generic]");
    if (genericBtn) {
      genericBtn.addEventListener("click", function () {
        var value = getCustomValue();
        if (!value) { flagInvalidCustom(); return; }
        startDonation(value);
      });
    }
    var input = document.getElementById("custom-donation-value");
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
          e.preventDefault();
          var value = getCustomValue();
          if (!value) { flagInvalidCustom(); return; }
          startDonation(value);
        }
      });
    }
  }
  function initScrollButtons() {
    var scrollBtns = document.querySelectorAll("[data-scroll-to-doar]");
    for (var i = 0; i < scrollBtns.length; i++) scrollBtns[i].addEventListener("click", scrollToDoar);
  }
  function initFaq() {
    var items = document.querySelectorAll(".faq-item");
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var q = item.querySelector(".faq-item__q");
        if (!q) return;
        q.addEventListener("click", function () {
          var isOpen = item.classList.contains("is-open");
          for (var j = 0; j < items.length; j++) items[j].classList.remove("is-open");
          if (!isOpen) item.classList.add("is-open");
        });
      })(items[i]);
    }
  }

  function init() {
    var vid = getOrCreateVisitorId();
    log("visitor_id ativo:", vid);
    log("tracking:", collectTracking());
    initValueButtons();
    initCustomDonate();
    initScrollButtons();
    initFaq();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
