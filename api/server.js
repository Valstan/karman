const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const cursorModelMonitor = require('./cursorModelMonitor');

const app = express();
app.set('trust proxy', true);

const port = Number(process.env.PORT || 8080);
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'karman_session';
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 14);
const sessionSecret = process.env.SESSION_SECRET || 'change-me';

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || 'karman_db',
});

app.use(express.json({ limit: '1mb' }));

app.use((_, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, cookiePart) => {
      const separatorIndex = cookiePart.indexOf('=');
      if (separatorIndex < 0) {
        return acc;
      }
      const key = cookiePart.slice(0, separatorIndex).trim();
      const value = cookiePart.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function safeEqualStrings(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest) && String(left).length === String(right).length;
}

function signSessionPayload(payload) {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.', 2);
  const expectedSignature = crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest('base64url');

  if (!safeEqualStrings(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload || typeof payload !== 'object' || typeof payload.uid !== 'number' || typeof payload.exp !== 'number') {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function buildSessionCookie(token, req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const securePart = secure ? '; Secure' : '';
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}${securePart}`;
}

function buildClearSessionCookie(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const securePart = secure ? '; Secure' : '';
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${securePart}`;
}

function verifyDjangoPassword(rawPassword, encodedPassword) {
  if (!encodedPassword || encodedPassword.startsWith('!')) {
    return false;
  }

  const parts = encodedPassword.split('$');
  if (parts.length !== 4) {
    return false;
  }

  const [algorithm, iterationsRaw, salt, digest] = parts;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }

  if (algorithm === 'pbkdf2_sha256') {
    const calculated = crypto.pbkdf2Sync(rawPassword, salt, iterations, 32, 'sha256').toString('base64');
    return safeEqualStrings(calculated, digest);
  }

  if (algorithm === 'pbkdf2_sha1') {
    const calculated = crypto.pbkdf2Sync(rawPassword, salt, iterations, 20, 'sha1').toString('base64');
    return safeEqualStrings(calculated, digest);
  }

  return false;
}

function parseNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return numeric;
}

function parseDate(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) {
    return fallback;
  }
  return asDate.toISOString().slice(0, 10);
}

function sanitizeUser(userRow) {
  return {
    id: userRow.id,
    username: userRow.username,
    email: userRow.email || '',
    first_name: userRow.first_name || '',
    last_name: userRow.last_name || '',
    is_superuser: Boolean(userRow.is_superuser),
  };
}

async function resolveUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[sessionCookieName];
  const payload = verifySessionToken(token);
  if (!payload) {
    return null;
  }

  const { rows } = await pool.query(
    `
      SELECT id, username, email, first_name, last_name, is_superuser, is_active
      FROM auth_user
      WHERE id = $1
    `,
    [payload.uid],
  );

  const user = rows[0];
  if (!user || !user.is_active) {
    return null;
  }

  return sanitizeUser(user);
}

async function requireAuth(req, res, next) {
  try {
    const user = await resolveUserFromRequest(req);
    if (!user) {
      res.status(401).json({ message: 'Требуется авторизация' });
      return;
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function getCreditById(creditId, userId, isSuperuser = false) {
  const params = [creditId];
  const ownershipFilter = isSuperuser ? '' : 'AND c.user_id = $2';
  if (!isSuperuser) {
    params.push(userId);
  }

  const { rows } = await pool.query(
    `
      SELECT
        c.id,
        COALESCE(NULLIF(c.name, ''), b.name) AS name,
        c.name AS raw_name,
        c.description,
        c.amount::text AS amount,
        c.interest_rate::text AS interest_rate,
        c.monthly_payment::text AS monthly_payment,
        c.payment_type,
        c.start_date,
        c.status,
        c.term_months,
        b.id AS bank_id,
        b.name AS bank_name,
        b.website AS bank_website
      FROM credits_credit c
      JOIN credits_bank b ON b.id = c.bank_id
      WHERE c.id = $1 ${ownershipFilter}
    `,
    params,
  );

  return rows[0] || null;
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: String(error) });
  }
});

