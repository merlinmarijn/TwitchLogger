[CmdletBinding()]
param(
  [string]$DumpPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$composePath = Join-Path $repoRoot 'compose.local-db.yaml'
$backupDirectory = Join-Path $repoRoot 'data\backups'

if (-not $DumpPath) {
  $DumpPath = Join-Path $backupDirectory 'production-baseline.dump'
}

$resolvedDump = (Resolve-Path -LiteralPath $DumpPath).Path
$resolvedBackupDirectory = (Resolve-Path -LiteralPath $backupDirectory).Path
if (-not $resolvedDump.StartsWith($resolvedBackupDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The dump must be stored under $resolvedBackupDirectory so the database container can read it."
}

$expectedHashPath = "$resolvedDump.sha256"
if (Test-Path -LiteralPath $expectedHashPath) {
  $expectedHash = (Get-Content -LiteralPath $expectedHashPath -Raw).Trim().Split(' ')[0]
  $stream = [IO.File]::OpenRead($resolvedDump)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      $actualHash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
  if ($actualHash -ne $expectedHash) {
    throw "Backup checksum mismatch. Expected $expectedHash but found $actualHash."
  }
}

docker compose --env-file (Join-Path $repoRoot '.env') -f $composePath up -d postgres
if ($LASTEXITCODE -ne 0) {
  throw 'Could not start the local PostgreSQL container.'
}

$container = 'twitchlogger-local-postgres'
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $status = docker inspect --format '{{.State.Health.Status}}' $container 2>$null
  if ($status -eq 'healthy') {
    $healthy = $true
    break
  }
  Start-Sleep -Seconds 1
}

if (-not $healthy) {
  throw 'Local PostgreSQL did not become healthy within 30 seconds.'
}

$containerDumpPath = '/backups/' + [IO.Path]::GetFileName($resolvedDump)

Write-Host 'Resetting the local twitchlogger database from the production baseline...'
docker exec $container dropdb --if-exists --force --username twitchlogger_local twitchlogger
if ($LASTEXITCODE -ne 0) { throw 'Could not drop the local database.' }

docker exec $container createdb --username twitchlogger_local twitchlogger
if ($LASTEXITCODE -ne 0) { throw 'Could not create the local database.' }

docker exec $container pg_restore --username twitchlogger_local --dbname twitchlogger --no-owner --no-acl --exit-on-error $containerDumpPath
if ($LASTEXITCODE -ne 0) { throw 'Could not restore the local database.' }

docker exec $container vacuumdb --username twitchlogger_local --dbname twitchlogger --analyze-only | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Restore succeeded, but ANALYZE failed.' }

docker exec $container psql --username twitchlogger_local --dbname twitchlogger --no-psqlrc --tuples-only --command "SELECT 'tables=' || count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'; SELECT 'chat_messages=' || count(*) FROM public.chat_messages; SELECT 'schema_migrations=' || count(*) FROM public.schema_migrations;"
if ($LASTEXITCODE -ne 0) { throw 'Restore succeeded, but verification queries failed.' }

Write-Host "Local database reset complete from $resolvedDump"
