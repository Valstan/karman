const crypto = require('crypto');

const COLLECTION_INTERVAL_MS = Number(process.env.CURSOR_MODEL_COLLECTION_INTERVAL_MS || 5 * 60 * 60 * 1000);
const REPORT_INTERVAL_MS = Number(process.env.CURSOR_MODEL_REPORT_INTERVAL_MS || 24 * 60 * 60 * 1000);
const RETENTION_DAYS = Number(process.env.CURSOR_MODEL_RETENTION_DAYS || 7);
const REPORT_HOUR_UTC = Number(process.env.CURSOR_MODEL_REPORT_HOUR || process.env.CURSOR_MODEL_REPORT_HOUR_UTC || 9);

let TELEGRAM_BOT_TOKEN = process.env.CURSOR_MODEL_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
let TELEGRAM_CHAT_ID = process.env.CURSOR_MODEL_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_PROVIDER = 'telegram';

let telegramConfigState = {
  loaded: false,
  loading: null,
};

async function loadTelegramConfigFromDb(pool) {
  if (telegramConfigState.loaded) {
    return;
  }
  if (telegramConfigState.loading) {
    await telegramConfigState.loading;
    return;
  }

  telegramConfigState.loading = (async () => {
    try {
      if (!TELEGRAM_BOT_TOKEN) {
        const tokenRows = await pool.query(
          'SELECT secret FROM socialaccount_socialapp WHERE provider = $1 ORDER BY id ASC LIMIT 1',
          [TELEGRAM_PROVIDER],
        );
        if (tokenRows.rows[0]?.secret) {
          TELEGRAM_BOT_TOKEN = tokenRows.rows[0].secret;
        }
      }

      if (!TELEGRAM_CHAT_ID) {
        const chatRows = await pool.query(`
          SELECT telegram_id
          FROM (
            SELECT telegram_id, 1 AS priority
            FROM bot_telegramuser
            WHERE is_active = TRUE
              AND telegram_id IS NOT NULL
            UNION ALL
            SELECT telegram_id, 2 AS priority
            FROM accounts_profile
            WHERE telegram_verified = TRUE
              AND telegram_id IS NOT NULL
          ) t
          ORDER BY priority ASC, telegram_id
          LIMIT 1
        `);
        if (chatRows.rows[0]?.telegram_id) {
          TELEGRAM_CHAT_ID = String(chatRows.rows[0].telegram_id);
        }
      }
    } catch (error) {
      console.error('Не удалось загрузить Telegram-настройки из БД:', error.message);
    } finally {
      telegramConfigState.loaded = true;
      telegramConfigState.loading = null;
    }
  })();

  await telegramConfigState.loading;
}

const MODEL_SOURCES = [
  {
    type: 'cursor_docs',
    label: 'Cursor Docs Models',
    url: 'https://cursor.com/docs/models',
  },
  {
    type: 'cursor_changelog',
    label: 'Cursor Changelog',
    url: 'https://cursor.com/changelog',
  },
];

const SEARCH_SOURCES = [
  {
    type: 'internet_search',
    label: 'Google News',
    url: 'https://news.google.com/rss/search?q=Cursor+AI+model+release',
  },
  {
    type: 'internet_search',
    label: 'Google News (Russian)',
    url: 'https://news.google.com/rss/search?q=%D1%86%D0%B5%D1%80%D1%8C%D1%91%D1%80+Cursor+model',
  },
  {
    type: 'internet_search',
    label: 'Google News (Cursor pricing)',
    url: 'https://news.google.com/rss/search?q=Cursor+AI+model+pricing+preview+cost',
  },
  {
    type: 'internet_search',
    label: 'Google News (AI model launch)',
    url: 'https://news.google.com/rss/search?q=OpenAI+Anthropic+Google+model+release+Cursor',
  },
  {
    type: 'internet_search',
    label: 'TechCrunch AI Feed',
    url: 'https://techcrunch.com/tag/artificial-intelligence/feed/',
  },
  {
    type: 'internet_search',
    label: 'The Verge AI',
    url: 'https://www.theverge.com/ai-artificial-intelligence/rss',
  },
];