app.post('/api/v1/auth/login', async (req, res, next) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      res.status(400).json({ message: 'Введите логин и пароль' });
      return;
    }

    const { rows } = await pool.query(
      `
        SELECT id, username, email, first_name, last_name, is_superuser, is_active, password
        FROM auth_user
        WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
        ORDER BY id ASC
        LIMIT 1
      `,
      [username],
    );

    const user = rows[0];
    if (!user || !user.is_active || !verifyDjangoPassword(password, user.password)) {
      res.status(401).json({ message: 'Неверный логин или пароль' });
      return;
    }

    const token = signSessionPayload({
      uid: user.id,
      exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds,
    });

    res.setHeader('Set-Cookie', buildSessionCookie(token, req));
    res.json({ user: sanitizeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildClearSessionCookie(req));
  res.json({ status: 'ok' });
});

app.get('/api/v1/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

app.get('/api/v1/auth/check/', requireAuth, (req, res) => {
  res.json({ authenticated: true, user: req.user });
});

app.get('/api/v1/dashboard/summary/', requireAuth, async (req, res, next) => {
  try {
    const whereCredits = req.user.is_superuser ? '' : 'WHERE user_id = $1';
    const wherePayments = req.user.is_superuser ? '' : 'WHERE c.user_id = $1';
    const params = req.user.is_superuser ? [] : [req.user.id];

    const [credits, payments] = await Promise.all([
      pool.query(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'active')::int AS active,
            COUNT(*) FILTER (WHERE status = 'overdue')::int AS overdue
          FROM credits_credit
          ${whereCredits}
        `,
        params,
      ),
      pool.query(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE p.status = 'scheduled')::int AS scheduled,
            COUNT(*) FILTER (WHERE p.status = 'overdue')::int AS overdue,
            COUNT(*) FILTER (WHERE p.status = 'paid')::int AS paid
          FROM credits_payment p
          JOIN credits_credit c ON c.id = p.credit_id
          ${wherePayments}
        `,
        params,
      ),
    ]);

    res.json({
      credits: credits.rows[0],
      payments: payments.rows[0],
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/credits/banks/', requireAuth, async (req, res, next) => {
  try {
    const query = req.user.is_superuser
      ? `
        SELECT
          id,
          name,
          address,
          phone,
          email,
          website
        FROM credits_bank
        ORDER BY id DESC
      `
      : `
        SELECT DISTINCT
          b.id,
          b.name,
          b.address,
          b.phone,
          b.email,
          b.website
        FROM credits_bank b
        JOIN credits_credit c ON c.bank_id = b.id
        WHERE c.user_id = $1
        ORDER BY b.id DESC
      `;

    const { rows } = await pool.query(
      query,
      req.user.is_superuser ? [] : [req.user.id],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/credits/credits/', requireAuth, async (req, res, next) => {
  try {
    const whereClause = req.user.is_superuser ? '' : 'WHERE c.user_id = $1';
    const { rows } = await pool.query(
      `
        SELECT
          c.id,
          COALESCE(NULLIF(c.name, ''), b.name) AS name,
          c.name AS raw_name,
          c.description,
          c.amount::text AS amount,
          c.interest_rate::text AS interest_rate,
          c.monthly_payment::text AS monthly_payment,
          c.payment_type,
          c.start_date,
          c.status,
          c.term_months,
          b.id AS bank_id,
          b.name AS bank_name,
          b.website AS bank_website
        FROM credits_credit c
        JOIN credits_bank b ON b.id = c.bank_id
        ${whereClause}
        ORDER BY c.start_date DESC NULLS LAST, c.id DESC
      `,
      req.user.is_superuser ? [] : [req.user.id],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/credits/credits/', requireAuth, async (req, res, next) => {
  try {
    const bankId = parseNumber(req.body.bank_id);
    const amount = parseNumber(req.body.amount, 0);
    const interestRate = parseNumber(req.body.interest_rate, 0);
    const monthlyPayment = parseNumber(req.body.monthly_payment);
    const termMonths = parseNumber(req.body.term_months, 1);
    const startDate = parseDate(req.body.start_date, new Date().toISOString().slice(0, 10));
    const status = typeof req.body.status === 'string' ? req.body.status : 'active';
    const paymentType = typeof req.body.payment_type === 'string' ? req.body.payment_type : 'annuity';
    const description = typeof req.body.description === 'string' ? req.body.description : '';
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';

    if (!bankId || termMonths < 1) {
      res.status(400).json({ message: 'Некорректные данные кредита' });
      return;
    }

    const insertResult = await pool.query(
      `
        INSERT INTO credits_credit (
          name, created_at, updated_at, bank_id, user_id, description,
          amount, interest_rate, monthly_payment, payment_type, start_date, status, term_months
        )
        VALUES ($1, NOW(), NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `,
      [
        rawName,
        bankId,
        req.user.id,
        description,
        amount,
        interestRate,
        monthlyPayment,
        paymentType,
        startDate,
        status,
        termMonths,
      ],
    );

    const created = await getCreditById(insertResult.rows[0].id, req.user.id, req.user.is_superuser);
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/v1/credits/credits/:id/', requireAuth, async (req, res, next) => {
  try {
    const creditId = parseNumber(req.params.id);
    if (!creditId) {
      res.status(400).json({ message: 'Некорректный ID кредита' });
      return;
    }

    const editableFields = {
      name: (value) => (typeof value === 'string' ? value : ''),
      description: (value) => (typeof value === 'string' ? value : ''),
      bank_id: (value) => parseNumber(value),
      amount: (value) => parseNumber(value),
      interest_rate: (value) => parseNumber(value),
      monthly_payment: (value) => parseNumber(value),
      payment_type: (value) => (typeof value === 'string' ? value : null),
      start_date: (value) => parseDate(value),
      status: (value) => (typeof value === 'string' ? value : null),
      term_months: (value) => parseNumber(value),
    };

    const setClauses = [];
    const values = [];

    Object.entries(editableFields).forEach(([field, parser]) => {
      if (!(field in req.body)) {
        return;
      }
      const parsedValue = parser(req.body[field]);
      if (parsedValue === null) {
        return;
      }
      values.push(parsedValue);
      setClauses.push(`${field} = $${values.length}`);
    });

    if (setClauses.length === 0) {
      res.status(400).json({ message: 'Нет полей для обновления' });
      return;
    }

    const queryValues = [...values];
    let ownershipPredicate = '';
    if (!req.user.is_superuser) {
      queryValues.push(req.user.id);
      ownershipPredicate = `user_id = $${queryValues.length} AND `;
    }
    queryValues.push(creditId);

    const updateResult = await pool.query(
      `
        UPDATE credits_credit
        SET ${setClauses.join(', ')}, updated_at = NOW()
        WHERE ${ownershipPredicate}id = $${queryValues.length}
        RETURNING id
      `,
      queryValues,
    );

    if (updateResult.rowCount === 0) {
      res.status(404).json({ message: 'Кредит не найден' });
      return;
    }

    const updated = await getCreditById(creditId, req.user.id, req.user.is_superuser);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/credits/payments/', requireAuth, async (req, res, next) => {
  try {
    const whereClause = req.user.is_superuser ? '' : 'WHERE c.user_id = $1';
    const { rows } = await pool.query(
      `
        SELECT
          p.id,
          p.credit_id,
          COALESCE(NULLIF(c.name, ''), b.name) AS credit_name,
          b.name AS bank_name,
          p.amount::text AS amount,
          p.principal_amount::text AS principal_amount,
          p.interest_amount::text AS interest_amount,
          p.due_date,
          p.paid_date,
          p.status
        FROM credits_payment p
        JOIN credits_credit c ON c.id = p.credit_id
        JOIN credits_bank b ON b.id = c.bank_id
        ${whereClause}
        ORDER BY p.due_date ASC NULLS LAST, p.id DESC
      `,
      req.user.is_superuser ? [] : [req.user.id],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/v1/credits/payments/:id/', requireAuth, async (req, res, next) => {
  try {
    const paymentId = parseNumber(req.params.id);
    if (!paymentId) {
      res.status(400).json({ message: 'Некорректный ID платежа' });
      return;
    }

    const editableFields = {
      amount: (value) => parseNumber(value),
      principal_amount: (value) => parseNumber(value),
      interest_amount: (value) => parseNumber(value),
      due_date: (value) => parseDate(value),
      paid_date: (value) => parseDate(value),
      status: (value) => (typeof value === 'string' ? value : null),
    };

    const setClauses = [];
    const values = [];

    Object.entries(editableFields).forEach(([field, parser]) => {
      if (!(field in req.body)) {
        return;
      }
      const parsedValue = parser(req.body[field]);
      if (parsedValue === null) {
        return;
      }
      values.push(parsedValue);
      setClauses.push(`${field} = $${values.length}`);
    });

    if (setClauses.length === 0) {
      res.status(400).json({ message: 'Нет полей для обновления' });
      return;
    }

    const queryValues = [...values];
    let ownershipPredicate = '';
    if (!req.user.is_superuser) {
      queryValues.push(req.user.id);
      ownershipPredicate = `AND c.user_id = $${queryValues.length}`;
    }
    queryValues.push(paymentId);

    const updateResult = await pool.query(
      `
        UPDATE credits_payment p
        SET ${setClauses.join(', ')}, updated_at = NOW()
        FROM credits_credit c
        WHERE p.credit_id = c.id
          AND p.id = $${queryValues.length}
          ${ownershipPredicate}
        RETURNING p.id
      `,
      queryValues,
    );

    if (updateResult.rowCount === 0) {
      res.status(404).json({ message: 'Платеж не найден' });
      return;
    }

    const whereRowClause = req.user.is_superuser ? 'WHERE p.id = $1' : 'WHERE c.user_id = $1 AND p.id = $2';
    const rowParams = req.user.is_superuser ? [paymentId] : [req.user.id, paymentId];
    const { rows } = await pool.query(
      `
        SELECT
          p.id,
          p.credit_id,
          COALESCE(NULLIF(c.name, ''), b.name) AS credit_name,
          b.name AS bank_name,
          p.amount::text AS amount,
          p.principal_amount::text AS principal_amount,
          p.interest_amount::text AS interest_amount,
          p.due_date,
          p.paid_date,
          p.status
        FROM credits_payment p
        JOIN credits_credit c ON c.id = p.credit_id
        JOIN credits_bank b ON b.id = c.bank_id
        ${whereRowClause}
      `,
      rowParams,
    );

    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/documents/', requireAuth, async (req, res, next) => {
  try {
    const whereClause = req.user.is_superuser ? '' : 'WHERE user_id = $1';
    const { rows } = await pool.query(
      `
        SELECT
          id,
          title,
          document_type,
          document_number,
          issue_date,
          expiry_date,
          issuing_authority,
          is_active
        FROM documents_document
        ${whereClause}
        ORDER BY id DESC
      `,
      req.user.is_superuser ? [] : [req.user.id],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/cursor-model-reports/', requireAuth, async (req, res, next) => {
  try {
    const limit = parseNumber(req.query.limit, 20);
    const reports = await cursorModelMonitor.listReports(pool, limit);
    res.json(reports);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/cursor-model-reports/:id/', requireAuth, async (req, res, next) => {
  try {
    const reportId = parseNumber(req.params.id);
    if (!reportId) {
      res.status(400).json({ message: 'Некорректный ID отчета' });
      return;
    }

    const report = await cursorModelMonitor.getReportById(pool, reportId);
    if (!report) {
      res.status(404).json({ message: 'Отчет не найден' });
      return;
    }
    res.json(report);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/v1/cursor-model-reports/:id/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user.is_superuser) {
      res.status(403).json({ message: 'Недостаточно прав' });
      return;
    }

    const reportId = parseNumber(req.params.id);
    if (!reportId) {
      res.status(400).json({ message: 'Некорректный ID отчета' });
      return;
    }
    const deleted = await cursorModelMonitor.deleteReportById(pool, reportId);
    if (!deleted) {
      res.status(404).json({ message: 'Отчет не найден' });
      return;
    }
    res.json({ message: 'Отчет удален', deleted });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/cursor-model-reports/run-now/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user.is_superuser) {
      res.status(403).json({ message: 'Недостаточно прав' });
      return;
    }
    const report = await cursorModelMonitor.generateDailyReport(pool);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/cursor-model-reports/collect-now/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user.is_superuser) {
      res.status(403).json({ message: 'Недостаточно прав' });
      return;
    }
    const result = await cursorModelMonitor.collectAndStoreEvents(pool);
    res.json({ message: 'Сбор завершен', ...result });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error('API error', error);
  res.status(500).json({
    message: 'Ошибка API',
    detail: process.env.NODE_ENV === 'production' ? undefined : String(error.message || error),
  });
});

const shouldRunCursorModelMonitor = process.env.CURSOR_MODEL_MONITOR_ENABLED !== 'false';
if (shouldRunCursorModelMonitor) {
  void cursorModelMonitor.startBackgroundMonitor(pool).catch((error) => {
    console.error('Cursor model monitor startup failed', error);
  });
}

app.listen(port, () => {
  console.log(`KARMAN API listening on port ${port}`);
});
