require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const passport = require('passport');
const session = require('express-session');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const PORT = process.env.PORT || 8080;

// --- 1. CONFIGURACIÓN DE SESIÓN Y PASSPORT ---
// Esto permite que el servidor "recuerde" al usuario tras el login
app.use(session({ 
    secret: 'sophia_secret_key_2024', // Puedes cambiar esto por una cadena aleatoria
    resave: false, 
    saveUninitialized: false 
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Configuración de la Estrategia de Google
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  (accessToken, refreshToken, profile, done) => {
    // FILTRO DE SEGURIDAD: Solo correos corporativos autorizados
    const email = profile.emails[0].value.toLowerCase();
    if (email.endsWith('@liverpool.com.mx') || email.endsWith('@suburbia.com.mx')) {
        return done(null, profile);
    }
    return done(null, false, { message: 'Dominio no autorizado' });
  }
));

// --- 2. MIDDLEWARES DE PROTECCIÓN ---
function isAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/google');
}

app.use(cors());
app.use(express.json());

// --- 3. RUTAS DE AUTENTICACIÓN ---
app.get('/auth/google', passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account' 
}));

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/auth/google' }),
    (req, res) => {
        res.redirect('/'); // Al tener éxito, va a la raíz
    }
);

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('https://accounts.google.com/Logout'); 
    });
});

// --- 4. SERVIR FRONTEND PROTEGIDO ---
// Solo usuarios logueados pueden ver el index.html
app.get('/', isAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// El resto de la carpeta public (css, js, imagenes)
app.use(express.static(path.join(__dirname, 'public')));

// --- 5. CONFIGURATION DE SOPHIA ---
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
           SUPER IMPORTANTE: Si el usuario habla en inglés, responde en inglés (traduce etiquetas y campos).
           REGLAS DE FORMATO:
           - Usa Markdown para negritas (**texto**).
           - NUNCA muestres estructura JSON, llaves {} o comillas.
           SEGURIDAD Y FUERA DE ALCANCE:
           - Si te preguntan por Soportec o solicitan algo fuera de tu alcance técnico (como crear tickets o asesoría especializada), indica que pueden contactar al teléfono 4425006484 o al WhatsApp 5550988688.
           - Si piden levantar un requerimiento, canalízalos a: https://epl-dwp.onbmc.com/
           - Si el tema no tiene nada que ver con TI o ITSM, indica cortésmente que tus funciones se limitan al soporte técnico corporativo.
           REGLA DE EJECUCIÓN: No digas "permíteme" o "dame un momento" antes de una función. Llama a la herramienta inmediatamente.`;
}

function getTicketPrompt() {
    return `REGLAS DE TICKETS:
           - Los tickets son INC + 12 dígitos. Ej: INC000000006816.
           - Si dan terminación (ej. 1730), rellena ceros hasta 12 dígitos para la función.
           - Traduce 'Assigned' a 'Asignado'.
           - NUNCA respondas con el ticket completo; elimina los 0 de en medio y refiérete al ticket como INC7910 (ejemplo).
           - Si el usuario habla inglés, traduce todo incluyendo estados y campos.
           PLANTILLA DE RESPUESTA:
           "Claro, \${displayName}, estos son los detalles del ticket solicitado:
           **Resumen:** [Breve resumen de los datos del ticket con tus propias palabras]
           **Ticket:** [ID sin ceros de en medio]
           **Estado:** [Estatus traducido]
           **Asignado a:** [Grupo/Agente]
           **Fecha:** [Fecha formateada como '3 de enero de 2025']
           **Detalles:** [Descripción o Solución]"`;
}

