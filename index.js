// hub.lovday.com.br — Servidor webhook Luna Checkout
// Recebe eventos de venda e atualiza comissões das creators no banco

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Banco de dados simples em JSON (substitua por PostgreSQL/MySQL em produção) ───
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ creators: [], sales: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Helpers ───
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── Lógica de comissão ───
// Ajuste a porcentagem conforme seus contratos com cada creator
const COMMISSION_RATE = 0.10; // 10% padrão

function calcCommission(saleAmount, creatorRate) {
  return parseFloat((saleAmount * (creatorRate || COMMISSION_RATE)).toFixed(2));
}

// ─── Encontra creator pelo utm_src ou sck do payload ───
// O Luna envia o parâmetro utm.src ou utm.sck com o código da creator
// Configure os links de cada creator como: seusite.com?src=@juliana
function findCreatorByUtm(utm) {
  const db = loadDB();
  const srcKey = utm?.src || utm?.sck || utm?.utm_source || null;
  if (!srcKey) return null;
  return db.creators.find(c =>
    c.utm_src === srcKey ||
    c.username === srcKey
  ) || null;
}

// ─── Handlers das rotas ───

// POST /webhook/luna — recebe eventos do Luna Checkout
async function handleWebhook(req, res) {
  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Payload inválido' });
  }

  const { event, id: saleId, amount, status, utm, client, items, payment } = payload;

  console.log(`[Webhook] Evento: ${event} | Venda: ${saleId} | Valor: R$${amount}`);

  const db = loadDB();

  // Evita duplicatas (idempotência)
  const alreadyProcessed = db.sales.find(s => s.sale_id === saleId && s.event === event);
  if (alreadyProcessed) {
    console.log(`[Webhook] Duplicata ignorada: ${saleId}`);
    return json(res, 200, { ok: true, duplicate: true });
  }

  // Identifica a creator pelo UTM
  const creator = findCreatorByUtm(utm);

  // Registra a venda
  const sale = {
    sale_id: saleId,
    event,
    status: status || 'unknown',
    amount: amount || 0,
    commission: creator ? calcCommission(amount, creator.commission_rate) : 0,
    creator_id: creator?.id || null,
    creator_username: creator?.username || null,
    client_name: client?.name || null,
    client_email: client?.email || null,
    utm_src: utm?.src || utm?.sck || null,
    items: items || [],
    paid_at: payment?.paid_at || null,
    created_at: new Date().toISOString(),
  };

  db.sales.push(sale);

  // Atualiza totais da creator
  if (creator && event === 'sale_approved') {
    const idx = db.creators.findIndex(c => c.id === creator.id);
    if (idx !== -1) {
      db.creators[idx].total_sales = (db.creators[idx].total_sales || 0) + 1;
      db.creators[idx].total_commission = parseFloat(
        ((db.creators[idx].total_commission || 0) + sale.commission).toFixed(2)
      );
      db.creators[idx].last_sale_at = new Date().toISOString();
    }
  }

  // Estorno ou chargeback: desconta a comissão
  if (creator && ['sale_refunded', 'sale_chargeback', 'sale_cancelled'].includes(event)) {
    const originalSale = db.sales.find(
      s => s.sale_id === saleId && s.event === 'sale_approved'
    );
    if (originalSale) {
      const idx = db.creators.findIndex(c => c.id === creator.id);
      if (idx !== -1) {
        db.creators[idx].total_commission = parseFloat(
          ((db.creators[idx].total_commission || 0) - originalSale.commission).toFixed(2)
        );
        db.creators[idx].total_sales = Math.max(0, (db.creators[idx].total_sales || 1) - 1);
      }
    }
  }

  saveDB(db);
  console.log(`[Webhook] Venda salva. Creator: ${creator?.username || 'não identificada'}`);
  return json(res, 200, { ok: true });
}

// GET /api/creator/:username — dados da creator para o portal
function handleGetCreator(req, res, username) {
  const db = loadDB();
  const creator = db.creators.find(c => c.username === username);
  if (!creator) return json(res, 404, { error: 'Creator não encontrada' });

  // Busca vendas dos últimos 6 meses
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const sales = db.sales
    .filter(s =>
      s.creator_id === creator.id &&
      s.event === 'sale_approved' &&
      new Date(s.created_at) >= sixMonthsAgo
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Agrupa por mês
  const byMonth = {};
  for (const sale of sales) {
    const month = sale.created_at.slice(0, 7); // "2026-05"
    if (!byMonth[month]) byMonth[month] = { sales: 0, commission: 0 };
    byMonth[month].sales++;
    byMonth[month].commission += sale.commission;
  }

  const history = Object.entries(byMonth)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, data]) => ({
      month,
      sales: data.sales,
      commission: parseFloat(data.commission.toFixed(2)),
    }));

  return json(res, 200, {
    id: creator.id,
    username: creator.username,
    name: creator.name,
    commission_rate: creator.commission_rate || COMMISSION_RATE,
    total_sales: creator.total_sales || 0,
    total_commission: creator.total_commission || 0,
    last_sale_at: creator.last_sale_at || null,
    referral_link: `https://lovday.com.br?src=${creator.utm_src || creator.username}`,
    history,
  });
}

// POST /api/creator — cadastra nova creator (admin)
async function handleCreateCreator(req, res) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return json(res, 401, { error: 'Não autorizado' });
  }

  let body;
  try { body = await parseBody(req); }
  catch (e) { return json(res, 400, { error: 'Payload inválido' }); }

  const { name, username, utm_src, commission_rate } = body;
  if (!name || !username) {
    return json(res, 400, { error: 'name e username são obrigatórios' });
  }

  const db = loadDB();
  if (db.creators.find(c => c.username === username)) {
    return json(res, 409, { error: 'Username já cadastrado' });
  }

  const creator = {
    id: Date.now().toString(),
    name,
    username,           // login da creator: @juliana
    utm_src: utm_src || username, // parâmetro ?src= no link Luna
    commission_rate: commission_rate || COMMISSION_RATE,
    total_sales: 0,
    total_commission: 0,
    last_sale_at: null,
    created_at: new Date().toISOString(),
  };

  db.creators.push(creator);
  saveDB(db);
  return json(res, 201, creator);
}

// GET /api/creators — lista todas as creators (admin)
function handleListCreators(req, res) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return json(res, 401, { error: 'Não autorizado' });
  }
  const db = loadDB();
  return json(res, 200, db.creators);
}

// ─── Roteador ───
const server = http.createServer(async (req, res) => {
  // CORS para o portal
  res.setHeader('Access-Control-Allow-Origin', 'https://hub.lovday.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return json(res, 204, {});

  const url = req.url.split('?')[0];

  try {
    if (req.method === 'POST' && url === '/webhook/luna') {
      return await handleWebhook(req, res);
    }
    if (req.method === 'GET' && url.startsWith('/api/creator/')) {
      const username = url.replace('/api/creator/', '');
      return handleGetCreator(req, res, username);
    }
    if (req.method === 'POST' && url === '/api/creator') {
      return await handleCreateCreator(req, res);
    }
    if (req.method === 'GET' && url === '/api/creators') {
      return handleListCreators(req, res);
    }
    if (req.method === 'GET' && url === '/health') {
      return json(res, 200, { ok: true, ts: new Date().toISOString() });
    }

    return json(res, 404, { error: 'Rota não encontrada' });
  } catch (err) {
    console.error('[Erro]', err);
    return json(res, 500, { error: 'Erro interno' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Webhook URL para Luna: https://hub.lovday.com.br/webhook/luna`);
});
