# Smoke tests para el motor Sayasent Colombia desplegado en Cloud Run.
# Uso: .\test-service.ps1 -ServiceUrl "https://envios-meta-sayasent-colombia-xxxx.run.app"
param(
    [Parameter(Mandatory=$true)]
    [string]$ServiceUrl
)

$ErrorActionPreference = "Continue"
$passed = 0
$failed = 0

function Test-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "`n>> $Name" -ForegroundColor Yellow
    try {
        & $Action
        $script:passed++
    } catch {
        Write-Host "   FAIL: $($_.Exception.Message)" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host "Corriendo smoke tests contra: $ServiceUrl" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green

# 1. Health check
Test-Step "Health check (GET /health)" {
    $r = Invoke-RestMethod -Uri "$ServiceUrl/health" -Method GET
    if ($r.status -ne "ok") { throw "status esperado 'ok', recibido '$($r.status)'" }
    Write-Host "   OK — service: $($r.service)" -ForegroundColor Cyan
}

# 2. Root (info)
Test-Step "Root info (GET /)" {
    $r = Invoke-RestMethod -Uri "$ServiceUrl/" -Method GET
    if (-not $r.service) { throw "falta campo 'service' en respuesta" }
    Write-Host "   OK — $($r.service) v$($r.version)" -ForegroundColor Cyan
    Write-Host "   Endpoints expuestos: $($r.endpoints.Count)" -ForegroundColor Cyan
}

# 3. Listar campañas
Test-Step "Listar campañas (GET /api/campaigns)" {
    $r = Invoke-RestMethod -Uri "$ServiceUrl/api/campaigns" -Method GET
    if (-not $r.success) { throw "success=false: $($r.error)" }
    Write-Host "   OK — $($r.data.Count) campaña(s) registradas" -ForegroundColor Cyan
}

# 4. Listar templates
Test-Step "Listar templates (GET /api/templates)" {
    $r = Invoke-RestMethod -Uri "$ServiceUrl/api/templates" -Method GET
    if (-not $r.success) { throw "success=false: $($r.error)" }
    Write-Host "   OK — $($r.data.Count) template(s) registradas" -ForegroundColor Cyan
}

# 5. Listar contactos (sin filtros)
Test-Step "Listar contactos (GET /api/contacts)" {
    $r = Invoke-RestMethod -Uri "$ServiceUrl/api/contacts" -Method GET
    if (-not $r.success) { throw "success=false: $($r.error)" }
    Write-Host "   OK — $($r.data.Count) contacto(s) en BD" -ForegroundColor Cyan
}

# 6. Webhook verify (GET) — simular handshake de Meta
Test-Step "Webhook verify (GET /webhook/whatsapp)" {
    try {
        # Sin el verify_token correcto debe retornar 403
        Invoke-RestMethod -Uri "$ServiceUrl/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=x" -Method GET | Out-Null
        throw "debería haber retornado 403 con token incorrecto"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 403) {
            Write-Host "   OK — webhook rechaza token inválido (403 esperado)" -ForegroundColor Cyan
        } else {
            throw "status inesperado: $($_.Exception.Response.StatusCode)"
        }
    }
}

# 7. 404 genérico
Test-Step "404 para endpoint inexistente" {
    try {
        Invoke-RestMethod -Uri "$ServiceUrl/nonexistent-path-xyz" -Method GET | Out-Null
        throw "debería haber retornado 404"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) {
            Write-Host "   OK — 404 correcto" -ForegroundColor Cyan
        } else {
            throw "status inesperado: $($_.Exception.Response.StatusCode)"
        }
    }
}

Write-Host "`n=====================================================" -ForegroundColor Green
Write-Host "Resumen: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Yellow" })
Write-Host ""
Write-Host "Para un envío real de prueba:" -ForegroundColor Yellow
Write-Host "  1. Crea una campaña con al menos 1 contacto en el CRM (o directo por BD)" -ForegroundColor Cyan
Write-Host "  2. Corre: POST $ServiceUrl/api/campaigns/<UUID>/send" -ForegroundColor Cyan
Write-Host "  3. Revisa el mensaje en WhatsApp del número de prueba" -ForegroundColor Cyan
Write-Host "  4. Mira GET $ServiceUrl/api/campaigns/<UUID>/metrics para contactabilidad" -ForegroundColor Cyan
