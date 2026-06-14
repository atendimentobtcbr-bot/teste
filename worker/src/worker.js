/*
 * Cloudflare Worker: gera links curtos para Pix
 * Multi-encurtador: clc.is, is.gd, urlfy.org, spoo.me (escolhido pelo frontend)
 *
 * Codes internos: 8 caracteres alfanuméricos (crypto-random)
 */

const ALLOWED_ORIGINS = new Set([
  "https://atendimentobtcbr-bot.github.io",
  "http://localhost:3000",
]);

const VERSION = "teste-2026-06-14-v4-kv-ttl";
const CODE_LENGTH = 8;
const SHORTENER_TIMEOUT_MS = 6000;
const PIX_PAGE = "https://atendimentobtcbr-bot.github.io/teste/pix.html";
const MAX_PIX_LENGTH = 4000;
const KV_TTL_SECONDS = 90 * 24 * 60 * 60; // 3 meses fixos: mantem o link/historico mesmo apos o Pix expirar

const VALID_PROVIDERS = new Set(["is.gd", "clc.is", "spoo.me", "urlfy.org"]);
const DEFAULT_PROVIDER = "clc.is";

const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    try {
      if (url.pathname === "/health") {
        return json({ ok: true }, 200, corsOrigin);
      }
      if (url.pathname === "/version") {
        return json({ ok: true, version: VERSION, providers: [...VALID_PROVIDERS] }, 200, corsOrigin);
      }
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        if (!checkBasicAuth(request, env)) return unauthorizedResponse();
        return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
      }
      if (url.pathname === "/api/shorten") {
        if (!checkBasicAuth(request, env)) return unauthorizedResponse();
        return await handleShorten(request, env, url, corsOrigin);
      }
      if (url.pathname === "/api/resolve") {
        return await handleResolve(request, corsOrigin);
      }
      if (request.method === "GET") {
        return await handleRedirect(url, env);
      }
      return json({ ok: false, error: "Not found" }, 404, corsOrigin);
    } catch (err) {
      console.error("Unhandled error:", err);
      return json({ ok: false, error: "Erro interno: " + err.message }, 500, corsOrigin);
    }
  },
};

// ---------- Handlers ----------

async function handleShorten(request, env, url, corsOrigin) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405, corsOrigin);
  }
  if (!env?.PIX_LINKS) {
    return json({ ok: false, error: "KV PIX_LINKS não configurado" }, 500, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400, corsOrigin);
  }

  const pix = String(body?.pix || "").replace(/\r/g, "").trim();
  const pedido = String(body?.pedido || "").trim();
  let provider = String(body?.provider || "").trim().toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) provider = DEFAULT_PROVIDER;

  if (!pix) {
    return json({ ok: false, error: "Campo 'pix' é obrigatório" }, 400, corsOrigin);
  }
  if (pix.length > MAX_PIX_LENGTH) {
    return json({ ok: false, error: `Pix muito longo (máx ${MAX_PIX_LENGTH} chars)` }, 400, corsOrigin);
  }

  const code = await generateUniqueCode(env.PIX_LINKS, CODE_LENGTH);
  const expirationTtl = KV_TTL_SECONDS;
  await env.PIX_LINKS.put(
    code,
    JSON.stringify({ pix, pedido, createdAt: new Date().toISOString() }),
    { expirationTtl }
  );

  const internalUrl = `${url.origin}/${code}`;
  const targetUrl = buildPixTargetUrl(pix, pedido);
  const short = await dispatchShortener(provider, internalUrl);

  return json(
    {
      ok: true,
      code,
      shortUrl: short.shortUrl || internalUrl,
      internalUrl,
      targetUrl,
      shortOk: !!short.shortUrl,
      shortProvider: short.shortUrl ? provider : "fallback",
      shortRequested: provider,
      shortError: short.shortUrl ? "" : short.error || "Usando URL interna",
    },
    200,
    corsOrigin
  );
}

