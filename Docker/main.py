import os
import sys
import shutil
import subprocess
from pathlib import Path
from typing import List, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Main App (minimal)")

# ---------- 공용 ----------
def _which(bin_name: str) -> str:
    p = shutil.which(bin_name)
    if not p:
        raise HTTPException(status_code=500, detail=f"'{bin_name}' not found in PATH")
    return p

# ---------- (1) 프레임 수 ----------
class FrameCountReq(BaseModel):
    video_path: str

class FrameCountResp(BaseModel):
    frame_count: int

@app.post("/video/frame_count", response_model=FrameCountResp)
def video_frame_count(req: FrameCountReq):
    video = Path(req.video_path)
    if not video.exists():
        raise HTTPException(status_code=400, detail=f"file not found: {video}")

    ffprobe = _which("ffprobe")
    cmd = [
        ffprobe, "-v", "error", "-count_frames",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames",
        "-of", "default=nokey=1:noprint_wrappers=1",
        str(video),
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode().strip()
        n = int(out)
    except Exception:
        n = 0  # 일부 코덱에서 N/A가 나올 수 있음 → 최소 스켈레톤에선 0 처리
    return FrameCountResp(frame_count=n)

# ---------- (2) TransT 서버 실행(7000) ----------
class TranstStartReq(BaseModel):
    cwd: Optional[str] = None
    host: str = "127.0.0.1"
    port: int = 7000

class TranstStartResp(BaseModel):
    started: bool

_TRANS_PROC: Optional[subprocess.Popen] = None

@app.post("/transt/start", response_model=TranstStartResp)
def transt_start(req: TranstStartReq):
    global _TRANS_PROC
    if _TRANS_PROC and _TRANS_PROC.poll() is None:
        return TranstStartResp(started=True)

    py = shutil.which("python") or sys.executable
    if not py:
        raise HTTPException(status_code=500, detail="python not found")

    workdir = req.cwd or os.getcwd()
    # 같은 폴더에 transt_server.py가 있다고 가정
    cmd = [py, "-m", "uvicorn", "transt_server:app", "--host", req.host, "--port", str(req.port)]
    try:
        _TRANS_PROC = subprocess.Popen(cmd, cwd=workdir)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"failed to start TransT: {e}")
    return TranstStartResp(started=True)

# ---------- (3) 프레임 추출 + YOLO 라벨링 ----------
class YoloItem(BaseModel):
    frame: int
    class_name: str = Field(..., alias="class")   # 입력 키는 "class"
    bbox_xywh: List[float]                        # [x, y, w, h] (픽셀)

    class Config:
        allow_population_by_field_name = True

class YoloExportReq(BaseModel):
    video_path: str
    out_dir: str
    image_ext: str = Field("jpg", pattern="^(jpg|png)$")
    overwrite: bool = False
    labels: List[YoloItem] = Field(default_factory=list)

class YoloExportResp(BaseModel):
    images_dir: str
    labels_dir: str
    classes_txt: str
    frames_written: int
    classes_map: Dict[str, int]  # {"Person":0, "Car":1 ...}

def _ensure_clean_dir(d: Path, overwrite: bool):
    if d.exists():
        if not overwrite:
            raise HTTPException(status_code=400, detail=f"directory exists: {d}")
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)

def _video_size(video_path: Path) -> (int, int):
    ffprobe = _which("ffprobe")
    cmd = [
        ffprobe, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "default=nokey=1:noprint_wrappers=1",
        str(video_path),
    ]
    out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode().strip().splitlines()
    if len(out) >= 2:
        return int(float(out[0])), int(float(out[1]))
    return 0, 0

@app.post("/yolo/export", response_model=YoloExportResp)
def yolo_export(req: YoloExportReq):
    video = Path(req.video_path)
    if not video.exists():
        raise HTTPException(status_code=400, detail=f"file not found: {video}")

    out_root = Path(req.out_dir)
    images_dir = out_root / "images"
    labels_dir = out_root / "labels"
    _ensure_clean_dir(out_root, req.overwrite)
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    # 1) 프레임 전부 추출
    ffmpeg = _which("ffmpeg")
    pattern = str(images_dir / f"%06d.{req.image_ext}")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(video), "-vsync", "0", pattern]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg extract failed: {e}")

    frames_written = len(list(images_dir.glob(f"*.{req.image_ext}")))
    if frames_written == 0:
        raise HTTPException(status_code=500, detail="no frames extracted")

    # 2) 해상도 가져와 YOLO 정규화
    W, H = _video_size(video)
    if W <= 0 or H <= 0:
        raise HTTPException(status_code=500, detail="failed to read video width/height")

    # 3) 클래스 맵 고정(등장 순서 기준, 안정적)
    cls_to_id: Dict[str, int] = {}
    order: List[str] = []
    for it in req.labels:
        if it.class_name not in cls_to_id:
            cls_to_id[it.class_name] = len(order)
            order.append(it.class_name)

    # 4) 프레임별 .txt 생성
    by_frame: Dict[int, List[YoloItem]] = {}
    for it in req.labels:
        if 1 <= it.frame <= frames_written:
            by_frame.setdefault(it.frame, []).append(it)

    for fidx, items in by_frame.items():
        txt = labels_dir / f"{fidx:06d}.txt"
        with txt.open("w", encoding="utf-8") as fp:
            for it in items:
                x, y, w, h = map(float, it.bbox_xywh)
                # 픽셀 → YOLO 정규화(xc, yc, w, h)
                xc = (x + w / 2.0) / W
                yc = (y + h / 2.0) / H
                wn = w / W
                hn = h / H
                # 클램프
                xc = min(max(xc, 0.0), 1.0)
                yc = min(max(yc, 0.0), 1.0)
                wn = min(max(wn, 0.0), 1.0)
                hn = min(max(hn, 0.0), 1.0)
                cid = cls_to_id[it.class_name]
                fp.write(f"{cid} {xc:.6f} {yc:.6f} {wn:.6f} {hn:.6f}\n")

    # 5) classes.txt 기록
    classes_txt = out_root / "classes.txt"
    with classes_txt.open("w", encoding="utf-8") as fp:
        for name in order:
            fp.write(name + "\n")

    return YoloExportResp(
        images_dir=str(images_dir),
        labels_dir=str(labels_dir),
        classes_txt=str(classes_txt),
        frames_written=frames_written,
        classes_map=cls_to_id,
    )