const MODEL_LIBRARY = [
  {
    name: 'GPT-5',
    provider: 'OpenAI',
    aliases: ['gpt-5', 'gpt 5'],
  },
  {
    name: 'GPT-4.1',
    provider: 'OpenAI',
    aliases: ['gpt-4.1', 'gpt 4.1'],
  },
  {
    name: 'GPT-4o',
    provider: 'OpenAI',
    aliases: ['gpt-4o', 'gpt 4o'],
  },
  {
    name: 'Claude Opus 4',
    provider: 'Anthropic',
    aliases: ['claude opus 4', 'opus 4'],
  },
  {
    name: 'Claude Sonnet 4',
    provider: 'Anthropic',
    aliases: ['claude sonnet 4', 'sonnet 4'],
  },
  {
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    aliases: ['claude 3.5', 'claude-3.5', 'claude 3 5', 'claude sonnet'],
  },
  {
    name: 'Gemini 2.0 Pro',
    provider: 'Google',
    aliases: ['gemini 2.0 pro', 'gemini 2 pro'],
  },
  {
    name: 'Gemini 2.5 Pro',
    provider: 'Google',
    aliases: ['gemini 2.5 pro', 'gemini 2 5 pro', 'gemini 2.5'],
  },
  {
    name: 'Gemini 2.5 Flash',
    provider: 'Google',
    aliases: ['gemini 2.5 flash', 'gemini flash'],
  },
  {
    name: 'Llama 4 Scout',
    provider: 'Meta',
    aliases: ['llama 4 scout', 'llama scout'],
  },
  {
    name: 'Llama 4 Maverick',
    provider: 'Meta',
    aliases: ['llama 4 maverick', 'llama maverick'],
  },
  {
    name: 'Llama 3.3',
    provider: 'Meta',
    aliases: ['llama 3.3', 'llama 3 3'],
  },
  {
    name: 'Mistral Large 2',
    provider: 'Mistral',
    aliases: ['mistral large 2', 'mistral large'],
  },
  {
    name: 'Qwen2.5',
    provider: 'Alibaba',
    aliases: ['qwen2.5', 'qwen 2.5', 'qwen'],
  },
  {
    name: 'DeepSeek R1',
    provider: 'DeepSeek',
    aliases: ['deepseek r1', 'deepseek-r1', 'deepseek'],
  },
  {
    name: 'Grok 2',
    provider: 'xAI',
    aliases: ['grok 2', 'grok2', 'grok'],
  },
  {
    name: 'Grok 3',
    provider: 'xAI',
    aliases: ['grok 3', 'grok3'],
  },
  {
    name: 'Gemma 2',
    provider: 'Google',
    aliases: ['gemma 2', 'gemma2'],
  },
];

const MONTHS_RU = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

const MONTHS_EN = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

let hasStarted = false;
let collectionTimer = null;
let reportTimer = null;

