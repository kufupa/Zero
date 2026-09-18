@echo off
REM Fallback if RegisterTrust.exe is missing. The Inno installer ships the exe.
"%~dp0RegisterTrust.exe" "%LOCALAPPDATA%\NavaOutlookAddin"
exit /b %ERRORLEVEL%
