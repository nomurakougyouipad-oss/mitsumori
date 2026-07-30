Attribute VB_Name = "ImportCSV"
Option Explicit

' ============================================================
' アプリのCSVを読み込む — 見積アプリ(mitsumori)のCSVを内訳書へ
'
' ・xlsmの構造には触れない（値の書き込みだけ。プルダウン・ボタン無傷）
' ・CSVはUTF-8(BOM付き)。ADODB.Streamで読む
' ・材料のH列(計上金額)は値で上書きするため、書き込み前に
'   H20:H34の計算式を復元してから使う行にだけ値を入れる
' ・率も必ず書き込む（B12:H12。材料・労務だけ「1＋率」の形）
'
' 導入: VBE(Alt+F11) → ファイル→インポートでこの.basを取り込み、
'       必要ならボタンに「アプリのCSVを読み込む」を登録
' ============================================================

' 担当者名を書くセル（発注メールの署名用。場所を変えたらここも変える）
Private Const STAFF_CELL As String = "N1"
Private Const SHEET_NAME As String = "内訳書"

Public Sub アプリのCSVを読み込む()
    Dim path As Variant
    path = Application.GetOpenFilename("アプリのCSV (*.csv),*.csv", , "アプリのCSVを選ぶ")
    If VarType(path) = vbBoolean Then Exit Sub

    Dim ws As Worksheet
    Set ws = ThisWorkbook.Worksheets(SHEET_NAME)

    Dim lines() As String
    lines = ReadUtf8Lines(CStr(path))

    ' 形式チェック
    If UBound(lines) < 0 Or InStr(lines(0), "mitsumori") = 0 Then
        MsgBox "アプリのCSVではないようです（1行目: " & lines(0) & "）", vbExclamation
        Exit Sub
    End If

    ' 上書き確認
    If Trim(ws.Range("C9").Value & "") <> "" Then
        If MsgBox("内訳書に入力が残っています（注番 " & ws.Range("C9").Value & "）。上書きしますか?", _
                  vbYesNo + vbQuestion) <> vbYes Then Exit Sub
    End If

    Application.ScreenUpdating = False
    On Error GoTo Fail

    ClearAndRestore ws

    Dim i As Long, f() As String
    Dim matRow As Long, labRow As Long, trvRow As Long, subRow As Long
    matRow = 20: labRow = 39: trvRow = 53: subRow = 63

    For i = 1 To UBound(lines)
        If Trim(lines(i)) = "" Then GoTo NextLine
        f = ParseCsvLine(lines(i))
        Select Case f(0)
            Case "C5", "C6", "C8", "C9"
                ws.Range(f(0)).Value = f(1)
            Case "STAFF"
                ws.Range(STAFF_CELL).Value = f(1)
            Case "B12", "C12", "D12", "E12", "F12", "G12", "H12"
                ws.Range(f(0)).Value = Val(f(1))
            Case "H85"
                ws.Range("H85").Value = Val(f(1))
            Case "MAT"   ' 品名, 数量, 計上金額, 仕入先 → B,C,H,L
                If matRow <= 34 Then
                    ws.Cells(matRow, "B").Value = f(1)
                    If f(2) <> "" Then ws.Cells(matRow, "C").Value = Val(f(2))
                    ws.Cells(matRow, "H").Value = Val(f(3))   ' 式を値で上書き（意図的）
                    If UBound(f) >= 4 Then ws.Cells(matRow, "L").Value = f(4)
                    matRow = matRow + 1
                End If
            Case "LAB"   ' 職種, 人数, 時間 → B,C,D（1h単価E・原価F・計上Hは式のまま）
                If labRow <= 48 Then
                    ws.Cells(labRow, "B").Value = f(1)
                    If f(2) <> "" Then ws.Cells(labRow, "C").Value = Val(f(2))
                    If f(3) <> "" Then ws.Cells(labRow, "D").Value = Val(f(3))
                    labRow = labRow + 1
                End If
            Case "TRV"   ' 作業内容, 人数, 時間, 距離 → B,C,D,F（E・G・Hは式のまま）
                If trvRow <= 59 Then
                    ws.Cells(trvRow, "B").Value = f(1)
                    If f(2) <> "" Then ws.Cells(trvRow, "C").Value = Val(f(2))
                    If f(3) <> "" Then ws.Cells(trvRow, "D").Value = Val(f(3))
                    If UBound(f) >= 4 Then If f(4) <> "" Then ws.Cells(trvRow, "F").Value = Val(f(4))
                    trvRow = trvRow + 1
                End If
            Case "SUB"   ' 外注先, 内容, 金額 → B,C,H
                If subRow <= 69 Then
                    ws.Cells(subRow, "B").Value = f(1)
                    ws.Cells(subRow, "C").Value = f(2)
                    ws.Cells(subRow, "H").Value = Val(f(3))
                    subRow = subRow + 1
                End If
        End Select
