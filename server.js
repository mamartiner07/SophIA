require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
const CFG = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    MODEL_ID: process.env.MODEL_ID || "gemini-1.5-flash",
    BMC_REST_URL: process.env.BMC_REST_URL,
    BMC_USERNAME: process.env.BMC_USERNAME,
    BMC_PASSWORD: process.env.BMC_PASSWORD,
    UM_RESET_URL: process.env.UM_RESET_URL,
    UM_BEARER_TOKEN: process.env.UM_BEARER_TOKEN,
    GCLOUD_TTS_API_KEY: process.env.GCLOUD_TTS_API_KEY
};

// In-memory history (Simple for demo, use Redis/Firestore for production)
const messageHistory = new Map();
const MAX_TURNS = 12;

// --- HELPERS ---
function loadHistory(chatId) {
    return messageHistory.get(chatId) || [];
}

function saveHistory(chatId, history) {
    if (history.length > MAX_TURNS) {
        history = history.slice(history.length - MAX_TURNS);
    }
    messageHistory.set(chatId, history);
}

function appendToHistory(chatId, role, text) {
    const history = loadHistory(chatId);
    history.push({ role, parts: [{ text }] });
    saveHistory(chatId, history);
}

// --- PROMPT MODULES ---
function getCorePrompt(displayName) {
    return `Eres SOPHIA, un asistente virtual corporativo experto en ITSM. Siempre habla en femenino (ej. "quedo atenta", "estoy lista").
           TU OBJETIVO: Recibir datos y presentarlos de forma ejecutiva, limpia y amigable. Siempre con actitud de servicio.
           
           REGLA DE TRATO:
           - Dirígete siempre al usuario por su nombre como **${displayName}** (usa solo el primer nombre, normalizado: Primera letra Mayúscula, resto minúsculas).
           - Sin emojis. Tono profesional y amable.
           - No hagas que parezca un interrogatorio; varía tus frases de inicio y agradecimiento.
           
           SUPER IMPORTANTE: Si el usuario habla en inglés, responde en inglés.
           
           REGLAS DE FORMATO:
           - Usa Markdown para negritas (**texto**).
           - NUNCA muestres estructura JSON.
           
           SEGURIDAD Y FUERA DE ALCANCE:
           - Contacto Soportec: Tel 4425006484 o WhatsApp 5550988688.
           - Requerimientos: https://epl-dwp.onbmc.com/
           
           REGLA DE EJECUCIÓN: No digas "permíteme" antes de una función.`;
}

function getTicketPrompt() {
    return `REGLAS DE TICKETS:
           - INC + 12 dígitos. Ej: INC000000006816.
           - Traduce 'Assigned' a 'Asignado'.
           - Rinde IDs limpios (ej. INC7910).
           - Formato: Resumen, Ticket, Estado, Asignado a, Fecha (ej. 3 de enero de 2025), Detalles.`;
}

function getResetPrompt(displayName) {
    return `REGLAS DE RESETEO DE CONTRASEÑA:
           - REGLA DE ORO 1: NUNCA pidas el nombre del usuario (${displayName}).
           - REGLA DE ORO 2: Pide los datos UNO POR UNO.
           - ASESORÍA: Reinicio (olvido) vs Desbloqueo (bloqueada).
           - mail: Solo @liverpool.com.mx o @suburbia.com.mx.
           - REGLA DE ORO 3: Antes del último dato, avisa que tomará un minuto.`;
}

function getContextSophia(displayName, intent = null) {
    let prompt = getCorePrompt(displayName);
    if (intent === 'consulta') prompt += "\n" + getTicketPrompt();
    else if (intent === 'reset') prompt += "\n" + getResetPrompt(displayName);
    else prompt += "\nCapacidades: Consultas de tickets (INC) y reseteos.";
    return { parts: [{ text: prompt }] };
}

