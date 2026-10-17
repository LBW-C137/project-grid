# Only the isolated offline smoke's PowerShell. Ordinary prompts leave permission/question frames untouched.
$global:ReadingFixtureInputRow = $null
function global:prompt {
    if ($global:ReadingFixtureClearOnPrompt) {
        Clear-Host
        $global:ReadingFixtureClearOnPrompt = $false
    }
    if ($global:ReadingFixtureSlashSubmitted) {
        # PowerShell has actually executed the submitted slash command. Keep its echo and real error/output,
        # then append the next CLI input; clearing here would erase the only completion evidence.
        $global:ReadingFixtureSlashSubmitted = $false
        Show-ReadingFixtureInput
    }
    if ($null -ne $global:ReadingFixtureInputRow) {
        [Console]::SetCursorPosition(1, [int]$global:ReadingFixtureInputRow)
        $global:ReadingFixtureInputRow = $null
    }
    ' '
}
function global:Show-ReadingFixtureInput {
    Write-Host ([string][char]0x2500 * 40)
    Write-Host ([string][char]0x276F + ' ')
    Write-Host ([string][char]0x2500 * 40)
    Write-Host ('  ' + [char]0x23F8 + ' manual mode on')
    # Drawing at the bottom can scroll the console. Capture the input row after all four lines have landed.
    $global:ReadingFixtureInputRow = [Console]::CursorTop - 3
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
Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
    $line = $null
    $cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    $global:ReadingFixtureSlashSubmitted = $line.StartsWith('/')
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}
