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

// --- RUTA: Obtener Perfil desde Google Auth ---
app.get('/api/user-profile', isAuth, (req, res) => {
    try {
        const email = req.user.emails[0].value;
        const firstName = req.user.name.givenName || "Usuario";
        const photo = req.user.photos && req.user.photos[0] ? req.user.photos[0].value : "";

        console.log(`[Profile] Entregando datos de Google para: ${email}`);

        res.json({
            displayName: req.user.displayName || firstName,
            email: email,
            photo: photo
        });
    } catch (error) {
        console.error("Error en user-profile:", error.message);
        res.status(500).json({ tipo: "error", respuesta: "No se pudo obtener el perfil de usuario." });
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
    UM_BASE_URL: process.env.UM_BASE_URL || "https://api.supporttsmx.com.mx",
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
function appendToHistory(chatId, role, content) {
    const history = loadHistory(chatId);
    if (typeof content === 'string') {
        history.push({ role, parts: [{ text: content }] });
    } else {
        history.push({ role, parts: Array.isArray(content) ? content : [content] });
    }
    saveHistory(chatId, history);
}

// --- UNIFIED SYSTEM PROMPT (Consolidado desde AppScript) ---
function getContextSophia(displayName) {
    let firstName = "Usuario";
    try {
        if (displayName && typeof displayName === 'string' && displayName.trim()) {
            const part = displayName.split(' ')[0];
            firstName = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }
    } catch (e) {
        console.error("Error formatting firstName:", e.message);
    }

    const texto = `Eres SOPHIA, un asistente virtual corporativo experto en ITSM.

           TU OBJETIVO:
           Recibir datos técnicos de un ticket y presentarlos al usuario de forma ejecutiva, limpia y amigable. Siempre debes sonar amable y servicial, mostrando estar a disposición del usuario en todo momento. Siempre con actitud de servicio.

           Regla de trato: Dirígete siempre al usuario por su nombre como **${firstName}** en cada respuesta (sin emojis) y mantén un tono profesional y amable. No hagas que parezca un interrogatorio, inicia cada pregunta con una frase diferente, agradeciendo al usuario, diciendo cosas diferentes, sin que en cada una digas "Claro ${firstName}", sino dándole variedad a la conversación.

           Los tickets que te va a proporcionar el usuario se conforman de las letras INC seguida de ceros y dígitos al final. Por ejemplo INC000000006816. Si el usuario te pide estatus del ticket con terminación 1730, debes rellenar con ceros hasta obtener INC y 12 dígitos; este será el valor que le pasarás a la función que busca el ticket. Siempre dale al usuario los datos del ticket. No respondas hasta que hayas ejecutado la función de búsqueda de ticket.

           SUPER IMPORTANTE. Si el usuario te habla en inglés, respóndele en inglés (traduce también los nombres de los campos, como número de empleado a employee number).

           REGLAS DE FORMATO (OBLIGATORIAS):
           1. NUNCA muestres estructura JSON, llaves {} o comillas al usuario. Interprétalas y utiliza la plantilla de respuesta esperada.
           2. Usa Markdown para negritas (**texto**).
           3. Si el 'Estatus' es 'Assigned', tradúcelo a 'Asignado'.
           4. Nunca respondas con el ticket completo; si el ticket es INC000000007910 elimina los 0 de en medio y refiérete al ticket como INC7910.

           PLANTILLA DE RESPUESTA ESPERADA:
           Claro, **${firstName}**, estos son los detalles del ticket solicitado:

           (REGLA DE ÉXITO PARA RESETEO):
           - Si el estatus es 'success', incluye el ID del incidente exactamente como se recibió del sistema (ej. 12345678), sin prefijos adicionales a menos que ya los traiga el valor original. Recuerda informar que la contraseña fue enviada al buzón institucional.

           (REGLA DE ERROR/FALLO PARA RESETEO):
           - Si el estatus es 'failed' o hay un error de verificación, DEBES parafrasear (con tus propias palabras, sin que suene robótico) la siguiente idea: "Lo lamento, **${firstName}**, tus datos no pudieron ser verificados correctamente en el sistema para realizar el proceso de forma automática. Por favor, ponte en contacto con el equipo de RH de tu localidad para validar tu información en el sistema. Quedo a tu disposición para cualquier otra solicitud."

            **Resumen:**
           [Aquí necesito que hagas un resumen con tus propias palabras de los datos que tengas del ticket]

            **Ticket:** [ID del Ticket sin los 00000]
            **Estado:** [Estatus]
            **Asignado a:** [Grupo Asignado] (O el Agente si existe)
            **Fecha:** [Fecha Reporte formateada en texto (por ejemplo 3 de enero de 2025)]

            **Detalles:**
           [Aquí pon la descripción detallada, o la Solución si está resuelto]

           ---
           NUEVA CAPACIDAD: RESETEO DE CONTRASEÑA
           - Si el usuario solicita reset de contraseña (restablecer / reiniciar), debes pedir educadamente estos datos, uno por uno si faltan.
           - Si el usuario te pide qué datos necesitas, puedes pedir todos en el mismo mensaje; de lo contrario, pídelos uno por uno.
           - Cuando pidas datos al usuario, utiliza SIEMPRE etiquetas en español, naturales y amigables. En caso de que el usuario te hable en inglés, traduce las etiquetas a inglés:
             • action  → "Reinicio o desbloqueo de cuenta" (SI EL USARIO PIDE REINICIO NO DES ASESORÍA Y VE AL SIGUIENTE PUNTO. SI EL USUARIO PIDE DESBLOQUEO NO DES ASESORIA Y VE AL SIGUIENTE PUNTO) Si el usuario indica que es reinicio, reset, cambio de contraseña, el valor que envías a la API será RESETEO; si el usuario dice desbloquear o similares, deberás enviar DESBLOQUEO. Asesora al usuario indicando que si no recuerda su contraseña deberá pedir un reinicio de contraseña, y si la recuerda, deberá pedir un desbloqueo de cuenta. Si el usuario te pide directamente reinicio o un desbloqueo, ya no lo asesores y continúa con el flujo.)
             • employnumber → "número de empleado"
             • mail → "correo electrónico corporativo" (únicamente acepta correos con dominio @liverpool.com.mx o @suburbia.com.mx. Si el usuario te da un correo con otro dominio, indícale que no es válido y especifícale los formatos aceptados.)
             • curp → "CURP"
             • rfc → "RFC con homoclave"
             • sysapp → "aplicación"
             • user → "usuario de acceso"

              - NO menciones los nombres técnicos del body (no digas "employnumber", "curp", etc.). 
              - Si necesitas recordar al usuario qué falta, menciónalo con estas etiquetas en español.

             Si al preguntar la aplicación el usuario te indica alguna de estas opciones, el valor que debes mandar en el body tiene que ser "Directorio Activo" (Para la lista de Directorio Activo no se puede aplicar Desbloqueo; el sistema aplica desbloqueos de estas cuentas cada 30 minutos automáticamente, tú puedes hacer únicamente reseteo/reinicio de contraseña):
              BMC Helix, Card Wizard, Control Digital, Citrix, Check ID, Directorio Activo, Facturación Web, FICO, IBM / OMS Sb, MiniPagos, Medallia, PAO, PLM, Portal Aclaraciones, Portal Remisiones, SSO, BX, Portal Ventas institucionales, Red Wifi Colabora / Servicios Liverpool, SAM Sistema Administración de Monederos, Seguros, Siebel / Service Request, Sterling, Valija, VAS, VPN, Web Desk, SALA DE JUNTAS, UKG, Windows, Super App.

              También tienes alcance a las siguientes aplicaciones, estas las mandas tal cual están escritas en esta lista a la API:
              SAP EWM, SAP EWM WSP, SAP Fiori, SAP PDM, SAP PMR, SAP S4hana SBP, Portal Liverpool, Cyberfinancial, CTE, Mesa de regalos, Portal de Abastecimientos, LPC, SAP BW, SAP ECC, SOMS.

              Si el usuario te pregunta a qué aplicaciones tienes alcance, o ves que no sabe qué aplicación resetear, pregúntale si quiere saber el catálogo y si te dice que sí, le das la lista completa. No le indiques cómo las envías al backend.

           - Cuando te falte únicamente un dato y lo pidas al usuario, indícale que después de que te comparta el dato faltante, comenzarás a realizar el desbloqueo y que te tomará aproximadamente un minuto.
           - Cuando cuentes con TODOS los datos, llama a la función de herramienta para procesarlo. No inventes datos.
           - Tras la respuesta de la API, informa:
             • Muestra el **ticket** devuelto (si existe).
             • SI la solicitud fue un reseteo indica explícitamente que **la contraseña fue enviada al buzón proporcionado**. Si el reinicio de contraseña fue para alguna de las aplicaciones de Directorio Activo, indica que puede tardar hasta 30 minutos en replicar.
           - Mantén el tono amable. NO USES EMOJIS.

           - Si te preguntan por Soportec, indica que los pueden contactar al teléfono 4425006484 o al WhatsApp 5550988688. Ellos pueden realizar creación de tickets e incidentes, y asesoría en TI. Si te piden algo fuera de tu alcance, canalízalo con ellos. Si piden levantar un requerimiento, envíalos a: https://epl-dwp.onbmc.com/

           REGLA IMPORTANTE:
           Cuando ya tengas todos los datos necesarios para ejecutar alguna función (consultar_estatus_ticket o reset_contrasena_um),
           NO generes ningún mensaje previo. Debes llamar inmediatamente a la herramienta.

            REGLA DE ENRUTAMIENTO:
            - Seguimiento/ID Ticket -> consultar_estatus_ticket.
            - Solicitud Reset/Restablecimiento -> reset_contrasena_um.
            - NO mezcles herramientas.

            REGLA DE ESTADO (OBLIGATORIA):
            No afirmes que ya cuentas con datos personales a menos que el usuario los haya proporcionado explícitamente en esta conversación. Siempre solicita todos los datos.`;

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
        "Detalle": jsonCompleto["Detailed Decription"],
        "Fecha": jsonCompleto["Report Date"] || jsonCompleto["Submit Date"]
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
        const candidates = resp.data.candidates;
        if (!candidates || candidates.length === 0) return "No pude generar el resumen por filtros de seguridad.";
        return candidates[0].content.parts[0].text;
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function ejecutarResetUM(payloadObj) {
    const baseUrl = CFG.UM_BASE_URL;
    const pathPost = "/RA/LIVERPOOL/setStarExecutionUM";
    const pathGet = "/RA/LIVERPOOL/getExecutionUM";

    const payload = {
        action: String(payloadObj.action || "RESETEO").trim().toUpperCase(),
        curp: String(payloadObj.curp || "").trim(),
        employnumber: String(payloadObj.employnumber || "").trim(),
        mail: String(payloadObj.mail || "").trim(),
        rfc: String(payloadObj.rfc || "").trim(),
        source: "sophia",
        sysapp: String(payloadObj.sysapp || "").trim(),
        user: String(payloadObj.user || "").trim()
    };

    try {
        const headers = { Authorization: `Bearer ${CFG.UM_BEARER_TOKEN}`, 'Content-Type': 'application/json' };
        const postResp = await axios.post(`${baseUrl}${pathPost}`, payload, { headers });
        const idExecution = postResp.data?.result?.idExecution;

        if (idExecution === undefined || idExecution === null) {
            return { Error: "No se inició la ejecución", Detalle: postResp.data };
        }

        let attempts = 0;
        const maxAttempts = 20; // Reducido a 5 min (20 * 15s) por timeout de Cloud Run
        const pollInterval = 15000;

        while (attempts < maxAttempts) {
            attempts++;
            await sleep(pollInterval);

            const getResp = await axios.get(`${baseUrl}${pathGet}?idExecution=${idExecution}`, { headers });
            const j = getResp.data;

            if (j.status === "success" && j.result && j.result.execution) {
                const exec = j.result.execution;
                if (exec.status === "failed" || exec.status === "success") {
                    return {
                        status: exec.status,
                        incident: exec.incident,
                        detail: exec.detail
                    };
                }
            }
        }
        return { Error: "Timeout", Detalle: "La operación tomó más de 5 minutos." };
    } catch (e) {
        return { Error: "Fallo en Reseteo", Detalle: e.response?.data || e.message };
    }
}

function extraerTicketUM(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // Prioridad a campos conocidos
    const keys = ['ticket', 'folio', 'incident', 'id'];
    for (const k of keys) if (obj[k]) return String(obj[k]);

    // Si no hay campo directo, buscar en el string completo
    const str = JSON.stringify(obj);
    const m = str.match(/INC\d+/i) || str.match(/\d{6,}/); // Buscamos INC o al menos 6 dígitos
    return m ? m[0] : null;
}

app.post('/api/tts', isAuth, async (req, res) => {
    try {
        let { text, lang } = req.body;

        // Optimización fonética: Evitar que deletree CURP
        if (text) {
            text = text.replace(/CURP/g, 'curp');
        }

        const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${CFG.GCLOUD_TTS_API_KEY}`;

        // Mapeo de voces personalizadas solicitadas por el usuario
        let voiceName = "";
        let langCode = lang || 'es-MX';

        if (langCode.startsWith('en')) {
            langCode = 'en-US';
            voiceName = 'en-US-Wavenet-F';
        } else if (langCode.startsWith('es')) {
            langCode = 'es-US';
            voiceName = 'es-US-Wavenet-A';
        }

        const payload = {
            input: { text },
            voice: {
                languageCode: langCode,
                name: voiceName,
                ssmlGender: 'FEMALE'
            },
            audioConfig: { audioEncoding: 'MP3' }
        };
        const resp = await axios.post(url, payload);
        res.json({ audio: resp.data.audioContent, type: 'audio/mp3' });
    } catch (e) {
        console.error("Error en TTS:", e.response?.data || e.message);
        res.status(500).json({
            tipo: "error",
            respuesta: "Ocurrió un error interno al procesar tu solicitud.",
            message: e.message,
            detail: e.response?.data?.error?.message || "Sin detalles adicionales"
        });
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
                        action: { type: "STRING", enum: ["RESETEO", "DESBLOQUEO"], description: "RESETEO (si no recuerda clave) o DESBLOQUEO (si la sabe pero está bloqueado)." },
                        curp: { type: "STRING", description: "CURP del usuario (Obligatorio)." },
                        employnumber: { type: "STRING", description: "Número de empleado del usuario." },
                        mail: { type: "STRING", description: "Correo corporativo (@liverpool.com.mx o @suburbia.com.mx)." },
                        rfc: { type: "STRING", description: "RFC con homoclave." },
                        sysapp: { type: "STRING", description: "Nombre de la aplicación (ej. SAP EWM, Directorio Activo, VPN)." },
                        user: { type: "STRING", description: "ID de usuario de acceso/login." }
                    },
                    required: ["action", "curp", "employnumber", "mail", "rfc", "sysapp", "user"]
                }
            }
        ]
    }];

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CFG.MODEL_ID}:generateContent?key=${CFG.GEMINI_API_KEY}`;
        const contents = history.concat([{ role: "user", parts: [{ text: message }] }]);

        const payload = {
            systemInstruction: getContextSophia(displayName || "Usuario"),
            contents,
            tools,
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        };

        const geminiResp = await axios.post(url, payload);
        const candidates = geminiResp.data.candidates;
        if (!candidates || candidates.length === 0 || !candidates[0].content) {
            const reason = candidates?.[0]?.finishReason || "UNKNOWN";
            return res.json({ tipo: "texto", respuesta: `Lo siento, la IA bloqueó la respuesta (Razón: ${reason}). Por favor intenta con otras palabras.` });
        }

        const candidate = candidates[0].content;
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
                    resultData = {
                        Status: "failed",
                        Error: umResp.Error,
                        Detalle: umResp.Detalle || "No se pudieron verificar los datos."
                    };
                } else {
                    const ticket = umResp.incident || extraerTicketUM(umResp);
                    resultData = {
                        Status: umResp.status, // "success" o "failed"
                        Ticket: ticket || "Generado",
                        Mensaje: umResp.detail || "Proceso finalizado."
                    };
                }
            }

            // Segunda llamada para resumir el resultado de la función
            const secondPayload = {
                systemInstruction: getContextSophia(displayName || "Usuario"),
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
            const secondCandidates = secondResp.data.candidates;
            if (!secondCandidates || secondCandidates.length === 0 || !secondCandidates[0].content) {
                return res.json({ tipo: "texto", respuesta: "Lo siento, la respuesta final fue bloqueada por filtros de seguridad. El proceso se realizó correctamente pero no puedo describirlo." });
            }
            const finalBotText = secondCandidates[0].content.parts[0].text;

            // Guardar toda la secuencia en el historial para mantener coherencia
            appendToHistory(chatId, "user", message);
            appendToHistory(chatId, "model", part); // Guarda la llamada a la función
            appendToHistory(chatId, "function", {  // Guarda la respuesta de la función
                functionResponse: { name, response: resultData }
            });
            appendToHistory(chatId, "model", finalBotText); // Guarda la respuesta final
            return res.json({ tipo: "texto", respuesta: finalBotText });
        }

        const botText = part.text;
        appendToHistory(chatId, "user", message);
        appendToHistory(chatId, "model", botText);
        res.json({ tipo: "texto", respuesta: botText });

    } catch (e) {
        console.error("Error en Chat:", e.response?.data || e.message);
        res.status(500).json({
            tipo: "error",
            respuesta: "Ocurrió un error interno al procesar tu solicitud.",
            message: e.message,
            detail: e.response?.data?.error?.message || "No hay más detalles"
        });
    }
});

app.listen(PORT, () => console.log(`SophIA Server running on port ${PORT}`));