async function handleResolve(request, corsOrigin) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400, corsOrigin);
  }

  const rawUrl = String(body?.url || "").trim();
  if (!rawUrl) {
    return json({ ok: false, error: "Campo 'url' é obrigatório" }, 400, corsOrigin);
  }

  let target = rawUrl;
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  if (!/^https:\/\//i.test(target)) {
    return json({ ok: false, error: "URL precisa ser HTTPS" }, 400, corsOrigin);
  }

  try {
    const resp = await fetchWithTimeout(target, {
      headers: {
        "User-Agent": REAL_UA,
        "Accept": "application/jose, application/json, */*",
      },
    });

    if (!resp.ok) {
      return json({ ok: false, error: `PSP HTTP ${resp.status}` }, 200, corsOrigin);
    }

    const text = (await resp.text()).trim();
    let payload = null;

    const parts = text.split(".");
    if (parts.length === 3) {
      try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = "=".repeat((4 - (b64.length % 4)) % 4);
        const decoded = atob(b64 + pad);
        payload = JSON.parse(decoded);
      } catch {}
    }
    if (!payload) {
      try { payload = JSON.parse(text); } catch {}
    }
    if (!payload) {
      return json({ ok: false, error: "Resposta do PSP não reconhecida" }, 200, corsOrigin);
    }

    const amountStr =
      payload?.valor?.original ??
      payload?.valor?.final ??
      payload?.amount ??
      payload?.transactionAmount;

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount)) {
      return json({ ok: false, error: "Valor não encontrado no payload do PSP" }, 200, corsOrigin);
    }

    const { createdAt, expiresAt, kind } = parseCalendario(payload?.calendario);

    return json(
      {
        ok: true,
        amount,
        merchantName: payload?.devedor?.nome || payload?.merchantName || "",
        createdAt,
        expiresAt,
        calendarKind: kind,
      },
      200,
      corsOrigin
    );
  } catch (err) {
    return json({ ok: false, error: "Erro ao consultar PSP: " + err.message }, 200, corsOrigin);
  }
}

async function handleRedirect(url, env) {
  const code = url.pathname.replace(/^\/+/, "");

  if (!code) return new Response("OK", { status: 200 });
  if (code === "favicon.ico" || code === "robots.txt") {
    return new Response(null, { status: 204 });
  }
  if (!env?.PIX_LINKS) return new Response("KV não configurado", { status: 500 });

  const raw = await env.PIX_LINKS.get(code);
  if (!raw) return new Response("Link não encontrado", { status: 404 });

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return new Response("Link corrompido", { status: 500 });
  }

  const pix = String(data?.pix || "").trim();
  const pedido = String(data?.pedido || "").trim();
  if (!pix) return new Response("Link inválido", { status: 500 });

  return Response.redirect(buildPixTargetUrl(pix, pedido), 302);
}

// ---------- TTL no KV ----------
// TTL agora e fixo em 3 meses (KV_TTL_SECONDS, ver topo). Mantemos o link
// resolvendo por 90 dias mesmo depois do Pix expirar, pra preservar historico.

// ---------- Basic Auth ----------

function checkBasicAuth(request, env) {
  if (!env?.ADMIN_USER || !env?.ADMIN_PASS) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === env.ADMIN_USER && pass === env.ADMIN_PASS;
}

function unauthorizedResponse() {
  return new Response("Acesso restrito", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="teste-admin", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// ---------- Calendário Pix BCB ----------
// cob (cobrança imediata): { criacao: ISO, expiracao: <segundos> }
// cobv (cobrança com vencimento): { dataDeVencimento: "YYYY-MM-DD", validadeAposVencimento?: <dias> }
function parseCalendario(cal) {
  if (!cal || typeof cal !== "object") {
    return { createdAt: null, expiresAt: null, kind: null };
  }

  if (cal.dataDeVencimento) {
    const base = new Date(cal.dataDeVencimento + "T23:59:59Z");
    if (!Number.isFinite(base.getTime())) {
      return { createdAt: null, expiresAt: null, kind: "cobv" };
    }
    const extraDays = Number.isFinite(parseInt(cal.validadeAposVencimento, 10))
      ? parseInt(cal.validadeAposVencimento, 10)
      : 0;
    const expires = new Date(base.getTime() + extraDays * 86400_000);
    return {
      createdAt: cal.criacao || null,
      expiresAt: expires.toISOString(),
      kind: "cobv",
    };
  }

  const expSec = parseInt(cal.expiracao, 10);
  if (cal.criacao && Number.isFinite(expSec)) {
    const created = new Date(cal.criacao);
    if (!Number.isFinite(created.getTime())) {
      return { createdAt: null, expiresAt: null, kind: "cob" };
    }
    return {
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + expSec * 1000).toISOString(),
      kind: "cob",
    };
  }

  return { createdAt: cal.criacao || null, expiresAt: null, kind: null };
}

// ---------- CORS / JSON ----------

function corsHeaders(origin) {
  const h = new Headers();
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function json(obj, status, origin) {
  const headers = corsHeaders(origin);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(obj), { status, headers });
}

// ---------- Códigos ----------

async function generateUniqueCode(kv, len) {
  for (let i = 0; i < 50; i++) {
    const c = randomCode(len);
    const exists = await kv.get(c);
    if (!exists) return c;
  }
  throw new Error("Falha ao gerar código único");
}

function randomCode(len) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// ---------- URL final do Pix ----------

function buildPixTargetUrl(pix, pedido) {
  const params = new URLSearchParams();
  if (pedido) params.set("pedido", pedido);
  params.set("v", Date.now().toString());
  return `${PIX_PAGE}?${params.toString()}#${encodeURIComponent(pix)}`;
}

// ---------- Despachador ----------

async function fetchWithTimeout(url, opts = {}, ms = SHORTENER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function dispatchShortener(provider, longUrl) {
  switch (provider) {
    case "is.gd":     return await createIsGdShortUrl(longUrl);
    case "clc.is":    return await createClcIsShortUrl(longUrl);
    case "spoo.me":   return await createSpooMeShortUrl(longUrl);
    case "urlfy.org": return await createUrlfyShortUrl(longUrl);
    default:
      return { shortUrl: null, error: `Provider desconhecido: ${provider}` };
  }
}

// ---------- is.gd ----------

async function createIsGdShortUrl(longUrl) {
  try {
    const api = "https://is.gd/create.php?format=simple&url=" + encodeURIComponent(longUrl);
    const resp = await fetchWithTimeout(api, {
      headers: {
        "User-Agent": REAL_UA,
        "Accept": "text/plain, */*",
      },
    });
    const text = (await resp.text()).trim();
    if (resp.ok && /^https?:\/\/is\.gd\//i.test(text)) {
      return { shortUrl: text, error: "" };
    }
    return { shortUrl: null, error: `is.gd HTTP ${resp.status}: ${text.slice(0, 120)}` };
  } catch (err) {
    return { shortUrl: null, error: "is.gd: " + err.message };
  }
}

// ---------- clc.is ----------

async function createClcIsShortUrl(longUrl) {
  try {
    const resp = await fetchWithTimeout("https://clc.is/api/links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": REAL_UA,
      },
      body: JSON.stringify({ domain: "clc.is", target_url: longUrl }),
    });
    const text = await resp.text();
    if (!resp.ok) return { shortUrl: null, error: `clc.is HTTP ${resp.status}: ${text.slice(0, 120)}` };

    let data;
    try { data = JSON.parse(text); }
    catch { return { shortUrl: null, error: "clc.is: resposta não-JSON: " + text.slice(0, 120) }; }

    const first = Array.isArray(data) ? data[0] : data;
    const short = first?.url || (first?.slug ? `https://clc.is/${first.slug}` : null);
    if (short && /^https?:\/\/clc\.is\//i.test(short)) {
      return { shortUrl: short, error: "" };
    }
    return { shortUrl: null, error: "clc.is: URL não encontrada. " + text.slice(0, 120) };
  } catch (err) {
    return { shortUrl: null, error: "clc.is: " + err.message };
  }
}