// --- API ACTIONS ---
async function loginBMC() {
    const resp = await axios.post(`${CFG.BMC_REST_URL}/api/jwt/login`,
        `username=${CFG.BMC_USERNAME}&password=${CFG.BMC_PASSWORD}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return resp.data;
}

async function getIncidentData(incidentNumber) {
    const jwt = await loginBMC();
    const headers = { Authorization: `AR-JWT ${jwt}`, Accept: 'application/json' };
    let qualification = `'Incident Number'="${incidentNumber}"`;
    let url = `${CFG.BMC_REST_URL}/api/arsys/v1/entry/HPD:Help Desk?q=${encodeURIComponent(qualification)}`;

    try {
        let resp = await axios.get(url, { headers });
        let list = resp.data;
        if (!list.entries.length) {
            url = `${CFG.BMC_REST_URL}/api/arsys/v1/entry/HPD:IncidentInterface?q=${encodeURIComponent(qualification)}`;
            resp = await axios.get(url, { headers });
            list = resp.data;
        }
        return list.entries[0]?.values || { Error: "No encontrado" };
    } catch (e) {
        return { Error: e.message };
    }
}

// --- ROUTES ---

app.post('/api/chat', async (req, res) => {
    const { message, chatId, displayName } = req.body;
    if (!message || !chatId) return res.status(400).json({ error: "Missing data" });

    const history = loadHistory(chatId);

    try {
        // Basic intent detection (simple version for server)
        const lower = message.toLowerCase();
        let intent = null;
        if (/inc|ticket|estatus|seguimiento/.test(lower)) intent = 'consulta';
        if (/reset|contrase|bloque/.test(lower)) intent = 'reset';

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;

        // Tools definition
        const tools = [{
            function_declarations: [
                {
                    name: "consultar_estatus_ticket",
                    description: "Consulta el estado de un ticket.",
                    parameters: { type: "OBJECT", properties: { ticket_id: { type: "STRING" } }, required: ["ticket_id"] }
                }
            ]
        }];

        const contents = history.concat([{ role: "user", parts: [{ text: message }] }]);
        const payload = {
            system_instruction: getContextSophia(displayName || "Usuario", intent),
            contents,
            tools,
            safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }] // Add others as needed
        };

        const geminiResp = await axios.post(url, payload);
        const candidate = geminiResp.data.candidates[0];
        const part = candidate.content.parts[0];

        // Handle tool calls
        if (part.functionCall) {
            const { name, args } = part.functionCall;
            if (name === "consultar_estatus_ticket") {
                const data = await getIncidentData(args.ticket_id);
                const finalResponse = `Detalles del ticket: ${JSON.stringify(data)}`; // Simple version, should use a second Gemini call for natural language
                appendToHistory(chatId, "user", message);
                appendToHistory(chatId, "model", finalResponse);
                return res.json({ tipo: "texto", respuesta: finalResponse });
            }
        }

        const text = part.text || "Entendido.";
        appendToHistory(chatId, "user", message);
        appendToHistory(chatId, "model", text);
        res.json({ tipo: "texto", respuesta: text });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/tts', async (req, res) => {
    const { text, lang } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    const apiKey = CFG.GCLOUD_TTS_API_KEY || CFG.GEMINI_API_KEY;
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

    const payload = {
        input: { text },
        voice: { languageCode: lang || 'es-MX', ssmlGender: "FEMALE" },
        audioConfig: { audioEncoding: "MP3" }
    };

    try {
        console.log(`[TTS] Synthesizing: "${text.substring(0, 50)}..." Lang: ${lang}`);
        const resp = await axios.post(url, payload);
        console.log(`[TTS] Success. Audio length: ${resp.data.audioContent.length}`);
        res.json({ audio: resp.data.audioContent, type: 'audio/mp3' });
    } catch (e) {
        const errorData = e.response ? e.response.data : e.message;
        console.error("[TTS] Error detail:", JSON.stringify(errorData));
        res.status(500).json({ error: e.message, details: errorData });
    }
});

app.post('/api/clear', (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ error: "Missing chatId" });
    messageHistory.delete(chatId);
    res.json({ success: true, message: `History for ${chatId} cleared.` });
});

app.get('/api/config', (req, res) => {
    res.json({
        gcloudTtsKey: CFG.GCLOUD_TTS_API_KEY
    });
});

app.listen(PORT, () => {
    console.log(`SophIA Server running on port ${PORT}`);
});
