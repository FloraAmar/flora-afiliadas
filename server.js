// Flora Amar — programa de afiliadas
// Página pública (políticas + inscrição + acompanhamento) e painel administrativo com senha.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "trocar-esta-senha";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("flora:" + ADMIN_PASSWORD).digest("hex");
const LINK_SECRET = process.env.LINK_SECRET || crypto.createHash("sha256").update("link:" + (process.env.DATABASE_URL || ADMIN_PASSWORD)).digest("hex");
const WEBHOOK_KEY = crypto.createHmac("sha256", LINK_SECRET).update("webhook-wbuy").digest("hex").slice(0, 24);
const tokenCadastro = prot => crypto.createHmac("sha256", LINK_SECRET).update("cad:" + prot).digest("base64url").slice(0, 22);
const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");
const TIPOS_PIX = ["CPF", "CNPJ", "E-mail", "Telefone", "Chave aleatória"];
const cpfValido = c => { c = String(c).replace(/\D/g, ""); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false; for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); if (((s * 10) % 11) % 10 !== +c[n]) return false; } return true; };

/* ---------------- e-mail (opcional, via SMTP) ---------------- */
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = require("nodemailer");
  mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: Number(process.env.SMTP_PORT || 465) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
}
const EMAIL_FROM = process.env.EMAIL_FROM || (process.env.SMTP_USER ? `Flora Amar <${process.env.SMTP_USER}>` : "");
const DEFAULT_CONFIG = { voucherValor: 500, desconto: 5, comissao: 5, prazoDias: 15, validadeVoucherDias: 30, minSeguidores: 1000, creditoLook: 10, metaMensal: 500, whatsapp: "(11) 92040-3050", inscricoesAbertas: true,
  nivel1Ate: 10000, nivel1Comissao: 5, nivel1Bonus: 10, nivel2Ate: 20000, nivel2Comissao: 6, nivel2Bonus: 7, nivel3Comissao: 7, nivel3Bonus: 5,
  autoFechamento: true };
// níveis por conversão mensal (Bronze, Prata, Ouro)
// limites mensais × 3 = limites do trimestre (ex.: R$ 10 mil/mês → R$ 30 mil no trimestre)
function nivelDe(total, c, mult = 3) {
  const a1 = c.nivel1Ate * mult, a2 = c.nivel2Ate * mult;
  if (total > a2) return { nome: "Ouro", comissao: c.nivel3Comissao, bonus: c.nivel3Bonus, proximo: null };
  if (total > a1) return { nome: "Prata", comissao: c.nivel2Comissao, bonus: c.nivel2Bonus, proximo: { nome: "Ouro", falta: Math.round((a2 - total) * 100) / 100 } };
  return { nome: "Bronze", comissao: c.nivel1Comissao, bonus: c.nivel1Bonus, proximo: { nome: "Prata", falta: Math.round((a1 - total) * 100) / 100 } };
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const STATUS_VALIDOS = new Set(["3", "4", "5", "7", "9", "12", "13", "14", "15", "16"]); // pagos/em andamento/concluídos
const STATUS_INVALIDOS = new Set(["1", "2", "6", "8", "10", "11"]); // aguardando, análise, cancelado, negado, devolvido

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
  encerrada: { t: "Parceria encerrada", d: "Sua parceria foi encerrada. Obrigada por ter feito parte do Programa de Afiliadas Flora Amar!" },
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
app.use("/webhook", express.text({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "300kb" }));
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next(); });

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/painel", (req, res) => res.sendFile(path.join(__dirname, "painel.html")));
app.get("/cadastro", (req, res) => res.sendFile(path.join(__dirname, "cadastro.html")));
app.get("/healthz", (req, res) => res.send("ok"));

