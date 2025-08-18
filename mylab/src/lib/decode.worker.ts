// Dedicated worker for image decoding
// Receives: { id: number, blob: Blob }
// Replies: { id: number, ok: true, bitmap: ImageBitmap } or { id: number, ok: false }

self.onmessage = async (e: MessageEvent) => {
  const { id, blob } = e.data as { id: number; blob: Blob };
  try {
    const bmp = await createImageBitmap(blob);
    // transfer ImageBitmap back to main thread
    (self as unknown as Worker).postMessage({ id, ok: true, bitmap: bmp }, [bmp as unknown as Transferable]);
  } catch {
    (self as unknown as Worker).postMessage({ id, ok: false });
  }
};

