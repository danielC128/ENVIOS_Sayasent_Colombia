# Script completo para deployment con configuracion automatica desde .env
param(
    [string]$ProjectId = "codigopagomaquisistema",
    [string]$Region = "us-west1",
    [string]$ServiceName = "envios-meta-sayasent-colombia",
    [string]$ImageName = "envios-meta-colombia",
    [string]$EnvFile = ".env",
    [string]$ServiceAccountEmail = "sql-conexion@codigopagomaquisistema.iam.gserviceaccount.com"

)

Write-Host "DEPLOYMENT COMPLETO: WhatsApp Campaign Service" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green

# Verificar prerequisitos (sin cambios)
Write-Host "`nVerificando prerequisitos..." -ForegroundColor Yellow
# ... (código de verificación sin cambios) ...

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Write-Host "Error: gcloud CLI no esta instalado" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Docker no esta instalado" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $EnvFile)) {
    Write-Host "Error: Archivo $EnvFile no encontrado" -ForegroundColor Red
    exit 1
}
Write-Host "Todos los prerequisitos OK" -ForegroundColor Green

# PASO 1: Configurar proyecto y APIs (sin cambios)
Write-Host "`nPASO 1: Configurando proyecto y APIs..." -ForegroundColor Yellow
gcloud config set project $ProjectId
gcloud services enable run.googleapis.com cloudbuild.googleapis.com containerregistry.googleapis.com

# PASO 2: Construir y subir imagen (sin cambios)
Write-Host "`nPASO 2: Construyendo imagen Docker..." -ForegroundColor Yellow
gcloud auth configure-docker --quiet
docker build -t "gcr.io/$ProjectId/${ImageName}:latest" .
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Fallo la construccion de la imagen" -ForegroundColor Red
    exit 1
}
Write-Host "Subiendo imagen a Container Registry..." -ForegroundColor Cyan
docker push "gcr.io/$ProjectId/${ImageName}:latest"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Fallo la subida de la imagen" -ForegroundColor Red
    exit 1
}

# <-- CAMBIO CLAVE: PASO 3 ahora prepara las variables ANTES de desplegar -->
Write-Host "`nPASO 3: Preparando variables de entorno desde $EnvFile..." -ForegroundColor Yellow

# Crear archivo temporal para variables de entorno en formato YAML
$envVarsFile = ".env.yaml"
$yamlContent = "NODE_ENV: production`n"

Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line -match '^([^=]+)=(.*)$') {
        $key = $matches[1].Trim()
        $value = $matches[2].Trim()

        # Skip variables que Cloud Run maneja automáticamente
        if ($key -eq "PORT" -or $key -eq "NODE_ENV") {
            Write-Host "   Saltando variable reservada: $key" -ForegroundColor Gray
            return
        }

        # Remover comillas externas
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        # Escapar comillas dobles dentro del valor para YAML
        $value = $value.Replace('"', '\"')

        # Agregar al YAML con comillas para valores complejos
        $yamlContent += "${key}: `"$value`"`n"
        Write-Host "   $key preparado para despliegue" -ForegroundColor Cyan
    }
}

# Guardar archivo YAML temporal
$yamlContent | Out-File -FilePath $envVarsFile -Encoding UTF8 -NoNewline
Write-Host "   Archivo de variables creado: $envVarsFile" -ForegroundColor Green

# <-- CAMBIO CLAVE: PASO 4 ahora usa --env-vars-file -->
Write-Host "`nPASO 4: Desplegando servicio en Cloud Run con todas las variables..." -ForegroundColor Yellow
gcloud run deploy $ServiceName `
    --image "gcr.io/$ProjectId/${ImageName}:latest" `
    --platform managed `
    --region $Region `
    --allow-unauthenticated `
    --max-instances 5 `
    --memory 4Gi `
    --cpu 4 `
    --timeout 3600 `
    --concurrency 25 `
    --env-vars-file $envVarsFile `
    --vpc-connector "projects/codigopagomaquisistema/locations/us-west1/connectors/sql-conector-react" `
    --service-account $ServiceAccountEmail `
    --quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Fallo el deployment en Cloud Run" -ForegroundColor Red
    exit 1
}

# PASO 5: Verificar deployment (sin cambios)
Write-Host "`nPASO 5: Verificando deployment..." -ForegroundColor Yellow
$ServiceUrl = gcloud run services describe $ServiceName --project $ProjectId --platform managed --region $Region --format 'value(status.url)'

# RESULTADO FINAL (sin cambios)
Write-Host "`nDEPLOYMENT COMPLETADO EXITOSAMENTE!" -ForegroundColor Green
# ... (resto del script de salida sin cambios) ...
Write-Host "   URL: $ServiceUrl" -ForegroundColor White