app.get("/api/config-publica", async (req, res) => {
  const c = await store.getConfig();
  res.json({ voucherValor: c.voucherValor, desconto: c.desconto, comissao: c.comissao, prazoDias: c.prazoDias, validadeVoucherDias: c.validadeVoucherDias, minSeguidores: c.minSeguidores, creditoLook: c.creditoLook, metaMensal: c.metaMensal, whatsapp: c.whatsapp, niveisTrimestrais: true, niveis: [{ nome: "Bronze", de: 0, ate: c.nivel1Ate * 3, comissao: c.nivel1Comissao, bonus: c.nivel1Bonus }, { nome: "Prata", de: c.nivel1Ate * 3, ate: c.nivel2Ate * 3, comissao: c.nivel2Comissao, bonus: c.nivel2Bonus }, { nome: "Ouro", de: c.nivel2Ate * 3, ate: null, comissao: c.nivel3Comissao, bonus: c.nivel3Bonus }], inscricoesAbertas: c.inscricoesAbertas });
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
  if (r.etapa === "aprovada") { v.cadastroPendente = !r.dadosWbuy; v.linkCadastro = `/cadastro?p=${r.protocolo}&t=${tokenCadastro(r.protocolo)}`; }
  if (["enviado"].includes(r.etapa)) v.envio = { metodo: r.envioMetodo, rastreio: r.rastreio };
  if (r.etapa === "entregue") { v.prazoVideo = r.prazoVideo; v.videoLink = r.videoLink || ""; }
  if (r.etapa === "ativa") { const rs = resumoMes(r, mesAtual(), c); v.mes = { nome: nomeMes(mesAtual()), total: rs.total, qtd: rs.qtd, nivel: rs.nivel, mantido: rs.mantido, trimestre: rs.trimestre, bonusPct: rs.bonusPct, comissaoPct: rs.comissaoPct, bonusValor: rs.bonusValor, proximo: rs.proximo }; const fa = r.fechamentos?.[mesAnterior()]; if (fa) v.mesAnterior = { nome: nomeMes(mesAnterior()), total: fa.total, nivel: fa.nivel, bonusValor: fa.bonusValor, lancado: !!fa.creditoLancado }; }
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

/* ---- cadastro pós-aprovação (dados para wBuy e nome do cupom) ---- */
async function acharPorToken(b) {
  const prot = limpa(b.p, 20).toUpperCase(); const t = limpa(b.t, 40);
  if (!prot || !t || t.length !== 22 || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(tokenCadastro(prot)))) return null;
  return (await store.list()).find(r => r.protocolo === prot) || null;
}
app.post("/api/cadastro/info", limite(40, 15 * 60e3), async (req, res) => {
  const r = await acharPorToken(req.body || {});
  if (!r) return res.status(404).json({ erro: "Link inválido. Use o link do e-mail de aprovação ou fale com a equipe." });
  if (!["aprovada", "compra", "enviado", "entregue", "video", "ativa"].includes(r.etapa)) return res.status(400).json({ erro: "Este cadastro ainda não está liberado." });
  const c = await store.getConfig();
  res.json({ nome: r.nome, email: r.email, whatsapp: r.whatsapp, cidade: r.cidade, enviado: !!r.dadosWbuy, dados: r.dadosWbuy ? { cupom: r.dadosWbuy.cupom } : null, voucher: r.voucher ? { codigo: r.voucher.codigo, valor: r.voucher.valor, validade: r.voucher.validade } : null, desconto: c.desconto, comissao: c.comissao, creditoLook: c.creditoLook, whatsMkt: c.whatsapp, ufs: UFS, tiposPix: TIPOS_PIX });
});
app.post("/api/cadastro", limite(15, 15 * 60e3), async (req, res) => {
  const b = req.body || {};
  const r = await acharPorToken(b);
  if (!r) return res.status(404).json({ erro: "Link inválido." });
  if (!["aprovada", "compra", "enviado", "entregue"].includes(r.etapa)) return res.status(400).json({ erro: "Não é mais possível alterar estes dados pelo site. Fale com a equipe." });
  const d = {
    nome: limpa(b.nome, 120), email: limpa(b.email, 160).toLowerCase(), emailLoja: limpa(b.emailLoja, 160).toLowerCase(), cpf: limpa(b.cpf, 20).replace(/\D/g, ""),
    nascimento: limpa(b.nascimento, 10), telefone: limpa(b.telefone, 30), cidade: limpa(b.cidade, 100), estado: limpa(b.estado, 2).toUpperCase(),
    tipoPix: limpa(b.tipoPix, 30), chavePix: limpa(b.chavePix, 120), cupom: limpa(b.cupom, 30).toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ""),
  };
  const falt = ["nome", "email", "cpf", "nascimento", "telefone", "cidade", "estado", "tipoPix", "chavePix", "cupom"].filter(k => !d[k]);
  if (falt.length) return res.status(400).json({ erro: "Preencha todos os campos obrigatórios.", campo: falt[0] });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email) || (d.emailLoja && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.emailLoja))) return res.status(400).json({ erro: "Confira o e-mail.", campo: "email" });
  if (!cpfValido(d.cpf)) return res.status(400).json({ erro: "CPF inválido. Confira os números.", campo: "cpf" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.nascimento)) return res.status(400).json({ erro: "Confira a data de nascimento.", campo: "nascimento" });
  if (!UFS.includes(d.estado)) return res.status(400).json({ erro: "Escolha o estado.", campo: "estado" });
  if (!TIPOS_PIX.includes(d.tipoPix)) return res.status(400).json({ erro: "Escolha o tipo de chave PIX.", campo: "tipoPix" });
  if (!/^[A-Z0-9]{4,20}$/.test(d.cupom)) return res.status(400).json({ erro: "O cupom deve ter de 4 a 20 letras ou números, sem espaços nem símbolos.", campo: "cupom" });
  const usados = (await store.list()).filter(x => x.id !== r.id).flatMap(x => [x.voucher?.codigo, x.cupom?.codigo, x.dadosWbuy?.cupom]).filter(Boolean);
  if (usados.includes(d.cupom)) return res.status(409).json({ erro: "Esse nome de cupom já está em uso. Escolha outro.", campo: "cupom" });
  const primeiraVez = !r.dadosWbuy;
  r.dadosWbuy = d; r.dadosRecebidosEm = new Date().toISOString();
  r.historico = [...(r.historico || []), { em: hoje(), t: primeiraVez ? `Afiliada enviou os dados de cadastro · cupom desejado ${d.cupom}` : "Afiliada atualizou os dados de cadastro" }];
  await store.put(r.id, r);
  res.json({ ok: true, cupom: d.cupom });
});

