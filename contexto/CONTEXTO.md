# Contexto del proyecto — Sayasent_Colombia (motor de envíos WhatsApp #2)

> Este documento resume el estado del proyecto, las decisiones tomadas y el plan de trabajo. Leer completo antes de continuar.

---

## 1. Quién soy y qué estoy haciendo

- **Usuario:** Daniel (email corporativo: marco@sayainvestments.co — aunque el usuario de GitHub es `danielC128`).
- **Objetivo inmediato:** Desplegar un **segundo motor de envíos masivos de WhatsApp** en Google Cloud Run, asociado a un **nuevo número de WhatsApp** distinto al original. El nuevo proyecto es para **Sayasent Colombia**.
- **Base de partida:** Se está partiendo de un proyecto ya existente y funcionando en producción (`envios-meta_cod_pago`), que es el motor de envíos original desplegado en Cloud Run.

---

## 2. El proyecto original (`envios-meta_cod_pago`)

### Ubicación
`C:\Proyectos Saya\envios-meta_cod_pago (2)\envios-meta_cod_pago`

### Qué es
Servicio backend Node.js + Express que envía campañas masivas de WhatsApp usando la **Meta Business API** (no Twilio — aunque el schema aún tiene campos legacy `twilio_sid`). Desplegado en **Google Cloud Run**.

### Stack técnico
- **Runtime:** Node.js con ESM (`"type": "module"`)
- **Framework:** Express 4.18
- **ORM:** Prisma 5.22 sobre **PostgreSQL**
- **Conexión a DB:** Cloud SQL Connector (socket Unix `/tmp/.s.PGSQL.5432` en producción; IP privada)
- **Integraciones:** Firebase Admin (Firestore), CORS
- **Deploy:** Docker → Cloud Run. Scripts locales `deploy-simple.ps1` (PowerShell) y `deploy.sh` (bash).

### Variables de entorno clave
```
# Cloud SQL
INSTANCE_CONNECTION_NAME, DB_USER, DB_PASS, DB_NAME, DB_SCHEMA

# Meta Business API
META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID

# Firebase
FIREBASE_CREDENTIALS (JSON del service account)

# App
NODE_ENV, PORT
```

### Endpoints
- `GET /health` — health check para Cloud Run
- `GET /` — info del servicio
- `POST /api/campaigns/:id/send` — dispara el envío de una campaña
- `GET /api/campaigns/:id/status` — estado de una campaña

### Configuración de rendimiento (ver `index.js`, constante `RATE_LIMIT`)
- 50 mensajes/segundo
- Lotes de 100 clientes
- 3 lotes concurrentes
- Recursos Cloud Run: 2 CPU, 2 GB RAM, timeout 1h, concurrencia 100

### Modelo de datos (PostgreSQL, via Prisma — `prisma/schema.prisma`)
Tablas principales:
- `campanha` — definición de campañas (nombre, template_id, variable_mappings JSON, tipo in/out)
- `cliente` — datos del cliente (incluye `code_pago`, `celular`, `nombre`, etc.)
- `cliente_campanha` — relación N:M cliente-campaña con tracking de envío (whatsapp_message_id, estado_mensaje, error_code)
- `template` — plantillas de WhatsApp aprobadas en Meta (nombre_template, template_content_sid)
- `codigo_pago` — códigos de pago por cliente (id_contrato, numero_cuota, fecha_vencimiento)
- `envios_directos` — envíos one-off sin cliente asociado
- `mensaje_out` + `mensaje_status_event` — tracking de mensajes con webhook events de Meta
- Otras: `cita`, `pago`, `accion_comercial`, `historico_*`, `leadh`, `conversacion`, `persona`, `usuario`, `rol`

### Variante `cod_pago`
El nombre de la carpeta original (`envios-meta_cod_pago`) indica que **esta versión añade soporte para usar `cliente.code_pago` como variable en las plantillas de WhatsApp** (aparece referenciado en `index.js:457`). Es decir, cuando la campaña tiene `variable_mappings` que incluyen `code_pago`, el servicio inyecta ese valor al mandar la plantilla a Meta.

### Estado del repo original en git
- Remote `origin`: `https://github.com/Gian2560/envios-meta.git` (repo de otra persona, `Gian2560`)
- Rama: `main`, último commit `327403a fix - depli simple index`
- **IMPORTANTE:** El usuario confirmó que **hace tiempo dejó de subirse los cambios al repo original de Gian**. El proyecto se trata como local. Los despliegues se hacían directamente desde la máquina local → Cloud Run vía Docker.
- Había cambios sin commitear: `Dockerfile`, `index.js`, `index-simple.js`, `package.json`, `prisma/schema.prisma`, `deploy-simple.ps1` (modificados); varios scripts `.ps1` eliminados; y archivos sueltos `.env`, `.env.yaml`, `.envfalso`, `apply-logs.js`, `patch.sed` como untracked.

