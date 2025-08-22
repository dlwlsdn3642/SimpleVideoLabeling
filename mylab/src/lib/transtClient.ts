export type TranstConfig = {
  baseUrl: string; // e.g. http://localhost:8010
};

export type CreateSessionResp = { session_id: string };
export type InitResp = { ok: boolean; elapsed_ms: number; target_id: string };
export type UpdateResp = { bbox_xywh: [number, number, number, number]; score?: number | null; elapsed_ms: number };

export class TranstClient {
  private base: string;

  constructor(_cfg?: Partial<TranstConfig>) {
    // Fixed API base as requested
    this.base = 'http://localhost:7000'.replace(/\/$/, '');
  }

  async createSession(sessionId?: string): Promise<CreateSessionResp> {
    const r = await fetch(`${this.base}/session/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId ?? null }),
    });
    if (!r.ok) throw new Error(`create_session ${r.status}`);
    return r.json();
  }

  async init(sessionId: string, image_b64: string, bbox_xywh: [number, number, number, number], targetId?: string): Promise<InitResp> {
    const r = await fetch(`${this.base}/track/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, image_b64, bbox_xywh, target_id: targetId ?? null }),
    });
    if (!r.ok) throw new Error(`track_init ${r.status}`);
    return r.json();
  }

  async update(sessionId: string, targetId: string, image_b64: string): Promise<UpdateResp> {
    const r = await fetch(`${this.base}/track/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, target_id: targetId, image_b64 }),
    });
    if (!r.ok) throw new Error(`track_update ${r.status}`);
    return r.json();
  }

  async dropTarget(sessionId: string, targetId: string): Promise<void> {
    const r = await fetch(`${this.base}/track/drop_target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, target_id: targetId }),
    });
    if (!r.ok) throw new Error(`drop_target ${r.status}`);
    await r.json().catch(() => undefined);
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('b64 encode failed'));
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
}