NextLine:
    Next i

    Application.ScreenUpdating = True
    MsgBox "読み込みました。金額（H86）がアプリの表示と一致するか確かめてください。", vbInformation
    Exit Sub
Fail:
    Application.ScreenUpdating = True
    MsgBox "読み込みに失敗しました: " & Err.Description, vbCritical
End Sub

' 入力欄のクリア＋材料H列の計算式を復元
Private Sub ClearAndRestore(ws As Worksheet)
    ws.Range("C5").ClearContents
    ws.Range("C6").ClearContents
    ws.Range("C8").ClearContents
    ws.Range("C9").ClearContents
    ws.Range(STAFF_CELL).ClearContents
    ws.Range("B20:C34").ClearContents
    ws.Range("L20:L34").ClearContents
    ws.Range("B39:D48").ClearContents
    ws.Range("B53:D59").ClearContents
    ws.Range("F53:F59").ClearContents
    ws.Range("B63:C69").ClearContents
    ws.Range("H63:H69").ClearContents
    ws.Range("H85").ClearContents
    材料H列の式を復元 ws
End Sub

' 材料 H20:H34 の計算式（原本と同じ式）を戻す。
' 「アプリのCSVを読み込む」がHを値で上書きするため、
' 使わなかった行・次の見積のためにここで毎回復元する。
Public Sub 材料H列の式を復元(Optional ws As Worksheet = Nothing)
    If ws Is Nothing Then Set ws = ThisWorkbook.Worksheets(SHEET_NAME)
    Dim r As Long
    For r = 20 To 34
        ws.Cells(r, "H").Formula = "=IF(F" & r & "<>"""",F" & r & "*(1+$B$12),"""")"
    Next r
End Sub

' 発注メールの署名用: 担当者セル→空ならファイル名（Tekkosho_01野村→野村）
' 既存の発注メールマクロの「ファイル名から名前を取る」箇所を
' この関数の呼び出しに置き換えると、アプリの担当者名が優先される。
Public Function 担当者名を取得() As String
    Dim v As String
    v = Trim(ThisWorkbook.Worksheets(SHEET_NAME).Range(STAFF_CELL).Value & "")
    If v <> "" Then
        担当者名を取得 = v
    Else
        Dim base As String
        base = ThisWorkbook.Name
        base = Left(base, InStrRev(base, ".") - 1)
        Dim i As Long
        For i = Len(base) To 1 Step -1
            If Mid(base, i, 1) Like "[0-9_]" Then
                担当者名を取得 = Mid(base, i + 1)
                Exit Function
            End If
        Next i
        担当者名を取得 = base
    End If
End Function

' ---------- UTF-8のCSVを読む（BOM対応） ----------
Private Function ReadUtf8Lines(path As String) As String()
    Dim st As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2              ' テキスト
    st.Charset = "UTF-8"
    st.Open
    st.LoadFromFile path
    Dim s As String
    s = st.ReadText(-1)
    st.Close
    s = Replace(s, vbCrLf, vbLf)
    s = Replace(s, vbCr, vbLf)
    ReadUtf8Lines = Split(s, vbLf)
End Function

' ---------- 1行をカンマ区切りで分割（"..."の中のカンマ・""に対応） ----------
Private Function ParseCsvLine(line As String) As String()
    Dim out() As String
    ReDim out(0 To 0)
    Dim n As Long: n = -1
    Dim i As Long, ch As String, cur As String, inQ As Boolean
    For i = 1 To Len(line)
        ch = Mid(line, i, 1)
        If inQ Then
            If ch = """" Then
                If i < Len(line) And Mid(line, i + 1, 1) = """" Then
                    cur = cur & """": i = i + 1
                Else
                    inQ = False
                End If
            Else
                cur = cur & ch
            End If
        Else
            If ch = """" Then
                inQ = True
            ElseIf ch = "," Then
                n = n + 1: ReDim Preserve out(0 To n): out(n) = cur: cur = ""
            Else
                cur = cur & ch
            End If
        End If
    Next i
    n = n + 1: ReDim Preserve out(0 To n): out(n) = cur
    ParseCsvLine = out
End Function
