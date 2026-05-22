# Lovday Hub — Webhook Server

Servidor que recebe eventos do Luna Checkout e alimenta o portal de creators em `hub.lovday.com.br`.

---

## Como funciona

1. Luna Checkout detecta uma venda → bate no endpoint `POST /webhook/luna`
2. O servidor lê o `utm.src` do payload para identificar qual creator gerou a venda
3. Salva a venda e credita a comissão no banco
4. O portal da creator consulta `GET /api/creator/@juliana` e exibe tudo atualizado

---

## Instalação

```bash
# 1. Clone ou copie os arquivos para o servidor
cd /var/www/hub.lovday.com.br

# 2. Não precisa instalar dependências — usa só Node.js puro

# 3. Crie o arquivo de variáveis de ambiente
cp .env.example .env
# Edite o .env e troque o ADMIN_KEY por algo seguro

# 4. Inicie o servidor
node index.js
```

### Recomendado: rodar com PM2 (mantém no ar 24/7)
```bash
npm install -g pm2
pm2 start index.js --name lovday-hub
pm2 save
pm2 startup
```

---

## Configurar no Luna Checkout

No painel do Luna:  
**Integrações → Webhooks → Novo Webhook**

- URL: `https://hub.lovday.com.br/webhook/luna`
- Ativar: **Venda aprovada** (obrigatório)
- Opcional: Venda estornada, Venda chargeback, Venda cancelada

---

## Como cadastrar uma creator

```bash
curl -X POST https://hub.lovday.com.br/api/creator \
  -H "Content-Type: application/json" \
  -H "x-admin-key: SUA_ADMIN_KEY" \
  -d '{
    "name": "Juliana Lima",
    "username": "@juliana",
    "utm_src": "@juliana",
    "commission_rate": 0.10
  }'
```

O link de indicação da Juliana será:
```
https://lovday.com.br?src=@juliana
```
Configure esse link no Luna como o link de afiliada dela.

---

## Rotas disponíveis

| Método | Rota                       | Descrição                        | Auth         |
|--------|----------------------------|----------------------------------|--------------|
| POST   | `/webhook/luna`            | Recebe eventos do Luna Checkout  | Nenhuma      |
| GET    | `/api/creator/:username`   | Dados da creator para o portal   | Nenhuma*     |
| POST   | `/api/creator`             | Cadastra nova creator            | x-admin-key  |
| GET    | `/api/creators`            | Lista todas as creators          | x-admin-key  |
| GET    | `/health`                  | Verifica se o servidor está no ar| Nenhuma      |

*O portal autentica com login/senha antes de consultar essa rota.

---

## Exemplo de payload recebido do Luna

```json
{
  "event": "sale_approved",
  "id": "ord_abc123",
  "amount": 297.00,
  "status": "paid",
  "method": "pix",
  "utm": {
    "src": "@juliana",
    "utm_source": "instagram",
    "utm_campaign": "lancamento-maio"
  },
  "client": {
    "name": "Maria Silva",
    "email": "maria@email.com",
    "phone": "5511999999999",
    "doc": "12345678901"
  },
  "payment": {
    "status": "paid",
    "paid_at": "2026-05-21T14:30:00Z"
  },
  "items": [
    { "id": "prod_1", "name": "Kit Skincare", "quantity": 1, "price": 297.00 }
  ]
}
```

---

## Para produção: trocar o banco JSON por PostgreSQL

O `db.json` é ótimo para começar, mas com 50+ creators e centenas de vendas, use um banco de verdade.

Opção gratuita e fácil: **Supabase** (PostgreSQL hospedado)

```sql
-- Tabela de creators
CREATE TABLE creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  utm_src TEXT,
  commission_rate NUMERIC DEFAULT 0.10,
  total_sales INT DEFAULT 0,
  total_commission NUMERIC DEFAULT 0,
  last_sale_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de vendas
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT,
  amount NUMERIC,
  commission NUMERIC,
  creator_id UUID REFERENCES creators(id),
  creator_username TEXT,
  client_name TEXT,
  client_email TEXT,
  utm_src TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sale_id, event)
);
```