function toText(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value)
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\u0022/gi, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlStrip(value) {
  return toText(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\[\\/(.*?)\\]/g, ' ')
    .replace(/\\[(.*?)\\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hashValue(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function clampText(value, maxLength = 420) {
  if (!value) {
    return '';
  }
  const text = String(value).trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function getSnippet(text, position) {
  if (!text || position < 0) {
    return text;
  }
  const start = Math.max(0, position - 120);
  const end = Math.min(text.length, position + 220);
  return clampText(htmlStrip(text.slice(start, end)), 280);
}

function detectModels(text) {
  const lowered = htmlStrip(text).toLowerCase();
  const unique = new Map();

  for (const item of MODEL_LIBRARY) {
    let bestMatch = null;
    let bestPos = Number.POSITIVE_INFINITY;
    for (const alias of item.aliases) {
      const pos = lowered.indexOf(alias);
      if (pos >= 0 && pos < bestPos) {
        bestPos = pos;
        bestMatch = alias;
      }
    }
    if (bestMatch !== null) {
      const key = `${item.provider.toLowerCase()}::${item.name.toLowerCase()}`;
      if (!unique.has(key)) {
        unique.set(key, {
          modelName: item.name,
          provider: item.provider,
          position: bestPos,
          alias: bestMatch,
        });
      }
    }
  }

  return Array.from(unique.values());
}

function extractPriceInfo(text) {
  const normalized = htmlStrip(text).replace(/\\s+/g, ' ');
  const result = {
    input: null,
    output: null,
    cache: null,
    cacheRead: null,
  };

  const pricePatterns = [
    { key: 'input', regex: /Input\s*\+?\s*Cache Write\s*:\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i },
    { key: 'output', regex: /Output\s*:\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i },
    { key: 'cache', regex: /Cache Write\s*:\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i },
    { key: 'cacheRead', regex: /Cache Read\s*:\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i },
  ];

  for (const entry of pricePatterns) {
    const match = normalized.match(entry.regex);
    if (match && match[1]) {
      result[entry.key] = `${match[1]} за 1M токенов`;
    }
  }

  return result;
}

function detectPreview(text) {
  const lowered = htmlStrip(text).toLowerCase();
  const now = new Date();
  const previewPhrases = [
    'preview',
    'beta',
    'beta-test',
    'pre-release',
    'preview mode',
    'превью',
    'бета',
    'обкат',
  ];

  const isPreview = previewPhrases.some((phrase) => lowered.includes(phrase));
  let previewUntil = null;

  const match = lowered.match(/до\s+([a-z]{3}\s+\d{1,2},?\s*\d{4})/i);
  if (match) {
    const parsed = safeDate(match[0]);
    if (parsed) {
      previewUntil = new Date(parsed).toISOString().slice(0, 10);
    }
  }

  return { isPreview, previewUntil };
}

function parseDateFromFreeText(value) {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  const isoMatch = normalized.match(/(\d{4}-\d{1,2}-\d{1,2})/);
  if (isoMatch) {
    const date = safeDate(isoMatch[0]);
    if (date) {
      return date;
    }
  }

  const simpleMatch = normalized.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/);
  if (simpleMatch) {
    const date = safeDate(simpleMatch[0].replace(/\//g, '-').replace(/-/g, '-'));
    if (date) {
      return date;
    }
  }

  const monthRegex = normalized.match(
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/,
  );
  if (monthRegex) {
    const month = MONTHS_EN[monthRegex[1]];
    if (month !== undefined) {
      return safeDate(`${monthRegex[3]}-${String(month + 1).padStart(2, '0')}-${monthRegex[2].padStart(2, '0')}`);
    }
  }

  const monthRuMatch = normalized.match(
    /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/,
  );
  if (monthRuMatch) {
    const month = MONTHS_RU[monthRuMatch[2]];
    if (month !== undefined) {
      return safeDate(`${monthRuMatch[3]}-${String(month + 1).padStart(2, '0')}-${monthRuMatch[1].padStart(2, '0')}`);
    }
  }

  return null;
}

function formatDisplayDate(value) {
  const date = safeDate(value);
  if (!date) {
    return 'Не указана';
  }
  return new Date(date).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function inferReleaseDateHint(text, sourceDate) {
  if (sourceDate) {
    const sourceDateValue = safeDate(sourceDate);
    if (sourceDateValue) {
      return sourceDateValue;
    }
  }
  return parseDateFromFreeText(htmlStrip(text));
}

function inferAvailabilityFromSource(sourceType, sourceLabel, text) {
  const lowered = htmlStrip(text).toLowerCase();
  if (sourceType === 'cursor_docs' || sourceType === 'cursor_changelog') {
    return 'Подтверждено: официальное обновление Cursor.';
  }

  const hasCursorMention =
    lowered.includes('cursor') || (sourceLabel && sourceLabel.toLowerCase().includes('cursor'));
  if (hasCursorMention) {
    return 'Предположительно: источник уже про Cursor, вероятно доступно.';
  }

  if (/\bв cursor\b|\bin cursor\b|\bfor cursor\b/.test(lowered)) {
    return 'Предположительно: упомянута интеграция с Cursor.';
  }

  return 'Пока не подтверждено, требуется ручная проверка доступности в Cursor.';
}

function inferReasonForNewness(text) {
  const lowered = htmlStrip(text).toLowerCase();
  const reasonPatterns = [
    {
      regex: /beta|preview|beta-test|превью|бета|обкат/,
      label: 'Модель упоминается как preview/тестовая и может быть выгодна по промо-условиям.',
    },
    {
      regex: /release|релиз|выпуск|анонс|анонсирован|annonc|нов(ый|ых)|new model|новая модель|newer|обновлен/i,
      label: 'Обновление сообщает о новой модели/новом статусе модели.',
    },
    {
      regex: /добавл|доступ|поддерж|подключ|подключен|available|support|доступна в/i,
      label: 'В сообщении указано добавление/поддержка модели.',
    },
    {
      regex: /цена|стоимость|input|output|cache|million|токен|токенов|стоимости|billing|pricing/i,
      label: 'Обсуждается стоимость использования и тарифы.',
    },
  ];

  for (const candidate of reasonPatterns) {
    if (candidate.regex.test(lowered)) {
      return candidate.label;
    }
  }

  return 'Модель появилась в релевантной публикации по LLM/AI.';
}

function formatEventSummary({
  modelName,
  priceInfo,
  sourceDate,
  sourceType,
  sourceLabel,
  text,
}) {
  const releaseAt = inferReleaseDateHint(text, sourceDate);
  const availability = inferAvailabilityFromSource(sourceType, sourceLabel, text);
  const reason = inferReasonForNewness(text);
  const priceParts = [];

  if (priceInfo.input) {
    priceParts.push(`вход: ${priceInfo.input}`);
  }
  if (priceInfo.output) {
    priceParts.push(`выход: ${priceInfo.output}`);
  }
  if (priceInfo.cache) {
    priceParts.push(`cache: ${priceInfo.cache}`);
  }
  if (priceInfo.cacheRead) {
    priceParts.push(`cache read: ${priceInfo.cacheRead}`);
  }

  const details = [
    `Сведения по модели ${modelName}.`,
    `Дата упоминания: ${formatDisplayDate(releaseAt)}`,
    `Почему новое: ${reason}`,
    `Доступность в Cursor: ${availability}`,
  ];
  if (priceParts.length) {
    details.push(`Цены за 1M токенов: ${priceParts.join(', ')}`);
  }

  return {
    summary: details.join('\n'),
    releaseDateHint: releaseAt,
    availabilityInCursor: availability,
    reasonForNewness: reason,
  };
}

function escapeTelegramText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Karman-Cursor-Model-Monitor/1.0',
        Accept: 'text/plain, text/html, application/xml, application/rss+xml, */*',
        ...options.headers,
      },
      ...options,
    });
    if (!response.ok) {
      throw new Error(`Fetch failed ${response.status} ${response.statusText} for ${url}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractRssTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match) {
    return '';
  }
  return htmlStrip(match[1]);
}

function parseRssItems(xmlText) {
  const items = [];
  const blockRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = blockRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const title = extractRssTag(block, 'title');
    const link = extractRssTag(block, 'link');
    const publishedAt = extractRssTag(block, 'pubDate');
    const description = extractRssTag(block, 'description');
    items.push({
      title,
      link,
      publishedAt: safeDate(publishedAt),
      description,
    });
  }
  return items;
}

function buildFingerprint({ sourceType, sourceUrl, sourcePublishedAt, modelName, title }) {
  const sourceId = sourcePublishedAt || 'unknown';
  return hashValue(`${sourceType}::${sourceUrl}::${sourceId}::${modelName}::${title}`);
}

function buildEventsFromText({ sourceType, sourceLabel, sourceUrl, text, sourceDate = null, collectedAt = null }) {
  const found = detectModels(text);
  if (!found.length) {
    return [];
  }

  const rows = [];
  for (const model of found) {
    const snippet = getSnippet(text, model.position);
    const priceInfo = extractPriceInfo(snippet + ' ' + text.slice(model.position, model.position + 800));
    const previewInfo = detectPreview(snippet);
    const extraInfo = formatEventSummary({
      modelName: model.modelName,
      priceInfo,
      sourceDate: sourceDate || collectedAt,
      sourceType,
      sourceLabel,
      text: `${model.modelName} ${snippet} ${text.slice(model.position - 160, model.position + 700)}`,
    });
    const title = `${model.modelName} в источнике ${sourceLabel}`;
    const summary = clampText(
      `${snippet}\n\n${extraInfo.summary}\n\nКлючевая фраза: ${model.alias}`,
      900,
    );
    rows.push({
      sourceType,
      sourceLabel,
      sourceUrl,
      sourceDate,
      title,
      modelName: model.modelName,
      provider: model.provider,
      summary,
      isPreview: previewInfo.isPreview,
      previewUntil: previewInfo.previewUntil,
      priceInput: priceInfo.input,
      priceOutput: priceInfo.output,
      priceCacheWrite: priceInfo.cache,
      priceCacheRead: priceInfo.cacheRead,
      releaseDateHint: extraInfo.releaseDateHint,
      availabilityInCursor: extraInfo.availabilityInCursor,
      reasonForNewness: extraInfo.reasonForNewness,
      rawText: clampText(text, 2000),
      fingerprint: buildFingerprint({
        sourceType,
        sourceUrl,
        sourcePublishedAt: sourceDate || '',
        modelName: model.modelName,
        title,
      }),
    });
  }
  return rows;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cursor_model_events (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_published_at TIMESTAMPTZ,
      model_name TEXT NOT NULL,
      model_provider TEXT,
      title TEXT NOT NULL,
      summary TEXT,
        release_date_hint TIMESTAMPTZ,
        availability_in_cursor TEXT,
        reason_for_newness TEXT,
      is_preview BOOLEAN NOT NULL DEFAULT FALSE,
      preview_until TEXT,
      price_input_per_million TEXT,
      price_output_per_million TEXT,
      price_cache_write_per_million TEXT,
      price_cache_read_per_million TEXT,
      raw_text TEXT,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE cursor_model_events
      ADD COLUMN IF NOT EXISTS release_date_hint TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS availability_in_cursor TEXT,
      ADD COLUMN IF NOT EXISTS reason_for_newness TEXT,
      ADD COLUMN IF NOT EXISTS price_cache_write_per_million TEXT,
      ADD COLUMN IF NOT EXISTS price_cache_read_per_million TEXT;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS cursor_model_events_discovered_at_idx
      ON cursor_model_events (discovered_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS cursor_model_events_model_name_idx
      ON cursor_model_events (model_name);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cursor_model_reports (
      id BIGSERIAL PRIMARY KEY,
      report_date DATE NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      total_events INTEGER NOT NULL DEFAULT 0,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cursor_model_report_items (
      id BIGSERIAL PRIMARY KEY,
      report_id BIGINT NOT NULL REFERENCES cursor_model_reports(id) ON DELETE CASCADE,
      event_position INTEGER NOT NULL,
      model_name TEXT NOT NULL,
      model_provider TEXT,
      title TEXT NOT NULL,
      summary TEXT,
        reason_for_newness TEXT,
        release_date_hint TIMESTAMPTZ,
        availability_in_cursor TEXT,
      source_url TEXT,
      source_type TEXT,
      is_preview BOOLEAN NOT NULL DEFAULT FALSE,
      preview_until TEXT,
      price_input_per_million TEXT,
      price_output_per_million TEXT,
      price_cache_write_per_million TEXT,
      price_cache_read_per_million TEXT,
      source_published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE cursor_model_report_items
      ADD COLUMN IF NOT EXISTS reason_for_newness TEXT,
      ADD COLUMN IF NOT EXISTS release_date_hint TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS availability_in_cursor TEXT,
      ADD COLUMN IF NOT EXISTS price_cache_write_per_million TEXT,
      ADD COLUMN IF NOT EXISTS price_cache_read_per_million TEXT;
  `);
}

async function upsertEvent(pool, event) {
  const result = await pool.query(
    `
      INSERT INTO cursor_model_events (
        source_type, source_label, source_url, source_published_at,
        model_name, model_provider, title, summary, release_date_hint, availability_in_cursor, reason_for_newness,
        is_preview, preview_until, price_input_per_million, price_output_per_million, price_cache_write_per_million, price_cache_read_per_million, raw_text, fingerprint
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      ) ON CONFLICT (fingerprint) DO UPDATE SET
        discovered_at = NOW(),
        source_published_at = COALESCE(EXCLUDED.source_published_at, cursor_model_events.source_published_at),
        summary = COALESCE(NULLIF(EXCLUDED.summary, ''), cursor_model_events.summary),
        release_date_hint = COALESCE(EXCLUDED.release_date_hint, cursor_model_events.release_date_hint),
        availability_in_cursor = COALESCE(EXCLUDED.availability_in_cursor, cursor_model_events.availability_in_cursor),
        reason_for_newness = COALESCE(EXCLUDED.reason_for_newness, cursor_model_events.reason_for_newness),
        price_input_per_million = COALESCE(EXCLUDED.price_input_per_million, cursor_model_events.price_input_per_million),
        price_output_per_million = COALESCE(EXCLUDED.price_output_per_million, cursor_model_events.price_output_per_million),
        price_cache_write_per_million = COALESCE(EXCLUDED.price_cache_write_per_million, cursor_model_events.price_cache_write_per_million),
        price_cache_read_per_million = COALESCE(EXCLUDED.price_cache_read_per_million, cursor_model_events.price_cache_read_per_million),
        is_preview = EXCLUDED.is_preview,
        preview_until = EXCLUDED.preview_until,
        raw_text = COALESCE(NULLIF(EXCLUDED.raw_text, ''), cursor_model_events.raw_text)
      RETURNING id;
    `,
    [
      event.sourceType,
      event.sourceLabel,
      event.sourceUrl,
      event.sourceDate,
      event.modelName,
      event.provider,
      event.title,
      event.summary,
      event.releaseDateHint,
      event.availabilityInCursor,
      event.reasonForNewness,
      event.isPreview,
      event.previewUntil,
      event.priceInput,
      event.priceOutput,
      event.priceCacheWrite,
      event.priceCacheRead,
      event.rawText,
      event.fingerprint,
    ],
  );
  return result.rows[0] ? result.rows[0].id : null;
}

async function collectCursorDocs() {
  const events = [];
  for (const source of MODEL_SOURCES) {
    try {
      const now = new Date().toISOString();
      const text = await fetchWithTimeout(source.url, { method: 'GET' });
      const candidates = buildEventsFromText({
        sourceType: source.type,
        sourceLabel: source.label,
        sourceUrl: source.url,
        text,
        sourceDate: null,
        collectedAt: now,
      });
      events.push(...candidates);
    } catch (error) {
      console.error(`Cursor model source failed: ${source.url}`, error.message);
    }
  }
  return events;
}

async function collectInternetNews() {
  const events = [];
  for (const source of SEARCH_SOURCES) {
    try {
      const now = new Date().toISOString();
      const rss = await fetchWithTimeout(source.url, { method: 'GET' });
      const items = parseRssItems(rss);
      for (const item of items) {
        const combined = `${item.title} ${item.description}`;
        const candidates = buildEventsFromText({
          sourceType: source.type,
          sourceLabel: source.label,
          sourceUrl: item.link || source.url,
          text: combined,
          sourceDate: item.publishedAt,
          collectedAt: now,
        });
        events.push(...candidates);
      }
    } catch (error) {
      console.error(`Search source failed: ${source.url}`, error.message);
    }
  }
  return events;
}

async function collectAndStoreEvents(pool) {
  const rawEvents = [...(await collectCursorDocs()), ...(await collectInternetNews())];
  const unique = new Map();

  for (const event of rawEvents) {
    if (event.fingerprint && !unique.has(event.fingerprint)) {
      unique.set(event.fingerprint, event);
    }
  }

  let inserted = 0;
  for (const event of unique.values()) {
    const insertedId = await upsertEvent(pool, event);
    if (insertedId) {
      inserted += 1;
    }
  }

  return {
    total: unique.size,
    inserted,
  };
}

function buildTelegramPayload(report) {
  const header = `<b>${escapeTelegramText(report.title)}</b>`;
  const period = `Период: ${new Date(report.period_start).toLocaleString('ru-RU')} — ${new Date(
    report.period_end,
  ).toLocaleString('ru-RU')}`;
  const total = `Событий: ${report.total_events}`;
  const lines = [header, period, total, ''];

  for (const item of report.items.slice(0, 15)) {
    const preview =
      item.is_preview && item.preview_until
        ? ` [PREVIEW до ${item.preview_until}]`
        : item.is_preview
          ? ' [PREVIEW]'
          : '';
    const modelLine = `${item.model_name || 'Модель'}${preview}`;
    const priceParts = [];
    if (item.price_input_per_million) {
      priceParts.push(`вход ${item.price_input_per_million}`);
    }
    if (item.price_output_per_million) {
      priceParts.push(`выход ${item.price_output_per_million}`);
    }
    if (item.price_cache_write_per_million) {
      priceParts.push(`cache write ${item.price_cache_write_per_million}`);
    }
    if (item.price_cache_read_per_million) {
      priceParts.push(`cache read ${item.price_cache_read_per_million}`);
    }
    const price = priceParts.length ? ` · Цены: ${escapeTelegramText(priceParts.join(', '))}` : '';
    const releaseDate = formatDisplayDate(item.release_date_hint || item.source_published_at);
    const sourceText = item.source_url ? ` · <a href="${escapeTelegramText(item.source_url)}">источник</a>` : '';
    const availabilityText = item.availability_in_cursor
      ? ` · Доступность: ${escapeTelegramText(item.availability_in_cursor)}`
      : '';
    const reasonText = item.reason_for_newness ? ` · Почему: ${escapeTelegramText(item.reason_for_newness)}` : '';
    const detailsText = `${price}${availabilityText}${reasonText} · Опубликовано: ${escapeTelegramText(releaseDate)}${sourceText}`;
    lines.push(`• ${escapeTelegramText(modelLine)}: ${escapeTelegramText(item.title)}${detailsText}`);
  }

  if (report.total_events > 15) {
    lines.push('', `...и еще ${report.total_events - 15} записей`);
  }

  return lines.join('\n');
}

async function sendTelegramMessage(pool, message) {
  await loadTelegramConfigFromDb(pool);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return;
  }
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
      15000,
    );
    if (!response) {
      throw new Error('No response from Telegram API');
    }
  } catch (error) {
    console.error('Telegram send error', error.message);
  }
}

async function upsertDailyReport(pool, reportDate, periodStart, periodEnd, title, summary, total, rowsForItems) {
  const upsert = await pool.query(
    `
      INSERT INTO cursor_model_reports (report_date, title, summary, total_events, period_start, period_end)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (report_date)
      DO UPDATE SET
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        total_events = EXCLUDED.total_events,
        period_start = EXCLUDED.period_start,
        period_end = EXCLUDED.period_end,
        created_at = NOW()
      RETURNING id;
    `,
    [reportDate, title, summary, total, periodStart.toISOString(), periodEnd.toISOString()],
  );

  const reportId = upsert.rows[0].id;
  await pool.query('DELETE FROM cursor_model_report_items WHERE report_id = $1', [reportId]);

  if (rowsForItems.length) {
    for (let i = 0; i < rowsForItems.length; i++) {
      const row = rowsForItems[i];
      await pool.query(
        `
          INSERT INTO cursor_model_report_items (
            report_id, event_position, model_name, model_provider, title, summary,
            reason_for_newness, release_date_hint, availability_in_cursor,
          source_url, source_type, is_preview, preview_until,
          price_input_per_million, price_output_per_million, price_cache_write_per_million, price_cache_read_per_million, source_published_at
          ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
          );
        `,
        [
          reportId,
          i + 1,
          row.model_name,
          row.model_provider,
          row.title,
          row.summary,
          row.reason_for_newness,
          row.release_date_hint,
          row.availability_in_cursor,
          row.source_url,
          row.source_type,
          row.is_preview,
          row.preview_until,
          row.price_input_per_million,
          row.price_output_per_million,
        row.price_cache_write_per_million,
        row.price_cache_read_per_million,
          row.source_published_at,
        ],
      );
    }
  }

  const reportRows = await pool.query('SELECT * FROM cursor_model_reports WHERE id = $1', [reportId]);
  const itemRows = await pool.query(
    `SELECT
      id,
      model_name,
      model_provider,
      title,
      summary,
      reason_for_newness,
      release_date_hint,
      availability_in_cursor,
      source_url,
      source_type,
      is_preview,
      preview_until,
      price_input_per_million,
      price_output_per_million,
      price_cache_write_per_million,
      price_cache_read_per_million,
      source_published_at,
      event_position
    FROM cursor_model_report_items
    WHERE report_id = $1
    ORDER BY event_position ASC`,
    [reportId],
  );

  return {
    ...reportRows.rows[0],
    items: itemRows.rows,
  };
}

async function generateDailyReport(pool) {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - REPORT_INTERVAL_MS);

  const found = await pool.query(
    `
      SELECT
        id,
        source_type,
        source_url,
        source_published_at,
        model_name,
        model_provider,
        title,
        summary,
        reason_for_newness,
        release_date_hint,
        availability_in_cursor,
        is_preview,
        preview_until,
        price_input_per_million,
        price_output_per_million,
        price_cache_write_per_million,
        price_cache_read_per_million
      FROM cursor_model_events
      WHERE discovered_at >= $1
      ORDER BY discovered_at DESC
    `,
    [periodStart.toISOString()],
  );

  const rows = found.rows;
  const title = `Дайджест по моделям Cursor ${periodEnd.toISOString().slice(0, 10)}`;
  const total = rows.length;

  const reportDate = periodEnd.toISOString().slice(0, 10);
  const summaryIntro =
    total > 0
      ? `За последние 24 часа найдено ${total} новых упоминаний о моделях и изменениях цен в Cursor и связанных источниках.`
      : 'За последние 24 часа новых релизов не найдено.';

  const modelGroups = [];
  for (const row of rows) {
    const priceParts = [];
    if (row.price_input_per_million) {
      priceParts.push(`вход: ${row.price_input_per_million}`);
    }
    if (row.price_output_per_million) {
      priceParts.push(`выход: ${row.price_output_per_million}`);
    }
    if (row.price_cache_write_per_million) {
      priceParts.push(`cache write: ${row.price_cache_write_per_million}`);
    }
    if (row.price_cache_read_per_million) {
      priceParts.push(`cache read: ${row.price_cache_read_per_million}`);
    }
    const priceLine = priceParts.length ? ` (${priceParts.join(', ')})` : '';
    const releaseDateLine = `Дата: ${formatDisplayDate(row.release_date_hint || row.source_published_at)}`;
    const availabilityLine = `Доступность в Cursor: ${row.availability_in_cursor || inferAvailabilityFromSource(row.source_type, row.source_url, row.summary)}`;
    const reasonLine = `Почему: ${row.reason_for_newness || inferReasonForNewness(`${row.title} ${row.summary}`)}`;
    const previewLine =
      row.is_preview && row.preview_until
        ? ` [PREVIEW до ${row.preview_until}]`
        : row.is_preview
          ? ' [PREVIEW]'
          : '';
    const modelName = row.model_name || 'Модель';
    const providerLine = row.model_provider ? ` (${row.model_provider})` : '';
    modelGroups.push(
      `- ${modelName}${providerLine}${previewLine}: ${row.title}${priceLine}\n  ${releaseDateLine}\n  ${availabilityLine}\n  ${reasonLine}`,
    );
  }

  const summary = `${summaryIntro}\n\n${modelGroups.join('\n')}`.trim();
  const report = await upsertDailyReport(
    pool,
    reportDate,
    periodStart,
    periodEnd,
    title,
    summary,
    total,
    rows.map((row) => ({
      model_name: row.model_name,
      model_provider: row.model_provider,
      title: row.title,
      summary: row.summary,
      reason_for_newness: row.reason_for_newness,
      release_date_hint: row.release_date_hint,
      availability_in_cursor: row.availability_in_cursor,
      source_url: row.source_url,
      source_type: row.source_type,
      is_preview: row.is_preview,
      preview_until: row.preview_until,
      price_input_per_million: row.price_input_per_million,
      price_output_per_million: row.price_output_per_million,
        price_cache_write_per_million: row.price_cache_write_per_million,
        price_cache_read_per_million: row.price_cache_read_per_million,
      source_published_at: row.source_published_at,
      event_position: 0,
    })),
  );

  await sendTelegramMessage(
    pool,
    buildTelegramPayload({ ...report, period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() }),
  );
  return report;
}

