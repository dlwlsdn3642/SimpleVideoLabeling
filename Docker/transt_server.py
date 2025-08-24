import uuid
from typing import Optional, List
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transt_wrapper import SERVICE, decode_image_from_b64
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="TransT Tracking Server")

origins = [
    "http://localhost:8010",
    "http://127.0.0.1:8010",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------- Schemas ---------
class CreateSessionReq(BaseModel):
    session_id: Optional[str] = None
    device: Optional[str] = Field(default=None, description="'cuda:0' 또는 'cpu' 등. None이면 자동판별")
class CreateSessionResp(BaseModel):
    session_id: str
class InitReq(BaseModel):
    session_id: str
    image_b64: str
    bbox_xywh: List[float]
    target_id: Optional[str] = None
class InitResp(BaseModel):
    ok: bool
    elapsed_ms: int
    target_id: str
class UpdateReq(BaseModel):
    session_id: str
    target_id: str
    image_b64: str
class UpdateResp(BaseModel):
    bbox_xywh: List[float]
    score: Optional[float] = None
    elapsed_ms: int
class DropTargetReq(BaseModel):
    session_id: str
    target_id: str
class DropSessionReq(BaseModel):
    session_id: str

# --------- Endpoints ---------
@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/session/create", response_model=CreateSessionResp)
def create_session(req: CreateSessionReq):
    sid = req.session_id or str(uuid.uuid4())
    try:
        SERVICE.create_session(sid, device=req.device)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"session_id": sid}

@app.post("/track/init", response_model=InitResp)
def track_init(req: InitReq):
    try:
        img = decode_image_from_b64(req.image_b64)
        target_id, tw = SERVICE.get_or_create_target(req.session_id, req.target_id)
        result = tw.init(img, tuple(req.bbox_xywh))
        return {**result, "target_id": target_id}
    except KeyError:
        raise HTTPException(status_code=404, detail="invalid session_id or target_id")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"init failed: {e}")

@app.post("/track/update", response_model=UpdateResp)
def track_update(req: UpdateReq):
    try:
        img = decode_image_from_b64(req.image_b64)
        session = SERVICE.get_session(req.session_id)
        tw = session.targets.get(req.target_id)
        if tw is None:
            raise KeyError("invalid target_id")
        result = tw.update(img)
        return result
    except KeyError:
        raise HTTPException(status_code=404, detail="invalid session_id or target_id")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"update failed: {e}")

@app.post("/track/drop_target")
def drop_target(req: DropTargetReq):
    try:
        SERVICE.drop_target(req.session_id, req.target_id)
        return {"ok": True}
    except KeyError:
        raise HTTPException(status_code=404, detail="invalid session_id")

@app.post("/session/drop")
def drop_session(req: DropSessionReq):
    try:
        SERVICE.close_session(req.session_id)
        return {"ok": True}
    except Exception:
        return {"ok": True}