/* ---- webhook da wBuy: detecta uso do voucher e vendas com o cupom da afiliada ---- */
function parseCorpo(raw) {
  if (raw && typeof raw === "object") return raw;
  const t = String(raw || "").trim();
  try { return JSON.parse(t); } catch {}
  try { const o = {}; new URLSearchParams(t).forEach((v, k) => { try { o[k] = JSON.parse(v); } catch { o[k] = v; } }); return o; } catch { return { raw: t }; }
}
function varrer(obj, fn, chave = "", prof = 0) {
  if (prof > 8 || obj == null) return;
  if (Array.isArray(obj)) return obj.forEach(v => varrer(v, fn, chave, prof + 1));
  if (typeof obj === "object") return Object.entries(obj).forEach(([k, v]) => varrer(v, fn, k, prof + 1));
  fn(chave, obj);
}
function normalizarPedido(o) {
  // formato oficial da API/webhook da wBuy (pedido com cupom, vendedor, valor_total, status{id,nome})
  if (!o || typeof o !== "object" || !o.id || !(o.valor_total || o.cupom || o.status)) return null;
  const vt = o.valor_total || {};
  const sub = Number(vt.subtotal), desc = Number(vt.desconto) || 0, tot = Number(vt.total);
  const base = !isNaN(sub) && sub > 0 ? r2(sub - desc) : (!isNaN(tot) ? r2(tot - (Number(o.frete?.valor) || 0)) : null);
  const st = typeof o.status === "object" ? o.status : { id: String(o.status ?? ""), nome: "" };
  const codigos = [o.cupom?.cupom, o.vendedor?.codigo].filter(Boolean).map(x => String(x).toUpperCase().trim());
  return { id: String(o.id), data: String(o.data || "").replace(" ", "T"), statusId: String(st.id ?? ""), status: st.nome || String(st.id ?? ""), base, codigos };
}
function acharPedido(corpo) {
  for (const cand of [corpo, corpo?.data, corpo?.pedido, corpo?.order, Array.isArray(corpo?.data) ? corpo.data[0] : null]) { const n = normalizarPedido(cand); if (n) return n; }
  return null;
}
function dadosPedido(corpo) {
  const n = acharPedido(corpo);
  if (n) { const textos = []; varrer(corpo, (k, v) => { if (typeof v === "string") textos.push(v.toUpperCase().trim()); }); return { id: n.id, total: n.base, status: n.status, statusId: n.statusId, data: n.data, textos, codigosPedido: n.codigos }; }
  let id = null, total = null, status = null; const textos = [];
  varrer(corpo, (k, v) => {
    const kl = k.toLowerCase();
    if (typeof v === "string") textos.push(v.toUpperCase().trim());
    if (id == null && /^(id|id_pedido|pedido|pedido_id|numero|numero_pedido|order_id|codigo_pedido)$/.test(kl) && (typeof v === "number" || /^\w{1,30}$/.test(String(v)))) id = String(v);
    if (total == null && /^(total|valor_total|total_pedido|valortotal|order_total|valor)$/.test(kl)) { const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); if (!isNaN(n) && n > 0) total = n; }
    if (status == null && /^(status|situacao|status_nome|status_pedido|order_status)$/.test(kl) && typeof v !== "object") status = String(v);
  });
  return { id, total, status, statusId: /^\d+$/.test(String(status || "")) ? String(status) : "", textos };
}
app.all("/webhook/wbuy/:key", async (req, res) => {
  if (req.params.key !== WEBHOOK_KEY) return res.status(404).send("not found");
  res.json({ ok: true });
  try {
    const corpo = parseCorpo(req.body);
    const p = dadosPedido(corpo);
    const codigos = new Set(p.textos);
    const todas = await store.list();
    const achados = [];
    for (const r of todas) {
      let mudou = false;
      const vc = r.voucher?.codigo?.toUpperCase();
      if (vc && codigos.has(vc) && !r.voucher.usado) {
        r.voucher.usado = true; r.voucher.usadoEm = new Date().toISOString(); r.voucher.pedidoUso = p.id;
        if (!r.pedido && p.id) r.pedido = p.id;
        r.historico = [...(r.historico || []), { em: hoje(), t: `Voucher ${vc} usado na loja${p.id ? " · pedido " + p.id : ""} (aviso automático da wBuy)` }];
        if (r.etapa === "aprovada") { r.etapa = "compra"; r.voucher.cadastradoWbuy = true; }
        mudou = true; achados.push(`voucher ${vc}`);
      }
      // status do pedido do voucher: avança envio/entrega sozinho
      const pedVoucher = r.voucher?.pedidoUso || r.pedido;
      if (p.id && pedVoucher && String(pedVoucher) === p.id && p.status) {
        const st = p.status.toLowerCase();
        if ((/entregue|conclu|finaliz/.test(st) || p.statusId === "7") && ["compra", "enviado"].includes(r.etapa)) {
          r.entregueEm = hoje(); r.enviadoEm = r.enviadoEm || hoje(); r.etapa = "entregue";
          const d = new Date(r.entregueEm + "T12:00:00"); d.setDate(d.getDate() + Number(r.prazoDias || 15)); r.prazoVideo = d.toISOString().slice(0, 10);
          r.historico = [...(r.historico || []), { em: hoje(), t: `Pedido ${p.id} entregue (aviso automático da wBuy) · vídeo até ${r.prazoVideo.split("-").reverse().join("/")}` }];
          mudou = true; achados.push("entrega");
        } else if ((/envi|despach|transport|saiu/.test(st) || ["5", "15"].includes(p.statusId)) && r.etapa === "compra") {
          r.enviadoEm = hoje(); r.etapa = "enviado";
          r.historico = [...(r.historico || []), { em: hoje(), t: `Pedido ${p.id} enviado (aviso automático da wBuy)` }];
          mudou = true; achados.push("envio");
        }
      }
      const cc = codigosAfiliada(r).find(x => x !== vc && (codigos.has(x) || (p.codigosPedido || []).includes(x)));
      if (cc && p.id) {
        r.vendas = r.vendas || {};
        const ant = r.vendas[p.id] || {};
        r.vendas[p.id] = { total: p.total ?? ant.total ?? null, status: p.status ?? ant.status ?? "", statusId: p.statusId || ant.statusId || "", em: ant.em || p.data || new Date().toISOString(), atualizadoEm: new Date().toISOString(), fonte: "webhook" };
        mudou = true; achados.push(`cupom ${cc}`);
      }
      if (mudou) await store.put(r.id, r);
    }
    const log = (await store.getConfig()).__webhookLog || [];
    log.unshift({ em: new Date().toISOString(), metodo: req.method, pedido: p.id, total: p.total, status: p.status, achados, amostra: JSON.stringify(corpo).slice(0, 3000) });
    const c = await store.getConfig(); c.__webhookLog = log.slice(0, 20); await store.setConfig(c);
  } catch (e) { console.error("webhook", e); }
});

