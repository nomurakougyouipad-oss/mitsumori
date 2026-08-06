# JIS標準サイズ表.json から js/jis-sizes.js を生成する（手で写さない）
$ErrorActionPreference = 'Stop'
$src = "C:\Users\yotsu\OneDrive\デスクトップ\実装プロジェクト用_これだけ\mitsumori\tools\jis-sizes.source.json"
$dst = "C:\Users\yotsu\OneDrive\デスクトップ\実装プロジェクト用_これだけ\mitsumori\js\jis-sizes.js"
$j = Get-Content $src -Raw -Encoding UTF8 | ConvertFrom-Json

# 寸法文字列から数字だけを順に取り出す（L-3x25x25 → 3,25,25）
function Nums([string]$s) {
    $m = [regex]::Matches($s, '\d+(?:\.\d+)?')
    return ($m | ForEach-Object { $_.Value })
}
function Row($nums, $kgm) {
    $n = ($nums | ForEach-Object { $_ }) -join ', '
    if ($null -ne $kgm) { return "    { nums: [$n], kgm: $kgm }," }
    return "    { nums: [$n] },"
}

$sb = New-Object System.Text.StringBuilder
$null = $sb.AppendLine('// ============================================================')
$null = $sb.AppendLine('// JIS標準サイズ表 — 「JIS標準サイズ表.json」から生成（手で写していない）')
$null = $sb.AppendLine('// nums は寸法の数字を順に並べたもの。品名の書き方（L-付き/□-付き/φの位置など）は')
$null = $sb.AppendLine('// 種類×材質ごとに違うので、ここでは持たない。catalog.js が単価マスターから')
$null = $sb.AppendLine('// 抽出した「型」に、この nums と長さを流し込んで品名を作る。')
$null = $sb.AppendLine('// kgm は参考重量(kg/m)。金額の計算には使わない（推定価格は出さない方針）。')
$null = $sb.AppendLine('// ============================================================')
$null = $sb.AppendLine('')

$map = @{ 'アングル' = 'angle'; '溝形鋼' = 'channel'; 'H形鋼' = 'hbeam'; '平鋼' = 'fb'; '丸棒' = 'round'; '角パイプ' = 'sqpipe' }
$null = $sb.AppendLine('export const JIS_SIZES = {')
foreach ($k in @('アングル', '溝形鋼', 'H形鋼', '平鋼', '丸棒', '角パイプ')) {
    $key = $map[$k]
    $null = $sb.AppendLine("  // $k")
    $null = $sb.AppendLine("  $key`: [")
    foreach ($e in $j.$k) {
        $null = $sb.AppendLine((Row (Nums $e.'寸法') $e.'kg/m'))
    }
    $null = $sb.AppendLine('  ],')
}
# SGP: 呼び径のみ
$null = $sb.AppendLine('  // SGP（呼び径A）')
$null = $sb.AppendLine('  sgp: [')
foreach ($e in $j.'SGP') {
    $null = $sb.AppendLine((Row (Nums $e.'呼び径') $e.'kg/m'))
}
$null = $sb.AppendLine('  ],')
# TP-A: 呼び径 + 肉厚。
# nums は「単価マスターの寸法に流し込む数字」なので、肉厚を入れる。
# マスターの型は 100Ax3mmx4000（肉厚mm）であり、Schの番号ではない。
# Sch は寸法ではなく規格の呼び名なので、別のフィールドに分けて持つ（mmは付けない）。
$null = $sb.AppendLine('  // TP-A（呼び径A ＋ 肉厚mm。Sch は sch フィールドに分ける）')
$null = $sb.AppendLine('  tpa: [')
foreach ($e in $j.'TP-A') {
    $nom = @(Nums $e.'呼び径')[0]
    $t = $e.'肉厚'
    $null = $sb.AppendLine("    { nums: [$nom, $t], sch: '$($e.'Sch')', kgm: $($e.'kg/m') },")
}
$null = $sb.AppendLine('  ],')
$null = $sb.AppendLine('};')
$null = $sb.AppendLine('')
$lens = ($j.'標準長さ') -join ', '
$null = $sb.AppendLine("// 定尺（mm）。長さは種類によらず共通で使う")
$null = $sb.AppendLine("export const JIS_LENGTHS = [$lens];")

[IO.File]::WriteAllText($dst, $sb.ToString(), [Text.UTF8Encoding]::new($false))
Write-Output ("生成: " + $dst)
foreach ($k in @('アングル', '溝形鋼', 'H形鋼', '平鋼', '丸棒', '角パイプ', 'SGP', 'TP-A')) {
    Write-Output ("  $k : " + @($j.$k).Count + " 件")
}
Write-Output ("  標準長さ : " + @($j.'標準長さ').Count + " 種")
