# LightSlice

Camera spectral band filter — fit-to-screen web app (AudioSlice’s light twin).

- Live camera (defaults to **rear** when available)
- Drag **LO / HI / band** on the visible spectrum (full band → **1 nm**)
- Full live camera image, modified as if through a spectral bandpass filter
- Selection marked on the **full EM** spectrum bar
- Presets (V B G Y O R) · Full · Flip
- RGB bandpass is approximate (teaching demo, not a spectrometer)

## Local

```bash
cd ~/lightslice-app
python3 -m http.server 8010
# open http://127.0.0.1:8010
```

Camera access requires a secure context (HTTPS or localhost).

## Deploy

Static files → Vercel. Target: **https://lightslice.markmaga.com** (when wired).

## Icons

```bash
python3 scripts/generate-icons.py
```
