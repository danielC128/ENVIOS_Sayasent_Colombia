# WhatsApp Campaign Service - Google Cloud Run

Servicio para envío masivo de campañas de WhatsApp Business optimizado para Google Cloud Run.

## 🚀 Características

- ✅ Envío masivo de mensajes WhatsApp usando Meta Business API
- ✅ Procesamiento por lotes optimizado con paralelismo controlado
- ✅ Rate limiting inteligente para cumplir con límites de API
- ✅ Integración con Prisma ORM y PostgreSQL
- ✅ Integración con Firebase Firestore
- ✅ Health checks para Cloud Run
- ✅ Logging estructurado y monitoreo
- ✅ Manejo graceful de errores y reintentos
- ✅ Optimizado para contenedores y escalamiento automático

## 🏗️ Arquitectura

```
[Client] → [Cloud Run] → [Meta Business API]
             ↓
         [PostgreSQL] → [Firebase Firestore]
```

## 📋 Requisitos Previos

1. **Google Cloud Project** configurado
2. **Docker** instalado
3. **gcloud CLI** instalado y configurado
4. **Meta Business API** configurada con:
   - Access Token
   - Phone Number ID
   - Business Account ID
5. **PostgreSQL** database accesible
6. **Firebase** project con service account

## 🛠️ Configuración

### 1. Clonar y configurar el proyecto

```bash
git clone [tu-repo]
cd envios-meta
```

### 2. Configurar variables de entorno

Las siguientes variables son requeridas:

```bash
# Database
DATABASE_URL="postgresql://usuario:password@host:5432/database"

# Meta Business API
META_ACCESS_TOKEN="tu_access_token"
META_PHONE_NUMBER_ID="tu_phone_number_id"
META_BUSINESS_ACCOUNT_ID="tu_business_account_id"

# Firebase
FIREBASE_CREDENTIALS='{"type": "service_account", "project_id": "...", ...}'

# App
NODE_ENV="production"
PORT="8080"
```

### 3. Configurar deployment

Edita las variables en `deploy.ps1` o `deploy.sh`:

```powershell
$PROJECT_ID = "tu-google-cloud-project-id"
$REGION = "us-central1"  # o tu región preferida
```

## 🚀 Deployment en Google Cloud Run

### Opción 1: Script automático (Windows)

```powershell
# Ejecutar desde PowerShell
.\deploy.ps1
```

### Opción 2: Script automático (Linux/Mac)

```bash
# Hacer ejecutable y ejecutar
chmod +x deploy.sh
./deploy.sh
```

### Opción 3: Comandos manuales

```bash
# 1. Configurar proyecto
gcloud config set project TU_PROJECT_ID

# 2. Habilitar APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable containerregistry.googleapis.com

# 3. Construir y subir imagen
docker build -t gcr.io/TU_PROJECT_ID/envios-meta:latest .
docker push gcr.io/TU_PROJECT_ID/envios-meta:latest

# 4. Desplegar en Cloud Run
gcloud run deploy envios-meta-service \
    --image gcr.io/TU_PROJECT_ID/envios-meta:latest \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --max-instances 10 \
    --memory 2Gi \
    --cpu 2 \
    --timeout 3600 \
    --concurrency 100
```

### 4. Configurar variables de entorno en Cloud Run

```bash
gcloud run services update envios-meta-service \
    --region us-central1 \
    --set-env-vars \
    DATABASE_URL="postgresql://...",\
    META_ACCESS_TOKEN="tu_token",\
    META_PHONE_NUMBER_ID="tu_phone_id",\
    META_BUSINESS_ACCOUNT_ID="tu_business_id",\
    FIREBASE_CREDENTIALS='{"type":"service_account",...}'
```

## 📱 Endpoints

### Health Check
```http
GET /health
```

### Root Information
```http
GET /
```

### Enviar Campaña
```http
POST /api/campaigns/:id/send
```

