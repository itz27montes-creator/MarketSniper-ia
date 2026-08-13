// server.js
// Backend de MarketSniper IA — hace de "puente" seguro entre tu página web y los modelos.
// Las keys SOLO viven aquí, leídas desde variables de entorno (nunca en el código,
// nunca enviadas al navegador del usuario).
//
// Flujo de cada mensaje:
//  1) Se le manda el mensaje a Qwen 3.6 27B (en Groq), con una herramienta "buscar_precios"
//     disponible. El modelo decide si necesita buscar en internet.
//  2) Si decide buscar, nuestro servidor ejecuta esa búsqueda REAL en Tavily y le devuelve
//     los resultados al modelo, para que arme una respuesta basada en datos reales.
//  3) Se le pide al modelo (en una segunda llamada) que convierta esa respuesta en un
//     JSON estructurado, siguiendo un esquema fijo, para poder dibujar la tarjeta visual.
//  4) Los links de "Fuentes consultadas" son los que Tavily devolvió de verdad, nunca
//     inventados por el modelo.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.6-27b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TAVILY_URL = 'https://api.tavily.com/search';

if (!GROQ_API_KEY) {
  console.error('[MarketSniper] Falta GROQ_API_KEY en el entorno (.env). El chatbot no funcionará hasta configurarla.');
}
if (!TAVILY_API_KEY) {
  console.error('[MarketSniper] Falta TAVILY_API_KEY en el entorno (.env). La búsqueda real no funcionará hasta configurarla.');
}

app.use(express.json({ limit: '10mb' })); // 10mb para permitir imágenes en base64
app.use(express.static(path.join(__dirname, 'public')));

// --- Instrucción para la investigación con búsqueda real ---
const GROUNDED_SYSTEM_PROMPT = `Eres MarketSniper IA, un investigador de precios de artículos de segunda mano.
Cuando el usuario describe o adjunta una foto de un artículo:
- Identifica el artículo (marca y modelo si es posible).
- Usa la herramienta buscar_precios para investigar su valor de mercado actual, tanto
  nuevo como de segunda mano. Puedes llamarla más de una vez si necesitas afinar la búsqueda
  (por ejemplo, primero para identificar el modelo exacto, luego para buscar precios).
- Si encuentras precios concretos en tiendas o marketplaces reales, indícalos con el
  nombre de la tienda y el precio exacto que encontraste.
- Da un rango de precio estimado (mínimo y máximo) basado en lo que encontraste.
- Si encuentras el precio histórico más bajo y más alto al que se ha vendido este
  artículo, inclúyelos también.
- Si detectas que el precio que pide el usuario está por debajo del valor de mercado,
  indícalo como posible oportunidad de compra.
Si el mensaje del usuario es solo un saludo o una pregunta general sin un artículo que
valorar, responde de forma breve y conversacional, sin usar la herramienta de búsqueda.
No inventes cifras ni tiendas: basa todo en los resultados reales de búsqueda. Responde
siempre en español.`;

// --- Instrucción para convertir el análisis en JSON estructurado ---
const STRUCTURE_SYSTEM_PROMPT = `Convierte el siguiente análisis en un objeto JSON válido con
exactamente estos campos (usa null o arreglo vacío si un dato no aplica):
{
  "type": "valuation" o "message",
  "text": string (solo si type es "message", la respuesta conversacional completa),
  "itemTitle": string,
  "category": string,
  "valuationMin": number,
  "valuationMax": number,
  "minHistoric": number o null,
  "maxHistoric": number o null,
  "currency": string,
  "confidence": "baja" | "media" | "alta",
  "retailers": [{ "name": string, "price": string }],
  "tags": [string],
  "notes": string
}
Usa "type": "valuation" cuando el análisis contiene una valoración de un artículo con precio.
Usa "type": "message" cuando es solo una respuesta conversacional, sin artículo que valorar.
No inventes datos que no estén en el análisis. No incluyas URLs, eso se agrega aparte.
Responde ÚNICAMENTE con el objeto JSON, sin texto adicional ni bloques de código.`;

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'buscar_precios',
    description: 'Busca en internet información real y precios actuales sobre un artículo o producto específico.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta de búsqueda concreta, por ejemplo: "PUMA Caven Triple Black precio segunda mano".',
        },
      },
      required: ['query'],
    },
  },
};

