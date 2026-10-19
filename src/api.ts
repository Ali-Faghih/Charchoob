/* Backend contract layer (FastAPI on :8000).
 * Same normalized contract as the main frontend: geometry in fractions,
 * final bytes always rendered by the server. */

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";

/** Backend message for an image with no detectable face/subject (service.NO_FACE_MESSAGE). */
export const NO_FACE_DETAIL =
  "برش بر اساس چهره برای این عکس ممکن نیست";

const NETWORK_FA = "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کنید.";
const GENERIC_FA = "پردازش انجام نشد. لطفاً دوباره تلاش کنید.";
const SERVER_FA = "سرور پاسخ نداد. چند لحظه بعد دوباره تلاش کنید.";

/* Backend error messages are English and surface verbatim in the UI, so they are
 * translated here. Keys are stable substrings of each message (some backend
 * messages embed dynamic parameters). Persian backend messages such as
 * NO_FACE_DETAIL are kept in this table so they pass through unchanged. */
const DETAIL_FA: ReadonlyArray<readonly [string, string]> = [
  [NO_FACE_DETAIL, NO_FACE_DETAIL],
  ["Could not decode the provided image bytes", "فایل تصویر خوانده نشد."],
  ["Could not encode the cropped image", "ساخت تصویر برش‌خورده ممکن نشد."],
  ["Invalid aspect ratio", "نسبت تصویر معتبر نیست."],
  ["حجم فایل بیشتر از ۲۰ مگابایت است", "حجم فایل بیشتر از ۲۰ مگابایت است."],
  ["برش با این نسبت برای این عکس ممکن نیست", "برش با این نسبت برای این عکس ممکن نیست."],
  ["overlay input must be PNG or JPEG", "فایل قاب باید PNG یا JPG باشد."],
  ["overlay input must be PNG", "فایل روی‌تصویر باید PNG باشد."],
  ["could not decode the overlay PNG", "فایل روی‌تصویر خوانده نشد."],
  ["could not decode the base image", "تصویر اصلی خوانده نشد."],
  ["params.mode must be", "حالت قاب یا لوگو معتبر نیست."],
  ["params must be", "پارامترهای ارسالی درست نیست."],
];

/** Translates a backend error message to Persian; unknown ones fall back to a generic sentence. */
function faDetail(detail: string): string {
  for (const [needle, fa] of DETAIL_FA) if (detail.includes(needle)) return fa;
  return GENERIC_FA;
}

/** Reads the FastAPI error body ({detail}) and builds a Persian message. */
async function apiError(res: Response): Promise<Error> {
  if (res.status >= 500) return new Error(SERVER_FA);
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b?.detail ?? "")
    .catch(() => "");
  return new Error(faDetail(detail));
}

export interface Crop {
  spec: string;
  label: string;
  url: string;
  width: number;
  height: number;
  box: [number, number, number, number] | null;
  format: "jpg" | "png";
}

export class CropApiError extends Error {
  readonly status: number;
  readonly noFace: boolean;
  constructor(status: number, detail: string) {
    super(faDetail(detail));
    this.name = "CropApiError";
    this.status = status;
    this.noFace = detail.includes(NO_FACE_DETAIL);
  }
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
    img.onerror = () => reject(new Error("تصویر ساخته‌شده خوانده نشد."));
  });
}

/** Convert any backend-decodable photo (HEIC/HEIF/...) to JPEG bytes.
 * Used at import for formats the browser cannot preview. */
export async function convertImage(file: File): Promise<Blob> {
  const form = new FormData();
  form.append("image", file);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/convert`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new Error(NETWORK_FA);
  }
  if (!response.ok) throw await apiError(response);
  return await response.blob();
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
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/crop/multi`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new Error(NETWORK_FA);
  }
  if (!response.ok) {
        // Read the backend detail; without this the failure reason never reaches the user.
    const detail = await response
      .json()
      .then((b: { detail?: string }) => b?.detail ?? "")
      .catch(() => "");
    throw new CropApiError(response.status, detail);
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
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/composite`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new Error(NETWORK_FA);
  }
  if (!response.ok) {
        // This used to report only "HTTP 400"; now the real Persian reason is used.
    throw await apiError(response);
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
