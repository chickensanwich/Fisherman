@echo off
echo Installing PyInstaller...
pip install pyinstaller

echo.
echo Building FisherMen executable...
pyinstaller --noconfirm --onedir --name "FisherMen" ^
    --add-data "index.html;." ^
    --add-data "admin.html;." ^
    --add-data "settings.html;." ^
    --add-data "css;css" ^
    --add-data "js;js" ^
    --add-data "assets;assets" ^
    --hidden-import "uvicorn.loops" ^
    --hidden-import "uvicorn.loops.asyncio" ^
    --hidden-import "uvicorn.protocols" ^
    --hidden-import "uvicorn.protocols.http" ^
    --hidden-import "uvicorn.protocols.http.h11_impl" ^
    --hidden-import "uvicorn.protocols.websockets" ^
    --hidden-import "uvicorn.lifespan" ^
    --hidden-import "uvicorn.lifespan.on" ^
    --hidden-import "fastapi" ^
    --hidden-import "email.mime.text" ^
    --hidden-import "email.mime.multipart" ^
    --hidden-import "langdetect" ^
    --hidden-import "deep_translator" ^
    --hidden-import "google.cloud.speech" ^
    launcher.py

echo.
echo ============================================================
echo Build complete!  Output folder:  dist\FisherMen\
echo Copy users.json, feedbacks.json, chats.json,
echo contributions.json, and settings.json into that folder
echo before distributing.
echo ============================================================
pause