**Ejemplo:**
```bash
curl -X POST "https://tu-servicio-url.run.app/api/campaigns/123/send" \
     -H "Content-Type: application/json"
```

## 🔧 Configuración de Rendimiento

El servicio está optimizado con:

- **Procesamiento por lotes**: 100 clientes por lote
- **Rate limiting**: 50 mensajes por segundo
- **Paralelismo**: 3 lotes concurrentes
- **Recursos**: 2 CPU, 2GB RAM
- **Timeout**: 1 hora
- **Concurrencia**: 100 requests simultáneos

### Ajustar configuración

Modifica las constantes en `index.js`:

```javascript
const RATE_LIMIT = {
  messagesPerSecond: 50,
  batchSize: 100,
  concurrentBatches: 3,
  // ...
};
```

## 📊 Monitoreo

### Logs

Ver logs en tiempo real:
```bash
gcloud run logs tail envios-meta-service --region us-central1
```

### Métricas

El servicio reporta:
- ✅ Mensajes enviados exitosamente
- ❌ Mensajes fallidos con códigos de error
- ⏱️ Tiempo de procesamiento
- 📈 Tasa de éxito
- 🚀 Mensajes por segundo

### Health Check

```bash
curl https://tu-servicio-url.run.app/health
```

## 🛡️ Seguridad

- ✅ Contenedor no-root
- ✅ Variables de entorno seguras
- ✅ HTTPS obligatorio
- ✅ Rate limiting
- ✅ Validación de entrada
- ✅ Manejo seguro de errores

## 📋 Base de Datos

### Schema Prisma

El servicio usa las siguientes tablas principales:
- `campanha`: Definición de campañas
- `cliente`: Información de clientes
- `cliente_campanha`: Relación cliente-campaña
- `template`: Plantillas de mensajes

### Migraciones

```bash
npx prisma migrate deploy
npx prisma generate
```

## 🔍 Troubleshooting

### Error común: "Template no aprobado"

Verifica que tu template esté aprobado en Meta Business Manager:
1. Ve a Meta Business Manager
2. Configuración → Plantillas de WhatsApp
3. Verifica que el estado sea "APROBADO"

### Error común: "Variables de entorno faltantes"

Verifica que todas las variables estén configuradas:
```bash
gcloud run services describe envios-meta-service \
    --region us-central1 \
    --format "export" | grep -A 20 "env:"
```

### Error común: "Database connection failed"

Verifica la conexión a la base de datos:
1. Confirma que `DATABASE_URL` esté correctamente formateada
2. Verifica conectividad de red
3. Confirma credenciales

## 📈 Escalamiento

Cloud Run escala automáticamente según la carga:
- **Mínimo**: 0 instancias (costo cero cuando no hay tráfico)
- **Máximo**: 10 instancias (configurable)
- **Cold start**: ~2-3 segundos
- **Escalamiento**: Automático basado en CPU y requests

## 💰 Costos

Aproximadamente para 1000 campañas/mes:
- **Cloud Run**: ~$15-30/mes
- **Container Registry**: ~$5/mes
- **Network**: Variable según volumen

## 📞 Soporte

Para problemas o preguntas:
1. Revisar logs: `gcloud run logs tail envios-meta-service`
2. Verificar health check: `/health`
3. Revisar variables de entorno
4. Consultar documentación de Meta Business API

---

## 🔄 Actualización

Para actualizar el servicio:

```bash
# 1. Hacer cambios en el código
# 2. Reconstruir imagen
docker build -t gcr.io/TU_PROJECT_ID/envios-meta:latest .
docker push gcr.io/TU_PROJECT_ID/envios-meta:latest

# 3. Redesplegar
gcloud run services update envios-meta-service \
    --image gcr.io/TU_PROJECT_ID/envios-meta:latest \
    --region us-central1
```

¡Tu servicio de campañas WhatsApp está listo para Google Cloud Run! 🚀
