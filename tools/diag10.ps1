$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ow_diag10.txt'
Set-Content -Path $log -Value 'diag10 start'
try {
  $sys32 = Join-Path $env:SystemRoot 'System32'
  $target = "$env:LOCALAPPDATA\omniworkspace-target"
  $objdump = 'C:\Users\haris\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin\objdump.exe'

  $need = @{
    'api-ms-win-crt-private-l1-1-0.dll' = @('memchr','memcmp','memcpy','memmove','strchr','strrchr')
    'api-ms-win-core-synch-l1-2-0.dll' = @('WaitOnAddress','WakeByAddressAll','WakeByAddressSingle')
    'api-ms-win-core-winrt-error-l1-1-0.dll' = @('RoOriginateErrorW')
    'comctl32.dll' = @('DefSubclassProc','RemoveWindowSubclass','SetWindowSubclass','TaskDialogIndirect')
    'bcryptprimitives.dll' = @('ProcessPrng')
    'propsys.dll' = @('PropVariantCompareEx','PropVariantToBSTR','PropVariantToVariant')
    'dwmapi.dll' = @('DwmEnableBlurBehindWindow','DwmGetWindowAttribute','DwmSetWindowAttribute')
    'imm32.dll' = @('ImmGetCompositionStringW','ImmGetContext','ImmReleaseContext','ImmSetCompositionWindow')
    'USERENV.dll' = @('GetUserProfileDirectoryW')
    'shlwapi.dll' = @('SHCreateMemStream')
    'oleaut32.dll' = @('VariantClear','VariantCopy','GetErrorInfo','SetErrorInfo','SysAllocStringLen','SysFreeString','SysStringLen')
    'rpcrt4.dll' = @('UuidCreate')
    'api-ms-win-crt-stdio-l1-1-0.dll' = @('__acrt_iob_func','__stdio_common_vfprintf')
    'api-ms-win-crt-runtime-l1-1-0.dll' = @('_beginthreadex','_endthreadex','_configure_narrow_argv','_initialize_narrow_environment')
  }

  foreach ($dll in $need.Keys) {
    $p = Join-Path $sys32 $dll
    if (-not (Test-Path $p)) { Add-Content $log ("NODLL   {0} (in System32)" -f $dll); continue }
    $o = & $objdump -p $p 2>&1 | Out-String
    $exp = @{}
    foreach ($m in [regex]::Matches($o, '(?m)^\s*\[\s*\d+\]\s*\+base\[\s*\d+\]\s+[0-9a-f]+\s+(\S+)\s*$')) {
      $exp[$m.Groups[1].Value] = $true
    }
    if ($exp.Count -eq 0) {
      Add-Content $log ("NOEXP   {0} (size {1})" -f $dll, (Get-Item $p).Length)
      continue
    }
    $miss = @($need[$dll] | Where-Object { -not $exp.ContainsKey($_) })
    if ($miss.Count -gt 0) { Add-Content $log ("MISSING {0} -> {1}" -f $dll, ($miss -join ',')) }
    else { Add-Content $log ("OK      {0} (exports {1})" -f $dll, $exp.Count) }
  }
} catch {
  Add-Content $log ("ERROR: " + $_.Exception.Message)
}
Add-Content $log 'diag10 end'