function getResetPrompt(displayName) {
    return `REGLAS DE RESETEO DE CONTRASEÑA:
           - REGLA DE ORO 1: NUNCA pidas el nombre del usuario. Ya lo conoces (es ${displayName}).
           - REGLA DE ORO 2: Pide los datos UNO POR UNO. No pases al siguiente hasta que el usuario entregue el anterior.
           - EXCEPCIÓN: Solo pídela toda la lista si el usuario lo solicita explícitamente (ej. "¿qué datos necesitas?").
           - REGLA DE ORO 3: Cuando falte solo el ÚLTIMO dato, indica que el proceso tomará aproximadamente un minuto una vez lo entregue.
           DATOS REQUERIDOS (SÓLO ESTOS 7):
           1. action: "Reinicio o desbloqueo de cuenta". Pregunta: "¿Deseas realizar un reinicio de contraseña o un desbloqueo de cuenta?"
           2. employnumber: "Número de empleado".
           3. mail: "Correo electrónico corporativo" (Solo @liverpool.com.mx o @suburbia.com.mx).
           4. placeBirth: "Lugar de nacimiento".
           5. rfc: "RFC con homoclave" (DEBE TENER EXACTAMENTE 13 CARACTERES).
           6. sysapp: "Aplicación". (Usa los catálogos de abajo).
           7. user: "Usuario de acceso" (ID de login).
           LOGICA DE APLICACIONES:
           - Si la aplicación es de la lista "Directorio Activo", usa 'Directorio Activo' para la API y aclara que solo aplica RESETEO.
           - Directorio Activo: BMC Helix, Card Wizard, Control Digital, Citrix, Check ID, Directorio Activo, Facturación Web, FICO, IBM / OMS Sb, MiniPagos, Medallia, PAO, PLM, Portal Aclaraciones, Portal Remisiones, SSO, BX, Portal Ventas institucionales, Red Wifi Colabora /Servicios Liverpool, SAM Sistema Administración de Monederos, Seguros, Siebel / Service Request, Sterling, Valija, VAS, VPN, Web Desk, SALA DE JUNTAS, UKG, Windows, Super App.
           - SAP: SAP EWM, SAP EWM WSP, SAP Fiori, SAP PDM, SAP PMR, SAP S4hana SBP, Portal Liverpool, Cyberfinancial, CTE, Mesa de regalos, Portal de Abastecimientos, LPC, SAP BW, SAP ECC, SOMS.`;
}

function getContextSophia(displayName, intent = null) {
    let prompt = getCorePrompt(displayName);
    if (intent === 'consulta') prompt += "\n" + getTicketPrompt();
    else if (intent === 'reset') prompt += "\n" + getResetPrompt(displayName);
    else prompt += "\nCapacidades: Consultas de tickets (INC) y reseteos.";
    return { parts: [{ text: prompt }] };
}

// --- ADVANCED HELPERS ---
function normalizeIncidentId(raw) {
    if (!raw) return raw;
    let r = String(raw).toUpperCase().replace(/\s+/g, '');
    if (r.startsWith('INC')) {
        const digits = r.replace(/^INC/, '').replace(/\D/g, '');
        return 'INC' + digits.padStart(12, '0');
    }
    const onlyDigits = r.replace(/\D/g, '');
    if (onlyDigits.length > 0) {
        return 'INC' + onlyDigits.padStart(12, '0');
    }
    return r;
}

function filtrarDatosRelevantes(jsonCompleto) {
    if (jsonCompleto.Error) return jsonCompleto;
    const mapeo = {
        "Ticket ID": jsonCompleto["Incident Number"] || jsonCompleto["Entry ID"],
        "Estatus": jsonCompleto["Status"],
        "Razón Estatus": jsonCompleto["Status_Reason"],
        "Prioridad": jsonCompleto["Priority"],
        "Empresa": jsonCompleto["Company"],
        "Resumen Corto": jsonCompleto["Description"],
        "Descripción Detallada": jsonCompleto["Detailed Decription"] || jsonCompleto["Detailed Description"],
        "Grupo Asignado": jsonCompleto["Assigned Group"],
        "Asignado A": jsonCompleto["Assignee"],
        "Resolución": jsonCompleto["Resolution"],
        "Fecha Creación": jsonCompleto["Reported Date"]
    };
    Object.keys(mapeo).forEach(key => { if (!mapeo[key]) delete mapeo[key]; });
    return mapeo;
}

async function generarResumenFinal(mensajeOriginal, datosJson, displayName) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;
    const promptFinal = `CONTEXTO: El usuario preguntó "${mensajeOriginal}". ACCIÓN: El sistema obtuvo: ${JSON.stringify(datosJson)}. INSTRUCCIÓN: Como SOPHIA, resume esto de forma amable para ${displayName}.`;
    try {
        const payload = {
            system_instruction: { parts: [{ text: getCorePrompt(displayName) }] },
            contents: [{ role: "user", parts: [{ text: promptFinal }] }]
        };
        const resp = await axios.post(url, payload);
        return resp.data.candidates[0].content.parts[0].text;
    } catch (e) {
        return "No pude generar el resumen. Datos: " + JSON.stringify(datosJson);
    }
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
    } catch (e) { return { Error: e.message }; }
}

