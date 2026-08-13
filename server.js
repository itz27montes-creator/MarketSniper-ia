// server.js
// Backend de MarketSniper IA — hace de "puente" seguro entre tu página web y Gemini.
// La key SOLO vive aquí, leída desde una variable de entorno (nunca escrita en el código,
// nunca enviada al navegador del usuario).
//
// Flujo de cada mensaje:
//  1) Se le pide a Gemini que investigue el artículo usando búsqueda real de Google
//     (grounding), para obtener precios y fuentes verificadas de internet.
//  2) Se le pide a Gemini (en una segunda llamada) que convierta ese análisis en un
//     JSON estructurado, siguiendo un esquema fijo, para poder dibujar la tarjeta visual.
//  3) Los links de fuentes se toman directamente de los metadatos reales que devuelve
//     Google (groundingMetadata), nunca inventados por el modelo.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// gemini-2.5-flash se retira en octubre 2026; usamos uno vigente por defecto.
// Debe ser un modelo que soporte la herramienta de búsqueda (google_search).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  console.error('[MarketSniper] Falta GEMINI_API_KEY en el entorno (.env). El chatbot no funcionará hasta configurarla.');
}

app.use(express.json({ limit: '10mb' })); // 10mb para permitir imágenes en base64
app.use(express.static(path.join(__dirname, 'public')));

// --- Paso 1: instrucción para la investigación con búsqueda real ---
const GROUNDED_SYSTEM_PROMPT = `Eres MarketSniper IA, un investigador de precios de artículos de segunda mano.
Cuando el usuario describe o adjunta una foto de un artículo, tu trabajo es:
- Identificar el artículo (marca y modelo si es posible).
- Buscar en internet su valor de mercado actual, tanto nuevo como de segunda mano.
- Si encuentras precios concretos en tiendas o marketplaces reales, indícalos con el
  nombre de la tienda y el precio exacto que encontraste.
- Da un rango de precio estimado (mínimo y máximo) basado en lo que encontraste.
- Si encuentras el precio histórico más bajo y más alto al que se ha vendido este
  artículo (por ejemplo en sitios de seguimiento de precios), inclúyelos también.
- Si detectas que el precio que pide el usuario está por debajo del valor de mercado,
  indícalo como posible oportunidad de compra.
Si el mensaje del usuario es solo un saludo o una pregunta general sin un artículo que
valorar, responde de forma breve y conversacional, sin necesidad de buscar nada.
No inventes cifras ni tiendas: basa todo en información real. Responde siempre en español.`;

// --- Paso 2: instrucción para convertir el análisis en JSON estructurado ---
const STRUCTURE_SYSTEM_PROMPT = `Convierte el siguiente análisis en un objeto JSON que cumpla
exactamente el esquema proporcionado.
Usa "type": "valuation" cuando el análisis contiene una valoración de un artículo con precio.
Usa "type": "message" cuando es solo una respuesta conversacional, sin artículo que valorar
(en ese caso, pon la respuesta completa en el campo "text" y deja los demás campos vacíos).
No inventes datos que no estén en el análisis. No incluyas URLs ni fuentes, eso se agrega aparte.`;

const CARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['valuation', 'message'] },
    text: { type: 'STRING' },
    itemTitle: { type: 'STRING' },
    category: { type: 'STRING' },
    valuationMin: { type: 'NUMBER' },
    valuationMax: { type: 'NUMBER' },
    minHistoric: { type: 'NUMBER' },
    maxHistoric: { type: 'NUMBER' },
    currency: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['baja', 'media', 'alta'] },
    retailers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          price: { type: 'STRING' },
        },
      },
    },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    notes: { type: 'STRING' },
  },
  required: ['type'],
};

// Convierte el historial simple del frontend ({role, text}) al formato de Gemini.
function buildContents(history, message, image) {
  const contents = (history || []).map((turn) => ({
    role: turn.role === 'model' ? 'model' : 'user',
    parts: [{ text: turn.text }],
  }));

  const parts = [{ text: message }];
  if (image && image.base64 && image.mimeType) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.base64,
      },
    });
  }

  contents.push({ role: 'user', parts });
  return contents;
}

async function callGemini(body) {
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || 'Error al conectar con Gemini.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

app.post('/api/analyze', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'El servidor no tiene configurada la API key de Gemini.' });
    }

    const { message, image, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Falta el mensaje a analizar.' });
    }

    // --- Paso 1: investigación con búsqueda real de Google ---
    const groundedData = await callGemini({
      systemInstruction: { parts: [{ text: GROUNDED_SYSTEM_PROMPT }] },
      contents: buildContents(history, message, image),
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 900 },
    });

    const candidate = groundedData?.candidates?.[0];
    const rawText = candidate?.content?.parts?.map((p) => p.text || '').join('\n').trim();

    if (!rawText) {
      const finishReason = candidate?.finishReason;
      return res.status(502).json({ error: `Gemini no devolvió una respuesta utilizable (${finishReason || 'desconocido'}).` });
    }

    // Fuentes REALES devueltas por Google (no inventadas por el modelo).
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const seen = new Set();
    const sources = [];
    for (const chunk of chunks) {
      const uri = chunk?.web?.uri;
      const title = chunk?.web?.title;
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        sources.push({ title: title || uri, url: uri });
      }
      if (sources.length >= 4) break;
    }

    // --- Paso 2: convertir el análisis en JSON estructurado para la tarjeta ---
    let card;
    try {
      const structureData = await callGemini({
        systemInstruction: { parts: [{ text: STRUCTURE_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: rawText }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: CARD_SCHEMA,
        },
      });
      const structureText = structureData?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
      card = JSON.parse(structureText);
    } catch (structureError) {
      console.error('[MarketSniper] No se pudo estructurar la respuesta, usando texto plano:', structureError.message);
      card = { type: 'message', text: rawText };
    }

    if (card.type === 'valuation') {
      card.sources = sources;
    }

    res.json({ reply: JSON.stringify(card) });
  } catch (error) {
    console.error('[MarketSniper] Error interno:', error);
    res.status(error.status || 500).json({ error: error.message || 'Error interno del servidor.' });
  }
});

app.listen(PORT, () => {
  console.log(`MarketSniper IA escuchando en http://localhost:${PORT}`);
});