### Advertencia de seguridad
- El proyecto original **no tenía `.gitignore`**.
- Los archivos `.env`, `.env.yaml`, `.envfalso` contienen secretos (DB passwords, Meta tokens, credenciales Firebase). **Nunca fueron commiteados** (estaban untracked), así que no hay leak.
- No se verificó si los scripts `.ps1` committeados en el historial (`configure-env.ps1`, `configure-env-from-file.ps1`) contienen credenciales hardcoded — esa verificación quedó pendiente cuando se decidió hacer fresh start.

---

## 3. El proyecto nuevo (Sayasent_Colombia)

### Ubicación
`C:\Proyectos Saya\4-Envíos\Sayasent_Colombia`

### Repositorio GitHub (nuevo, vacío, creado por el usuario)
`https://github.com/danielC128/ENVIOS_Sayasent_Colombia.git`

### Qué se ha hecho hasta ahora
1. **Copia del proyecto original** a la nueva carpeta, excluyendo:
   - `.git/` (fresh start — sin historial del original)
   - `node_modules/`
   - `.env`, `.env.yaml`, `.envfalso` (secretos)
2. **Creación de `.gitignore`** apropiado en la nueva carpeta (ya protege `.env*`, `node_modules`, `.claude/`, logs, scratch files, etc.).

### Archivos copiados a la nueva carpeta
```
.claude/                 (config local de Claude Code - ignorado por .gitignore)
.dockerignore
.dockerignore-new        (posible duplicado - pendiente decidir si borrar)
.env.example             (vacío)
.gitignore               (nuevo, recién creado)
apply-logs.js            (scratch - pendiente decidir si borrar)
cloud-run-service.yaml
contexto/                (esta carpeta)
deploy-simple.ps1
deploy.sh
Dockerfile
index.js                 (~968 líneas - el motor principal)
index-simple.js          (~989 líneas - pendiente confirmar si se usa)
package.json
patch.sed                (scratch - pendiente decidir si borrar)
prisma/schema.prisma
QUICK_COMMANDS.md
README.md
test-service.ps1
```

### Pendiente antes del primer commit + push
El usuario aún no confirmó:
- Si borrar físicamente los archivos scratch (`apply-logs.js`, `patch.sed`, `.dockerignore-new`) o dejarlos.
- Cuál es el archivo de entrada real: `index.js` o `index-simple.js` (ambos hacen cosas muy parecidas; `package.json` apunta a `server.js` en sus scripts, pero ese archivo no existe en la carpeta — esto es una inconsistencia del proyecto original que hay que resolver).
- Si `QUICK_COMMANDS.md` sigue siendo útil.

---

## 4. Decisiones tomadas en la conversación

1. **No pasar por Cloud Shell** — El usuario originalmente planeaba subir el proyecto a GitHub y clonarlo desde Cloud Shell de GCP para modificarlo ahí. Se decidió que es más eficiente **trabajar localmente** (ya están todas las herramientas: `gcloud`, Docker, editor) y usar GitHub como respaldo/source of truth, no como paso intermedio obligatorio.

2. **Fresh start en git** — No preservar historial del repo original de Gian. Se inicia repo nuevo con commit limpio en `C:\Proyectos Saya\4-Envíos\Sayasent_Colombia`.

3. **El nuevo repo es privado del usuario** (`danielC128/ENVIOS_Sayasent_Colombia`), ya creado vacío en GitHub.

4. **Seguridad de credenciales** — El usuario **NO debe pasar tokens/passwords por el chat**. Para autenticar el push a GitHub, se hará por navegador o PAT directamente desde git cuando lo pida. `gh` CLI no está instalado en esta máquina.

---

## 5. Plan de trabajo (próximos pasos)

### Fase 1 — Preparar el repo nuevo
1. Limpiar archivos scratch de la carpeta (tras confirmación del usuario).
2. Resolver la inconsistencia de `index.js` vs `index-simple.js` vs `server.js` (qué archivo arranca realmente).
3. `git init` en `C:\Proyectos Saya\4-Envíos\Sayasent_Colombia`.
4. Primer commit: "initial import from envios-meta base".
5. `git remote add origin https://github.com/danielC128/ENVIOS_Sayasent_Colombia.git`.

