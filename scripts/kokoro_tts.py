#!/usr/bin/env python3
# Persistent Kokoro-82M TTS sidecar.
#
# Loads the ONNX model + voices ONCE at startup, then serves many synthesis
# requests over stdin/stdout using newline-delimited JSON. voice.ts spawns one
# of these per app session and reuses it.
#
# Protocol:
#   startup  -> {"ready": true}                  (model loaded OK; then loops)
#            -> {"fatal": true, "error": "..."}  (import/load failed; exit 1)
#   request  <- {"id","text","voice","lang","out"}   (one JSON line on stdin)
#   response -> {"id": id, "ok": true}                (WAV written to "out")
#            -> {"id": id, "ok": false, "error": "..."}
#
# A single bad request never crashes the loop — it is caught and reported as
# ok:false so voice.ts can fall back to macOS `say`. Chinese (zf_xiaoxiao /
# lang "zh") needs misaki[zh]; if that errors at runtime it surfaces here as
# ok:false and voice.ts degrades gracefully.
import sys, json, argparse


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--voices", required=True)
    args = ap.parse_args()

    # Load the model ONCE. Any import/load failure is fatal → report + exit 1.
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
        k = Kokoro(args.model, args.voices)
    except Exception as e:
        emit({"fatal": True, "error": str(e)})
        sys.exit(1)

    emit({"ready": True})

    # Newline-delimited JSON requests; exits cleanly on EOF.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            samples, sr = k.create(
                req["text"], voice=req["voice"], speed=1.0, lang=req["lang"]
            )
            sf.write(req["out"], samples, sr)
            emit({"id": rid, "ok": True})
        except Exception as e:  # never crash on one bad request
            emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