// Convierte el historial simple del frontend ({role, text}) al formato de mensajes de Groq (estilo OpenAI).
function buildMessages(history, message, image) {
  const messages = [{ role: 'system', content: GROUNDED_SYSTEM_PROMPT }];

  (history || []).forEach((turn) => {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: turn.text,
    });
  });

  if (image && image.base64 && image.mimeType) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: message });
  }

  return messages;
}

async function callGroq(body) {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: GROQ_MODEL, ...body }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || 'Error al conectar con Groq.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

// Ejecuta una búsqueda REAL en Tavily y devuelve resultados + fuentes.
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) {
    return { summaryForModel: 'Búsqueda no disponible: falta configurar TAVILY_API_KEY.', sources: [] };
  }
  const response = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({ query, max_results: 5, search_depth: 'basic' }),
  });
  const data = await response.json();
  if (!response.ok) {
    return { summaryForModel: `Búsqueda falló: ${data?.error || 'error desconocido'}.`, sources: [] };
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const sources = results
    .filter((r) => r && r.url)
    .map((r) => ({ title: r.title || r.url, url: r.url }));
  const summaryForModel = results
    .map((r) => `- ${r.title || r.url} (${r.url}): ${(r.content || '').slice(0, 400)}`)
    .join('\n') || 'Sin resultados relevantes.';
  return { summaryForModel, sources };
}

app.post('/api/analyze', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'El servidor no tiene configurada la API key de Groq.' });
    }

    const { message, image, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Falta el mensaje a analizar.' });
    }

    // --- Bucle de investigación: el modelo decide si necesita buscar ---
    let messages = buildMessages(history, message, image);
    const collectedSources = [];
    let finalText = null;
    const MAX_TOOL_ROUNDS = 3;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const data = await callGroq({
        messages,
        tools: [SEARCH_TOOL],
        tool_choice: 'auto',
        temperature: 0.4,
        max_tokens: 900,
      });
      const choice = data?.choices?.[0];
      const assistantMessage = choice?.message;

      if (assistantMessage?.tool_calls?.length) {
        messages.push(assistantMessage);
        for (const call of assistantMessage.tool_calls) {
          let query = '';
          try {
            query = JSON.parse(call.function.arguments || '{}').query || '';
          } catch (e) {
            query = '';
          }
          const { summaryForModel, sources } = await tavilySearch(query || message);
          collectedSources.push(...sources);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: summaryForModel,
          });
        }
        continue; // vuelve a preguntarle al modelo con los resultados ya incluidos
      }

      finalText = assistantMessage?.content?.trim();
      break;
    }

    if (!finalText) {
      // Se acabaron los intentos con herramientas; forzamos una respuesta final sin ellas.
      const data = await callGroq({ messages, temperature: 0.4, max_tokens: 900 });
      finalText = data?.choices?.[0]?.message?.content?.trim();
    }

    if (!finalText) {
      return res.status(502).json({ error: 'El modelo no devolvió una respuesta utilizable.' });
    }

    // Fuentes REALES devueltas por Tavily (deduplicadas).
    const seen = new Set();
    const sources = [];
    for (const s of collectedSources) {
      if (s.url && !seen.has(s.url)) {
        seen.add(s.url);
        sources.push(s);
      }
      if (sources.length >= 4) break;
    }

    // --- Convertir el análisis en JSON estructurado para la tarjeta ---
    let card;
    try {
      const structureData = await callGroq({
        messages: [
          { role: 'system', content: STRUCTURE_SYSTEM_PROMPT },
          { role: 'user', content: finalText },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
        max_tokens: 700,
      });
      const structureText = structureData?.choices?.[0]?.message?.content?.trim();
      card = JSON.parse(structureText);
    } catch (structureError) {
      console.error('[MarketSniper] No se pudo estructurar la respuesta, usando texto plano:', structureError.message);
      card = { type: 'message', text: finalText };
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
