<#
    subir_llaves_produccion.ps1 — pone credenciales de pasarela en el .env del VPS.

    Por que existe: las llaves de produccion no deben pasar por el chat, ni quedar en un archivo
    del repo, ni en el historial de la terminal. Este script las pide por consola (sin eco), las
    manda por SSH por STDIN —nunca como argumentos, que se verian en el `ps` de cualquier usuario
    del servidor— y no las escribe en disco local.

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
Write-Host 'Deja una vacia (solo Enter) para no tocarla.'
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
foreach ($v in $aEscribir) {
    if ($v.Value -match '[\r\n]') { throw "$($v.Key) trae un salto de linea. Copiala de nuevo." }
}

# ── Script remoto ────────────────────────────────────────────────────────────────────────
# Sin `set -e`: un `grep` que no encuentra nada devuelve 1 y abortaria el script a la mitad,
# dejando las llaves puestas y el servicio SIN reiniciar (ya paso una vez).
$sb = [System.Text.StringBuilder]::new()
$null = $sb.AppendLine("set -u")
$null = $sb.AppendLine("ENV='$EnvPath'")
$null = $sb.AppendLine('BAK="$ENV.bak.$(date +%Y%m%d%H%M%S)"')
$null = $sb.AppendLine('cp "$ENV" "$BAK" && echo "  respaldo: $BAK"')

foreach ($v in $aEscribir) {
    $clave = $v.Key
    $valor = $v.Value -replace "'", "'\''"      # comilla simple segura dentro de '...'
    $null = $sb.AppendLine("VAL='$valor'")
    # Se reescribe el archivo entero sin la clave y se anade al final. Solo shell: nada de
    # sed (los valores traen / y &) ni python3 (que puede no estar instalado).
    $null = $sb.AppendLine("awk -v k='$clave=' 'index(`$0,k)!=1' `"`$ENV`" > `"`$ENV.tmp`"")
    $null = $sb.AppendLine("printf '%s=%s\n' '$clave' `"`$VAL`" >> `"`$ENV.tmp`"")
    $null = $sb.AppendLine("mv `"`$ENV.tmp`" `"`$ENV`" && echo '  $clave escrita'")
}
$null = $sb.AppendLine('unset VAL')
$null = $sb.AppendLine('chmod 600 "$ENV"')
$null = $sb.AppendLine('sudo systemctl restart escalapp-api')
$null = $sb.AppendLine('sleep 3')
$null = $sb.AppendLine('echo "  servicio: $(systemctl is-active escalapp-api)"')
$null = $sb.AppendLine('echo "--- verificacion (longitud y ultimos 4, nunca el valor) ---"')
$null = $sb.AppendLine(@'
while IFS= read -r linea; do
  k="${linea%%=*}"; v="${linea#*=}"
  case "$k" in
    DLOCAL_API_KEY|DLOCAL_SECRET_KEY|WOMPI_PUBLIC_KEY|WOMPI_PRIVATE_KEY|WOMPI_INTEGRITY_SECRET|WOMPI_EVENTS_SECRET|APP_PUBLIC_URL|APP_FRONTEND_URL|COBRANZA_SUCCESS_URL)
      if [ -n "$v" ]; then echo "  $k: ${#v} caracteres, termina en ...${v: -4}"; else echo "  $k: VACIA"; fi ;;
  esac
done < "$ENV"
'@)
$null = $sb.AppendLine('echo "--- que pasarela podria cobrar hoy ---"')
$null = $sb.AppendLine('cd /var/www/admin_ws && node -e ''require("dotenv").config({quiet:true});console.log(JSON.stringify(require("./app_core/cobranza").estadoDeConfiguracion()))''')

Write-Host ''
Write-Host "Conectando a $VpsHost ..." -ForegroundColor Cyan
$sb.ToString() | & $ssh -o BatchMode=yes -o ConnectTimeout=20 $VpsHost 'bash -s'
$code = $LASTEXITCODE

$vars = $null; $aEscribir = $null; $sb = $null
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