/* ---- API REST da wBuy: sincroniza vendas e lança o Bônus Look como crédito do cliente ---- */
const WBUY_BASE = process.env.WBUY_BASE || "https://sistema.sistemawbuy.com.br/api/v1";
const wbuyConfigurada = () => !!(process.env.WBUY_API_USER && process.env.WBUY_API_PASS);
const espera = ms => new Promise(r => setTimeout(r, ms));
async function wbuy(metodo, caminho, corpo) {
  if (!wbuyConfigurada()) throw new Error("API da wBuy não configurada no Render (WBUY_API_USER e WBUY_API_PASS).");
  const auth = Buffer.from(`${process.env.WBUY_API_USER}:${process.env.WBUY_API_PASS}`).toString("base64");
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(WBUY_BASE + caminho, { method: metodo, headers: { Authorization: "Bearer " + auth, "User-Agent": `FloraAmarAfiliadas (${process.env.WBUY_CONTACT || "afiliadas"})`, "Content-Type": "application/json", Accept: "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
    if (r.status === 429) { await espera(15000); continue; }
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
    if (!r.ok || (j.responseCode && Number(j.responseCode) >= 400)) throw new Error(`wBuy ${metodo} ${caminho.split("?")[0]}: ${r.status} ${j.message || j.raw || ""}`.trim());
    return j;
  }
  throw new Error("wBuy: limite de requisições atingido, tente em 1 minuto.");
}
const mesAtual = () => hoje().slice(0, 7);
const mesAnterior = (m = mesAtual()) => { const [a, b] = m.split("-").map(Number); const d = new Date(Date.UTC(a, b - 2, 1)); return d.toISOString().slice(0, 7); };
const fimDoMes = m => { const [a, b] = m.split("-").map(Number); return new Date(Date.UTC(a, b, 0)).toISOString().slice(0, 10); };
const nomeMes = m => { const [a, b] = m.split("-").map(Number); return ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"][b - 1] + "/" + a; };
function codigosAfiliada(r) { return [...new Set([r.cupom?.codigo, r.dadosWbuy?.cupom, ...(r.codigosWbuy || [])].filter(Boolean).map(x => String(x).toUpperCase().trim()))]; }
async function sincronizarVendas(mes) {
  const ini = mes + "-01", fim = fimDoMes(mes);
  const todas = await store.list();
  const porCodigo = new Map(); for (const r of todas) for (const c of codigosAfiliada(r)) if (c !== r.voucher?.codigo?.toUpperCase()) porCodigo.set(c, r);
  const alteradas = new Set(); let lidos = 0, achados = 0;
  for (let off = 0; off < 5000; off += 100) {
    const j = await wbuy("GET", `/order/?periodo_inicial=${ini}&periodo_final=${fim}&order=id,asc&limit=${off},100`);
    const lista = Array.isArray(j.data) ? j.data : [];
    for (const o of lista) {
      const n = normalizarPedido(o); if (!n) continue; lidos++;
      const r = n.codigos.map(c => porCodigo.get(c)).find(Boolean); if (!r) continue;
      r.vendas = r.vendas || {};
      r.vendas[n.id] = { ...(r.vendas[n.id] || {}), total: n.base, status: n.status, statusId: n.statusId, em: n.data || ini, atualizadoEm: new Date().toISOString(), fonte: "api" };
      alteradas.add(r); achados++;
    }
    if (lista.length < 100) break;
    await espera(700);
  }
  for (const r of alteradas) await store.put(r.id, r);
  const c = await store.getConfig(); c.__sync = { ...(c.__sync || {}), [mes]: { em: new Date().toISOString(), lidos, achados } }; await store.setConfig(c);
  return { mes, lidos, achados };
}
function vendaConta(v) { if (v.statusId) return !STATUS_INVALIDOS.has(String(v.statusId)); return !/cancel|devolv|estorn|recus|negad|aguard|análise|analise/i.test(v.status || ""); }
/* ---- data de entrada e trimestres de cada afiliada ---- */
const idxMes = m => { const [a, b] = String(m).split("-").map(Number); return a * 12 + b - 1; };
const mesIdx = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`;
const ehImportada = r => String(r.origem || "").startsWith("Importada");
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? String(d) : "";
function primeiraVenda(r) { const ds = Object.values(r.vendas || {}).filter(vendaConta).map(v => String(v.em || "").slice(0, 10)).filter(dataOk).sort(); return ds[0] || ""; }
// data em que a afiliada entrou: a informada pelo time; senão a ativação (cadastro pelo site) ou a 1ª venda com o cupom (importadas)
function entradaDe(r) {
  if (dataOk(r.dataEntrada)) return { data: r.dataEntrada, fonte: "informada" };
  if (!ehImportada(r)) { const d = dataOk(String(r.ativaEm || "").slice(0, 10)); if (d) return { data: d, fonte: "ativação" }; return { data: "", fonte: "" }; }
  const p = primeiraVenda(r); return p ? { data: p, fonte: "1ª venda com o cupom" } : { data: "", fonte: "" };
}
function totalDoMes(r, mes) {
  const vs = Object.values(r.vendas || {}).filter(v => String(v.em || "").slice(0, 7) === mes && vendaConta(v));
  let t = r2(vs.reduce((a, v) => a + (Number(v.total) || 0), 0));
  if (!vs.length && r.fechamentos?.[mes]?.total) t = r.fechamentos[mes].total;
  return t;
}
const nomeMesCurto = m => { const [a, b] = m.split("-").map(Number); return ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"][b - 1] + "/" + String(a).slice(2); };
const nomePeriodo = ms => `${nomeMesCurto(ms[0])} a ${nomeMesCurto(ms[ms.length - 1])}`;
// trimestres contados a partir do mês de entrada; o nível de um trimestre vem da soma das vendas do trimestre anterior
function trimestreDe(r, mes) {
  const e = entradaDe(r); if (!e.data) return null;
  const k = Math.floor((idxMes(mes) - idxMes(e.data.slice(0, 7))) / 3); if (k < 0) return null;
  const i0 = idxMes(e.data.slice(0, 7)) + 3 * k;
  const meses = [0, 1, 2].map(x => mesIdx(i0 + x)); const anteriores = k > 0 ? [-3, -2, -1].map(x => mesIdx(i0 + x)) : [];
  return { n: k + 1, meses, anteriores, entrada: e.data, fonte: e.fonte };
}
function resumoMes(r, mes, c) {
  const vs = Object.entries(r.vendas || {}).map(([id, v]) => ({ id, ...v })).filter(v => String(v.em || "").slice(0, 7) === mes);
  const validas = vs.filter(vendaConta);
  const total = r2(validas.reduce((a, v) => a + (Number(v.total) || 0), 0));
  const tri = trimestreDe(r, mes);
  let base = 0, nv = nivelDe(0, c), trimestre = null, proximo = null, mantido = "";
  if (tri) {
    base = r2(tri.anteriores.reduce((a, m) => a + totalDoMes(r, m), 0));
    nv = nivelDe(base, c);
    const acumulado = r2(tri.meses.filter(m => m <= mes).reduce((a, m) => a + (m === mes ? total : totalDoMes(r, m)), 0));
    const proj = nivelDe(acumulado, c);
    proximo = proj.proximo;
    trimestre = { n: tri.n, periodo: nomePeriodo(tri.meses), meses: tri.meses, entrada: tri.entrada, fonte: tri.fonte,
      base, periodoAnterior: tri.anteriores.length ? nomePeriodo(tri.anteriores) : "", acumulado, nivelProximoTrimestre: proj.nome };
    mantido = tri.anteriores.length ? `vendas de ${nomePeriodo(tri.anteriores)}` : "1º trimestre";
  }
  return { total, mantido, trimestre, qtd: validas.length, pendentes: vs.length - validas.length, nivel: nv.nome, comissaoPct: nv.comissao, bonusPct: nv.bonus, comissaoValor: r2(total * nv.comissao / 100), bonusValor: r2(total * nv.bonus / 100), proximo, metaOk: total >= c.metaMensal, vendas: vs.sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, 50) };
}
async function acharClienteWbuy(r) {
  const emails = [r.dadosWbuy?.emailLoja, r.dadosWbuy?.email, r.email].filter(Boolean).map(e => e.toLowerCase());
  for (const e of [...new Set(emails)]) {
    const j = await wbuy("GET", `/customer/?q=${encodeURIComponent(e)}&limit=0,20`);
    const c = (Array.isArray(j.data) ? j.data : []).find(x => String(x.email || "").toLowerCase() === e);
    if (c) return c;
  }
  const cpf = r.dadosWbuy?.cpf;
  if (cpf) { const f = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"); for (const d of [f, cpf]) { const j = await wbuy("GET", `/customer/?doc1=${encodeURIComponent(d)}&limit=0,5`); const c = (Array.isArray(j.data) ? j.data : [])[0]; if (c) return c; } }
  return null;
}
let fechandoAgora = false;
async function fecharMes(mes, lancar) {
  if (fechandoAgora) throw new Error("Já existe um fechamento em andamento.");
  fechandoAgora = true;
  try {
    const sync = wbuyConfigurada() ? await sincronizarVendas(mes) : null;
    const c = await store.getConfig();
    const todas = await store.list(); const linhas = [];
    for (const r of todas) {
      if (!["ativa", "video"].includes(r.etapa) && !(r.vendas && Object.keys(r.vendas).length)) continue;
      const rs = resumoMes(r, mes, c);
      r.fechamentos = r.fechamentos || {};
      const ant = r.fechamentos[mes] || {};
      const f = { ...ant, mes, total: rs.total, qtd: rs.qtd, nivel: rs.nivel, nivelMantido: rs.mantido, trimestre: rs.trimestre ? { n: rs.trimestre.n, periodo: rs.trimestre.periodo, base: rs.trimestre.base } : null, comissaoPct: rs.comissaoPct, comissaoValor: rs.comissaoValor, bonusPct: rs.bonusPct, bonusValor: rs.bonusValor, metaOk: rs.metaOk, calculadoEm: new Date().toISOString() };
      if (ant.creditoLancado) { f.bonusValor = ant.bonusValor; f.total = ant.total; f.nivel = ant.nivel; f.bonusPct = ant.bonusPct; }
      if (lancar && !ant.creditoLancado && f.bonusValor > 0) {
        try {
          const cli = await acharClienteWbuy(r);
          if (!cli) f.erro = "Cliente não encontrado na loja (confira o e-mail do cadastro na loja).";
          else {
            await wbuy("POST", `/customer/credit/${cli.id}`, { tipo: 1, valor: f.bonusValor, observacoes: `Bônus Look ${nomeMes(mes)} · Programa de Afiliadas (nível ${f.nivel})` });
            Object.assign(f, { creditoLancado: true, creditoEm: new Date().toISOString(), clienteId: String(cli.id), erro: "" });
            r.historico = [...(r.historico || []), { em: hoje(), t: `Bônus Look de ${nomeMes(mes)} lançado: R$ ${f.bonusValor.toFixed(2).replace(".", ",")} (nível ${f.nivel})` }];
          }
        } catch (e) { f.erro = e.message; }
        await espera(500);
      }
      r.fechamentos[mes] = f; await store.put(r.id, r);
      linhas.push({ id: r.id, nome: r.nome, ...f });
    }
    const c2 = await store.getConfig();
    const resumo = { mes, em: new Date().toISOString(), lancado: !!lancar, afiliadas: linhas.length, totalVendas: r2(linhas.reduce((a, l) => a + l.total, 0)), totalBonus: r2(linhas.reduce((a, l) => a + (l.bonusValor || 0), 0)), totalComissao: r2(linhas.reduce((a, l) => a + (l.comissaoValor || 0), 0)), erros: linhas.filter(l => l.erro).length, sync };
    if (lancar) resumo.concluido = resumo.erros === 0;
    c2.__fechamentos = { ...(c2.__fechamentos || {}), [mes]: { ...(c2.__fechamentos?.[mes] || {}), ...resumo } }; await store.setConfig(c2);
    return { ...resumo, linhas };
  } finally { fechandoAgora = false; }
}
// agenda: todo dia 01 (a partir das 6h de Brasília) fecha o mês anterior; a cada 6h atualiza as vendas do mês atual
let ultimaSync = 0;
setInterval(async () => {
  try {
    if (!wbuyConfigurada()) return;
    const c = await store.getConfig();
    const agoraBR = new Date(Date.now() - 3 * 3600e3);
    const ant = mesAnterior();
    if (c.autoFechamento && agoraBR.getUTCHours() >= 6 && !c.__fechamentos?.[ant]?.concluido && !(c.__fechamentos?.[ant]?.tentativas >= 5)) {
      try { await fecharMes(ant, true); } catch (e) { console.error("fechamento", e.message); }
      const c3 = await store.getConfig(); c3.__fechamentos = c3.__fechamentos || {}; c3.__fechamentos[ant] = { ...(c3.__fechamentos[ant] || {}), tentativas: (c3.__fechamentos[ant]?.tentativas || 0) + 1 }; await store.setConfig(c3);
    }
    if (Date.now() - ultimaSync > 6 * 3600e3) { ultimaSync = Date.now(); for (const m of ultimosMeses(6)) if (!c.__sync?.[m]) { await sincronizarVendas(m); await espera(2000); } await sincronizarVendas(mesAtual()); }
  } catch (e) { console.error("agenda", e.message); }
}, 20 * 60e3);

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
app.get("/api/admin/afiliadas", exigeAdmin, async (req, res) => {
  const c = await store.getConfig();
  res.json((await store.list()).map(r => { const rs = r.etapa === "ativa" ? resumoMes(r, mesAtual(), c) : null; if (rs) delete rs.vendas;
    return { ...r, tokenCadastro: r.protocolo ? tokenCadastro(r.protocolo) : "", entrada: entradaDe(r), resumo: rs }; }));
});
app.post("/api/admin/email", exigeAdmin, limite(60, 60 * 60e3), async (req, res) => {
  if (!mailer) return res.status(400).json({ erro: "Envio automático de e-mail não configurado." });
  const { para, assunto, texto } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(para || ""))) return res.status(400).json({ erro: "E-mail da afiliada inválido." });
  try { await mailer.sendMail({ from: EMAIL_FROM, to: String(para), subject: limpa(assunto, 200), text: String(texto || "").slice(0, 10000) }); res.json({ ok: true }); }
  catch (e) { console.error("email", e.message); res.status(502).json({ erro: "O servidor de e-mail recusou o envio. Confira os dados de SMTP no Render." }); }
});
app.put("/api/admin/afiliadas/:id", exigeAdmin, async (req, res) => {
  const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  const data = req.body || {}; delete data.tokenCadastro; delete data.entrada; delete data.resumo; if (data.dataEntrada && !dataOk(data.dataEntrada)) delete data.dataEntrada; data.atualizadoEm = new Date().toISOString();
  if (!data.protocolo) data.protocolo = novoProtocolo();
  await store.put(id, data); res.json({ ok: true, id, protocolo: data.protocolo });
});
app.delete("/api/admin/afiliadas/:id", exigeAdmin, async (req, res) => { await store.del(String(req.params.id)); res.json({ ok: true }); });
app.get("/api/admin/config", exigeAdmin, async (req, res) => { const c = await store.getConfig(); const log = c.__webhookLog || []; for (const k of Object.keys(c)) if (k.startsWith("__")) delete c[k]; res.json({ ...c, wbuyApi: wbuyConfigurada(), emailAutomatico: !!mailer, webhookUrl: `${req.protocol}://${req.get("host")}/webhook/wbuy/${WEBHOOK_KEY}`, webhookUltimo: log[0] || null, webhookTotal: log.length }); });
app.get("/api/admin/vendas", exigeAdmin, async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || "")) ? req.query.mes : mesAtual();
  const c = await store.getConfig();
  const linhas = (await store.list()).filter(r => ["ativa", "video"].includes(r.etapa) || Object.keys(r.vendas || {}).length || r.fechamentos?.[mes])
    .map(r => ({ id: r.id, nome: r.nome, instagram: r.instagram, cupom: r.cupom?.codigo || r.dadosWbuy?.cupom || "", etapa: r.etapa, ...resumoMes(r, mes, c), fechamento: r.fechamentos?.[mes] || null }))
    .sort((a, b) => b.total - a.total);
  res.json({ mes, mesAtual: mesAtual(), api: wbuyConfigurada(), sync: c.__sync?.[mes] || null, fechamento: c.__fechamentos?.[mes] || null, linhas });
});
app.post("/api/admin/vendas/sync", exigeAdmin, async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(String(req.body?.mes || "")) ? req.body.mes : mesAtual();
  try { const c = await store.getConfig(); if (!c.__sync?.[mesAnterior(mes)]) await sincronizarVendas(mesAnterior(mes)); res.json(await sincronizarVendas(mes)); } catch (e) { res.status(400).json({ erro: e.message }); }
});
app.post("/api/admin/fechamento", exigeAdmin, async (req, res) => {
  const mes = String(req.body?.mes || "");
  if (!/^\d{4}-\d{2}$/.test(mes) || mes >= mesAtual()) return res.status(400).json({ erro: "Escolha um mês que já terminou." });
  try { res.json(await fecharMes(mes, !!req.body?.lancar)); } catch (e) { res.status(400).json({ erro: e.message }); }
});
app.post("/api/admin/fechamento/desfazer", exigeAdmin, async (req, res) => {
  const { id, mes } = req.body || {};
  const r = await store.get(String(id || "")); const f = r?.fechamentos?.[mes];
  if (!f?.creditoLancado) return res.status(400).json({ erro: "Não há crédito lançado para desfazer." });
  try {
    await wbuy("POST", `/customer/credit/${f.clienteId}`, { tipo: 2, valor: f.bonusValor, observacoes: `Estorno Bônus Look ${nomeMes(mes)} · Programa de Afiliadas` });
    f.creditoLancado = false; f.estornadoEm = new Date().toISOString();
    r.historico = [...(r.historico || []), { em: hoje(), t: `Bônus Look de ${nomeMes(mes)} estornado` }];
    await store.put(r.id, r);
    const c = await store.getConfig(); if (c.__fechamentos?.[mes]) { c.__fechamentos[mes].concluido = false; c.__fechamentos[mes].tentativas = 99; await store.setConfig(c); }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});
/* ---- aviso: afiliadas que não bateram a meta nos últimos 3 meses fechados ---- */
function ultimosMeses(n) { const out = []; let m = mesAtual(); for (let i = 0; i < n; i++) { m = mesAnterior(m); out.unshift(m); } return out; }
function ultimos3Meses() { const m1 = mesAnterior(); const m2 = mesAnterior(m1); const m3 = mesAnterior(m2); return [m3, m2, m1]; }
function alertasMeta(todas, c) {
  const meses = ultimos3Meses();
  return todas.filter(r => r.etapa === "ativa").map(r => {
    const e = entradaDe(r).data; if (!e) return null; // sem data de entrada: não avisa
    const primeiroMesCheio = e.slice(8, 10) === "01" ? e.slice(0, 7) : mesIdx(idxMes(e.slice(0, 7)) + 1);
    if (primeiroMesCheio > meses[0]) return null; // ainda não completou 3 meses cheios no programa
    if (r.avisoMetaIgnorado === meses[2]) return null; // time decidiu manter neste ciclo
    const m = meses.map(mes => ({ mes, nome: nomeMes(mes), total: resumoMes(r, mes, c).total }));
    if (m.some(x => x.total >= c.metaMensal)) return null;
    return { id: r.id, nome: r.nome, cupom: codigosAfiliada(r)[0] || "", meses: m };
  }).filter(Boolean);
}
app.get("/api/admin/alertas-meta", exigeAdmin, async (req, res) => {
  const c = await store.getConfig();
  res.json({ meta: c.metaMensal, meses: ultimos3Meses().map(m => ({ mes: m, nome: nomeMes(m), sincronizado: !!c.__sync?.[m] })), lista: alertasMeta(await store.list(), c) });
});

/* ---- importar afiliadas que já existem (da wBuy ou de uma lista colada) ---- */
async function listarTudo(caminho) {
  const out = [];
  for (let off = 0; off < 3000; off += 100) {
    const j = await wbuy("GET", `${caminho}${caminho.includes("?") ? "&" : "?"}limit=${off},100`);
    const l = Array.isArray(j.data) ? j.data : (j.data && typeof j.data === "object" ? Object.values(j.data) : []);
    out.push(...l); if (l.length < 100) break; await espera(700);
  }
  return out;
}
app.get("/api/admin/importar/wbuy", exigeAdmin, async (req, res) => {
  try {
    const vendedores = await listarTudo("/partnerstore");
    let cupons = []; try { cupons = await listarTudo("/coupon/"); } catch (e) { console.error("cupons", e.message); }
    const todas = await store.list();
    const emails = new Set(todas.map(r => (r.email || "").toLowerCase()).filter(Boolean));
    const cods = new Set(todas.flatMap(codigosAfiliada));
    const lista = vendedores.map(v => {
      const id = String(v.id ?? v.vendedor_id ?? "");
      const codigo = String(v.codigo || "").toUpperCase().trim();
      const seus = cupons.filter(c => String(c.afiliado_id ?? c.vendedor_id ?? "") === id && id).map(c => String(c.cupom || "").toUpperCase().trim()).filter(Boolean);
      const todosCods = [...new Set([codigo, ...seus].filter(Boolean))];
      const email = String(v.email || "").toLowerCase().trim();
      return { wbuyId: id, nome: limpa(v.nome, 120), email, codigo, cupons: todosCods, comissao: v.comissao ?? "", dataEntrada: String(v.data_cadastro || v.dt_cadastro || v.data_criacao || v.created_at || v.data || "").slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || "", ativo: String(v.ativo ?? "1") !== "0", jaExiste: (email && emails.has(email)) || todosCods.some(c => cods.has(c)) };
    });
    res.json({ total: lista.length, lista });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});
app.post("/api/admin/importar", exigeAdmin, async (req, res) => {
  const itens = Array.isArray(req.body?.itens) ? req.body.itens.slice(0, 500) : [];
  const c = await store.getConfig(); const todas = await store.list();
  const emails = new Set(todas.map(r => (r.email || "").toLowerCase()).filter(Boolean));
  const cods = new Set(todas.flatMap(codigosAfiliada));
  let criadas = 0, puladas = 0;
  for (const it of itens) {
    const nome = limpa(it.nome, 120); const email = limpa(it.email, 160).toLowerCase();
    const codigos = [...new Set((Array.isArray(it.cupons) ? it.cupons : [it.cupom]).map(x => limpa(x, 30).toUpperCase().replace(/\s+/g, "")).filter(x => /^[A-Z0-9_-]{2,30}$/.test(x)))];
    if (!nome || (!email && !codigos.length)) { puladas++; continue; }
    if ((email && emails.has(email)) || codigos.some(x => cods.has(x))) { puladas++; continue; }
    const id = "af" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
    await store.put(id, {
      nome, email, instagram: limpa(it.instagram, 120), whatsapp: limpa(it.whatsapp, 30), protocolo: novoProtocolo(), etapa: "ativa",
      origem: it.wbuyId ? "Importada da wBuy" : "Importada de lista", wbuyVendedorId: limpa(it.wbuyId, 20) || undefined,
      cupom: codigos[0] ? { codigo: codigos[0], desconto: c.desconto, comissao: Number(it.comissao) || c.nivel1Comissao, cadastradoWbuy: true, afiliadaCadastrada: true, grupo: true } : undefined,
      codigosWbuy: codigos.slice(1), criadoEm: new Date().toISOString(), ativaEm: hoje(), dataEntrada: dataOk(it.dataEntrada) || undefined,
      historico: [{ em: hoje(), t: it.wbuyId ? "Afiliada importada da wBuy (já ativa)" : "Afiliada importada de lista (já ativa)" }],
    });
    if (email) emails.add(email); codigos.forEach(x => cods.add(x)); criadas++;
  }
  res.json({ criadas, puladas });
});
app.get("/api/admin/webhook-log", exigeAdmin, async (req, res) => res.json((await store.getConfig()).__webhookLog || []));
app.put("/api/admin/config", exigeAdmin, async (req, res) => {
  const b = req.body || {}; const c = { ...DEFAULT_CONFIG };
  delete b.emailAutomatico;
  for (const k of Object.keys(DEFAULT_CONFIG)) if (k in b) c[k] = typeof DEFAULT_CONFIG[k] === "number" ? (Number(b[k]) >= 0 ? Number(b[k]) : DEFAULT_CONFIG[k]) : typeof DEFAULT_CONFIG[k] === "boolean" ? !!b[k] : limpa(b[k], 40);
  const atual = await store.getConfig(); for (const k of Object.keys(atual)) if (k.startsWith("__")) c[k] = atual[k];
  await store.setConfig(c); const pub = {}; for (const k of Object.keys(c)) if (!k.startsWith("__")) pub[k] = c[k]; res.json(pub);
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: "Algo deu errado. Tente de novo em instantes." }); });

store.init().then(() => app.listen(PORT, () => console.log("Flora Afiliadas na porta " + PORT))).catch(e => { console.error("Falha ao iniciar:", e); process.exit(1); });
