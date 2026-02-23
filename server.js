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

app.set('trust proxy', 1);

app.use(session({
    secret: 'sophia_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax' }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    proxy: true
},
    (accessToken, refreshToken, profile, done) => {
        const email = profile.emails[0].value.toLowerCase();
        if (email.endsWith('@liverpool.com.mx') || email.endsWith('@suburbia.com.mx')) {
            return done(null, profile);
        }
        return done(null, false, { message: 'Dominio no autorizado' });
    }
));

function isAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/google');
}

app.use(cors());
app.use(express.json());

// --- NUEVA RUTA: Obtener Perfil desde Helix usando el correo de Google ---
app.get('/api/user-profile', isAuth, async (req, res) => {
    try {
        const email = req.user.emails[0].value;
        const jwt = await loginBMC();
        const headers = { Authorization: `AR-JWT ${jwt}`, Accept: 'application/json' };

        // Consulta a CTM:People por correo electrónico
        const qualification = `'Internet E-mail'="${email}"`;
        const url = `${CFG.BMC_REST_URL}/api/arsys/v1/entry/CTM:People?q=${encodeURIComponent(qualification)}`;

        const response = await axios.get(url, { headers });
        const personData = response.data.entries[0]?.values;

        // Extraemos el nombre o usamos el nombre de Google como respaldo
        const firstName = personData ? personData['First Name'] : req.user.name.givenName;

        res.json({
            displayName: firstName,
            email: email,
            photo: req.user.photos[0].value
        });
    } catch (error) {
        console.error("Error en user-profile:", error.message);
        res.json({ displayName: req.user.name.givenName, email: req.user.emails[0].value });
    }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/auth/google' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

app.get('/', isAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

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

function loadHistory(chatId) { return messageHistory.get(chatId) || []; }
function saveHistory(chatId, history) {
    if (history.length > MAX_TURNS) history = history.slice(history.length - MAX_TURNS);
    messageHistory.set(chatId, history);
}
function appendToHistory(chatId, role, text) {
    const history = loadHistory(chatId);
    history.push({ role, parts: [{ text }] });
    saveHistory(chatId, history);
}

// --- UNIFIED SYSTEM PROMPT (Consolidado desde AppScript) ---
function getContextSophia(displayName) {
    // Normalización del nombre (Primera Mayúscula, resto minúsculas)
    const firstName = displayName.split(' ')[0].charAt(0).toUpperCase() + displayName.split(' ')[0].slice(1).toLowerCase();

    const texto = `Eres SOPHIA, un asistente virtual corporativo experto en ITSM. Siempre habla en femenino (ej. "quedo atenta", "estoy lista").

    TU OBJETIVO:
    Recibir datos técnicos de un ticket o procesos de cuenta y presentarlos al usuario de forma ejecutiva, limpia y amigable. Siempre con actitud de servicio.

    REGLA DE TRATO:
    - Dirígete siempre al usuario por su nombre como **${firstName}** en cada respuesta. 
    - Sin emojis. Tono profesional y amable. 
    - No hagas que parezca un interrogatorio; varía tus frases de inicio y agradecimiento.
    - SUPER IMPORTANTE: Si el usuario habla en inglés, responde en inglés (traduce etiquetas y campos).

    REGLAS DE FORMATO (OBLIGATORIAS):
    1. NUNCA muestres estructura JSON, llaves {} o comillas.
    2. Usa Markdown para negritas (**texto**).
    3. Si el 'Estatus' es 'Assigned', tradúcelo a 'Asignado'.
    4. Nunca respondas con el ticket completo; si es INC000000007910, refiérete a él como INC7910 (quita los ceros de en medio).

    --- CAPACIDAD 1: CONSULTA DE TICKETS ---
    - Los tickets son INC + 12 dígitos. Si dan terminación (ej. 1730), rellena ceros hasta 12 dígitos para la función.
    - No respondas hasta ejecutar la función de búsqueda.
    - PLANTILLA DE RESPUESTA:
      "Claro, ${firstName}, estos son los detalles del ticket solicitado:
      **Resumen:** [Resumen con tus palabras de los datos técnicos]
      **Ticket:** [ID sin ceros de en medio]
      **Estado:** [Estatus traducido]
      **Asignado a:** [Grupo/Agente]
      **Fecha:** [Fecha formateada como '3 de enero de 2025']
      **Detalles:** [Descripción o Solución]"

    --- CAPACIDAD 2: RESETEO DE CONTRASEÑA ---
    - Pide los datos UNO POR UNO, a menos que el usuario pida la lista completa.
    - ETIQUETAS A USAR (Pide estos datos exactos):
      • "Reinicio o desbloqueo de cuenta" (Valores API: RESETEO o DESBLOQUEO).
      • "Número de empleado"
      • "Correo electrónico corporativo" (Solo @liverpool.com.mx o @suburbia.com.mx).
      • "Lugar de nacimiento"
      • "RFC con homoclave"
      • "Aplicación"
      • "Usuario de acceso"
    - LOGICA DE APLICACIONES:
      - Si mencionan aplicaciones de "Directorio Activo" (Citrix, VPN, Windows, WiFi, etc.), usa 'Directorio Activo' para la API e indica que solo aplica RESETEO.
      - Para SAP (EWM, Fiori, S4hana), envía el nombre tal cual.
    - FINALIZACIÓN: Cuando falte solo el ÚLTIMO dato, indica que el proceso tomará un minuto. Tras el éxito, informa que la contraseña fue enviada al buzón.

    SEGURIDAD Y FUERA DE ALCANCE:
    - Contacto Soportec: Teléfono 4425006484 o WhatsApp 5550988688.
    - Requerimientos: https://epl-dwp.onbmc.com/
    - No inventes datos. Si no tienes la información, pídela.

    REGLA DE EJECUCIÓN:
    - No digas "permíteme" o "dame un momento". Llama a la herramienta inmediatamente sin texto previo.
    - REGLA DE ESTADO: No afirmes tener datos personales si el usuario no los dio en esta conversación específica.`;

    return { parts: [{ text: texto }] };
}


// --- HELPERS ---
function normalizeIncidentId(raw) {
    if (!raw) return raw;
    let r = String(raw).toUpperCase().replace(/\s+/g, '');
    const digits = r.replace(/\D/g, '');
    return 'INC' + digits.padStart(12, '0');
}

function filtrarDatosRelevantes(jsonCompleto) {
    if (jsonCompleto.Error) return jsonCompleto;
    return {
        "Ticket ID": jsonCompleto["Incident Number"],
        "Estatus": jsonCompleto["Status"],
        "Asignado A": jsonCompleto["Assignee"],
        "Resumen": jsonCompleto["Description"]
    };
}

async function generarResumenFinal(mensajeOriginal, datosJson, displayName) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;

    // Usamos el mismo prompt de sistema para que no pierda la personalidad de SOPHIA
    const payload = {
        system_instruction: getContextSophia(displayName),
        contents: [{
            role: "user",
            parts: [{ text: `CONTEXTO: El usuario preguntó "${mensajeOriginal}". Registro JSON obtenido: ${JSON.stringify(datosJson)}. Genera el resumen siguiendo tus reglas de formato.` }]
        }]
    };

    try {
        const resp = await axios.post(url, payload);
        return resp.data.candidates[0].content.parts[0].text;
    } catch (e) {
        return "No pude generar el resumen. Datos: " + JSON.stringify(datosJson);
    }
}

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
        return resp.data.entries[0]?.values || { Error: "No encontrado" };
    } catch (e) { return { Error: e.message }; }
}

