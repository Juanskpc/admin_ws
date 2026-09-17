<#
    subir_llaves_produccion.ps1 — pone credenciales de pasarela en el .env del VPS.

    Por que existe: las llaves de produccion no deben pasar por el chat, ni quedar en un archivo
    del repo, ni en el historial de la terminal. Este script las pide por consola (sin eco), las
    manda por SSH por STDIN —nunca como argumentos, que se verian en el `ps` de cualquier usuario
    del servidor— y no las escribe en disco local.

    ⚠️ EJECUTALO EN UNA VENTANA DE POWERSHELL DE VERDAD, no desde el `!` de Claude Code ni desde
    una tarea automatizada: `Read-Host -AsSecureString` necesita una consola interactiva. Si no la
    tiene, captura un solo caracter y el script aborta antes de tocar nada (ya paso: 2026-09-16).

    Uso:
        cd "C:\Programacion\Proyecto pasivo\admin_ws"
        .\scripts\subir_llaves_produccion.ps1

    Es idempotente: si la variable ya existe la reemplaza, si no la agrega. Hace copia de
    seguridad del .env antes de tocarlo, reinicia escalapp-api y verifica el resultado mostrando
    solo la longitud y los ultimos 4 caracteres, nunca el valor.
#>

[CmdletBinding()]
param(
    [string]$VpsHost = 'escalapp@45.63.105.95',
    [string]$EnvPath = '/var/www/admin_ws/.env'
)

$ErrorActionPreference = 'Stop'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'   # el ssh de Git Bash no ve el agente de Windows
if (-not (Test-Path $ssh)) { throw "No se encontro $ssh" }

