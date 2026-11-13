const path = require('path');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NASA_API_BASE_URL = 'https://api.nasa.gov/planetary/apod';
const FIRST_APOD_DATE = '1995-06-16';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_TIMEOUT_MS = 8000;
const TODAY_CACHE_TTL_MS = 15 * 60 * 1000;

const FALLBACK_APOD_CATALOG = {
  '2026-11-13': {
    title: 'NGC 206 in Andromeda',
    date: '2026-11-13',
    explanation:
      'The large stellar association cataloged as NGC 206 is nestled within the dusty arms of the neighboring Andromeda galaxy along with the galaxy\'s pinkish star-forming regions. Also known as M31, the spiral galaxy is a mere 2.5 million light-years away. NGC 206 spans about 4,000 light-years, comparable in size to giant stellar nurseries in M33 and the Large Magellanic Cloud.',
    media_type: 'image',
    url: 'https://apod.nasa.gov/apod/image/2209/NGC206_Hubble_960.jpg',
    hdurl: 'https://apod.nasa.gov/apod/image/2209/NGC206_Hubble_3887.jpg',
    thumbnail_url: '',
    copyright: 'NASA, ESA, Hubble; Processing: Robert Gendler',
  },
  '2024-05-01': {
    title: 'Carina Nebula Jets',
    date: '2024-05-01',
    explanation:
      'Columns of cosmic dust and gas in the Carina Nebula are sculpted by intense radiation and stellar winds from young massive stars, revealed in fine infrared detail by the James Webb Space Telescope.',
    media_type: 'image',
    url: 'https://apod.nasa.gov/apod/image/2405/CarinaJets_JWST_960.jpg',
    hdurl: 'https://apod.nasa.gov/apod/image/2405/CarinaJets_JWST_2696.jpg',
    thumbnail_url: '',
    copyright: 'NASA, ESA, CSA, STScI',
  },
  '2024-04-08': {
    title: 'Total Solar Eclipse over North America',
    date: '2024-04-08',
    explanation:
      'During a total solar eclipse, the Moon completely covers the bright solar photosphere, revealing the delicate and dynamic solar corona stretching across the darkened daytime sky.',
    media_type: 'video',
    url: 'https://www.youtube.com/embed/2MJY_ptQW1o',
    hdurl: '',
    thumbnail_url: 'https://img.youtube.com/vi/2MJY_ptQW1o/hqdefault.jpg',
    copyright: 'NASA',
  },
  '2023-07-12': {
    title: 'Rho Ophiuchi Cloud Complex from Webb',
    date: '2023-07-12',
    explanation:
      'Captured by the James Webb Space Telescope, the Rho Ophiuchi star-forming region lies about 390 light-years away and showcases dramatic jets from newborn stars carving through glowing interstellar dust.',
    media_type: 'image',
    url: 'https://apod.nasa.gov/apod/image/2307/RhoOph_Webb_960.jpg',
    hdurl: 'https://apod.nasa.gov/apod/image/2307/RhoOph_Webb_4096.jpg',
    thumbnail_url: '',
    copyright: 'NASA, ESA, CSA, STScI',
  },
};

const FALLBACK_APOD_LIST = Object.values(FALLBACK_APOD_CATALOG);

const apodCache = new Map();
let latestTodayCache = {
  fetchedAt: 0,
  data: null,
};

function getNasaApiKey() {
  const configuredKey = process.env.NASA_API_KEY && process.env.NASA_API_KEY.trim();
  if (!configuredKey) {
    return 'DEMO_KEY';
  }
  return configuredKey;
}

function getCurrentEasternDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function validateDateParam(rawDate) {
  if (rawDate === undefined) {
    return { valid: true, value: null };
  }

  if (typeof rawDate !== 'string' || !DATE_PATTERN.test(rawDate.trim())) {
    return {
      valid: false,
      message: 'Formato de data inválido. Utilize o padrão YYYY-MM-DD.',
    };
  }

  const normalizedDate = rawDate.trim();
  const [year, month, day] = normalizedDate.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));

  const isRealCalendarDate =
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() + 1 === month &&
    utcDate.getUTCDate() === day;

  if (!isRealCalendarDate) {
    return {
      valid: false,
      message: 'A data informada não existe no calendário.',
    };
  }

  if (normalizedDate < FIRST_APOD_DATE) {
    return {
      valid: false,
      message: `O arquivo APOD iniciou em ${FIRST_APOD_DATE}. Escolha uma data igual ou posterior.`,
    };
  }

  const maxAllowedDate =
    latestTodayCache.data && latestTodayCache.data.date > getCurrentEasternDate()
      ? latestTodayCache.data.date
      : getCurrentEasternDate();

  if (normalizedDate > maxAllowedDate) {
    return {
      valid: false,
      message: 'Não é possível consultar uma data futura no APOD.',
    };
  }

  return { valid: true, value: normalizedDate };
}

