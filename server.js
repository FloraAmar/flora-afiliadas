// Flora Amar — programa de afiliadas
// Página pública (políticas + inscrição + acompanhamento) e painel administrativo com senha.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "trocar-esta-senha";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("flora:" + ADMIN_PASSWORD).digest("hex");
const DEFAULT_CONFIG = { voucherValor: 500, desconto: 5, comissao: 5, prazoDias: 15, validadeVoucherDias: 30, minSeguidores: 1000, creditoLook: 10, metaMensal: 500, whatsapp: "(11) 92040-3050", inscricoesAbertas: true };

/* ---------------- armazenamento ---------------- */
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });
  store = {
    async init() {
      await pool.query(`create table if not exists afiliadas (id text primary key, data jsonb not null, criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now())`);
      await pool.query(`create table if not exists config (k text primary key, v jsonb not null)`);
    },
    async list() { return (await pool.query("select id, data from afiliadas order by criado_em desc")).rows.map(r => ({ ...r.data, id: r.id })); },
    async get(id) { const r = await pool.query("select id, data from afiliadas where id=$1", [id]); return r.rows[0] ? { ...r.rows[0].data, id: r.rows[0].id } : null; },
    async put(id, data) { const { id: _, ...d } = data; await pool.query("insert into afiliadas (id, data) values ($1,$2) on conflict (id) do update set data=excluded.data, atualizado_em=now()", [id, d]); },
    async del(id) { await pool.query("delete from afiliadas where id=$1", [id]); },
    async getConfig() { const r = await pool.query("select v from config where k='programa'"); return { ...DEFAULT_CONFIG, ...(r.rows[0]?.v || {}) }; },
    async setConfig(v) { await pool.query("insert into config (k,v) values ('programa',$1) on conflict (k) do update set v=excluded.v", [v]); },
  };
} else {
  // modo local de teste: arquivo JSON
  const file = path.join(__dirname, "dados-local.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { afiliadas: {}, config: {} }; } };
  const save = d => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  store = {
    async init() {},
    async list() { const d = load(); return Object.entries(d.afiliadas).map(([id, v]) => ({ ...v, id })).sort((a, b) => (b.criadoEm || "").localeCompare(a.criadoEm || "")); },
    async get(id) { const v = load().afiliadas[id]; return v ? { ...v, id } : null; },
    async put(id, data) { const d = load(); const { id: _, ...v } = data; d.afiliadas[id] = v; save(d); },
    async del(id) { const d = load(); delete d.afiliadas[id]; save(d); },
    async getConfig() { return { ...DEFAULT_CONFIG, ...load().config }; },
    async setConfig(v) { const d = load(); d.config = v; save(d); },
  };
}

/* ---------------- utilidades ---------------- */
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // horário de Brasília
const limpa = (s, max = 500) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const normIg = s => limpa(s, 80).toLowerCase().replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\//, "").replace(/^@/, "").replace(/\/.*$/, "");
const novoProtocolo = () => "FA" + crypto.randomBytes(3).toString("hex").toUpperCase();
const ETAPA_PUBLICA = {
  proposta: { t: "Inscrição em análise", d: "Recebemos sua inscrição e vamos avaliar seu perfil. Você recebe a resposta pelo WhatsApp." },
  aprovada: { t: "Aprovada! Escolha seus looks", d: "Use o voucher abaixo no carrinho da loja para escolher seus looks." },
  compra: { t: "Pedido recebido", d: "Seus looks estão sendo separados com carinho." },
  enviado: { t: "Looks a caminho", d: "Seu pedido já saiu para entrega." },
  entregue: { t: "Hora do vídeo", d: "Seus looks chegaram. Poste o vídeo de recebidos dentro do prazo, marcando o @floraamaroficial, e envie o link aqui embaixo." },
  video: { t: "Vídeo recebido", d: "Estamos conferindo o vídeo e criando seu cupom de afiliada." },
  ativa: { t: "Afiliada ativa", d: "Seu cupom está liberado. Divulgue e ganhe comissão e crédito look em cada venda." },
  recusada: { t: "Inscrição não aprovada", d: "Desta vez seu perfil não se encaixou no programa. Obrigada pelo interesse na Flora Amar!" },
};

/* ---------------- sessão do painel ---------------- */
const sign = v => v + "." + crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const verify = t => { if (!t) return false; const i = t.lastIndexOf("."); const v = t.slice(0, i); if (sign(v) !== t) return false; return Number(v.split(":")[1]) > Date.now(); };
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=").map(decodeURIComponent)).filter(p => p[0]));
const exigeAdmin = (req, res, next) => verify(cookies(req).fa_sess) ? next() : res.status(401).json({ erro: "Faça login no painel." });

// limite simples de tentativas por IP
const hits = new Map();
const limite = (max, janelaMs) => (req, res, next) => {
  const k = req.path + "|" + (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  const agora = Date.now(); const h = (hits.get(k) || []).filter(t => agora - t < janelaMs); h.push(agora); hits.set(k, h);
  if (h.length > max) return res.status(429).json({ erro: "Muitas tentativas. Espere alguns minutos e tente de novo." });
  next();
};

/* ---------------- app ---------------- */
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "300kb" }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next(); });

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/painel", (req, res) => res.sendFile(path.join(__dirname, "painel.html")));
app.get("/healthz", (req, res) => res.send("ok"));

