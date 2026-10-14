@echo off
setlocal
cd /d "%~dp0\.."

echo ===========================================================================
echo QuizZy - Weekly Evaluation & Model Drift Pipeline
echo ===========================================================================

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment Python not found at .venv\Scripts\python.exe
    echo Please create the virtual environment before running this script.
    pause
    exit /b 1
)

echo Activating virtual environment...
call .venv\Scripts\activate.bat

echo Running weekly evaluation pipeline...
python eval\run_eval.py --weekly --cooldown-ms 2500

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% EQU 0 (
    echo.
    echo ===========================================================================
    echo [SUCCESS] Weekly re-evaluation and drift analysis completed successfully!
    echo Report archived in eval\results\history\ and latest_eval.json.
    echo ===========================================================================
) else (
    echo.
    echo ===========================================================================
    echo [FAILURE] Weekly re-evaluation encountered an error (exit code: %EXIT_CODE%).
    echo ===========================================================================
)

endlocal
exit /b %EXIT_CODE%