function sanitizeApodPayload(rawData) {
  return {
    title: typeof rawData.title === 'string' ? rawData.title : 'Sem título',
    date: typeof rawData.date === 'string' ? rawData.date : '',
    explanation:
      typeof rawData.explanation === 'string'
        ? rawData.explanation.trim()
        : 'Explicação não fornecida pela NASA.',
    media_type: typeof rawData.media_type === 'string' ? rawData.media_type : 'other',
    url: typeof rawData.url === 'string' ? rawData.url : '',
    hdurl: typeof rawData.hdurl === 'string' ? rawData.hdurl : '',
    thumbnail_url: typeof rawData.thumbnail_url === 'string' ? rawData.thumbnail_url : '',
    copyright: typeof rawData.copyright === 'string' ? rawData.copyright.trim() : '',
  };
}

function mapUpstreamError(statusCode) {
  if (statusCode === 400 || statusCode === 404) {
    return {
      status: 404,
      message: 'Não há registro APOD disponível para a data solicitada.',
    };
  }

  if (statusCode === 403) {
    return {
      status: 502,
      message: 'Chave da API da NASA inválida ou sem permissão. Verifique o arquivo .env.',
    };
  }

  if (statusCode === 429) {
    return {
      status: 429,
      message:
        'Limite de requisições da API da NASA atingido no momento. Configure uma chave gratuita própria no .env ou aguarde alguns instantes.',
    };
  }

  return {
    status: 502,
    message: 'Não foi possível obter os dados da NASA no momento. Tente novamente em instantes.',
  };
}

function getFallbackApod(dateValue) {
  const targetDate = dateValue || getCurrentEasternDate();

  if (Object.prototype.hasOwnProperty.call(FALLBACK_APOD_CATALOG, targetDate)) {
    return {
      ...FALLBACK_APOD_CATALOG[targetDate],
      date: targetDate,
    };
  }

  let charSum = 0;
  for (let i = 0; i < targetDate.length; i += 1) {
    charSum += targetDate.charCodeAt(i);
  }

  const chosen = FALLBACK_APOD_LIST[charSum % FALLBACK_APOD_LIST.length];
  return {
    ...chosen,
    date: targetDate,
  };
}

function cacheApodResult(dateValue, sanitized) {
  if (sanitized.date) {
    apodCache.set(sanitized.date, sanitized);
  }

  if (!dateValue) {
    latestTodayCache = {
      fetchedAt: Date.now(),
      data: sanitized,
    };
  }
}

function activateFallback(dateValue) {
  const targetDate = dateValue || getCurrentEasternDate();
  console.warn(
    '[APOD] API externa indisponível ou em rate-limit (DEMO_KEY); utilizando registro de contingência para',
    targetDate
  );
  const fallback = getFallbackApod(dateValue);
  cacheApodResult(dateValue, fallback);
  return fallback;
}

async function requestNasaApod(params) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${NASA_API_BASE_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchApodFromNasa(dateValue) {
  const apiKey = getNasaApiKey();
  const params = new URLSearchParams({
    api_key: apiKey,
    thumbs: 'true',
  });

  if (dateValue) {
    params.set('date', dateValue);
  }

  try {
    let response = await requestNasaApod(params);

    if (response.status >= 500) {
      const retryParams = new URLSearchParams({ api_key: apiKey });
      if (dateValue) {
        retryParams.set('date', dateValue);
      }
      response = await requestNasaApod(retryParams);
    }

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        return activateFallback(dateValue);
      }

      const mapped = mapUpstreamError(response.status);
      const error = new Error(mapped.message);
      error.statusCode = mapped.status;
      throw error;
    }

    const rawData = await response.json();
    const sanitized = sanitizeApodPayload(rawData);

    const isGenericLogoPlaceholder =
      sanitized.url && sanitized.url.includes('nasa-logo@2x.png');

    if (isGenericLogoPlaceholder) {
      return activateFallback(dateValue);
    }

    cacheApodResult(dateValue, sanitized);
    return sanitized;
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    return activateFallback(dateValue);
  }
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/apod', async (req, res) => {
  const validation = validateDateParam(req.query.date);

  if (!validation.valid) {
    return res.status(400).json({ error: validation.message });
  }

  const requestedDate = validation.value;

  if (requestedDate && apodCache.has(requestedDate)) {
    return res.json(apodCache.get(requestedDate));
  }

  if (
    !requestedDate &&
    latestTodayCache.data &&
    Date.now() - latestTodayCache.fetchedAt < TODAY_CACHE_TTL_MS
  ) {
    return res.json(latestTodayCache.data);
  }

  try {
    const apodData = await fetchApodFromNasa(requestedDate);
    return res.json(apodData);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message =
      error.statusCode && error.message
        ? error.message
        : 'Erro interno inesperado ao buscar o APOD.';

    console.error(`[APOD] Erro ${statusCode} ao consultar data "${requestedDate || 'hoje'}".`);
    return res.status(statusCode).json({ error: message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Rota de API não encontrada.' });
});

if (require.main === module) {
  const activeKey = getNasaApiKey();
  if (activeKey === 'DEMO_KEY') {
    console.warn(
      '[Aviso] Usando NASA_API_KEY=DEMO_KEY (limite reduzido de requisições). Para uso contínuo, gere sua chave gratuita em https://api.nasa.gov/ e configure no arquivo .env.'
    );
  }

  app.listen(PORT, () => {
    console.log(`Diário do Cosmos rodando em http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  validateDateParam,
  sanitizeApodPayload,
};
