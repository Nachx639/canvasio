#!/usr/bin/env bash
# Provisiona los modelos de voz locales de CANVASIO:
#   - STT: whisper.cpp (binario por brew) + modelo ggml-small (multilingüe, es)
#   - TTS: Kokoro-82M (venv pip kokoro-onnx + espeak-ng) + modelo fp16 ONNX
# Fallback de TTS sin setup: voz nativa de macOS `say` por idioma (siempre disponible).
set -uo pipefail

# La app empaquetada usa ~/Library/Application Support/CanvasIO
# (electron productName=CanvasIO). Debe coincidir con app.getPath('userData').
# Override con CANVASIO_APP_SUPPORT para desarrollo.
APP_SUPPORT="${CANVASIO_APP_SUPPORT:-$HOME/Library/Application Support/CanvasIO}"
MODELS="$APP_SUPPORT/models"
PIPER_VOICES="$APP_SUPPORT/piper/voices"
KOKORO="$APP_SUPPORT/kokoro"
VENV="$APP_SUPPORT/piper-venv"

# STT baseline model (always downloaded). ggml-small is multilingüe, rápido en
# Apple Silicon/Metal y suficiente para órdenes cortas en español.
WHISPER_MODEL_NAME="${CANVASIO_WHISPER_MODEL_NAME:-ggml-small.bin}"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_NAME}"

# Modelo OPCIONAL de mayor precisión (~1.4 GB). La app lo usa automáticamente
# SOLO si el archivo ya existe en el directorio de modelos; si no está, recurre
# al modelo baseline anterior sin fallar. Descárgalo a mano para activarlo:
#   CANVASIO_WHISPER_DOWNLOAD_PREFERRED=1 ./scripts/setup-voice.sh
PREFERRED_MODEL_NAME="${CANVASIO_WHISPER_PREFERRED_MODEL:-ggml-medium.bin}"
PREFERRED_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${PREFERRED_MODEL_NAME}"

echo "▸ CANVASIO · setup de voz"

# --- whisper.cpp binary ---
if ! command -v whisper-cli >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/whisper-cli ]; then
  echo "  · Instalando whisper-cpp (brew)…"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_REQUIRE_TAP_TRUST=1 brew install whisper-cpp
else
  echo "  · whisper-cli ya disponible ✓"
fi

# --- espeak-ng (dep de sistema para Kokoro/misaki) ---
if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "  · Instalando espeak-ng (brew)…"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_REQUIRE_TAP_TRUST=1 brew install espeak-ng || true
else
  echo "  · espeak-ng ya disponible ✓"
fi

# --- whisper STT model ---
mkdir -p "$MODELS"
if [ ! -f "$MODELS/$WHISPER_MODEL_NAME" ]; then
  echo "  · Descargando modelo STT $WHISPER_MODEL_NAME…"
  curl -L --fail -o "$MODELS/$WHISPER_MODEL_NAME" "$WHISPER_URL"
else
  echo "  · Modelo STT ya presente ✓"
fi

# --- modelo STT preferido (opcional, sólo si se pide) ---
if [ "${CANVASIO_WHISPER_DOWNLOAD_PREFERRED:-0}" = "1" ] && \
   [ "$PREFERRED_MODEL_NAME" != "$WHISPER_MODEL_NAME" ]; then
  if [ ! -f "$MODELS/$PREFERRED_MODEL_NAME" ]; then
    echo "  · Descargando modelo STT preferido $PREFERRED_MODEL_NAME (~1.4 GB)…"
    curl -L --fail -o "$MODELS/$PREFERRED_MODEL_NAME" "$PREFERRED_URL"
  else
    echo "  · Modelo STT preferido ya presente ✓"
  fi
fi

# --- venv + deps de Python para Kokoro ---
# Reutilizamos el venv existente ($VENV); venvPython() en la app resuelve
# $VENV/bin/python3. onnxruntime/numpy entran como deps de kokoro-onnx.
if [ ! -d "$VENV" ]; then
  echo "  · Creando venv…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip || true
fi
echo "  · Instalando kokoro-onnx + soundfile + misaki[zh]…"
"$VENV/bin/pip" install --quiet kokoro-onnx soundfile "misaki[zh]" || true

# --- Piper (solo para las voces es_ES de ESPAÑA/castellano) ---
# Kokoro no tiene voz en castellano de España (sus 3 voces ES son latinas,
# hexgrad/kokoro#246), así que conservamos Piper para la voz neural española.
echo "  · Instalando piper-tts (voces es_ES de España)…"
"$VENV/bin/pip" install --quiet piper-tts || true
# Voz castellana masculina (España): es_ES-davefx-medium (.onnx + .onnx.json).
mkdir -p "$PIPER_VOICES"
PIPER_ES_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium"
if [ ! -f "$PIPER_VOICES/es_ES-davefx-medium.onnx" ]; then
  echo "  · Descargando voz española davefx (Piper)…"
  curl -L --fail -o "$PIPER_VOICES/es_ES-davefx-medium.onnx" "$PIPER_ES_BASE/es_ES-davefx-medium.onnx" || true
  curl -L --fail -o "$PIPER_VOICES/es_ES-davefx-medium.onnx.json" "$PIPER_ES_BASE/es_ES-davefx-medium.onnx.json" || true
else
  echo "  · Voz española davefx ya presente ✓"
fi

# --- modelo + voces Kokoro ---
mkdir -p "$KOKORO"
KOKORO_MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx"
KOKORO_VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
if [ ! -f "$KOKORO/kokoro-v1.0.fp16.onnx" ]; then
  echo "  · Descargando modelo Kokoro (~160 MB)…"
  curl -L --fail -o "$KOKORO/kokoro-v1.0.fp16.onnx" "$KOKORO_MODEL_URL" || true
else
  echo "  · Modelo Kokoro ya presente ✓"
fi
if [ ! -f "$KOKORO/voices-v1.0.bin" ]; then
  echo "  · Descargando voces Kokoro (~26 MB)…"
  curl -L --fail -o "$KOKORO/voices-v1.0.bin" "$KOKORO_VOICES_URL" || true
else
  echo "  · Voces Kokoro ya presentes ✓"
fi

echo "▸ Voz lista. STT: whisper.cpp · TTS: Kokoro-82M con fallback macOS say por idioma."