async function cleanOldData(pool) {
  const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const border = new Date(Date.now() - maxAgeMs);
  await pool.query('DELETE FROM cursor_model_events WHERE discovered_at < $1', [border.toISOString()]);
  await pool.query('DELETE FROM cursor_model_reports WHERE created_at < $1', [border.toISOString()]);
}

async function startBackgroundMonitor(pool) {
  if (hasStarted) {
    return;
  }
  hasStarted = true;
  await ensureSchema(pool);

  const runCollection = async () => {
    try {
      const result = await collectAndStoreEvents(pool);
      if (result.total > 0) {
        console.log(`Cursor models: collected ${result.total} events, inserted ${result.inserted}`);
      }
      await cleanOldData(pool);
    } catch (error) {
      console.error('Cursor model collection error:', error);
    }
  };

  const runReport = async () => {
    try {
      await generateDailyReport(pool);
    } catch (error) {
      console.error('Cursor model report error:', error);
    }
  };

  await runCollection();
  collectionTimer = setInterval(runCollection, COLLECTION_INTERVAL_MS);
  collectionTimer.unref && collectionTimer.unref();

  const scheduleFirstReport = () => {
    const now = new Date();
    const scheduled = new Date(now);
    scheduled.setHours(REPORT_HOUR_UTC, 0, 0, 0);
    if (scheduled.getTime() <= now.getTime()) {
      scheduled.setDate(scheduled.getDate() + 1);
    }
    const delay = scheduled.getTime() - now.getTime();
    setTimeout(async () => {
      await runReport();
      reportTimer = setInterval(runReport, REPORT_INTERVAL_MS);
      reportTimer.unref && reportTimer.unref();
    }, delay);
  };

  scheduleFirstReport();
}