app.get("/api/config-publica", async (req, res) => {
  const c = await store.getConfig();
  res.json({ voucherValor: c.voucherValor, desconto: c.desconto, comissao: c.comissao, prazoDias: c.prazoDias, validadeVoucherDias: c.validadeVoucherDias, minSeguidores: c.minSeguidores, creditoLook: c.creditoLook, metaMensal: c.metaMensal, whatsapp: c.whatsapp, inscricoesAbertas: c.inscricoesAbertas });
});

app.post("/api/inscricao", limite(8, 60 * 60e3), async (req, res) => {
  const b = req.body || {};
  if (b.site) return res.json({ ok: true, protocolo: novoProtocolo() }); // armadilha anti-robô
  const c = await store.getConfig();
  if (!c.inscricoesAbertas) return res.status(400).json({ erro: "As inscrições estão fechadas no momento." });
  const d = {
    nome: limpa(b.nome, 120), instagram: limpa(b.instagram, 120), tiktok: limpa(b.tiktok, 120), whatsapp: limpa(b.whatsapp, 30), email: limpa(b.email, 160).toLowerCase(),
    cidade: limpa(b.cidade, 100), seguidores: Math.max(0, parseInt(String(b.seguidores).replace(/\D/g, ""), 10) || 0), nicho: limpa(b.nicho, 160),
    proposta: limpa(b.proposta, 2000), tamanho: limpa(b.tamanho, 40), origem: "Site de inscrição",
  };
  const faltando = ["nome", "instagram", "whatsapp", "email", "cidade", "proposta"].filter(k => !d[k]);
  if (faltando.length) return res.status(400).json({ erro: "Preencha todos os campos obrigatórios." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return res.status(400).json({ erro: "Confira o e-mail." });
  if (d.whatsapp.replace(/\D/g, "").length < 10) return res.status(400).json({ erro: "Confira o WhatsApp com DDD." });
  if (!b.aceite) return res.status(400).json({ erro: "Para continuar, aceite as políticas do programa." });
  if (d.seguidores < c.minSeguidores) return res.status(400).json({ erro: `O programa pede pelo menos ${c.minSeguidores.toLocaleString("pt-BR")} seguidores em perfil público.` });
  const todas = await store.list();
  const ig = normIg(d.instagram);
  const dup = todas.find(r => r.etapa !== "recusada" && (normIg(r.instagram) === ig || (r.email && r.email === d.email)));
  if (dup) return res.status(409).json({ erro: "Já existe uma inscrição com esse Instagram ou e-mail. Use “Acompanhar inscrição” com seu protocolo." });
  const protocolo = novoProtocolo();
  const id = "af" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  await store.put(id, { ...d, protocolo, etapa: "proposta", criadoEm: new Date().toISOString(), aceitePoliticasEm: new Date().toISOString(), historico: [{ em: hoje(), t: "Inscrição feita pelo site" }] });
  res.json({ ok: true, protocolo });
});

function viewPublica(r, c) {
  const e = ETAPA_PUBLICA[r.etapa] || ETAPA_PUBLICA.proposta;
  const v = { nome: r.nome, protocolo: r.protocolo, etapa: r.etapa, titulo: e.t, texto: e.d, whatsapp: c.whatsapp };
  if (["aprovada", "compra"].includes(r.etapa) && r.voucher) v.voucher = { codigo: r.voucher.codigo, valor: r.voucher.valor, validade: r.voucher.validade };
  if (["enviado"].includes(r.etapa)) v.envio = { metodo: r.envioMetodo, rastreio: r.rastreio };
  if (r.etapa === "entregue") { v.prazoVideo = r.prazoVideo; v.videoLink = r.videoLink || ""; }
  if (r.etapa === "ativa" && r.cupom) v.cupom = { codigo: r.cupom.codigo, desconto: r.cupom.desconto, comissao: r.cupom.comissao, creditoLook: r.cupom.creditoLook ?? c.creditoLook };
  return v;
}
async function acharPorProtocolo(b) {
  const prot = limpa(b.protocolo, 20).toUpperCase().replace(/\s/g, ""); const email = limpa(b.email, 160).toLowerCase();
  if (!prot || !email) return null;
  return (await store.list()).find(r => r.protocolo === prot && r.email === email) || null;
}
app.post("/api/status", limite(30, 15 * 60e3), async (req, res) => {
  const r = await acharPorProtocolo(req.body || {});
  if (!r) return res.status(404).json({ erro: "Não encontramos essa inscrição. Confira o protocolo e o e-mail usados no cadastro." });
  res.json(viewPublica(r, await store.getConfig()));
});
app.post("/api/video", limite(15, 15 * 60e3), async (req, res) => {
  const r = await acharPorProtocolo(req.body || {});
  if (!r) return res.status(404).json({ erro: "Inscrição não encontrada." });
  if (r.etapa !== "entregue") return res.status(400).json({ erro: "O envio do vídeo abre depois que os looks são entregues." });
  const link = limpa(req.body.videoLink, 400);
  if (!/^https?:\/\/\S+\.\S+/.test(link)) return res.status(400).json({ erro: "Cole o link completo do vídeo (começando com https://)." });
  r.videoLink = link; r.videoEnviadoPelaAfiliadaEm = new Date().toISOString(); r.videoEm = hoje();
  r.historico = [...(r.historico || []), { em: hoje(), t: "Afiliada enviou o link do vídeo pelo site" }];
  await store.put(r.id, r);
  res.json({ ok: true, ...viewPublica(r, await store.getConfig()) });
});

/* ---- painel ---- */
app.post("/api/login", limite(10, 15 * 60e3), (req, res) => {
  const s = String(req.body?.senha || "");
  const ok = s.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ erro: "Senha incorreta." });
  const tok = sign("admin:" + (Date.now() + 30 * 864e5));
  res.setHeader("Set-Cookie", `fa_sess=${encodeURIComponent(tok)}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Strict${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { res.setHeader("Set-Cookie", "fa_sess=; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/admin/afiliadas", exigeAdmin, async (req, res) => res.json(await store.list()));
app.put("/api/admin/afiliadas/:id", exigeAdmin, async (req, res) => {
  const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  const data = req.body || {}; data.atualizadoEm = new Date().toISOString();
  if (!data.protocolo) data.protocolo = novoProtocolo();
  await store.put(id, data); res.json({ ok: true, id, protocolo: data.protocolo });
});
app.delete("/api/admin/afiliadas/:id", exigeAdmin, async (req, res) => { await store.del(String(req.params.id)); res.json({ ok: true }); });
app.get("/api/admin/config", exigeAdmin, async (req, res) => res.json(await store.getConfig()));
app.put("/api/admin/config", exigeAdmin, async (req, res) => {
  const b = req.body || {}; const c = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) if (k in b) c[k] = typeof DEFAULT_CONFIG[k] === "number" ? (Number(b[k]) >= 0 ? Number(b[k]) : DEFAULT_CONFIG[k]) : typeof DEFAULT_CONFIG[k] === "boolean" ? !!b[k] : limpa(b[k], 40);
  await store.setConfig(c); res.json(c);
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: "Algo deu errado. Tente de novo em instantes." }); });

store.init().then(() => app.listen(PORT, () => console.log("Flora Afiliadas na porta " + PORT))).catch(e => { console.error("Falha ao iniciar:", e); process.exit(1); });
