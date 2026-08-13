// server.js
// Backend de MarketSniper IA — hace de "puente" seguro entre tu página web y Gemini.
// La key SOLO vive aquí, leída desde una variable de entorno (nunca escrita en el código,
// nunca enviada al navegador del usuario).

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// gemini-2.5-flash se retira en octubre 2026; usamos uno vigente por defecto.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  console.error('[MarketSniper] Falta GEMINI_API_KEY en el entorno (.env). El chatbot no funcionará hasta configurarla.');
}

app.use(express.json({ limit: '10mb' })); // 10mb para permitir imágenes en base64
app.use(express.static(path.join(__dirname, 'public')));

// Instrucción de sistema: define el "personaje" y el trabajo del bot.
const SYSTEM_INSTRUCTION = `Eres MarketSniper IA, un asistente experto en tasación de artículos de segunda mano
y en detectar oportunidades de compra (chollos). Cuando el usuario describe o adjunta una foto de un artículo:
- Estima un rango de valor de mercado realista (moneda según el contexto del usuario).
- Señala qué datos faltan para afinar la valoración (marca, modelo, estado, accesorios, etc.).
- Si detectas que el precio pedido es bajo respecto al valor de mercado, indícalo como posible oportunidad.
- Sé claro, breve y directo. Usa párrafos cortos, sin relleno innecesario.
- Responde siempre en español.`;

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

app.post('/api/analyze', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'El servidor no tiene configurada la API key de Gemini.' });
    }

    const { message, image, history } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Falta el mensaje a analizar.' });
    }

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: buildContents(history, message, image),
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 1024,
      },
    };

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
      const errMessage = data?.error?.message || 'Error al conectar con Gemini.';
      console.error('[MarketSniper] Error de Gemini:', errMessage);
      return res.status(response.status).json({ error: errMessage });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n').trim();

    if (!reply) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      return res.status(502).json({ error: `Gemini no devolvió una respuesta utilizable (${finishReason || 'desconocido'}).` });
    }

    res.json({ reply });
  } catch (error) {
    console.error('[MarketSniper] Error interno:', error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

app.listen(PORT, () => {
  console.log(`MarketSniper IA escuchando en http://localhost:${PORT}`);
});
