import os
import re
import json
import subprocess
import shutil
from pathlib import Path

# Configuration
IMPORT_DIR = Path("/Users/bjoern/projects/bjoern/di/import")
IMPORTED_DIR = Path("/Users/bjoern/projects/bjoern/di/imported")
MUSIC_DIR = Path("/Users/bjoern/projects/bjoern/di/music")
FFMPEG_PATH = "ffmpeg"
FFPROBE_PATH = "ffprobe"
EXHALE_PATH = "/Users/bjoern/projects/bjoern/exhale/bin/exhale"

def natural_sort_key(s):
    """Key function for natural sorting."""
    return [int(text) if text.isdigit() else text.lower()
            for text in re.split('([0-9]+)', s)]

def slugify(text):
    """Basic slugification for folder names."""
    text = text.lower().strip()
    text = re.sub(r'\s+', '-', text)
    text = re.sub(r'[^a-z0-9\-]', '', text)
    return text

def get_audio_duration(file_path):
    """Uses ffprobe to get duration in seconds."""
    if not file_path.exists(): return 0
    cmd = [
        FFPROBE_PATH, "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(file_path)
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return int(float(result.stdout.strip()))
    except (ValueError, TypeError):
        return 0

def process_tracks():
    # 1. Ensure root directories exist
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    IMPORTED_DIR.mkdir(parents=True, exist_ok=True)
    MUSIC_DIR.mkdir(parents=True, exist_ok=True)

    # 2. Gather all genres (from music/ and from import files)
    genres = {} # slug -> { "name": ..., "slug": ... }
    
    # 2a. Scan existing genres in music/
    for genre_path in MUSIC_DIR.iterdir():
        if genre_path.is_dir():
            slug = genre_path.name
            index_path = genre_path / "index.json"
            name = slug.replace("-", " ").title() # Fallback name
            if index_path.exists():
                try:
                    with open(index_path, "r") as f:
                        data = json.load(f)
                        name = data.get("name", name)
                except:
                    pass
            genres[slug] = {"name": name, "slug": slug}

    # 2b. Scan for new tracks in import/ and imported/
    raw_files = []
    for sdir in [IMPORT_DIR, IMPORTED_DIR]:
        for file in sdir.glob("*.mp3"):
            match = re.search(r"^(.*) No\. (.*)\.mp3$", file.name)
            if not match: continue
            
            genre_name = match.group(1)
            track_id = match.group(2)
            genre_slug = slugify(genre_name)
            
            if genre_slug not in genres:
                genres[genre_slug] = {"name": genre_name, "slug": genre_slug}
            
            raw_files.append({
                "path": file,
                "genre_slug": genre_slug,
                "track_id": track_id
            })

    # 3. Process each genre to rebuild its index and perform conversions
    root_genres = []
    
    for slug in sorted(genres.keys()):
        data = genres[slug]
        genre_dir = MUSIC_DIR / slug
        genre_dir.mkdir(parents=True, exist_ok=True)
        
        index_path = genre_dir / "index.json"
        existing_genre_data = {}
        if index_path.exists():
            try:
                with open(index_path, "r") as f:
                    existing_genre_data = json.load(f)
            except:
                pass
        
        # tracks: { track_id: duration }
        current_tracks = existing_genre_data.get("tracks", {})
        
        print(f"\nProcessing genre: {data['name']} ({slug})")
        
        # 3a. Add tracks already converted to .m4a but missing from index.json
        for m4a_file in genre_dir.glob("*.m4a"):
            track_id = m4a_file.stem
            if track_id not in current_tracks:
                print(f"  Found already converted track '{track_id}', measuring duration...")
                current_tracks[track_id] = get_audio_duration(m4a_file)
        
        # 3b. Process new tracks from import/ or imported/ for this genre
        genre_raw_files = [f for f in raw_files if f["genre_slug"] == slug]
        
        for raw in genre_raw_files:
            src_path = raw["path"]
            track_id = raw["track_id"]
            dest_audio = genre_dir / f"{track_id}.m4a"
            dest_cover = genre_dir / f"{track_id}.jpg"
            
            # Convert if destination doesn't exist
            if not dest_audio.exists():
                duration = get_audio_duration(src_path)
                print(f"  Converting {src_path.name} ({duration}s) to {dest_audio.name}...")
                
                ffmpeg_cmd = [FFMPEG_PATH, "-y", "-i", str(src_path), "-vn", "-f", "wav", "-"]
                exhale_cmd = [EXHALE_PATH, "e", str(dest_audio)]
                
                try:
                    p1 = subprocess.Popen(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    p2 = subprocess.Popen(exhale_cmd, stdin=p1.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    p1.stdout.close()
                    p2.wait()
                    current_tracks[track_id] = duration
                except Exception as e:
                    print(f"  Error converting {src_path.name}: {e}")
            else:
                # Ensure it's in the tracks list if it exists already
                if track_id not in current_tracks:
                    current_tracks[track_id] = get_audio_duration(dest_audio)

            # Ensure cover image exists
            if not dest_cover.exists():
                print(f"  Extracting cover for {track_id}...")
                subprocess.run([
                    FFMPEG_PATH, "-y", "-i", str(src_path),
                    "-map", "0:v:0", "-vframes", "1", str(dest_cover)
                ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # Move from import to imported
            if src_path.parent == IMPORT_DIR:
                dest_imported = IMPORTED_DIR / src_path.name
                if not dest_imported.exists():
                    shutil.move(str(src_path), str(dest_imported))
                else:
                    os.remove(str(src_path))

        # 3c. Finalize genre index.json
        # Sort tracks by ID naturally for a consistent index
        sorted_track_ids = sorted(current_tracks.keys(), key=natural_sort_key)
        final_tracks_dict = {tid: current_tracks[tid] for tid in sorted_track_ids}
        total_playtime = sum(final_tracks_dict.values())
        
        genre_index = {
            "name": data["name"],
            "prompt": existing_genre_data.get("prompt", ""),
            "engine": existing_genre_data.get("engine", "v4.5-all"),
            "tracks": final_tracks_dict
        }
        
        with open(index_path, "w") as f:
            json.dump(genre_index, f, indent=2)
            
        root_genres.append({
            "id": slug,
            "name": data["name"],
            "trackCount": len(final_tracks_dict),
            "totalPlaytime": total_playtime
        })

    # 4. Finalize root index.json
    root_index_path = MUSIC_DIR / "index.json"
    with open(root_index_path, "w") as f:
        json.dump(root_genres, f, indent=2)
        
    print(f"\nImporting complete. Processed {len(root_genres)} genres.")

if __name__ == "__main__":
    process_tracks()
