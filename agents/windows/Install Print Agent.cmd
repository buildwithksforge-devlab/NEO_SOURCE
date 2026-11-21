@echo off
setlocal
set "target=%LOCALAPPDATA%\NEO\PrintAgent\bin"
if not exist "%target%" mkdir "%target%"
copy /Y "%~dp0NEOPrintAgent.exe" "%target%\NEOPrintAgent.exe" >nul
if errorlevel 1 (
 echo Close the running NEO Print Agent before installing this update.
 pause
 exit /b 1
)
powershell.exe -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'NEO Print Agent.lnk'));$s.TargetPath=[IO.Path]::Combine($env:LOCALAPPDATA,'NEO','PrintAgent','bin','NEOPrintAgent.exe');$s.Save()"
start "" "%target%\NEOPrintAgent.exe"
