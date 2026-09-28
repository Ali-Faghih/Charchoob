import { ChangeEvent, HTMLAttributes, PointerEvent, ReactNode, useEffect, useRef, useState } from "react";
import { compositeBlob, cropImage, type Crop } from "./api";

const sampleImage =
  "https://images.unsplash.com/photo-1742301874070-0039a7bf19fb?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&q=88&w=1600";

type Ratio = {
  label: string;
  value: string;
  ratio?: number;
  spec: string;
};

const ratios: Ratio[] = [
  { label: "مربع", value: "۱:۱", ratio: 1, spec: "1:1" },
  { label: "استاندارد", value: "۴:۳", ratio: 4 / 3, spec: "4:3" },
  { label: "چاپ", value: "۵:۴", ratio: 5 / 4, spec: "5:4" },
  { label: "عریض", value: "۱۶:۹", ratio: 16 / 9, spec: "16:9" },
  { label: "عمودی", value: "پرتره", ratio: 4 / 5, spec: "4:5" },
  { label: "افقی", value: "لنداسکیپ", ratio: 3 / 2, spec: "3:2" },
  { label: "دلخواه", value: "سفارشی", spec: "custom" },
];

/* ---------- backend contract geometry (fractions, mirrors the server) ---------- */

/** New-UI grid index (0 = top-RIGHT, RTL-first) -> backend index (0 = top-LEFT). */
function toBackendPos(i: number): number {
  return Math.floor(i / 3) * 3 + (2 - (i % 3));
}

const ANCHOR_M = 0.04;

/** 9-grid anchor (fractions) from a BACKEND position index. */
function anchorOf(b: number): [number, number] {
  const col = b % 3;
  const row = Math.floor(b / 3);
  return [ANCHOR_M + (col * (1 - 2 * ANCHOR_M)) / 2, ANCHOR_M + (row * (1 - 2 * ANCHOR_M)) / 2];
}

/** Logo box [left, top, w, h] in fractions (backend _logo_box_px mirror). */
function logoBox(o: { scale: number; pos: number; ox: number; oy: number; natW: number; natH: number }): [number, number, number, number] {
  const logoAspect = o.natW > 0 && o.natH > 0 ? o.natW / o.natH : 1;
  let w = Math.max(o.scale, 1) / 100;
  let h = w / logoAspect;
  if (w > 1) { w = 1; h = 1 / logoAspect; }
  if (h > 1) { h = 1; w = logoAspect; }
  const [ax, ay] = anchorOf(o.pos);
  const left = Math.min(Math.max(ax + o.ox - w / 2, 0), 1 - w);
  const top = Math.min(Math.max(ay + o.oy - h / 2, 0), 1 - h);
  return [left, top, w, h];
}

/** Photo box [left, top, w] in fractions (backend _photo_box_px mirror). */
function framePhotoBox(o: { scale: number; pos: number; ox: number; oy: number }): [number, number, number] {
  const s = Math.min(Math.max(o.scale, 10), 100) / 100;
  const w = s;
  const [ax, ay] = anchorOf(o.pos);
  const left = Math.min(Math.max(ax + o.ox - w / 2, 0), 1 - w);
  const top = Math.min(Math.max(ay + o.oy - w / 2, 0), 1 - w);
  return [left, top, w];
}

function FrameMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "frame-mark frame-mark--small" : "frame-mark"} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function ArrowIcon({ down = false }: { down?: boolean }) {
  return <span className={down ? "arrow arrow--down" : "arrow"} aria-hidden="true" />;
}

