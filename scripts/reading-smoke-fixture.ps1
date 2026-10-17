# Only the isolated offline smoke's PowerShell. Ordinary prompts leave permission/question frames untouched.
$global:ReadingFixtureInputRow = $null
function global:prompt {
    if ($global:ReadingFixtureClearOnPrompt) {
        Clear-Host
        $global:ReadingFixtureClearOnPrompt = $false
    }
    if ($null -ne $global:ReadingFixtureInputRow) {
        [Console]::SetCursorPosition(1, [int]$global:ReadingFixtureInputRow)
        $global:ReadingFixtureInputRow = $null
    }
    ' '
}
function global:Show-ReadingFixtureInput {
    Write-Host ([string][char]0x2500 * 40)
    $global:ReadingFixtureInputRow = [Console]::CursorTop
    Write-Host ([string][char]0x276F + ' ')
    Write-Host ([string][char]0x2500 * 40)
    Write-Host ('  ' + [char]0x23F8 + ' manual mode on')
}
# Actual local payload execution precedes the CLI-shaped result. Echo is not a no-output command.
function global:!echo {
    param([string]$Text)
    $result = Write-Output $Text
    Clear-Host
    Write-Host ('! echo ' + $Text)
    Write-Host ('  ' + [char]0x23BF + ' ' + $result)
    Show-ReadingFixtureInput
}
function global:!true {
    & { }
    Clear-Host
    Write-Host '! true'
    Write-Host ('  ' + [char]0x23BF + ' (Bash completed with no output)')
    Show-ReadingFixtureInput
}
Set-PSReadLineKeyHandler -Key '/' -ScriptBlock { Start-Sleep -Milliseconds 160; [Microsoft.PowerShell.PSConsoleReadLine]::Insert('/') }
