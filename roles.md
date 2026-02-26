# Roles y Permisos de Google Cloud para SophIA

Este documento detalla los roles mínimos necesarios para el despliegue y operación de SophIA en Google Cloud Platform (GCP).

## 1. Roles para el Administrador / Desarrollador
Estos permisos permiten construir, subir y desplegar el código en el proyecto.

| Rol | ID Técnico | Se usa en | Justificación |
| :--- | :--- | :--- | :--- |
| **Cloud Run Admin** | `roles/run.admin` | Cloud Run | Permite crear, actualizar y gestionar los servicios donde vive SophIA. |
| **Artifact Registry Admin** | `roles/artifactregistry.admin` | Artifact Registry | Permite crear repositorios y subir las imágenes de Docker. |
| **Cloud Build Editor** | `roles/cloudbuild.builds.editor` | Cloud Build | Permite ejecutar los procesos de compilación y despliegue automático. |
| **Service Account User** | `roles/iam.serviceAccountUser` | IAM / Cloud Run | Permite que Cloud Run use una identidad específica para ejecutar el servicio. |
| **Logs Viewer** | `roles/logging.viewer` | Cloud Logging | Permite ver los logs de error y la telemetría para depuración y reportes. |
| **Secret Manager Admin (Opcional)** | `roles/secretmanager.admin` | Secret Manager | Permite crear y gestionar las API Keys (Gemini, BMC) de forma segura. |
| **Cloud Build Builder (Opcional)** | `roles/cloudbuild.builds.builder` | Cloud Build | Requerido en algunos entornos para que la cuenta pueda ejecutar compilaciones. |
| **API Keys Admin (Opcional)** | `roles/apikeys.admin` | APIs & Services | Permite crear y restringir las llaves de API necesarias para Gemini. |
| **OAuth Config Editor (Opcional)** | `roles/oauthconfig.editor` | APIs & Services | **Crucial:** Permite configurar la pantalla de consentimiento y crear los Client IDs para el login corporativo. |

---

## 2. Roles para la Identidad del Servicio (Runtime)
Estos permisos los debe tener la **Service Account** asignada al servicio de Cloud Run (`sophia-runner`).

| Rol | ID Técnico | Se usa en | Justificación |
| :--- | :--- | :--- | :--- |
| **Logs Writer** | `roles/logging.logWriter` | Cloud Logging | Permite que SophIA escriba la telemetría y logs estructurados de uso. |
| **Artifact Registry Reader** | `roles/artifactregistry.reader` | Artifact Registry | Permite que Cloud Run descargue la imagen del contenedor para ejecutarla. |
| **Secret Manager Accessor** | `roles/secretmanager.secretAccessor` | Secret Manager | Permite leer API Keys (Gemini, BMC) de forma segura si se guardan ahí. |
| **Speech User** | `roles/speech.client` | Text-to-Speech | Permite que el backend haga llamadas a la API de voz de Google. |

---

## 3. APIs Necesarias (Activar en el proyecto)
- Cloud Run API
- Generative Language API (Gemini)
- Cloud Text-to-Speech API
- Artifact Registry API
- Cloud Build API
- Service Usage API (Necesaria para que el proyecto gestione sus propias cuotas y APIs)

---

## 4. ¿Qué es la Service Account y cómo solicitarla?

La **Service Account** es la "identidad" de SophIA. Imagínala como un usuario especial que no tiene contraseña y que solo sirve para que el código (Node.js) pueda hablar con otros servicios de Google (como la voz o los logs) de forma segura.

### ¿Debo pedirla o crearla yo?
Depende de los permisos que te den:

1.  **Si te dan el rol de EDITOR:** Tú mismo podrás crearla en la sección "IAM > Service Accounts". No necesitas pedírsela al admin.
2.  **Si el entorno es muy restringido:** Pídele al admin que cree una Service Account llamada `sophia-runner` y que le asigne los roles de la **Sección 2** de este documento.

**Recomendación:** Pide que te den permiso para crearla tú mismo (`roles/iam.serviceAccountAdmin` opcional), para que tengas autonomía total sobre la identidad del servicio.

---

## 5. Resumen para el Administrador
Si quieres simplificar la solicitud, puedes pedir el rol de **EDITOR** (`roles/editor`) sobre el proyecto. Esto te permitirá crear la Service Account, activar las APIs y gestionar todo sin depender de soporte técnico para cada pequeño cambio.
---

## 6. Nota sobre Sesiones en Producción (Alta Disponibilidad)
Actualmente, SophIA guarda las sesiones de usuario en la memoria del servidor (`express-session` con memoria RAM). Si en el futuro escalas a **múltiples instancias** de Cloud Run para manejar más usuarios, las sesiones se perderán entre una llamada y otra.

**Para producción robusta (Opcional):**
1.  Activar la API de **Memorystore for Redis**.
2.  Asignar el rol `roles/redis.editor` a tu usuario.
3.  Configurar un Serverless VPC Connector.

*Por ahora, con una sola instancia, esto no es necesario.*