async function listReports(pool, limit = 20) {
  const rowsResult = await pool.query(
    `SELECT
       id, report_date, title, summary, total_events, period_start, period_end, created_at
     FROM cursor_model_reports
     ORDER BY report_date DESC
     LIMIT $1`,
    [limit],
  );
  return rowsResult.rows;
}

async function getReportById(pool, reportId) {
  const reportRows = await pool.query(
    'SELECT id, report_date, title, summary, total_events, period_start, period_end, created_at FROM cursor_model_reports WHERE id = $1',
    [reportId],
  );
  if (!reportRows.rows[0]) {
    return null;
  }
  const itemRows = await pool.query(
    `
    SELECT
      id, model_name, model_provider, title, summary,
      reason_for_newness, release_date_hint, availability_in_cursor,
      source_url, source_type,
      is_preview, preview_until,
      price_input_per_million, price_output_per_million,
      price_cache_write_per_million, price_cache_read_per_million,
      source_published_at, event_position
    FROM cursor_model_report_items
    WHERE report_id = $1
    ORDER BY event_position ASC
    `,
    [reportId],
  );
  return {
    ...reportRows.rows[0],
    items: itemRows.rows,
  };
}

async function deleteReportById(pool, reportId) {
  const result = await pool.query('DELETE FROM cursor_model_reports WHERE id = $1', [reportId]);
  return result.rowCount || 0;
}

module.exports = {
  startBackgroundMonitor,
  collectAndStoreEvents,
  generateDailyReport,
  listReports,
  getReportById,
  deleteReportById,
};
