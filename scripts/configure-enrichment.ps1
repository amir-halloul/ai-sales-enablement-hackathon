<#
.SYNOPSIS
    Prepares a Salesforce org to call the Acme enrichment API.

.DESCRIPTION
    1. Optionally points the Acme_Enrichment Named Credential at the API base URL
       (updates the source file and deploys it, so source and org stay in sync).
    2. Stores the API key in the Acme_Enrichment External Credential (principal "ApiKey").
       The key is sent as the X-API-Key header on every callout.

    The key is read from enrichment-api/.env (API_KEY=...). If that file does not exist, a
    random key is generated and written there so the API can use the same value.
    On the host, set the API's API_KEY variable to the same value.
    The key is never printed.

.EXAMPLE
    ./scripts/configure-enrichment.ps1
    ./scripts/configure-enrichment.ps1 -Url https://my-enrichment-api.onrender.com
    ./scripts/configure-enrichment.ps1 -PromptForKey
#>
param(
    [string] $TargetOrg = 'osfDev',
    [string] $Url,
    [switch] $PromptForKey
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot 'enrichment-api\.env'
$namedCredentialFile = Join-Path $projectRoot 'force-app\main\default\namedCredentials\Acme_Enrichment.namedCredential-meta.xml'
$apiVersion = 'v66.0'

function Invoke-SfRest([string] $Path, [string] $Method, [string] $BodyFile) {
    $output = & sf api request rest "/services/data/$apiVersion/$Path" --method $Method --body "@$BodyFile" --header 'Content-Type: application/json' --target-org $TargetOrg 2>&1 | Out-String
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Output = $output }
}

# --- 1. Callout URL -----------------------------------------------------------
if ($Url) {
    $parsed = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref] $parsed) -or $parsed.Scheme -ne 'https') {
        throw "Url must be an absolute https URL. Got: $Url"
    }
    $baseUrl = $parsed.GetLeftPart([UriPartial]::Path).TrimEnd('/')

    $xml = Get-Content -Raw -Path $namedCredentialFile
    $pattern = '(<parameterName>Url</parameterName>\s*<parameterType>Url</parameterType>\s*<parameterValue>)[^<]*(</parameterValue>)'
    if ($xml -notmatch $pattern) { throw "Could not find the Url parameter in $namedCredentialFile" }
    $xml = [regex]::Replace($xml, $pattern, { param($m) $m.Groups[1].Value + [Security.SecurityElement]::Escape($baseUrl) + $m.Groups[2].Value })
    [IO.File]::WriteAllText($namedCredentialFile, $xml, (New-Object Text.UTF8Encoding $false))

    Write-Host "Deploying Named Credential Acme_Enrichment -> $baseUrl"
    & sf project deploy start --source-dir $namedCredentialFile --target-org $TargetOrg --wait 10 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Named Credential deploy failed. Run the deploy manually to see the error.' }
}

# --- 2. API key ---------------------------------------------------------------
if ($PromptForKey) {
    $secure = Read-Host -AsSecureString 'Enrichment API key'
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
} elseif (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*API_KEY\s*=' } | Select-Object -First 1
    if (-not $line) { throw "API_KEY not found in $envFile" }
    $key = ($line -split '=', 2)[1].Trim()
    Write-Host "Using API key from $envFile"
} else {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    New-Item -ItemType Directory -Force -Path (Split-Path $envFile) | Out-Null
    Set-Content -Path $envFile -Value "API_KEY=$key" -Encoding ascii
    Write-Host "Generated a new API key and saved it to $envFile (git- and deploy-ignored)"
}
if ([string]::IsNullOrWhiteSpace($key)) { throw 'API key is empty.' }

$body = @{
    externalCredential = 'Acme_Enrichment'
    principalName      = 'ApiKey'
    principalType      = 'NamedPrincipal'
    credentials        = @{ Key = @{ value = $key; encrypted = $true } }
} | ConvertTo-Json -Depth 5

$bodyFile = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($bodyFile, $body, (New-Object Text.UTF8Encoding $false))

    # Update the stored credential if it exists, otherwise create it.
    $result = Invoke-SfRest 'named-credentials/credential' 'PUT' $bodyFile
    if (-not $result.Ok) {
        $result = Invoke-SfRest 'named-credentials/credential' 'POST' $bodyFile
    }
    if (-not $result.Ok) {
        throw "Could not store the API key in External Credential Acme_Enrichment:`n$($result.Output -replace [regex]::Escape($key), '***')"
    }
    Write-Host 'Stored API key in External Credential Acme_Enrichment (principal ApiKey).'
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $bodyFile
}
