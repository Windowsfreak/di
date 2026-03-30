# Dream Improvisation

A high-performance, mobile-first web application for immersive audio playback. Designed for relaxation, meditation, and dream-like states, featuring advanced background preloading and offline support.

## ✨ Features

- **Premium UI/UX**: Stunning dark-mode design with fluid animations and responsive layouts.
- **Intelligent Preloading**: Background download manager that pre-fetches upcoming tracks to ensure uninterrupted playback even on unstable connections.
- **Offline Support**: Powerful Service Worker integration for caching media and static assets.
- **Audio Engine**: 
    - **Native Streaming**: Uses HTML5 Audio with MediaElementSource for minimal memory footprint and fast starts.
    - **Gapless Support**: Smooth transitions between tracks.
    - **Smart Fading**: Automatic volume fades for play/pause and track endings.
- **Sleep Timer**: Customizable timer with optional "finish track" mode and gentle volume fade-out.
- **Media Session Integration**: Control playback via system media controls (lock screen, notifications, etc.).
- **Battery Efficient**: Optimized for low CPU usage in the background.

## 🎵 Importing Tracks

The application uses a specific structure for music management. Tracks are converted to low-bitrate xHE-AAC (m4a) for mobile efficiency and high quality.

### Naming Convention
Source files must follow this exact pattern:
`[Genre Name] No. [TrackID].mp3`

Example: `Deep Meditation No. 42.mp3`

### Import Process

1. **Prepare Downloads**: Place your source `.mp3` files into the `import/` directory.
2. **Setup Environment**: Ensure you have `ffmpeg` and `exhale` installed.
3. **Run Importer**: Execute the Python script:
   ```bash
   python3 import_tracks.py
   ```
4. **What happens?**
   - Tracks are grouped by Genre.
   - Files are converted to `.m4a` using xHE-AAC.
   - Album covers are extracted as `.jpg`.
   - `music/index.json` and genre-specific `index.json` files are automatically updated.
   - Original files are moved to the `imported/` directory.

## 🚀 Running Locally

To serve the application with proper range-request support for seeking:

Using Python:
```bash
python3 -m http.server 8086 --directory .
```

Using Caddy (Recommended for production/LAN testing):
```bash
caddy file-server --listen :8086
```