app.post('/api/tts', async (req, res) => {
    try {
        const { text, lang } = req.body;
        const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${CFG.GCLOUD_TTS_API_KEY}`;
        const payload = {
            input: { text },
            voice: { languageCode: lang || 'es-MX', ssmlGender: 'FEMALE' },
            audioConfig: { audioEncoding: 'MP3' }
        }; 
        const resp = await axios.post(url, payload);
        res.json({ audio: resp.data.audioContent, type: 'audio/mp3' });
    } catch (error) {
        console.error("Error en TTS:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/clear', (req, res) => {
    const { chatId } = req.body;
    messageHistory.delete(chatId);
    res.json({ status: "ok", message: "Historial limpiado" });
});

// --- API CHAT ---
app.post('/api/chat', isAuth, async (req, res) => {
    const { message, chatId, displayName } = req.body;
    const history = loadHistory(chatId);
    const lower = message.toLowerCase();
    let intent = /inc|ticket|estatus/.test(lower) ? 'consulta' : (/reset|reinicio|contrase/.test(lower) ? 'reset' : null);

    try {
        // Fast track para tickets directos
        const ticketMatch = message.match(/inc\s*0*\d+/i) || message.match(/\b\d{6,}\b/);
        if (ticketMatch && intent === 'consulta') {
            const rawData = await getIncidentData(normalizeIncidentId(ticketMatch[0]));
            const summary = await generarResumenFinal(message, filtrarDatosRelevantes(rawData), displayName);
            appendToHistory(chatId, "user", message);
            appendToHistory(chatId, "model", summary);
            return res.json({ tipo: "texto", respuesta: summary });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;
        const payload = {
            system_instruction: getContextSophia(displayName || "Usuario"),
            contents: history.concat([{ role: "user", parts: [{ text: message }] }]),
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        };

        const geminiResp = await axios.post(url, payload);
        const text = geminiResp.data.candidates[0].content.parts[0].text;

        appendToHistory(chatId, "user", message);
        appendToHistory(chatId, "model", text);
        res.json({ tipo: "texto", respuesta: text });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`SophIA Server running on port ${PORT}`));