function Button({
  children,
  variant = "primary",
  onClick,
  disabled,
  size = "md",
  title,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "text";
  onClick?: () => void;
  disabled?: boolean;
  size?: "md" | "sm";
  title?: string;
}) {
  return (
    <button className={`button button--${variant}${size === "sm" ? " button--sm" : ""}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function Heading({
  children,
  level = 2,
  className = "",
}: {
  children: ReactNode;
  level?: 1 | 2 | 3;
  className?: string;
}) {
  const Tag = level === 1 ? "h1" : level === 3 ? "h3" : "h2";
  return <Tag className={`heading heading--${level} ${className}`}>{children}</Tag>;
}

function Header({
  page,
  setPage,
}: {
  page: "home" | "about";
  setPage: (page: "home" | "about") => void;
}) {
  return (
    <header className="site-header">
      <button className="brand" onClick={() => setPage("home")} aria-label="صفحه اصلی چارچوب">
        <FrameMark small />
        <span className="brand__name">چارچوب</span>
        <span className="brand__tag">برش هوشمند تصویر</span>
      </button>
      <nav className="nav" aria-label="ناوبری اصلی">
        <button className={page === "home" ? "nav__link is-active" : "nav__link"} onClick={() => setPage("home")}>
          خانه
        </button>
        <button className={page === "about" ? "nav__link is-active" : "nav__link"} onClick={() => setPage("about")}>
          درباره ما
        </button>
      </nav>
      <div className="header__meta">نسخه آزمایشی ۰.۱</div>
    </header>
  );
}

function StepLine({ active }: { active: number }) {
  const steps = ["بارگذاری و انتخاب نسبت", "پیش‌نمایش و نهایی‌کردن", "قاب و نشان", "رندر و دانلود"];
  return (
    <div className="steps" aria-label="مراحل کار">
      {steps.map((step, index) => (
        <div className={`step ${index <= active ? "is-active" : ""}`} key={step}>
          <span className="step__number">۰{index + 1}</span>
          <span>{step}</span>
        </div>
      ))}
    </div>
  );
}

type FinishMode = "none" | "logo" | "frame";

function RangeControl({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span><strong>{label}</strong><b>{value}%</b></span>
      <input dir="ltr" type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <small><span>{min}%</span><span>{max}%</span></small>
    </label>
  );
}

function PositionGrid({
  value,
  onChange,
  customLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  customLabel?: string | null;
}) {
  const names = ["بالا راست", "بالا وسط", "بالا چپ", "وسط راست", "مرکز", "وسط چپ", "پایین راست", "پایین وسط", "پایین چپ"];
  return (
    <div className="position-control">
      <div className="setting-label"><strong>موقعیت</strong><span>{customLabel ?? names[value]}</span></div>
      <div className="position-row">
        <div className="position-grid">
          {names.map((name, index) => (
            <button
              key={name}
              className={index === value ? "position-cell is-active" : "position-cell"}
              aria-label={name}
              onClick={() => onChange(index)}
            >
              <span />
            </button>
          ))}
        </div>
        <p>برای تنظیم دقیق، مورد را روی پیش‌نمایش بکشید.</p>
      </div>
    </div>
  );
}

function UploadSetting({ label, fileName, onChange }: { label: string; fileName?: string; onChange: (file: File) => void }) {
  return (
    <label className="setting-upload">
      <input type="file" accept="image/png" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onChange(file);
      }} />
      <FrameMark small />
      <span>{fileName ? `تغییر فایل: ${fileName}` : label}</span>
      <small>PNG</small>
    </label>
  );
}

function readImageFile(file: File): Promise<{ url: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  return new Promise((resolve, reject) => {
    img.onload = () => resolve({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("failed to read image file"));
  });
}

function ListRow({
  thumb,
  children,
  badges,
  actions,
  active = false,
  dim = false,
  onClick,
  title,
  extra,
}: {
  thumb: ReactNode;
  children: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  active?: boolean;
  dim?: boolean;
  onClick?: () => void;
  title?: string;
  extra?: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div
      className={`list-row${active ? " is-active" : ""}${dim ? " is-dim" : ""}`}
      onClick={onClick}
      title={title}
      {...extra}
    >
      {thumb}
      <span className="list-row__main">{children}</span>
      {badges}
      {actions && (
        <span className="list-row__actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  );
}

function ViewToggle({ value, onChange, show = true }: { value: boolean; onChange: () => void; show?: boolean }) {
  if (!show) return null;
  return (
    <div className="view-toggle" role="group" aria-label="نمایش برش">
      <button className={!value ? "is-active" : "is-inactive"} onClick={onChange}>برش</button>
      <button className={value ? "is-active" : "is-inactive"} onClick={onChange}>روی اصلی</button>
    </div>
  );
}

interface AssetFile {
  url: string;
  name: string;
  w: number;
  h: number;
}

interface LogoCfg {
  scale: number;
  opacity: number;
  pos: number;
  ox: number;
  oy: number;
  custom: boolean;
  file: AssetFile | null;
}

interface FrameCfg {
  layer: "under" | "over";
  scale: number;
  opacity: number;
  pos: number;
  ox: number;
  oy: number;
  custom: boolean;
  file: AssetFile | null;
}

interface CustomCrop {
  url: string;
  width: number;
  height: number;
  box: [number, number, number, number];
}

interface Rendered {
  url: string;
  format: "jpg" | "png";
  width: number;
  height: number;
}

interface SubjCfg {
  mode: FinishMode;
  logo: LogoCfg;
  frame: FrameCfg;
  rendered: Rendered | null;
  rendering: boolean;
  message: "success" | "error" | null;
  errText: string;
}

function defaultSubjCfg(): SubjCfg {
  return {
    mode: "none",
    logo: { scale: 25, opacity: 80, pos: 6, ox: 0, oy: 0, custom: false, file: null },
    frame: { layer: "under", scale: 95, opacity: 100, pos: 4, ox: 0, oy: 0, custom: false, file: null },
    rendered: null,
    rendering: false,
    message: null,
    errText: "",
  };
}

function FinishStudio({ items, customs, originKeys, onToggleOrigin, onCustomRequest, onPaneChange, onBack }: {
  items: { photo: { url: string; w: number; h: number; file: File; name: string }; crop: Crop }[];
  customs: Record<number, CustomCrop>;
  originKeys: Set<number>;
  onToggleOrigin: (i: number) => void;
  onCustomRequest: (i: number) => void;
  onPaneChange: (pane: "studio" | "outputs") => void;
  onBack: () => void;
}) {
  const [subject, setSubject] = useState(0);
  const [cfgs, setCfgs] = useState<Record<number, SubjCfg>>({});
  const cfgsRef = useRef(cfgs);
  cfgsRef.current = cfgs;
  const [review, setReview] = useState<number | null>(null);
  const [showOrigin, setShowOrigin] = useState(false);
  // نمای داخلی مرحله ۳/۴: استودیو یا خروجی‌ها (فقط یکی دیده می‌شود)
  const [pane, setPane] = useState<"studio" | "outputs">("studio");
  // وضعیت دانلود (به‌صورت یک‌تا‌یک) + خلاصه «دانلود همه»
  const [busyDl, setBusyDl] = useState<Set<number>>(new Set());
  const [dlSummary, setDlSummary] = useState<{ ok: number; fail: number } | null>(null);
  const switchPane = (p: "studio" | "outputs") => {
    setPane(p);
    onPaneChange(p);
  };
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; cw: number; ch: number; apply: (ox: number, oy: number) => void } | null>(null);

  const idx = subject < items.length ? subject : 0;
  const item = items[idx];
  const crop = item.crop;
  const original = item.photo;
  const cfg: SubjCfg = cfgs[idx] ?? defaultSubjCfg();

  const patch = (p: Partial<SubjCfg>) =>
    setCfgs((m) => ({ ...m, [idx]: { ...(m[idx] ?? defaultSubjCfg()), ...p } }));
  const patchLogo = (p: Partial<LogoCfg>) => patch({ logo: { ...cfg.logo, ...p } });
  const patchFrame = (p: Partial<FrameCfg>) => patch({ frame: { ...cfg.frame, ...p } });
  const custom = customs[idx];
  const base = custom ?? { url: crop.url, width: crop.width, height: crop.height };
  const effBox: [number, number, number, number] | null = custom?.box ?? crop.box;
  const ratio = crop.width / crop.height;
  // خروجی منتخب مرحله ۴ (همان انتخاب مشترک استودیو)
  const outItem = items[idx] ?? items[0];
  const outCc = cfgs[idx];
  const outCustom = customs[idx];
  const outSrc = outCc?.rendered?.url ?? outCustom?.url ?? outItem.crop.url;
  const outW = outCc?.rendered?.width ?? outCustom?.width ?? outItem.crop.width;
  const outH = outCc?.rendered?.height ?? outCustom?.height ?? outItem.crop.height;

  const takeFile = async (file: File, which: "logo" | "frame") => {
    if (file.type !== "image/png" && !/\.png$/i.test(file.name)) {
      patch({ message: "error", errText: "ورودی این بخش فقط PNG است." });
      return;
    }
    try {
      const r = await readImageFile(file);
      const asset = { url: r.url, name: file.name, w: r.w, h: r.h };
      if (which === "logo") patchLogo({ file: asset });
      else patchFrame({ file: asset });
    } catch {
      patch({ message: "error", errText: "خواندن فایل ناموفق بود." });
    }
  };

  const beginDrag = (
    event: PointerEvent<HTMLDivElement>,
    ox: number,
    oy: number,
    apply: (ox: number, oy: number) => void
  ) => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox, oy, cw: rect.width, ch: rect.height, apply };
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    d.apply(d.ox + (event.clientX - d.sx) / d.cw, d.oy + (event.clientY - d.sy) / d.ch);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const compositeSubject = async (i: number) => {
    const c = cfgsRef.current[i] ?? defaultSubjCfg();
    const cp = items[i].crop;
    const b = customs[i] ?? { url: cp.url, width: cp.width, height: cp.height };
    const f = c.mode === "logo" ? c.logo.file : c.frame.file;
    if (c.mode === "none" || !f) throw new Error("ابتدا فایل PNG را انتخاب کنید");
    const baseBlob = await (await fetch(b.url)).blob();
    const overBytes = await (await fetch(f.url)).arrayBuffer();
    const params =
      c.mode === "logo"
        ? { mode: "logo", scale: c.logo.scale, opacity: c.logo.opacity, position: toBackendPos(c.logo.pos), offsetX: c.logo.ox, offsetY: c.logo.oy }
        : { mode: "frame", placement: c.frame.layer, photo_scale: c.frame.scale, position: toBackendPos(c.frame.pos), offsetX: c.frame.ox, offsetY: c.frame.oy, photo_opacity: c.frame.opacity };
    return compositeBlob(baseBlob, overBytes, f.name, params);
  };

  const renderFinalFor = async (i: number) => {
    const c0 = cfgsRef.current[i] ?? defaultSubjCfg();
    if (!items[i]) return;
    const f = c0.mode === "logo" ? c0.logo.file : c0.frame.file;
    if (c0.mode === "none" || !f) return;
    setCfgs((m) => ({ ...m, [i]: { ...(m[i] ?? defaultSubjCfg()), rendering: true, message: null, errText: "" } }));
    try {
      const out = await compositeSubject(i);
      const url = URL.createObjectURL(out.blob);
      setCfgs((m) => {
        const old = m[i]?.rendered?.url;
        if (old) URL.revokeObjectURL(old);
        return { ...m, [i]: { ...(m[i] ?? defaultSubjCfg()), rendered: { url, format: out.format, width: out.width, height: out.height }, rendering: false, message: "success" } };
      });
    } catch (e) {
      setCfgs((m) => ({ ...m, [i]: { ...(m[i] ?? defaultSubjCfg()), rendering: false, message: "error", errText: (e as Error).message || "خطا در رندر نهایی" } }));
    }
  };

  const renderFinal = () => void renderFinalFor(idx);

  // رندر خودکار (debounce) مثل کیت قبلی؛ فقط برای آیتم فعال، نه همه
  const cfgsSig = JSON.stringify({
    cfg: Object.fromEntries(
      Object.entries(cfgs).map(([k, c]) => [k, { m: c.mode, l: c.logo, f: c.frame }])
    ),
    custom: customs,
  });
  useEffect(() => {
    const c = cfgs[idx];
    if (!c || c.rendering || c.mode === "none") return;
    const f = c.mode === "logo" ? c.logo.file : c.frame.file;
    if (!f) return;
    const t = window.setTimeout(() => {
      void renderFinalFor(idx).catch(() => {
        /* errors are stored on the card */
      });
    }, 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgsSig, idx]);

  const applyToAll = () => {
    const src: SubjCfg = cfgs[idx] ?? defaultSubjCfg();
    if (src.mode === "none") return;
    setCfgs((m) => {
      const next: Record<number, SubjCfg> = { ...m };
      for (let i = 0; i < items.length; i++) {
        const cur = next[i] ?? defaultSubjCfg();
        next[i] = { ...cur, mode: src.mode, logo: { ...src.logo }, frame: { ...src.frame } };
      }
      return next;
    });
  };

  const downloadUrl = (url: string, name: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  };

  const dlOne = async (i: number): Promise<boolean> => {
    if (busyDl.has(i)) return false;
    const c = cfgs[i] ?? defaultSubjCfg();
    const cp = items[i].crop;
    const baseName = items[i].photo.name.replace(/\.[^.]+$/, "") || "khabar";
    setBusyDl((prev) => new Set(prev).add(i));
    try {
      if (c.rendered) {
        downloadUrl(c.rendered.url, `${baseName}-${cp.spec}.${c.rendered.format}`);
        return true;
      }
      const configured = c.mode !== "none" && (c.mode === "logo" ? c.logo.file : c.frame.file);
      if (configured) {
        const out = await compositeSubject(i);
        const url = URL.createObjectURL(out.blob);
        downloadUrl(url, `${baseName}-${cp.spec}.${out.format}`);
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        return true;
      }
      const b = customs[i] ?? { url: cp.url };
      downloadUrl(b.url, `${baseName}-${cp.spec}.jpg`);
      return true;
    } catch {
      return false;
    } finally {
      setBusyDl((prev) => {
        const next = new Set(prev);
        next.delete(i);
        return next;
      });
    }
  };

  const downloadOutput = (i: number) => void dlOne(i);

  // دانلود همه به‌صورت ترتیبی (نه تایمر پلکانی) + خلاصه نتیجه
  const downloadAll = async () => {
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < items.length; i++) {
      if (await dlOne(i)) ok++;
      else fail++;
      if (i < items.length - 1) await new Promise((r) => window.setTimeout(r, 200));
    }
    setDlSummary({ ok, fail });
  };

  // رندر دستیِ همه خروجی‌ها (زمانی که کاربر بخواهد یکجا همه‌چیز را تازه کند)
  const renderAll = () => {
    for (let i = 0; i < items.length; i++) {
      const c = cfgsRef.current[i] ?? defaultSubjCfg();
      const f = c.mode === "logo" ? c.logo.file : c.frame.file;
      if (c.mode !== "none" && f) void renderFinalFor(i).catch(() => {});
    }
  };

  const reset = () => {
    if (cfg.rendered) URL.revokeObjectURL(cfg.rendered.url);
    patch(defaultSubjCfg());
  };

  return (
    <>
      {pane === "studio" ? (
        <>
        <div className="preview-panel">
          <div className="finish-preview">
            <div className="finish-preview__top">
              <span>{original.name}</span>
            </div>
            <div className="finish-preview__stage">
              <div className={`final-canvas final-canvas--${cfg.mode}`} style={{ aspectRatio: crop.width / crop.height }}>
                {cfg.mode === "frame" && cfg.frame.layer === "under" && (
                  cfg.frame.file
                    ? <img src={cfg.frame.file.url} alt="قاب" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill", pointerEvents: "none" }} />
                    : <div className="demo-frame demo-frame--under" />
                )}
                {cfg.mode === "frame" && (() => {
                  const [fl, ft, fw] = framePhotoBox({ scale: cfg.frame.scale, pos: toBackendPos(cfg.frame.pos), ox: cfg.frame.ox, oy: cfg.frame.oy });
                  return (
                    <div
                      className="draggable-photo is-draggable"
                      onPointerDown={(e) => beginDrag(e, cfg.frame.ox, cfg.frame.oy, (ox, oy) => patchFrame({ ox, oy, custom: true }))}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      style={{ position: "absolute", left: `${fl * 100}%`, top: `${ft * 100}%`, width: `${fw * 100}%`, height: `${fw * 100}%`, opacity: cfg.frame.opacity / 100 }}
                    >
                      <img src={base.url} alt="پیش‌نمایش خروجی خبری" draggable={false} />
                    </div>
                  );
                })()}
                {cfg.mode === "logo" && (
                  <div className="draggable-photo">
                    <img src={base.url} alt="پیش‌نمایش خروجی خبری" draggable={false} />
                  </div>
                )}
                {cfg.mode === "none" && (
                  <div className="draggable-photo">
                    <img src={base.url} alt="پیش‌نمایش خروجی خبری" draggable={false} />
                  </div>
                )}
                {cfg.mode === "frame" && cfg.frame.layer === "over" && (
                  cfg.frame.file
                    ? <img src={cfg.frame.file.url} alt="قاب" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill", pointerEvents: "none" }} />
                    : <div className="demo-frame demo-frame--over" />
                )}
                {cfg.mode === "logo" && cfg.logo.file && (() => {
                  const [ll, lt, lw] = logoBox({ scale: cfg.logo.scale, pos: toBackendPos(cfg.logo.pos), ox: cfg.logo.ox, oy: cfg.logo.oy, natW: cfg.logo.file.w, natH: cfg.logo.file.h });
                  return (
                    <img
                      src={cfg.logo.file.url}
                      alt="لوگو"
                      draggable={false}
                      onPointerDown={(e) => beginDrag(e, cfg.logo.ox, cfg.logo.oy, (ox, oy) => patchLogo({ ox, oy, custom: true }))}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      style={{ position: "absolute", left: `${ll * 100}%`, top: `${lt * 100}%`, width: `${lw * 100}%`, opacity: cfg.logo.opacity / 100, cursor: "grab", touchAction: "none", userSelect: "none", zIndex: 4 }}
                    />
                  );
                })()}
                {cfg.mode !== "none" && !(cfg.mode === "logo" ? cfg.logo.file : cfg.frame.file) && (
                  <div className="empty-asset">ابتدا فایل {cfg.mode === "logo" ? "لوگو" : "قاب"} را انتخاب کنید</div>
                )}
              </div>
            </div>
            <div className="preview-hint">
              <span className="status-dot" />
              <span>{items.length} خروجی آماده تنظیم</span>
              <button className="text-link" onClick={() => setReview(idx)}>بازبینی</button>
            </div>
          </div>
        </div>
        <aside className="controls">
            <div className="control-section">
              <div className="control-title">
                <span><b>۰۳</b> قاب و نشان</span>
                {cfg.mode !== "none" && <span className="check">✓</span>}
              </div>
            <div className="list-stack">
              {items.map((item, index) => {
                const cc = cfgs[index];
                const badges = [
                  cc?.mode === "logo" && cc.logo.file && "لوگو",
                  cc?.mode === "frame" && cc.frame.file && "قاب",
                  customs[index] && "سفارشی",
                ].filter(Boolean);
                return (
                  <ListRow
                    key={item.photo.url + item.crop.spec}
                    active={index === idx}
                    onClick={() => setSubject(index)}
                    title="تنظیم این خروجی"
                    thumb={<img className="list-row__thumb list-row__thumb--sm" src={customs[index]?.url ?? item.crop.url} alt={item.photo.name} />}
                    badges={badges.length > 0 ? <span className="list-row__badge">{badges.join(" · ")}</span> : undefined}
                  >
                    {item.photo.name} · {item.crop.label}
                  </ListRow>
                );
              })}
            </div>
          <div className="finish-settings">
            <div className="mode-switch">
              {[
                ["none", "بدون"],
                ["logo", "لوگو / واترمارک"],
                ["frame", "قاب / بک‌گراند"],
              ].map(([value, label]) => (
                <button key={value} className={cfg.mode === value ? "is-active" : ""} onClick={() => patch({ mode: value as FinishMode, message: null })}>
                  {label}
                </button>
              ))}
            </div>

            {cfg.mode === "none" ? (
              <div className="no-settings"><FrameMark /><p>این برش بدون قاب یا نشان رسانه رندر می‌شود.</p></div>
            ) : cfg.mode === "logo" ? (
              <div className="settings-panel">
                <UploadSetting label="انتخاب فایل PNG لوگو" fileName={cfg.logo.file?.name} onChange={(f) => void takeFile(f, "logo")} />
                <RangeControl label="اسکیل" value={cfg.logo.scale} min={5} max={1000} onChange={(v) => patchLogo({ scale: v })} />
                <RangeControl label="اوپسیتی" value={cfg.logo.opacity} onChange={(v) => patchLogo({ opacity: v })} />
                <PositionGrid value={cfg.logo.pos} customLabel={cfg.logo.custom ? "سفارشی (درگ)" : undefined} onChange={(v) => patchLogo({ pos: v, ox: 0, oy: 0, custom: false })} />
              </div>
            ) : (
              <div className="settings-panel">
                <UploadSetting label="انتخاب فایل PNG قاب" fileName={cfg.frame.file?.name} onChange={(f) => void takeFile(f, "frame")} />
                <div className="layer-switch">
                  <button className={cfg.frame.layer === "under" ? "is-active" : ""} onClick={() => patchFrame({ layer: "under" })}>قاب زیر عکس</button>
                  <button className={cfg.frame.layer === "over" ? "is-active" : ""} onClick={() => patchFrame({ layer: "over" })}>قاب روی عکس</button>
                </div>
                <p className="setting-help">ترتیب قرارگیری قاب نسبت به تصویر اصلی را مشخص کنید.</p>
                <RangeControl label="اندازه عکس در قاب" value={cfg.frame.scale} min={10} max={100} onChange={(v) => patchFrame({ scale: v })} />
                <RangeControl label="اوپسیتی عکس" value={cfg.frame.opacity} onChange={(v) => patchFrame({ opacity: v })} />
                <PositionGrid value={cfg.frame.pos} customLabel={cfg.frame.custom ? "سفارشی (درگ)" : undefined} onChange={(v) => patchFrame({ pos: v, ox: 0, oy: 0, custom: false })} />
              </div>
            )}

            <div className="finish-actions">
              <button className="reset-link" onClick={reset}>بازنشانی تنظیمات این مورد</button>
              <Button variant="secondary" onClick={applyToAll}>اعمال به همه خروجی‌ها</Button>
              <button className="reset-link" onClick={renderAll}>→ رندر همه خروجی‌ها</button>
              <Button onClick={() => void renderFinal()} disabled={cfg.rendering}>
                {cfg.rendering && <span className="spinner" />}
                {cfg.rendering ? "در حال به‌روزرسانی…" : "به‌روزرسانی رندر نهایی"}
              </Button>
              {cfg.message === "success" && <div className="render-message render-message--success">رندر نهایی با موفقیت به‌روزرسانی شد.</div>}
              {cfg.message === "error" && <div className="render-message render-message--error">{cfg.errText || "خطا در رندر نهایی"}</div>}
            </div>
            <div className="finish-actions__links">
              <Button onClick={() => switchPane("outputs")}>مشاهده خروجی‌ها <ArrowIcon /></Button>
              <button className="reset-link" onClick={onBack}>→ بازگشت به پیش‌نمایش‌ها</button>
            </div>
          </div>
          </div>
          </aside>
        </>
      ) : (
      <>
      <div className="preview-panel">
        <div className="finish-preview">
          <div className="finish-preview__top">
            <span>{outItem.photo.name}</span>
          </div>
          <div className="finish-preview__stage">
            <div
              className="final-canvas final-canvas--none is-zoomable"
              style={{ aspectRatio: `${outW} / ${outH}` }}
              onClick={() => { setReview(idx); setShowOrigin(false); }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setReview(idx); setShowOrigin(false); } }}
            >
              <div className="draggable-photo">
                <img src={outSrc} alt="پیش‌نمایش خروجی نهایی" draggable={false} />
              </div>
              <span className="final-canvas__zoom-hint">برای بزرگ‌نمایی کلیک کنید</span>
            </div>
          </div>
          <div className="preview-hint">
            <span className="status-dot" />
            <span>{items.length} خروجی نهایی</span>
            <button className="text-link" onClick={() => { setReview(idx); setShowOrigin(false); }}>بازبینی</button>
          </div>
        </div>
      </div>
      <aside className="controls">
        {(() => {
          const groups: { spec: string; label: string; indices: number[] }[] = [];
          for (let i = 0; i < items.length; i++) {
            const spec = items[i].crop.spec;
            let g = groups.find((x) => x.spec === spec);
            if (!g) {
              g = { spec, label: items[i].crop.label, indices: [] };
              groups.push(g);
            }
            g.indices.push(i);
          }
          return groups.map((g) => (
            <div key={g.spec} className="control-section">
              <div className="control-title">
                <span><b>۰۴</b> {g.label}</span>
                <b>{g.indices.length} خروجی</b>
              </div>
              <div className="output-grid">
                {g.indices.map((index) => {
                  const item = items[index];
                  const cc = cfgs[index];
                  const custom = customs[index];
                  const dims = cc?.rendered
                    ? `${cc.rendered.width} × ${cc.rendered.height}`
                    : custom
                      ? `${custom.width} × ${custom.height}`
                      : `${item.crop.width} × ${item.crop.height}`;
                  const badges = [
                    custom ? "سفارشی" : null,
                    cc?.rendered ? "رندر شده" : null,
                  ].filter(Boolean) as string[];
                  return (
                    <figure
                      key={item.photo.url + item.crop.spec}
                      className={`output-card${index === idx ? " is-active" : ""}`}
                      onClick={() => setSubject(index)}
                    >
                      <div className="output-card__frame">
                        <img
                          className="output-card__img"
                          src={cc?.rendered?.url ?? custom?.url ?? item.crop.url}
                          alt={`${item.photo.name} · ${item.crop.label}`}
                          draggable={false}
                          onClick={(e) => { e.stopPropagation(); setSubject(index); setReview(index); setShowOrigin(false); }}
                        />
                        {badges.length > 0 && <span className="output-card__badges">{badges.join(" · ")}</span>}
                        <span className="output-card__zoom">بزرگ‌نمایی</span>
                      </div>
                      <figcaption className="output-card__meta">
                        <span className="output-card__name">{item.photo.name}</span>
                        <span className="output-card__dims">{dims}</span>
                      </figcaption>
                      <button
                        className="output-card__dl"
                        disabled={busyDl.has(index)}
                        onClick={(e) => { e.stopPropagation(); void downloadOutput(index); }}
                      >
                        {busyDl.has(index) ? "در حال دانلود…" : "دانلود"}
                      </button>
                    </figure>
                  );
                })}
              </div>
            </div>
          ));
        })()}
        {dlSummary && (
          <div className={`render-message ${dlSummary.fail === 0 ? "render-message--success" : "render-message--error"}`}>
            {dlSummary.fail === 0 ? `همه ${dlSummary.ok} خروجی دانلود شد.` : `${dlSummary.ok} دانلود شد، ${dlSummary.fail} ناموفق.`}
          </div>
        )}
        <Button onClick={() => void downloadAll()} disabled={busyDl.size > 0}>
          {busyDl.size > 0 ? "در حال دانلود…" : "دانلود همه"}
        </Button>
        <button className="reset-link" onClick={() => switchPane("studio")}>→ بازگشت به استودیو</button>
      </aside>
      </>
      )}

      {review !== null && (() => {
        const rcp = items[review].crop;
        const photo = items[review].photo;
        const cc = cfgs[review] ?? defaultSubjCfg();
        const custom = customs[review];
        const viewSrc = cc.rendered?.url ?? custom?.url ?? rcp.url;
        const viewDims = cc.rendered
          ? `${cc.rendered.width} × ${cc.rendered.height}`
          : custom
            ? `${custom.width} × ${custom.height}`
            : `${rcp.width} × ${rcp.height}`;
        const vBox = custom?.box ?? rcp.box;
        return (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="review-modal">
              <div className="modal-header">
                <div><strong>{photo.name} · {rcp.label}</strong><span>{viewDims}</span></div>
                <div className="modal-actions">
                  {vBox && <ViewToggle value={showOrigin} onChange={() => setShowOrigin((v) => !v)} show={true} />}
                  <Button size="sm" variant="secondary" onClick={() => onCustomRequest(review)}>برش دلخواه</Button>
                  <Button size="sm" onClick={() => void downloadOutput(review)}>دانلود</Button>
                  <button className="modal-close" onClick={() => { setReview(null); setShowOrigin(false); }}>بستن</button>
                </div>
              </div>
              <div className="review-modal__body">
                {showOrigin && vBox ? (
                  <div className="origin-stage" style={{ aspectRatio: `${photo.w} / ${photo.h}` }}>
                    <img src={photo.url} alt="عکس اصلی" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
                    <img
                      src={viewSrc}
                      alt="برش"
                      draggable={false}
                      style={{
                        position: "absolute",
                        left: `${(vBox[0] / photo.w) * 100}%`,
                        top: `${(vBox[1] / photo.h) * 100}%`,
                        width: `${((vBox[2] - vBox[0]) / photo.w) * 100}%`,
                        height: `${((vBox[3] - vBox[1]) / photo.h) * 100}%`,
                        opacity: 0.5,
                        border: "2px solid var(--accent)",
                        pointerEvents: "none",
                      }}
                    />
                  </div>
                ) : (
                  <img src={viewSrc} alt="بازبینی خروجی نهایی" />
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

interface Original {
  url: string;
  w: number;
  h: number;
  file: File;
  name: string;
}

interface CustomCrop {
  url: string;
  width: number;
  height: number;
  box: [number, number, number, number];
}

const MAX_PHOTOS = 10;
const MAX_FILE_MB = 12;

function Home() {
  const [image, setImage] = useState(sampleImage);
  const [photos, setPhotos] = useState<Original[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number[]>([3]);
  const [results, setResults] = useState<{ photo: Original; crop: Crop }[] | null>(null);
  const [finalized, setFinalized] = useState(false);
  // نمای داخلی استودیو (مرحله ۳/۴): استودیو یا پنل خروجی‌ها
  const [finPane, setFinPane] = useState<"studio" | "outputs">("studio");
  const [dragging, setDragging] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [progress, setProgress] = useState("");
  const [cropStep, setCropStep] = useState({ done: 0, total: 0, name: "" });
  const [cropError, setCropError] = useState("");
  // ویزارد ۴ مرحله‌ای: فقط یک مرحله دیده می‌شود (hidden، نه unmount تا stateها بمانند)
  const [stage, setStage] = useState(1);
  // آیتم منتخب مرحله دوم (داخل همان باکس workspace)
  const [stageSel, setStageSel] = useState(0);
  const goStage = (n: number) => {
    setStage(n);
    const anchor = n === 3 ? "finish-studio" : "studio";
    window.setTimeout(
      () => document.querySelector(`#${anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      80
    );
  };
  const [cusW, setCusW] = useState("4");
  const [cusH, setCusH] = useState("3");
  // برش دلخواه و جای برشِ مرحله دوم (مشترک با استودیو)
  const [customs, setCustoms] = useState<Record<number, CustomCrop>>({});
  const [originKeys, setOriginKeys] = useState<Set<number>>(new Set());
  const [modalTarget, setModalTarget] = useState<number | null>(null);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 1 });
  const [cropBusy, setCropBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cropDragRef = useRef<{ sx: number; sy: number; r: { x: number; y: number; w: number }; cw: number; ch: number; mode: "move" | "resize" } | null>(null);

  const resetBatch = () => {
    setResults(null);
    setFinalized(false);
    setFinPane("studio");
    setStageSel(0);
    setStage(1);
    setCustoms((prev) => {
      Object.values(prev).forEach((c) => URL.revokeObjectURL(c.url));
      return {};
    });
    setOriginKeys(new Set());
    setModalTarget(null);
  };

  const takeOriginals = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) {
      setCropError("فایل تصویری معتبر انتخاب کنید.");
      return;
    }
    const tooBig = imgs.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    const ok = imgs.filter((f) => f.size <= MAX_FILE_MB * 1024 * 1024).slice(0, MAX_PHOTOS);
    if (ok.length === 0) {
      setCropError(`حجم هر عکس حداکثر ${MAX_FILE_MB} مگابایت.`);
      return;
    }
    setCropError(
      [
        tooBig.length > 0 ? `${tooBig.length} فایل سنگین‌تر از حد نادیده گرفته شد.` : "",
        imgs.length > MAX_PHOTOS ? `حداکثر ${MAX_PHOTOS} عکس.` : "",
      ].filter(Boolean).join(" ")
    );
    const out: Original[] = [];
    for (const file of ok) {
      try {
        const r = await readImageFile(file);
        out.push({ url: r.url, w: r.w, h: r.h, file, name: file.name });
      } catch {
        /* skip unreadable */
      }
    }
    if (out.length === 0) {
      setCropError("خواندن تصویر ناموفق بود.");
      return;
    }
    setPhotos(out);
    setPicked(new Set(out.map((_, i) => i)));
    setImage(out[0].url);
    resetBatch();
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    void takeOriginals(files).catch(() => setCropError("خواندن تصویر ناموفق بود."));
  };

  const onDropFile = (files: File[]) => {
    void takeOriginals(files).catch(() => setCropError("خواندن تصویر ناموفق بود."));
  };

  const removePhoto = (index: number) => {
    setPhotos((prev) => {
      const gone = prev[index];
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((_, i) => i !== index);
    });
    setPicked((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
    resetBatch();
  };

  const clearPhotos = () => {
    setPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setPicked(new Set());
    resetBatch();
  };

  const togglePhoto = (index: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    resetBatch();
  };

  const dragPhotoFrom = useRef<number | null>(null);

  const movePhoto = (from: number, to: number) => {
    if (from === to || results) return; // reorder only before cropping
    setPhotos((prev) => {
      const next = [...prev];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
    setPicked((prev) => {
      // indices shift with the move; keep the same photos picked
      const ids = photos.map((p) => p.url);
      const moved = ids[from];
      const rest = ids.filter((_, i) => i !== from);
      rest.splice(to, 0, moved);
      const next = new Set<number>();
      prev.forEach((i) => {
        const id = ids[i];
        const ni = rest.indexOf(id);
        if (ni >= 0) next.add(ni);
      });
      return next;
    });
    setImage(photos[from]?.url ?? image);
  };

  const toggleRatio = (index: number) => {
    setSelected((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
    resetBatch();
  };

  const customSpec = () => {
    const w = Math.max(1, parseInt(cusW, 10) || 4);
    const h = Math.max(1, parseInt(cusH, 10) || 3);
    return `${w}:${h}`;
  };

  // یک یا چند نسبت درخواستی برای همه عکس‌های منتخب
  const wantedSpecs = () =>
    selected.map((i) =>
      i === 6 ? { spec: customSpec(), label: customSpec() } : { spec: ratios[i].spec, label: ratios[i].value }
    );

  const applyCrop = async () => {
    const targets = photos.filter((_, i) => picked.has(i));
    const specs = wantedSpecs();
    if (targets.length === 0) {
      setCropError("حداقل یک تصویر را انتخاب کنید.");
      return;
    }
    if (specs.length === 0) {
      setCropError("حداقل یک نسبت را انتخاب کنید.");
      return;
    }
    setCropping(true);
    setCropError("");
    setCropStep({ done: 0, total: targets.length, name: "" });
    resetBatch();
    try {
      const out: { photo: Original; crop: Crop }[] = [];
      for (let i = 0; i < targets.length; i++) {
        setProgress(`برش ${i + 1} از ${targets.length}…`);
        setCropStep({ done: i, total: targets.length, name: targets[i].name });
        try {
          const crops = await cropImage(targets[i].file, specs);
          for (const crop of crops) out.push({ photo: targets[i], crop });
        } catch {
          /* این عکس رد میشود، بقیه ادامه میدهند */
        }
        setCropStep({ done: i + 1, total: targets.length, name: "" });
      }
      if (out.length === 0) throw new Error("برش هیچ تصویری موفق نبود.");
      if (out.length < targets.length * specs.length) {
        setCropError("برش بعضی موارد ناموفق بود.");
      }
      setResults(out);
      setStageSel(0);
      goStage(2);
    } catch (e) {
      setCropError((e as Error).message || "خطا در برش تصویر");
    } finally {
      setCropping(false);
      setProgress("");
      setCropStep({ done: 0, total: 0, name: "" });
    }
  };

  // پیش‌نمایش مرحله اول همیشه سایز اصلی اولین عکس منتخب است (بدون فریم فیک)
  const stagePhoto = photos.find((_, i) => picked.has(i)) ?? photos[0];

  const toggleOrigin = (i: number) => {
    setOriginKeys((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const finalize = () => {
    setFinalized(true);
    goStage(3);
  };

  const openCropFor = (i: number) => {
    if (!results) return;
    const { photo, crop } = results[i];
    const b = customs[i]?.box ?? crop.box;
    if (b) {
      setRect({ x: b[0] / photo.w, y: b[1] / photo.h, w: (b[2] - b[0]) / photo.w });
    } else {
      const r = crop.width / crop.height;
      const k0 = photo.w / photo.h / r;
      let w = 1;
      if (w * k0 > 1) w = 1 / k0;
      setRect({ x: (1 - w) / 2, y: (1 - w * k0) / 2, w });
    }
    setModalTarget(i);
  };

  const confirmCrop = () => {
    if (cropBusy || modalTarget === null || !results) return;
    const { photo } = results[modalTarget];
    const rcp = results[modalTarget].crop;
    const kk = photo.w / photo.h / (rcp.width / rcp.height);
    setCropBusy(true);
    const img = new Image();
    img.src = photo.url;
    img.onload = () => {
      const h = rect.w * kk;
      const x1 = Math.round(rect.x * photo.w);
      const y1 = Math.round(rect.y * photo.h);
      const x2 = Math.round((rect.x + rect.w) * photo.w);
      const y2 = Math.round((rect.y + h) * photo.h);
      const cw = Math.max(1, x2 - x1);
      const ch = Math.max(1, y2 - y1);
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext("2d")?.drawImage(img, x1, y1, cw, ch, 0, 0, cw, ch);
      canvas.toBlob((blob) => {
        setCropBusy(false);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const i = modalTarget;
        setCustoms((m) => {
          const prev = m[i]?.url;
          if (prev) URL.revokeObjectURL(prev);
          return { ...m, [i]: { url, width: cw, height: ch, box: [x1, y1, x2, y2] } };
        });
        setModalTarget(null);
      }, "image/jpeg", 0.95);
    };
    img.onerror = () => setCropBusy(false);
  };

  const clearCustom = () => {
    if (modalTarget === null) return;
    const i = modalTarget;
    setCustoms((m) => {
      const prev = m[i]?.url;
      if (prev) URL.revokeObjectURL(prev);
      if (!m[i]) return m;
      const next = { ...m };
      delete next[i];
      return next;
    });
    setModalTarget(null);
  };

  return (
    <main>
      <section className="hero">
        <div className="hero__copy">
          <div className="eyebrow"><span /> برش هوشمند برای تحریریه‌های حرفه‌ای</div>
          <Heading level={1} className="hero__title">
            هر چهره،
            <br />
            در <span className="outlined-word">چارچوب</span> درست.
          </Heading>
          <p className="hero__lead">
            برش هوشمند تصاویر خبری با اولویت تشخیص چهره، بدن و زاویه سوژه؛
            <br className="desktop-only" /> برای خروجی‌های دقیق و آماده انتشار در هر رسانه.
          </p>
          <div className="hero__actions">
            <Button onClick={() => document.querySelector("#studio")?.scrollIntoView({ behavior: "smooth" })}>
              شروع برش تصویر <ArrowIcon down />
            </Button>
            <span className="trust-note">رایگان · بدون نیاز به ثبت‌نام</span>
          </div>
        </div>
        <div className="hero__visual" aria-label="نمونه تشخیص چهره و ترکیب‌بندی تصویر خبری">
          <div className="visual__index">۰۱ / تحلیل سوژه خبری</div>
          <div className="visual__image-wrap">
            <img src={sampleImage} alt="خبرنگار مقابل دوربین در یک گزارش میدانی" />
            <div className="composition-grid"><span /><span /><span /><span /></div>
            <FrameMark />
          </div>
          <div className="visual__caption">
            <span>چهره و زاویه بدن شناسایی شد</span>
            <span>اطمینان ۹۸٪</span>
          </div>
        </div>
      </section>

      <section className="studio" id="studio">
        <div className="section-heading">
          <div>
            <span className="section-number">۰۲</span>
            <Heading>کارگاه برش</Heading>
          </div>
          <p>تصویرها را اضافه کنید، نسبت را انتخاب کنید؛ چهره و سوژه در خروجی‌ها داخل قاب می‌مانند.</p>
        </div>
        <StepLine active={stage === 1 ? 0 : stage === 2 ? 1 : finPane === "outputs" ? 3 : 2} />

        <div className={stage === 3 ? "workspace hidden" : "workspace"}>
          {stage === 2 && results ? (() => {
            const i = Math.min(stageSel, results.length - 1);
            const { photo, crop } = results[i];
            const custom = customs[i];
            const src = custom?.url ?? crop.url;
            const box = custom?.box ?? crop.box;
            const dims = custom ? `${custom.width} × ${custom.height}` : `${crop.width} × ${crop.height}`;
            const showO = originKeys.has(i) && box;
            return (
              <div className="preview-panel">
                <div className="panel-top">
                  <span>پیش‌نمایش برش</span>
                  <span className="file-info">{photo.name} · {dims}</span>
                </div>
                <div className="crop-stage">
                  <div
                    className="crop-frame"
                    style={{ position: "relative", aspectRatio: showO && box ? `${photo.w} / ${photo.h}` : `${crop.width} / ${crop.height}` }}
                  >
                    {showO && box ? (
                      <>
                        <img src={photo.url} alt="عکس اصلی" draggable={false} />
                        <img
                          src={src}
                          alt="برش"
                          draggable={false}
                          style={{
                            position: "absolute",
                            left: `${(box[0] / photo.w) * 100}%`,
                            top: `${(box[1] / photo.h) * 100}%`,
                            width: `${((box[2] - box[0]) / photo.w) * 100}%`,
                            height: `${((box[3] - box[1]) / photo.h) * 100}%`,
                            opacity: 0.5,
                            border: "2px solid var(--accent)",
                            pointerEvents: "none",
                          }}
                        />
                      </>
                    ) : (
                      <img src={src} alt="برش" />
                    )}
                  </div>
                </div>
                <div className="preview-hint">
                  <span className="status-dot" />
                  <span>{results.length} برش آماده</span>
                </div>
              </div>
            );
          })() : (
          <div className="preview-panel">
            <div className="panel-top">
              <span>پیش‌نمایش تصویر</span>
              <span className="file-info">
                {photos.length > 0
                  ? `${photos[0].name} · ${photos[0].w}×${photos[0].h}${photos.length > 1 ? ` (+${photos.length - 1})` : ""}`
                  : "هنوز تصویری انتخاب نشده"}
              </span>
            </div>
            <div className="crop-stage">
              <div
                className="crop-frame"
                style={stagePhoto ? { position: "relative", aspectRatio: `${stagePhoto.w} / ${stagePhoto.h}` } : { position: "relative" }}
              >
                {photos.length > 0 ? (
                  <img src={stagePhoto ? stagePhoto.url : image} alt="تصویر آماده برای برش" />
                ) : (
                  <div className="empty-asset">هنوز تصویری انتخاب نشده است</div>
                )}
              </div>
            </div>
            <div className="preview-hint">
              <span className="status-dot" />
              {photos.length > 0 ? `${picked.size} از ${photos.length} تصویر انتخاب شده` : "تصویر را اضافه کنید"}
              <button className="text-link" onClick={() => inputRef.current?.click()}>تغییر تصویر</button>
            </div>
          </div>
          )}

          <aside className="controls">
            {stage === 2 && results ? (
              <>
                <div className="control-section">
                  <div className="control-title">
                    <span><b>۰۲</b> برش‌ها</span>
                    <span className="check">✓</span>
                  </div>
                  <div className="list-stack">
                    {results.map(({ photo, crop }, i) => {
                      const custom = customs[i];
                      const dims = custom ? `${custom.width} × ${custom.height}` : `${crop.width} × ${crop.height}`;
                      const on = i === Math.min(stageSel, results.length - 1);
                      const box = custom?.box ?? crop.box;
                      return (
                        <ListRow
                          key={photo.url + crop.spec}
                          active={on}
                          onClick={() => setStageSel(i)}
                          title="نمایش این برش"
                          thumb={<img className="list-row__thumb" src={custom?.url ?? crop.url} alt={photo.name} />}
                          badges={custom ? <span className="list-row__badge">سفارشی</span> : undefined}
                          actions={
                            <>
                              <ViewToggle value={originKeys.has(i)} onChange={() => toggleOrigin(i)} show={!!box} />
                              <button className="reset-link" title="برش دلخواه" onClick={() => openCropFor(i)}>برش دلخواه</button>
                            </>
                          }
                        >
                          {photo.name} · {crop.label} · {dims}
                        </ListRow>
                      );
                    })}
                  </div>
                </div>
                <Button onClick={finalize}>نهایی‌کردن برش‌ها <ArrowIcon /></Button>
                <button className="reset-link" onClick={() => goStage(1)}>→ بازگشت به مرحله ۱</button>
              </>
            ) : (
              <>
            <div className="control-section">
              <div className="control-title">
                <span><b>۰۱</b> بارگذاری و انتخاب نسبت</span>
                {photos.length > 0 && <span className="check">✓</span>}
              </div>
              <label
                className={dragging ? "upload is-dragging" : "upload"}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  onDropFile(Array.from(e.dataTransfer.files));
                }}
              >
                <input ref={inputRef} type="file" accept="image/*" multiple onChange={onFile} />
                <FrameMark small />
                <span><strong>تصویرها را انتخاب کنید</strong><small>JPG، PNG یا WEBP · هر فایل تا ۱۲ مگابایت · حداکثر {MAX_PHOTOS} عکس</small></span>
              </label>
              {photos.length > 0 && (
                <>
                  <div className="list-head">
                    <span>{photos.length} تصویر</span>
                    <button className="reset-link" onClick={clearPhotos}>حذف همه</button>
                  </div>
                  <div className="list-stack">
                  {photos.map((p, i) => {
                    const on = picked.has(i);
                    return (
                      <ListRow
                        key={p.url}
                        active={on}
                        dim={!on}
                        title={on ? "عدم انتخاب" : "انتخاب (درگ برای جابه‌جایی)"}
                        onClick={() => togglePhoto(i)}
                        thumb={<img className="list-row__thumb" src={p.url} alt={p.name} />}
                        badges={on ? <span className="check">✓</span> : undefined}
                        actions={
                          <button className="icon-button" onClick={() => removePhoto(i)} aria-label="حذف تصویر">
                            ×
                          </button>
                        }
                        extra={{
                          draggable: !results,
                          onDragStart: () => { dragPhotoFrom.current = i; },
                          onDragOver: (e) => e.preventDefault(),
                          onDrop: () => {
                            if (dragPhotoFrom.current !== null) {
                              movePhoto(dragPhotoFrom.current, i);
                              dragPhotoFrom.current = null;
                            }
                          },
                        }}
                      >
                        {p.name} · {p.w}×{p.h}
                      </ListRow>
                    );
                  })}
                  </div>
                </>
              )}
              <div className="ratio-grid">
                {ratios.map((ratio, index) => (
                  <button
                    key={ratio.value}
                    className={selected.includes(index) ? "ratio is-selected" : "ratio"}
                    onClick={() => toggleRatio(index)}
                  >
                    <span className="ratio__shape" style={{ aspectRatio: index === 6 ? (parseInt(cusW, 10) || 4) / (parseInt(cusH, 10) || 3) : (ratio.ratio ?? 1.4) }} />
                    <strong>{ratio.value}</strong>
                    <small>{ratio.label}</small>
                  </button>
                ))}
              </div>
              {selected.includes(6) && (
                <div className="custom-ratio">
                  <span>عرض</span>
                  <input value={cusW} onChange={(e) => { setCusW(e.target.value); resetBatch(); }} inputMode="numeric" />
                  <span>ارتفاع</span>
                  <input value={cusH} onChange={(e) => { setCusH(e.target.value); resetBatch(); }} inputMode="numeric" />
                  <span>→ {customSpec()}</span>
                </div>
              )}
            </div>
            <Button onClick={() => void applyCrop()} disabled={cropping || picked.size === 0 || selected.length === 0}>
              {cropping ? (progress || "در حال برش…") : `نهایی‌کردن برش (${picked.size} عکس × ${selected.length} نسبت)`} <ArrowIcon />
            </Button>
            {cropError && <p className="privacy privacy--error">{cropError}</p>}
            <p className="privacy">تصاویر شما ذخیره نمی‌شوند و پس از پردازش حذف خواهند شد.</p>
              </>
            )}
          </aside>
        </div>

        {results && finalized && (
          <div className={stage === 3 ? "workspace" : "workspace hidden"}>
            <FinishStudio
              items={results}
              customs={customs}
              originKeys={originKeys}
              onToggleOrigin={toggleOrigin}
              onCustomRequest={openCropFor}
              onPaneChange={(p) => setFinPane(p)}
              onBack={() => goStage(2)}
            />
          </div>
        )}

        {modalTarget !== null && results && (() => {
          const { photo, crop } = results[modalTarget];
          const kk = photo.w / photo.h / (crop.width / crop.height);
          const h = rect.w * kk;
          const iw = Math.max(1, Math.round(rect.w * photo.w));
          const ih = Math.max(1, Math.round(h * photo.h));
          const minW = Math.min(64 / photo.w, 0.9);
          const beginCrop = (e: PointerEvent<HTMLDivElement>, mode: "move" | "resize") => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            cropDragRef.current = { sx: e.clientX, sy: e.clientY, r: { ...rect }, cw: 0, ch: 0, mode };
            const stage = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
            if (cropDragRef.current && stage) {
              cropDragRef.current.cw = stage.width;
              cropDragRef.current.ch = stage.height;
            }
          };
          const moveCrop = (e: PointerEvent<HTMLDivElement>) => {
            const d = cropDragRef.current;
            if (!d || d.cw === 0) return;
            const dx = (e.clientX - d.sx) / d.cw;
            const dy = (e.clientY - d.sy) / d.ch;
            if (d.mode === "move") {
              const hh = d.r.w * kk;
              setRect({
                x: Math.min(Math.max(d.r.x + dx, 0), 1 - d.r.w),
                y: Math.min(Math.max(d.r.y + dy, 0), 1 - hh),
                w: d.r.w,
              });
            } else {
              const maxW = Math.min(1 - d.r.x, (1 - d.r.y) / kk);
              setRect({ ...d.r, w: Math.min(Math.max(d.r.w + dx, minW), maxW) });
            }
          };
          const endCrop = () => {
            cropDragRef.current = null;
          };
          return (
            <div className="modal-backdrop modal-backdrop--top" role="dialog" aria-modal="true">
              <div className="crop-modal">
                <div className="modal-header">
                  <div><strong>تنظیم برش دلخواه · {photo.name}</strong><span>ابعاد زنده: {iw} × {ih}</span></div>
                </div>
                <div className="custom-crop-stage">
                  <img src={photo.url} alt="تصویر اصلی برای برش دلخواه" draggable={false} />
                  <div
                    className="custom-crop-box"
                    style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${h * 100}%`, aspectRatio: "auto" }}
                    onPointerDown={(e) => beginCrop(e, "move")}
                    onPointerMove={moveCrop}
                    onPointerUp={endCrop}
                    onPointerCancel={endCrop}
                  >
                    <i /><i /><i /><i />
                    <span>{iw} × {ih}</span>
                    <div
                      className="custom-crop-box__resize"
                      onPointerDown={(e) => beginCrop(e, "resize")}
                      onPointerMove={moveCrop}
                      onPointerUp={endCrop}
                      onPointerCancel={endCrop}
                    />
                  </div>
                </div>
                <div className="crop-modal__actions">
                  <Button size="sm" onClick={() => void confirmCrop()} disabled={cropBusy}>{cropBusy ? "در حال برش…" : "تأیید برش"}</Button>
                  <Button size="sm" variant="secondary" onClick={() => clearCustom()}>بازگشت به خودکار</Button>
                  <button className="reset-link" onClick={() => { if (!cropBusy) setModalTarget(null); }}>انصراف</button>
                </div>
              </div>
            </div>
          );
        })()}
      </section>

      {cropping && (
        <div className="processing-overlay" role="status" aria-live="polite">
          <div className="processing-card">
            <span className="spinner" />
            <p className="processing-card__title">در حال برش هوشمند…</p>
            <p className="processing-card__text">چهره، نیم‌تنه و جهت نگاه تحلیل می‌شود تا سوژه در هر نسبت درست بماند.</p>
            <div className="processing-card__track">
              <div className="processing-card__fill" style={{ width: `${cropStep.total ? (cropStep.done / cropStep.total) * 100 : 0}%` }} />
            </div>
            <p className="processing-card__pct">
              {cropStep.total ? `${Math.round((cropStep.done / cropStep.total) * 100)}٪ · ${cropStep.done} از ${cropStep.total} تصویر` : "آماده‌سازی…"}
            </p>
            {cropStep.name && <p className="processing-card__file">{cropStep.name}</p>}
          </div>
        </div>
      )}

      <section className="principles">
        <div className="principle-intro">
          <span className="section-number">۰۳ / چرا چارچوب؟</span>
          <Heading>هوشمندی، بدون دخالت در نگاه شما.</Heading>
        </div>
        {[
          ["اولویت با چهره", "چهره، نیم‌تنه، جهت نگاه و زاویه بدن پیش از هر برش تحلیل می‌شوند."],
          ["خروجی برای هر رسانه", "از کارت خبر تا کاور و استوری؛ سوژه در تمام نسبت‌ها درست می‌ماند."],
          ["آماده انتشار", "قاب، لوگوی رسانه و واترمارک را پیش از دانلود نهایی اضافه کنید."],
        ].map((item, i) => (
          <article className="principle" key={item[0]}>
            <span>۰{i + 1}</span>
            <FrameMark small />
            <Heading level={3}>{item[0]}</Heading>
            <p>{item[1]}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function About() {
  return (
    <main className="about">
      <div className="about__intro">
        <span className="section-number">درباره چارچوب / ۱۴۰۴</span>
        <Heading level={1}>به تصویر، فضای درست می‌دهیم.</Heading>
        <p>
          چارچوب یک ابزار فارسی برای آماده‌سازی تصاویر خبری است؛ سامانه‌ای که با
          اولویت تشخیص چهره، بدن و زاویه سوژه، هر تصویر را برای رسانه‌های مختلف آماده می‌کند.
        </p>
      </div>
      <div className="about__manifesto">
        <FrameMark />
        <blockquote>
          «ما معتقدیم برش خوب، حذف‌کردن نیست؛
          <br /> پیدا کردن مرز درست برای روایت تصویر است.»
        </blockquote>
        <div className="about__details">
          <span>طراحی‌شده برای تحریریه‌ها، دبیران عکس و خبرنگاران</span>
          <span>ساخته‌شده با دقت در ایران</span>
        </div>
      </div>
    </main>
  );
}

export default function App() {
  const [page, setPage] = useState<"home" | "about">("home");
  return (
    <div className="app" dir="rtl">
      <Header page={page} setPage={setPage} />
      {page === "home" ? <Home /> : <About />}
      <footer className="footer">
        <div className="brand brand--footer"><FrameMark small /><span className="brand__name">چارچوب</span></div>
        <p>ابزار هوشمند برش و آماده‌سازی تصاویر خبری</p>
        <span>© ۱۴۰۴ — همه حقوق محفوظ است.</span>
      </footer>
    </div>
  );
}
