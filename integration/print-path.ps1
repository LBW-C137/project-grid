# Prints PATH with newly installed machine and user tools added (refresh-path.ps1), for Command Prompt
# terminals, which read it in bootstrap.cmd. Nothing is written to the registry.
. (Join-Path $PSScriptRoot 'refresh-path.ps1')
[Console]::Out.Write($env:Path)