### Fase 2 — Modificar para Colombia
El proyecto es casi igual al original, pero apunta a **otro número de WhatsApp**. Cambios probables:
- **Variables de entorno** distintas en Cloud Run (nuevo `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_BUSINESS_ACCOUNT_ID`). Estas se configuran en Cloud Run, **no** en el código.
- **Nombre del servicio Cloud Run** — el original era `envios-meta-service`; el nuevo probablemente `sayasent-colombia-envios` o similar. Ajustar en `deploy-simple.ps1` / `deploy.sh` / `cloud-run-service.yaml`.
- **Nombre de imagen Docker** en el registry (`gcr.io/PROJECT/sayasent-colombia:latest`).
- Posiblemente **base de datos distinta** (otro Cloud SQL instance, u otro schema dentro del mismo) — confirmar con el usuario.
- Posibles diferencias en **templates de Meta** aprobadas para el número nuevo (el `template_content_sid` en la tabla `template` apuntará a otras plantillas).
- **Región de Cloud Run** — puede cambiar si Colombia requiere otra región (ej. `southamerica-east1` en vez de `us-central1`).

### Fase 3 — Deploy y push
1. Segundo commit con los ajustes para Colombia.
2. `git push -u origin main` (primera autenticación a GitHub por navegador/PAT).
3. Build y deploy a Cloud Run con `deploy-simple.ps1`.
4. Configurar variables de entorno del nuevo servicio en Cloud Run (las reales, NO commiteadas).
5. Probar `/health` y un envío de prueba.

---

## 6. Información adicional relevante

### Cosas que el usuario dijo en la conversación
- *"hace tiempo que dejó de subirse los cambios hechos aquí al repositorio original, este proyecto es más local que algo que se subía a un repositorio"* — por eso fresh start es seguro.
- *"antes, esto se desplegaba desde una computadora local a cloud run, como un docker, entonces esas credenciales se seteaban no sé dónde"* — las credenciales vivían en variables de entorno de Cloud Run y/o en archivos `.env` locales, NUNCA deben subirse al repo.
- *"nos han pedido hacer lo mismo pero para otro número de wsp"* — confirma que es el mismo motor, solo cambia el número de WhatsApp.

### Cosas que hay que confirmar con el usuario al retomar
1. Archivo de entrada real (`index.js` vs `index-simple.js` vs falta `server.js`).
2. Borrar o no los scratch (`apply-logs.js`, `patch.sed`, `.dockerignore-new`).
3. ¿Se usa la misma base de datos Cloud SQL que el original, o una nueva?
4. ¿Nombre exacto que quiere para el servicio Cloud Run nuevo?
5. Los tokens/credenciales del nuevo número de WhatsApp ¿ya los tiene o los consigue después?
6. ¿Región de Cloud Run para el nuevo despliegue?

### Entorno de trabajo
- **OS:** Windows 11 Pro
- **Shell:** Git Bash (el usuario usa Claude Code con Bash tool en sintaxis Unix)
- **Herramientas disponibles localmente:** Docker, gcloud CLI, Node.js, git, PowerShell
- **Herramientas NO disponibles:** `gh` CLI (GitHub CLI — no instalado)

### Referencias
- Proyecto original: `C:\Proyectos Saya\envios-meta_cod_pago (2)\envios-meta_cod_pago`
- Proyecto nuevo: `C:\Proyectos Saya\4-Envíos\Sayasent_Colombia`
- Repo destino: `https://github.com/danielC128/ENVIOS_Sayasent_Colombia.git`
- README detallado del original (deploy, endpoints, schema): `../README.md` en la carpeta nueva
- Schema completo: `../prisma/schema.prisma`

---

## 7. Cómo retomar desde este documento

Si estás abriendo una nueva sesión de Claude desde esta carpeta, aquí tienes las acciones inmediatas sugeridas:

1. **Leer este documento completo.**
2. **Leer `../README.md` y `../prisma/schema.prisma`** para entender el dominio.
3. **Preguntar al usuario las 6 confirmaciones pendientes** de la sección 6.
4. **NO hacer `git init` todavía** hasta tener las respuestas (especialmente sobre scratch files e `index-simple.js`).
5. **NO commitear ni pushear nada** sin verificar que `.gitignore` está activo y ningún `.env` ha quedado rastreado.
6. Cuando se haga push, el usuario se autenticará con GitHub **directamente** (navegador o PAT) — no pedirle credenciales nunca.
