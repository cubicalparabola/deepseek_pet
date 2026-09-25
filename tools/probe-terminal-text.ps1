# 探针：**能不能真的拿到终端里的文本**（只读，不改任何东西）
#
# 结论（本机实测）：能。Windows Terminal 把缓冲区文本暴露在**子元素**上
# （`ControlType.Text` + `TextPattern`，UIA 树 8 层以内就能找到）——
# 顶层窗口上没有这个 pattern，只在顶层找会得出"拿不到"的错误结论。
#
# ⚠️ 顺带实测到一个必须一起处理的事实：**终端缓冲区里本来就有密钥/地址**。
# 探针输出里就出现过 `dsh web: http://127.0.0.1:3080/?token=...`。
# 所以线上取文本时必须：只取尾部、只在内存里用一次、**绝不落盘**、先做密钥打码、
# 且命中敏感词就整段不发（见 `src/main/perception/terminal-text.ts` 与
# `redactTerminalSecrets()`）。
#
# 只读承诺：不注入、不改窗口、不发按键、不碰剪贴板、不 attach 任何进程的控制台。
#
# 用法：pwsh -NoProfile -ExecutionPolicy Bypass -File tools/probe-terminal-text.ps1
# 输出：build/terminal-text-probe.json + 控制台摘要

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$outFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\terminal-text-probe.json'
$maxNodes = 400
$maxDepth = 8

function Shorten([string]$text, [int]$limit) {
  if ($null -eq $text) { return '' }
  $flat = $text -replace '\s+', ' '
  if ($flat.Length -le $limit) { return $flat }
  return $flat.Substring(0, $limit) + '…'
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# 只有这些进程才值得去读缓冲区（其余一律不碰）
$terminalLike = @('windowsterminal', 'windowsterminalpreview', 'conhost', 'cmd', 'powershell', 'pwsh',
  'wezterm', 'wezterm-gui', 'alacritty', 'mintty', 'tabby', 'xshell', 'putty', 'termius', 'wsl', 'wslhost')

$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)

$report = [ordered]@{ ok = $true; windows = @(); terminals = @() }

foreach ($element in $children) {
  $process = ''
  $title = ''
  $className = ''
  try {
    $title = [string]$element.Current.Name
    $className = [string]$element.Current.ClassName
    $proc = Get-Process -Id $element.Current.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $process = $proc.ProcessName }
  } catch { continue }
  $isTerminal = $terminalLike -contains $process.ToLower()

  # 逐元素（含子元素）试两种模式，找到第一个有文本的就停
  $best = $null
  $visited = 0
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($element, 0))
  while ($queue.Count -gt 0 -and $visited -lt $maxNodes -and $null -eq $best) {
    $item = $queue.Dequeue()
    $node = $item[0]
    $depth = $item[1]
    $visited++
    $text = ''
    $mode = ''
    try {
      $patternObject = $null
      if ($node.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$patternObject)) {
        $value = $patternObject.DocumentRange.GetText(-1)
        if ($null -ne $value -and $value.Trim().Length -gt 0) { $text = $value; $mode = 'TextPattern' }
      }
      if ($text -eq '') {
        $valueObject = $null
        if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valueObject)) {
          $value = $valueObject.Current.Value
          if ($null -ne $value -and $value.Trim().Length -gt 0) { $text = $value; $mode = 'ValuePattern' }
        }
      }
    } catch { /* 单个元素失败无所谓，继续找 */ }
    if ($text -ne '') {
      $best = [ordered]@{ mode = $mode; length = $text.Length; preview = Shorten $text 300; controlType = ''; className = '' }
      try {
        $best.controlType = [string]$node.Current.ControlType.ProgrammaticName
        $best.className = [string]$node.Current.ClassName
      } catch { /* 忽略 */ }
      break
    }
    if ($depth -lt $maxDepth) {
      try {
        $kids = $node.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($kid in $kids) { $queue.Enqueue(@($kid, $depth + 1)) }
      } catch { /* 忽略 */ }
    }
  }

  $row = [ordered]@{
    process = $process
    title = Shorten $title 50
    className = $className
    terminalLike = $isTerminal
    nodesVisited = $visited
    text = $best
  }
  $report.windows += $row
  if ($isTerminal) { $report.terminals += $row }
}

$report.terminalCount = $report.terminals.Count
$report.terminalsWithText = ($report.terminals | Where-Object { $null -ne $_.text }).Count
$report.windowsWithText = ($report.windows | Where-Object { $null -ne $_.text }).Count
$report | ConvertTo-Json -Depth 8 | Set-Content -Path $outFile -Encoding utf8

Write-Host "顶层窗口=$($report.windows.Count) 疑似终端=$($report.terminalCount) 终端取到文本=$($report.terminalsWithText) 任意窗口取到文本=$($report.windowsWithText)"
foreach ($row in $report.terminals) {
  if ($null -ne $row.text) {
    Write-Host ("[终端] {0} 模式={1} 长度={2} 访问节点={3} 控件={4}" -f $row.process, $row.text.mode, $row.text.length, $row.nodesVisited, $row.text.controlType)
    Write-Host ("    " + $row.text.preview)
  } else {
    Write-Host ("[终端] {0} 没取到文本（访问了 {1} 个节点）" -f $row.process, $row.nodesVisited)
  }
}
Write-Host "写出：$outFile"
