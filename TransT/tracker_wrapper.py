# tracker_wrapper.py
import base64
import threading
import time
from typing import Dict, Tuple, Optional

import cv2
import numpy as np
import torch
import torch.backends.cudnn as cudnn

torch.set_grad_enabled(False)
cudnn.benchmark = True
cv2.setNumThreads(0)


# ---------- 공통 유틸 ----------
def decode_image_from_b64(b64: str) -> np.ndarray:
    # "data:image/png;base64,..." 프리픽스 허용
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("이미지 디코딩 실패")
    return img

# ---------- ModelManager: 가중치/파라미터 1회 로드 ----------
class ModelManager:
    def __init__(self, tracker_name: str = "transt", param_name: str = "transt50"):
        # pytracking.evaluation.Tracker 경로가 표준
        from pytracking.evaluation import Tracker
        from importlib import import_module

        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        self.tracker_name = tracker_name
        self.param_name = param_name
        self.TrackerCtor = Tracker

        # 파라미터 모듈 로드 (여기서 1회만)
        param_module = import_module(f"pytracking.parameter.{tracker_name}.{param_name}")
        self.params = param_module.parameters()
        # 디바이스/옵션 명시
        self.params.use_gpu = torch.cuda.is_available()
        if hasattr(self.params, "device"):
            self.params.device = self.device

    def new_internal_tracker(self):
        """각 대상(target)마다 내부 트래커 인스턴스를 생성"""
        t = self.TrackerCtor(self.tracker_name, self.param_name)
        internal = t.create_tracker(self.params) if hasattr(t, "create_tracker") else t.tracker_class(self.params)
        # 학습 비활성화 모드
        try:
            internal.net.eval()
        except Exception:
            pass
        return internal


MODEL = ModelManager(tracker_name="transt", param_name="transt50")

# ---------- TranstWrapper: '객체 하나'용 래퍼 ----------
class TranstWrapper:
    def __init__(self):
        self.lock = threading.Lock()
        self.internal = MODEL.new_internal_tracker()
        self.initialized = False

    def init(self, img_bgr: np.ndarray, bbox_xywh: Tuple[float, float, float, float]):
        x, y, w, h = [float(v) for v in bbox_xywh]
        box = np.array([x, y, w, h], dtype=np.float32)

        with self.lock:
            t0 = time.time()
            state = {"init_bbox": box}
            self.internal.initialize(img_bgr, state)
            self.initialized = True
            return {"ok": True, "elapsed_ms": int((time.time() - t0) * 1000)}

    def update(self, img_bgr: np.ndarray):
        if not self.initialized:
            raise RuntimeError("init 호출 전입니다.")

        with self.lock:
            t0 = time.time()
            out = self.internal.track(img_bgr)
            # 출력 정규화
            if isinstance(out, dict):
                bbox = out.get("target_bbox") or out.get("bbox") or out.get("target_box")
                score = out.get("score")
            else:
                bbox = out[:4] if isinstance(out, (list, tuple, np.ndarray)) and len(out) >= 4 else None
                score = None

            if bbox is None:
                raise RuntimeError("트래커 출력에 bbox가 없습니다.")

            bbox = [float(v) for v in bbox]
            return {
                "bbox_xywh": bbox,
                "score": (float(score) if score is not None else None),
                "elapsed_ms": int((time.time() - t0) * 1000),
            }

# ---------- 세션/타깃 스토어 ----------
class Session:
    def __init__(self, device: Optional[str] = None):
        self.device = device or MODEL.device
        self.targets: Dict[str, TranstWrapper] = {}

class TranstService:
    def __init__(self):
        self.sessions: Dict[str, Session] = {}
        self.lock = threading.Lock()

    def create_session(self, session_id: str, device: Optional[str] = None):
        with self.lock:
            if session_id in self.sessions:
                raise ValueError("이미 존재하는 session_id")
            self.sessions[session_id] = Session(device=device)

    def close_session(self, session_id: str):
        with self.lock:
            self.sessions.pop(session_id, None)

    def get_session(self, session_id: str) -> Session:
        s = self.sessions.get(session_id)
        if s is None:
            raise KeyError("존재하지 않는 session_id")
        return s

    def get_or_create_target(self, session_id: str, target_id: Optional[str]) -> Tuple[str, TranstWrapper]:
        s = self.get_session(session_id)
        if target_id is not None:
            tw = s.targets.get(target_id)
            if tw is None:
                tw = TranstWrapper()
                s.targets[target_id] = tw
            return target_id, tw
        new_id = f"T{int(time.time()*1000)%10_000_000}"
        tw = TranstWrapper()
        s.targets[new_id] = tw
        return new_id, tw

    def drop_target(self, session_id: str, target_id: str):
        s = self.get_session(session_id)
        s.targets.pop(target_id, None)


SERVICE = TranstService()
