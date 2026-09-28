/* Backend contract layer (FastAPI on :8000).
 * Same normalized contract as the main frontend: geometry in fractions,
 * final bytes always rendered by the server. */

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";

export interface Crop {
  spec: string;
  label: string;
  url: string;
  width: number;
  height: number;
  box: [number, number, number, number] | null;
  format: "jpg" | "png";
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  const chunk = 8192;
  for (let i = 0; i < binary.length; i += chunk) {
    const slice = binary.slice(i, i + chunk);
    for (let j = 0; j < slice.length; j++) {
      bytes[i + j] = slice.charCodeAt(j);
    }
  }
  return new Blob([bytes], { type: mime });
}

function resolveImageSize(url: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = url;
  return new Promise((resolve, reject) => {
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("failed to load image"));
  });
}

/** Crop one image at all requested specs (single backend call). */
export async function cropImage(
  file: File,
  specs: { spec: string; label: string }[]
): Promise<Crop[]> {
  const form = new FormData();
  form.append("image", file);
  for (const s of specs) {
    form.append("aspects", s.spec);
  }
  const response = await fetch(`${API_BASE_URL}/crop/multi`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`crop API error: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    results: Array<{
      aspect: string;
      box?: [number, number, number, number];
      width: number;
      height: number;
      jpeg: string;
      format: string;
    }>;
  };
  const labelOf = (aspect: string) =>
    specs.find((s) => s.spec === aspect)?.label ?? aspect;
  return Promise.all(
    payload.results.map(async (r) => {
      const format: "jpg" | "png" = r.format === "png" ? "png" : "jpg";
      const blob = base64ToBlob(r.jpeg, `image/${format}`);
      const url = URL.createObjectURL(blob);
      const { w, h } = await resolveImageSize(url);
      return {
        spec: r.aspect,
        label: labelOf(r.aspect),
        url,
        width: r.width || w,
        height: r.height || h,
        box: r.box ?? null,
        format,
      };
    })
  );
}

/** Composite a logo/frame over one finished crop at full resolution. */
export async function compositeBlob(
  base: Blob,
  overlayBytes: ArrayBuffer,
  overlayName: string,
  params: Record<string, unknown>
): Promise<{ blob: Blob; format: "jpg" | "png"; width: number; height: number }> {
  const form = new FormData();
  form.append("image", base);
  form.append("overlay", new File([overlayBytes], overlayName, { type: "image/png" }));
  form.append("params", JSON.stringify(params));
  const response = await fetch(`${API_BASE_URL}/composite`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`composite API error: HTTP ${response.status}`);
  }
  const buf = await response.arrayBuffer();
  const blob = new Blob([buf], {
    type: response.headers.get("content-type") ?? "image/jpeg",
  });
  const url = URL.createObjectURL(blob);
  const { w, h } = await resolveImageSize(url);
  URL.revokeObjectURL(url);
  return {
    blob,
    format: (response.headers.get("content-type")?.includes("png") ? "png" : "jpg") as "jpg" | "png",
    width: w,
    height: h,
  };
}