// ---------- spoo.me ----------

async function createSpooMeShortUrl(longUrl) {
  try {
    const resp = await fetchWithTimeout("https://spoo.me/api/v1/shorten", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": REAL_UA,
      },
      body: JSON.stringify({ long_url: longUrl }),
    });
    const text = await resp.text();
    if (!resp.ok) return { shortUrl: null, error: `spoo.me HTTP ${resp.status}: ${text.slice(0, 120)}` };

    let data;
    try { data = JSON.parse(text); }
    catch { return { shortUrl: null, error: "spoo.me: resposta não-JSON: " + text.slice(0, 120) }; }

    const first = Array.isArray(data) ? data[0] : data;
    const short =
      first?.short_url ||
      first?.shortUrl ||
      first?.url ||
      (first?.alias ? `https://spoo.me/${first.alias}` : null);
    if (short && /^https?:\/\//i.test(short)) {
      return { shortUrl: short, error: "" };
    }
    return { shortUrl: null, error: "spoo.me: URL não encontrada. " + text.slice(0, 120) };
  } catch (err) {
    return { shortUrl: null, error: "spoo.me: " + err.message };
  }
}

// ---------- urlfy.org ----------

async function createUrlfyShortUrl(longUrl) {
  try {
    const resp = await fetchWithTimeout("https://www.urlfy.org/api/v1/shorten", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": REAL_UA,
      },
      body: JSON.stringify({ url: longUrl }),
    });
    const text = await resp.text();
    if (!resp.ok) return { shortUrl: null, error: `urlfy.org HTTP ${resp.status}: ${text.slice(0, 120)}` };

    let data;
    try { data = JSON.parse(text); }
    catch { return { shortUrl: null, error: "urlfy.org: resposta não-JSON: " + text.slice(0, 120) }; }

    const first = Array.isArray(data) ? data[0] : data;
    let short = first?.shortUrl || first?.short_url || first?.url || first?.link;

    if (short && !/^https?:\/\//i.test(short)) {
      short = "https://www.urlfy.org/" + String(short).replace(/^\/+/, "");
    }
    if (short && /^https?:\/\//i.test(short)) {
      return { shortUrl: short, error: "" };
    }
    return { shortUrl: null, error: "urlfy.org: URL não encontrada. " + text.slice(0, 120) };
  } catch (err) {
    return { shortUrl: null, error: "urlfy.org: " + err.message };
  }
}