// --- ROUTES PROTEGIDAS ---

app.post('/api/chat', isAuth, async (req, res) => {
    const { message, chatId, displayName } = req.body;
    if (!message || !chatId) return res.status(400).json({ error: "Missing data" });

    const history = loadHistory(chatId);
    const lower = message.toLowerCase();
    let intent = null;
    if (/inc|ticket|estatus|seguimiento/.test(lower)) intent = 'consulta';
    if (/reset|restable|reinicio|contrase|bloque|um|sdagent/.test(lower)) intent = 'reset';

    try {
        const ticketMatch = message.match(/inc\s*0*\d+/i) || message.match(/\b\d{6,}\b/);
        if (ticketMatch && !/reset|contrase|bloque/.test(lower)) {
            const normalized = normalizeIncidentId(ticketMatch[0]);
            const rawData = await getIncidentData(normalized);
            const summary = await generarResumenFinal(message, filtrarDatosRelevantes(rawData), displayName || "Usuario");
            appendToHistory(chatId, "user", message);
            appendToHistory(chatId, "model", summary);
            return res.json({ tipo: "texto", respuesta: summary });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;
        const tools = [{
            function_declarations: [
                {
                    name: "consultar_estatus_ticket",
                    description: "Consulta el estado de un ticket.",
                    parameters: { type: "OBJECT", properties: { ticket_id: { type: "STRING" } }, required: ["ticket_id"] }
                },
                {
                    name: "reset_contrasena_um",
                    description: "Realiza el reseteo de contraseña vía sdAgentUM.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            action: { type: "STRING" }, employnumber: { type: "STRING" },
                            mail: { type: "STRING" }, placeBirth: { type: "STRING" },
                            rfc: { type: "STRING" }, sysapp: { type: "STRING" }, user: { type: "STRING" }
                        },
                        required: ["action", "employnumber", "mail", "placeBirth", "rfc", "sysapp", "user"]
                    }
                }
            ]
        }];

        const payload = {
            system_instruction: getContextSophia(displayName || "Usuario", intent),
            contents: history.concat([{ role: "user", parts: [{ text: message }] }]),
            tools,
            safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }]
        };

        const geminiResp = await axios.post(url, payload);
        const part = geminiResp.data.candidates[0].content.parts[0];

        if (part.functionCall) {
            const { name, args } = part.functionCall;
            if (name === "consultar_estatus_ticket") {
                const rawData = await getIncidentData(normalizeIncidentId(args.ticket_id));
                const summary = await generarResumenFinal(message, filtrarDatosRelevantes(rawData), displayName || "Usuario");
                appendToHistory(chatId, "user", message);
                appendToHistory(chatId, "model", summary);
                return res.json({ tipo: "texto", respuesta: summary });
            }
            if (name === "reset_contrasena_um") {
                try {
                    const resp = await axios.post(CFG.UM_RESET_URL, args, {
                        headers: { Authorization: `Bearer ${CFG.UM_BEARER_TOKEN}`, Accept: 'application/json' }
                    });
                    const msg = `Reseteo solicitado con éxito. Folio: ${resp.data.ticket || "Registrado"}.`;
                    appendToHistory(chatId, "user", message);
                    appendToHistory(chatId, "model", msg);
                    return res.json({ tipo: "texto", respuesta: msg });
                } catch (err) {
                    return res.json({ tipo: "error", respuesta: "Error en el servicio de reseteo." });
                }
            }
        }

        const text = part.text || "Entendido.";
        appendToHistory(chatId, "user", message);
        appendToHistory(chatId, "model", text);
        res.json({ tipo: "texto", respuesta: text });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tts', isAuth, async (req, res) => {
    const { text, lang } = req.body;
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${CFG.GCLOUD_TTS_API_KEY || CFG.GEMINI_API_KEY}`;
    try {
        const resp = await axios.post(url, {
            input: { text },
            voice: { languageCode: lang || 'es-MX', ssmlGender: "FEMALE" },
            audioConfig: { audioEncoding: "MP3" }
        });
        res.json({ audio: resp.data.audioContent, type: 'audio/mp3' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clear', isAuth, (req, res) => {
    messageHistory.delete(req.body.chatId);
    res.json({ success: true });
});

app.get('/api/config', isAuth, (req, res) => {
    res.json({ gcloudTtsKey: CFG.GCLOUD_TTS_API_KEY });
});

app.listen(PORT, () => console.log(`SophIA Server running on port ${PORT}`));
