import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Pool, PoolClient } from 'pg';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Database pool -------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable'
    ? false
    : { rejectUnauthorized: false }, // Render Postgres requires SSL
});

// ---- Health check --------------------------------------------------------
app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'NeuroPay API', version: '1.0.0' });
});

// ---- POST /api/wallet/topup-offline --------------------------------------
// Body: { driverCode, amount, method: 'cash' | 'card' | 'agent', reference?, nonce }
app.post('/api/wallet/topup-offline', async (req: Request, res: Response) => {
  const { driverCode, amount, method = 'cash', reference = null, nonce } = req.body || {};

  if (!driverCode || !amount || !nonce) {
    return res.status(400).json({ success: false, error: 'driverCode, amount and nonce are required' });
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ success: false, error: 'amount must be a positive number' });
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve wallet with row lock (anti double-spend)
    const wRes = await client.query(
      `SELECT w.id, w.balance, w.driver_id
         FROM wallets w
         JOIN driver_profiles dp ON dp.user_id = w.driver_id
        WHERE dp.driver_code = $1
        FOR UPDATE OF w`,
      [driverCode]
    );
    if (wRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Wallet not found for driverCode' });
    }
    const wallet = wRes.rows[0];

    // Nonce replay protection
    const nRes = await client.query(
      `INSERT INTO used_nonces (nonce, wallet_id) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING RETURNING id`,
      [nonce, wallet.id]
    );
    if (nRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Duplicate nonce - transaction already processed' });
    }

    // Credit wallet
    const uRes = await client.query(
      `UPDATE wallets SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance`,
      [amt, wallet.id]
    );

    // Record transaction
    const tRes = await client.query(
      `INSERT INTO transactions (wallet_id, driver_id, type, amount, method, reference, nonce, status, created_at)
       VALUES ($1, $2, 'topup', $3, $4, $5, $6, 'completed', now())
       RETURNING id`,
      [wallet.id, wallet.driver_id, amt, method, reference, nonce]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      transactionId: tRes.rows[0].id,
      newBalance: Number(uRes.rows[0].balance),
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('topup-offline error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---- POST /api/transactions/batch-sync -----------------------------------
// Body: { driverCode, transactions: [{ localId, amount, type: 'payment'|'topup', method?, reference?, nonce, occurredAt }] }
// Anti-double-spend: per-nonce uniqueness + row-level wallet lock + balance floor check.
app.post('/api/transactions/batch-sync', async (req: Request, res: Response) => {
  const { driverCode, transactions } = req.body || {};
  if (!driverCode || !Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ success: false, error: 'driverCode and non-empty transactions[] required' });
  }
  if (transactions.length > 500) {
    return res.status(400).json({ success: false, error: 'Batch too large (max 500)' });
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const wRes = await client.query(
      `SELECT w.id, w.balance, w.driver_id
         FROM wallets w
         JOIN driver_profiles dp ON dp.user_id = w.driver_id
        WHERE dp.driver_code = $1
        FOR UPDATE OF w`,
      [driverCode]
    );
    if (wRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Wallet not found for driverCode' });
    }
    const wallet = wRes.rows[0];
    let balance = Number(wallet.balance);

    const accepted: { localId: any; transactionId: string; balanceAfter: number }[] = [];
    const rejected: { localId: any; reason: string }[] = [];

    for (const tx of transactions) {
      const { localId, amount, type, method = 'payment', reference = null, nonce, occurredAt } = tx || {};
      const amt = Number(amount);

      if (!localId || !Number.isFinite(amt) || amt <= 0 || !['payment', 'topup'].includes(type) || !nonce) {
        rejected.push({ localId, reason: 'Invalid transaction payload' });
        continue;
      }

      // Nonce uniqueness (server-side dedupe across retries/offline duplicates)
      const nRes = await client.query(
        `INSERT INTO used_nonces (nonce, wallet_id) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING RETURNING id`,
        [nonce, wallet.id]
      );
      if (nRes.rowCount === 0) {
        rejected.push({ localId, reason: 'Duplicate nonce (already synced)' });
        continue;
      }

      const delta = type === 'topup' ? amt : -amt;
      if (balance + delta < 0) {
        rejected.push({ localId, reason: 'Insufficient balance' });
        // consume the nonce anyway to prevent retry storms
        continue;
      }

      balance += delta;
      const tRes = await client.query(
        `INSERT INTO transactions (wallet_id, driver_id, type, amount, method, reference, nonce, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', COALESCE($8::timestamptz, now()))
         RETURNING id`,
        [wallet.id, wallet.driver_id, type, amt, method, reference, nonce, occurredAt ?? null]
      );
      accepted.push({ localId, transactionId: tRes.rows[0].id, balanceAfter: balance });
    }

    await client.query(`UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2`, [balance, wallet.id]);
    await client.query('COMMIT');

    return res.json({
      success: true,
      walletId: wallet.id,
      accepted,
      rejected,
      finalBalance: balance,
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('batch-sync error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---- GET /api/transactions/recent ----------------------------------------
app.get('/api/transactions/recent', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
  try {
    const result = await pool.query(
      `SELECT t.id, t.type, t.amount, t.method, t.reference, t.status, t.created_at,
              dp.driver_code, u.full_name
         FROM transactions t
         JOIN wallets w ON w.id = t.wallet_id
         JOIN driver_profiles dp ON dp.user_id = w.driver_id
         JOIN users u ON u.id = dp.user_id
        ORDER BY t.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return res.json({ success: true, count: result.rowCount, transactions: result.rows });
  } catch (err: any) {
    console.error('recent error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ---- GET /api/driver/:driverCode/balance ---------------------------------
app.get('/api/driver/:driverCode/balance', async (req: Request, res: Response) => {
  const { driverCode } = req.params;
  try {
    const result = await pool.query(
      `SELECT w.balance, w.currency, dp.driver_code, u.full_name
         FROM wallets w
         JOIN driver_profiles dp ON dp.user_id = w.driver_id
         JOIN users u ON u.id = dp.user_id
        WHERE dp.driver_code = $1`,
      [driverCode]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Driver not found' });
    }
    const row = result.rows[0];
    return res.json({
      success: true,
      driverCode: row.driver_code,
      fullName: row.full_name,
      balance: Number(row.balance),
      currency: row.currency,
    });
  } catch (err: any) {
    console.error('balance error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ---- 404 + error handler -------------------------------------------------
app.use((_req: Request, res: Response) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`NeuroPay API listening on port ${PORT}`));

export default app;
