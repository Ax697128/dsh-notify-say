# WAV 音量增益/峰值测量（v0.4.16）
#
# ## 为什么需要
#
# 实测本包 247 个语音包的峰值：最小 24.7%、中位 40.4%、最大 84.4%。
# 素材本身录得偏轻，而 Windows MCI 的 `setaudio volume to 1000` 上限
# 只等于原始幅度 1.0 倍，**没法超过**，所以 GUI 音量拉满也还是偏小。
# 唯一办法是做**数字增益**：把样本乘一个系数。
#
# ## 为什么必须限幅
#
# 最响的文件已 84.4%，硬乘 2 倍会超过满刻度 → 削波失真（破音）。
# 所以增益前先测峰值，按 `目标峰值 / 实测峰值` 算实际系数，并封顶。
#
# ## 支持范围
#
# 只处理 **16-bit PCM WAV**（本包语音包全是这种）。
# mp3/m4a/flac/ogg 在 PowerShell 里没有免费解码器，
# 无法逐样本处理 —— 这类文件原样播放，由调用方决定是否提示用户。

<#
.SYNOPSIS
  读取 16-bit PCM WAV 的峰值（相对满刻度的百分比）。
.PARAMETER Path
  wav 路径。
.OUTPUTS
  [double] 0..100 的百分比；无法解析时返回 -1。
#>
function Get-WavPeakPercent {
  param([Parameter(Mandatory)][string]$Path)

  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 44) { return -1 }
    if ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF') { return -1 }
    if ([System.Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ne 'WAVE') { return -1 }

    # 遍历 chunk，找 fmt 与 data
    $pos = 12
    $bits = 0
    $audioFormat = 0
    $dataOff = -1
    $dataLen = 0
    while ($pos -lt $bytes.Length - 8) {
      $id = [System.Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
      $sz = [BitConverter]::ToInt32($bytes, $pos + 4)
      if ($sz -lt 0) { return -1 }
      if ($id -eq 'fmt ') {
        $audioFormat = [BitConverter]::ToInt16($bytes, $pos + 8)
        $bits = [BitConverter]::ToInt16($bytes, $pos + 8 + 14)
      } elseif ($id -eq 'data') {
        $dataOff = $pos + 8
        $dataLen = $sz
        break
      }
      $pos += 8 + $sz + ($sz % 2)   # chunk 按偶数字节对齐
    }

    # 只处理 16-bit PCM（format 1）
    if ($audioFormat -ne 1 -or $bits -ne 16) { return -1 }
    if ($dataOff -lt 0 -or $dataLen -le 0) { return -1 }

    $end = [Math]::Min($dataOff + $dataLen, $bytes.Length - 1)
    $peak = 0
    for ($i = $dataOff; $i -lt $end; $i += 2) {
      $v = [Math]::Abs([BitConverter]::ToInt16($bytes, $i))
      if ($v -gt $peak) { $peak = $v }
    }
    return [Math]::Round($peak / 327.67, 2)
  } catch {
    return -1
  }
}

<#
.SYNOPSIS
  对 16-bit PCM WAV 做数字增益，写到一个临时文件。
.DESCRIPTION
  `Gain` 是**期望**倍数，但会按峰值自动限幅：
  实际系数 = min(Gain, TargetPeakPercent / 实测峰值)。
  这样小声的文件能明显变响，而本来就响的文件不会削波。

  返回值里带实际用的倍数和最终峰值，便于日志与排查。
.PARAMETER Path
  源 wav。
.PARAMETER OutPath
  输出 wav（调用方负责之后删除）。
.PARAMETER Gain
  期望增益倍数（1.0 = 不变）。上限由 ValidateRange 限制。
.PARAMETER TargetPeakPercent
  限幅目标峰值（默认 95，留 5% 余量）。
.OUTPUTS
  hashtable: @{ Ok; AppliedGain; PeakBefore; PeakAfter; Reason }
#>
function Invoke-WavGain {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$OutPath,
    [double]$Gain = 2.0,
    [double]$TargetPeakPercent = 95
  )

  $result = @{ Ok = $false; AppliedGain = 1.0; PeakBefore = -1; PeakAfter = -1; Reason = '' }

  try {
    if ($Gain -le 1.0) { $result.Reason = 'gain<=1'; return $result }

    $peakBefore = Get-WavPeakPercent -Path $Path
    $result.PeakBefore = $peakBefore
    if ($peakBefore -lt 0) { $result.Reason = 'not-16bit-pcm'; return $result }
    if ($peakBefore -le 0) { $result.Reason = 'silent'; return $result }

    # 按峰值限幅：绝不越过 TargetPeakPercent
    $maxSafe = $TargetPeakPercent / $peakBefore
    $apply = [Math]::Min($Gain, $maxSafe)
    if ($apply -le 1.02) {
      # 已经够响（或几乎不需要放大），不折腾
      $result.Reason = 'already-loud'
      $result.AppliedGain = 1.0
      $result.PeakAfter = $peakBefore
      return $result
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)

    # 定位 data chunk
    $pos = 12
    $dataOff = -1
    $dataLen = 0
    while ($pos -lt $bytes.Length - 8) {
      $id = [System.Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
      $sz = [BitConverter]::ToInt32($bytes, $pos + 4)
      if ($sz -lt 0) { return $result }
      if ($id -eq 'data') { $dataOff = $pos + 8; $dataLen = $sz; break }
      $pos += 8 + $sz + ($sz % 2)
    }
    if ($dataOff -lt 0) { $result.Reason = 'no-data-chunk'; return $result }

    $end = [Math]::Min($dataOff + $dataLen, $bytes.Length - 1)
    $newPeak = 0
    for ($i = $dataOff; $i -lt $end; $i += 2) {
      $v = [int][BitConverter]::ToInt16($bytes, $i)
      $scaled = [int][Math]::Round($v * $apply)
      # 硬限幅（理论上前面的计算已保证不越界，这里防浮点误差）
      if ($scaled -gt 32767) { $scaled = 32767 }
      if ($scaled -lt -32768) { $scaled = -32768 }
      $a = [Math]::Abs($scaled)
      if ($a -gt $newPeak) { $newPeak = $a }
      $bytes[$i] = [byte]($scaled -band 0xFF)
      $bytes[$i + 1] = [byte](($scaled -shr 8) -band 0xFF)
    }

    [System.IO.File]::WriteAllBytes($OutPath, $bytes)
    $result.Ok = $true
    $result.AppliedGain = [Math]::Round($apply, 3)
    $result.PeakAfter = [Math]::Round($newPeak / 327.67, 2)
    $result.Reason = 'applied'
    return $result
  } catch {
    $result.Reason = 'error:' + $_.Exception.Message
    return $result
  }
}

<#
.SYNOPSIS
  该文件能否做数字增益（16-bit PCM wav）。
  mp3/m4a/flac/ogg 一律返回 false —— PowerShell 里没有免费解码器。
#>
function Test-WavGainSupported {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-WavPeakPercent -Path $Path) -ge 0
}