function Read-Secreto([string]$Etiqueta) {
    $seguro = Read-Host -Prompt $Etiqueta -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host ''
Write-Host '=== Llaves de PRODUCCION de dLocal Go ===' -ForegroundColor Cyan
Write-Host 'Estan en dashboard.dlocalgo.com -> Integrations -> API Integration'
Write-Host '(OJO: las de dashboard-sbx... son las de prueba, no sirven aqui)'
Write-Host 'Al pegar NO veras los caracteres. Deja una vacia (Enter) para no tocarla.'
Write-Host ''

$vars = [ordered]@{
    'DLOCAL_API_KEY'    = Read-Secreto 'DLOCAL_API_KEY'
    'DLOCAL_SECRET_KEY' = Read-Secreto 'DLOCAL_SECRET_KEY'
}

$aEscribir = @($vars.GetEnumerator() | Where-Object { $_.Value -and $_.Value.Trim() -ne '' })
if ($aEscribir.Count -eq 0) {
    Write-Host 'No ingresaste ninguna llave. Nada que hacer.' -ForegroundColor Yellow
    exit 0
}

# Validacion ANTES de conectar: mas vale abortar aqui que dejar media llave en produccion.
Write-Host ''
Write-Host 'Capturado:' -ForegroundColor Cyan
$problemas = @()
foreach ($v in $aEscribir) {
    Write-Host ("  {0}: {1} caracteres" -f $v.Key, $v.Value.Length)
    if ($v.Value -match '[\r\n]')      { $problemas += "$($v.Key) trae un salto de linea." }
    elseif ($v.Value.Length -lt 16)    { $problemas += "$($v.Key) solo tiene $($v.Value.Length) caracteres: el pegado no funciono." }
    elseif ($v.Value -notmatch '^[A-Za-z0-9_\-]+$') { $problemas += "$($v.Key) tiene caracteres raros; revisa que copiaste la llave y nada mas." }
}
if ($problemas.Count -gt 0) {
    Write-Host ''
    foreach ($p in $problemas) { Write-Host "  $p" -ForegroundColor Red }
    Write-Host ''
    Write-Host 'No se envio nada. Abre una ventana de PowerShell normal y vuelve a intentarlo;' -ForegroundColor Yellow
    Write-Host 'si el pegado con Ctrl+V no entra, prueba con clic derecho en la consola.' -ForegroundColor Yellow
    exit 1
}

# ── Script remoto ────────────────────────────────────────────────────────────────────────
# Se une con "`n" (LF) y NO con AppendLine, que en Windows escribe CRLF: bash trataba el \r
# como parte del nombre y buscaba "/var/www/admin_ws/.env\r" (2026-09-16). Ademas, al otro lado
# pasa por `tr -d '\r'` como segunda red.
#
# Sin `set -e`: un `grep` que no encuentra nada devuelve 1 y abortaria el script a la mitad,
# dejando las llaves puestas y el servicio SIN reiniciar (tambien paso ya).
$L = New-Object System.Collections.Generic.List[string]
$L.Add("set -u")
$L.Add("ENV='$EnvPath'")
$L.Add('BAK="$ENV.bak.$(date +%Y%m%d%H%M%S)"')
$L.Add('cp "$ENV" "$BAK" && echo "  respaldo: $BAK"')

foreach ($v in $aEscribir) {
    $clave = $v.Key
    $valor = $v.Value -replace "'", "'\''"      # comilla simple segura dentro de '...'
    $L.Add("VAL='$valor'")
    # Se reescribe el archivo sin la clave y se anade al final. Solo shell: nada de sed (los
    # valores traen / y &) ni python3 (que puede no estar instalado).
    $L.Add("awk -v k='$clave=' 'index(`$0,k)!=1' `"`$ENV`" > `"`$ENV.tmp`"")
    $L.Add("printf '%s=%s\n' '$clave' `"`$VAL`" >> `"`$ENV.tmp`"")
    $L.Add("mv `"`$ENV.tmp`" `"`$ENV`" && echo '  $clave escrita'")
}
$L.Add('unset VAL')
$L.Add('chmod 600 "$ENV"')
$L.Add('sudo systemctl restart escalapp-api')
$L.Add('sleep 3')
$L.Add('echo "  servicio: $(systemctl is-active escalapp-api)"')
$L.Add('echo "--- verificacion (longitud y ultimos 4, nunca el valor) ---"')
$L.Add('while IFS= read -r linea; do')
$L.Add('  k="${linea%%=*}"; v="${linea#*=}"')
$L.Add('  case "$k" in')
$L.Add('    DLOCAL_API_KEY|DLOCAL_SECRET_KEY|WOMPI_PUBLIC_KEY|WOMPI_PRIVATE_KEY|WOMPI_INTEGRITY_SECRET|WOMPI_EVENTS_SECRET|APP_PUBLIC_URL|APP_FRONTEND_URL|COBRANZA_SUCCESS_URL)')
$L.Add('      if [ -n "$v" ]; then echo "  $k: ${#v} caracteres, termina en ...${v: -4}"; else echo "  $k: VACIA"; fi ;;')
$L.Add('  esac')
$L.Add('done < "$ENV"')
$L.Add('echo "--- que pasarela podria cobrar hoy ---"')
$L.Add('cd /var/www/admin_ws && node -e ''require("dotenv").config({quiet:true});console.log(JSON.stringify(require("./app_core/cobranza").estadoDeConfiguracion()))''')

$remoto = ($L -join "`n") + "`n"

Write-Host ''
Write-Host "Conectando a $VpsHost ..." -ForegroundColor Cyan
# La limpieza se hace en el SERVIDOR y no aqui, porque no depende de la version de PowerShell:
#   \r              -> el CRLF de Windows, que bash metia dentro del nombre del archivo
#   \357\273\277    -> los tres bytes del BOM UTF-8 que PowerShell antepone al escribir al stdin
#                      de un exe nativo, y que se comia la primera linea del script
# Las dos cosas mordieron en 2026-09-16/17. $OutputEncoding NO basta para el BOM.
$remoto | & $ssh -o BatchMode=yes -o ConnectTimeout=20 $VpsHost "tr -d '\r\357\273\277' | bash"
$code = $LASTEXITCODE

$vars = $null; $aEscribir = $null; $L = $null; $remoto = $null
[GC]::Collect()

Write-Host ''
if ($code -eq 0) {
    Write-Host 'Llaves puestas. Falta activar la pasarela en la base de PRODUCCION:' -ForegroundColor Green
    Write-Host "  UPDATE cobranza.cob_pasarela SET estado='A' WHERE codigo='dlocal';"
    Write-Host 'Y el negocio de Chile necesita precio en CLP antes de poder cobrarle.' -ForegroundColor Yellow
} else {
    Write-Host "El script remoto termino con codigo $code. Revisa la salida de arriba." -ForegroundColor Red
}
exit $code
