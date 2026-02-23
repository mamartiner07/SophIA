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
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Sesión expirada', redirect: '/auth/google' });
    }
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
    const firstName = displayName.split(' ')[0].charAt(0).toUpperCase() + displayName.split(' ')[0].slice(1).toLowerCase();

    const texto = `Eres SOPHIA, un asistente virtual corporativo experto en ITSM. Siempre habla en femenino.

TU OBJETIVO:
Ayudar con tickets de BMC Helix y reseteos de cuenta. Siempre amable y profesional. Dirígete al usuario como **${firstName}**. Sin emojis.

--- CAPACIDAD 1: CONSULTA DE TICKETS ---
- Usa la herramienta 'consultar_estatus_ticket' para buscar folios (ej. INC000000006816).
- Si dan terminación (ej. 1730), rellena ceros hasta 12 dígitos.
- Traduce status 'Assigned' a 'Asignado'.
- Acorta folios: INC000000007910 -> INC7910.

--- CAPACIDAD 2: RESETEO DE CONTRASEÑA ---
- Usa 'reset_contrasena_um' cuando tengas todos estos datos:
  • action (RESETEO o DESBLOQUEO)
  • employnumber (Número de empleado)
  • mail (Correo corporativo @liverpool.com.mx o @suburbia.com.mx)
  • placeBirth (Lugar de nacimiento)
  • rfc (RFC con homoclave)
  • sysapp (Aplicación)
  • user (Usuario de acceso)

- Lógica de Apps: Para Citrix, VPN, Windows, WiFi, usa 'Directorio Activo' y solo RESETEO.
- Si falta un dato, pídelo educadamente. Si ya dijeron que es un reset, no vuelvas a preguntar.
- Antes del último dato, indica que tomará un minuto. Al finalizar, informa que se envió al buzón.

REGLA DE ORO: No digas "procesando" o "permíteme". Llama a la herramienta inmediatamente sin texto previo.`;

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
        "Grupo Asignado": jsonCompleto["Assigned Group"],
        "Asignado A": jsonCompleto["Assignee"],
        "Resumen": jsonCompleto["Description"],
        "Detalle": jsonCompleto["Detailed Decription"]
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

async function ejecutarResetUM(payloadObj) {
    try {
        const clean = {
            action: String(payloadObj.action || "RESETEO").trim().toUpperCase(),
            employnumber: String(payloadObj.employnumber || "").trim(),
            mail: String(payloadObj.mail || "").trim(),
            placeBirth: String(payloadObj.placeBirth || "").trim(),
            rfc: String(payloadObj.rfc || "").trim(),
            sysapp: String(payloadObj.sysapp || "").trim(),
            user: String(payloadObj.user || "").trim()
        };

        const headers = {
            Authorization: `Bearer ${CFG.UM_BEARER_TOKEN}`,
            'Accept': 'application/json'
        };

        const resp = await axios.post(CFG.UM_RESET_URL, clean, { headers });
        return resp.data;
    } catch (e) {
        return { Error: "Fallo en Reseteo", Detalle: e.response?.data || e.message };
    }
}

function extraerTicketUM(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const keys = ['ticket', 'folio', 'incident', 'id'];
    for (const k of keys) if (obj[k]) return String(obj[k]);
    const str = JSON.stringify(obj);
    const m = str.match(/INC\d+/i) || str.match(/\b\d{6,}\b/);
    return m ? m[0] : null;
}

app.post('/api/tts', isAuth, async (req, res) => {
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

app.post('/api/clear', isAuth, (req, res) => {
    const { chatId } = req.body;
    messageHistory.delete(chatId);
    res.json({ status: "ok", message: "Historial limpiado" });
});

// --- API CHAT CON FUNCTION CALLING ---
app.post('/api/chat', isAuth, async (req, res) => {
    const { message, chatId, displayName } = req.body;
    const history = loadHistory(chatId);

    const tools = [{
        function_declarations: [
            {
                name: "consultar_estatus_ticket",
                description: "Consulta el estado de un ticket en BMC Helix.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        ticket_id: { type: "STRING", description: "Número de incidente completo (ej. INC000000006816)." }
                    },
                    required: ["ticket_id"]
                }
            },
            {
                name: "reset_contrasena_um",
                description: "Ejecuta el reseteo de contraseña en el sistema corporativo.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: { type: "STRING", enum: ["RESETEO", "DESBLOQUEO"] },
                        employnumber: { type: "STRING" },
                        mail: { type: "STRING" },
                        placeBirth: { type: "STRING" },
                        rfc: { type: "STRING" },
                        sysapp: { type: "STRING" },
                        user: { type: "STRING" }
                    },
                    required: ["action", "employnumber", "mail", "placeBirth", "rfc", "sysapp", "user"]
                }
            }
        ]
    }];

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;
        const contents = history.concat([{ role: "user", parts: [{ text: message }] }]);

        const payload = {
            system_instruction: getContextSophia(displayName || "Usuario"),
            contents,
            tools,
            safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }]
        };

        const geminiResp = await axios.post(url, payload);
        const candidate = geminiResp.data.candidates[0].content;
        const part = candidate.parts[0];

        if (part.functionCall) {
            const { name, args } = part.functionCall;
            let resultData;

            if (name === "consultar_estatus_ticket") {
                const raw = await getIncidentData(normalizeIncidentId(args.ticket_id));
                resultData = filtrarDatosRelevantes(raw);
            } else if (name === "reset_contrasena_um") {
                const umResp = await ejecutarResetUM(args);
                if (umResp.Error) {
                    resultData = { Error: "No se pudo completar el reseteo. Contacte a Soportec." };
                } else {
                    const ticket = extraerTicketUM(umResp);
                    resultData = { Status: "Éxito", Ticket: ticket || "Generado", Mensaje: "Contraseña enviada al buzón." };
                }
            }

            // Segunda llamada para resumir el resultado de la función
            const secondPayload = {
                system_instruction: getContextSophia(displayName || "Usuario"),
                contents: contents.concat([
                    { role: "model", parts: [part] },
                    {
                        role: "function",
                        parts: [{
                            functionResponse: {
                                name: name,
                                response: resultData
                            }
                        }]
                    }
                ])
            };

            const secondResp = await axios.post(url, secondPayload);
            const finalBotText = secondResp.data.candidates[0].content.parts[0].text;

            appendToHistory(chatId, "user", message);
            appendToHistory(chatId, "model", finalBotText);
            return res.json({ tipo: "texto", respuesta: finalBotText });
        }

        const botText = part.text;
        appendToHistory(chatId, "user", message);
        appendToHistory(chatId, "model", botText);
        res.json({ tipo: "texto", respuesta: botText });

    } catch (e) {
        console.error("Error en Chat:", e.message);
        res.status(500).json({ error: "Ocurrió un error al procesar tu solicitud." });
    }
});

app.listen(PORT, () => console.log(`SophIA Server running on port ${PORT}`));
