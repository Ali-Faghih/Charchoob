import {
  ChangeEvent,
  CSSProperties,
  HTMLAttributes,
  PointerEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  compositeBlob,
  convertImage,
  cropImage,
  CropApiError,
  type Crop,
} from "./api"
import Icon from "./components/icons"
import { ArrowDown, ArrowLeft, ChevronDown, ChevronUp, ImagePlus } from "lucide-react"

const sampleImage = "hero.jpg"

type Ratio = {
  label: string
  value: string
  ratio?: number
  spec: string
}

const ratios: Ratio[] = [
  { label: "مربع", value: "۱:۱", ratio: 1, spec: "1:1" },
  { label: "استاندارد", value: "۴:۳", ratio: 4 / 3, spec: "4:3" },
  { label: "چاپ", value: "۵:۴", ratio: 5 / 4, spec: "5:4" },
  { label: "عریض", value: "۱۶:۹", ratio: 16 / 9, spec: "16:9" },
]

/** Flip "w:h" (either digit script) — orientation toggle for non-square presets. */
const flipSpec = (spec: string) => spec.split(":").reverse().join(":")

const FA_ORDINAL = [
  "اول",
  "دوم",
  "سوم",
  "چهارم",
  "پنجم",
  "ششم",
  "هفتم",
  "هشتم",
  "نهم",
  "دهم",
]

/** Latin digits → Persian for display labels (specs stay Latin for the backend). */
const faDigits = (s: string) => s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d])

/** File names for error messages: at most 3 names, the rest as a count. */
const namesFa = (names: string[], noun = "مورد") =>
  names.length <= 3
    ? names.join("، ")
    : `${names.slice(0, 3).join("، ")} و ${faDigits(String(names.length - 3))} ${noun} دیگر`

interface SpecGroup {
  spec: string
  label: string
  indices: number[]
}

/** Group crop items by aspect spec, preserving first-seen order. */
function groupBySpec(
  items: { crop: { spec: string; label: string } }[],
): SpecGroup[] {
  const groups: SpecGroup[] = []
  items.forEach(({ crop }, i) => {
    let g = groups.find((x) => x.spec === crop.spec)
    if (!g) {
      g = { spec: crop.spec, label: crop.label, indices: [] }
      groups.push(g)
    }
    g.indices.push(i)
  })
  return groups
}

interface PhotoGroup {
  url: string
  name: string
  indices: number[]
}

/** Group crop items by source photo, preserving first-seen order. */
function groupByPhoto(
  items: { photo: { url: string; name: string } }[],
): PhotoGroup[] {
  const groups: PhotoGroup[] = []
  items.forEach(({ photo }, i) => {
    let g = groups.find((x) => x.url === photo.url)
    if (!g) {
      g = { url: photo.url, name: photo.name, indices: [] }
      groups.push(g)
    }
    g.indices.push(i)
  })
  return groups
}

/* ---------- backend contract geometry (fractions, mirrors the server) ---------- */

/** New-UI grid index (0 = top-RIGHT, RTL-first) -> backend index (0 = top-LEFT). */
function toBackendPos(i: number): number {
  return Math.floor(i / 3) * 3 + (2 - (i % 3))
}

const ANCHOR_M = 0.04

/** 9-grid anchor (fractions) from a BACKEND position index. */
function anchorOf(b: number): [number, number] {
  const col = b % 3
  const row = Math.floor(b / 3)
  return [
    ANCHOR_M + (col * (1 - 2 * ANCHOR_M)) / 2,
    ANCHOR_M + (row * (1 - 2 * ANCHOR_M)) / 2,
  ]
}

/** Logo box [left, top, w, h] in fractions (backend _logo_box_px mirror). */
function logoBox(o: {
  scale: number
  pos: number
  ox: number
  oy: number
  natW: number
  natH: number
  canvasW: number
  canvasH: number
}): [number, number, number, number] {
  const logoAspect = o.natW > 0 && o.natH > 0 ? o.natW / o.natH : 1
  // Scale means "logo width relative to canvas width", so the height scales
  // relative to canvas height; hence the canvas aspect ratio must be multiplied too
  const A = o.canvasH > 0 ? o.canvasW / o.canvasH : 1
  let w = Math.max(o.scale, 1) / 100
  let h = (w * A) / logoAspect
  if (w > 1) {
    w = 1
    h = A / logoAspect
  }
  if (h > 1) {
    h = 1
    w = logoAspect / A
  }
  const [ax, ay] = anchorOf(o.pos)
  const left = Math.min(Math.max(ax + o.ox - w / 2, 0), 1 - w)
  const top = Math.min(Math.max(ay + o.oy - h / 2, 0), 1 - h)
  return [left, top, w, h]
}

/** Photo box [left, top, w] in fractions (backend _photo_box_px mirror). */
function framePhotoBox(o: {
  scale: number
  pos: number
  ox: number
  oy: number
}): [number, number, number] {
  const s = Math.min(Math.max(o.scale, 1), 100) / 100
  const w = s
  const [ax, ay] = anchorOf(o.pos)
  const left = Math.min(Math.max(ax + o.ox - w / 2, 0), 1 - w)
  const top = Math.min(Math.max(ay + o.oy - w / 2, 0), 1 - w)
  return [left, top, w]
}

function FrameMark({ small = false }: { small?: boolean }) {
  return (
    <span
      className={small ? "frame-mark frame-mark--small" : "frame-mark"}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

function ArrowIcon({ down = false }: { down?: boolean }) {
  return down ? (
    <ArrowDown
      size={17}
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
    />
  ) : (
    <ArrowLeft
      size={17}
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
    />
  )
}

function Button({
  children,
  variant = "primary",
  onClick,
  disabled,
  size = "md",
  title,
}: {
  children: ReactNode
  variant?: "primary" | "secondary" | "text"
  onClick?: () => void
  disabled?: boolean
  size?: "md" | "sm"
  title?: string
}) {
  return (
    <button
      className={`button button--${variant}${
        size === "sm" ? " button--sm" : ""
      }`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

function Heading({
  children,
  level = 2,
  className = "",
}: {
  children: ReactNode
  level?: 1 | 2 | 3
  className?: string
}) {
  const Tag = level === 1 ? "h1" : level === 3 ? "h3" : "h2"
  return (
    <Tag className={`heading heading--${level} ${className}`}>{children}</Tag>
  )
}

function Header({
  page,
  setPage,
}: {
  page: "home" | "about"
  setPage: (page: "home" | "about") => void
}) {
  return (
    <header className="site-header">
      <button
        className="brand"
        onClick={() => setPage("home")}
        aria-label="صفحه اصلی چارچوب"
      >
        <FrameMark small />
        <span className="brand__name">چارچوب</span>
        <span className="brand__tag">برش هوشمند تصویر</span>
      </button>
      <nav className="nav" aria-label="ناوبری اصلی">
        <button
          className={page === "home" ? "nav__link is-active" : "nav__link"}
          onClick={() => setPage("home")}
        >
          خانه
        </button>
        <button
          className={page === "about" ? "nav__link is-active" : "nav__link"}
          onClick={() => setPage("about")}
        >
          درباره ما
        </button>
      </nav>
      <div className="header__meta">نسخه آزمایشی ۰.۱</div>
    </header>
  )
}

function StepLine({ active }: { active: number }) {
  const steps = [
    "بارگذاری و انتخاب نسبت",
    "پیش‌نمایش و نهایی‌کردن",
    "قاب و لوگو",
    "پردازش و دانلود",
  ]
  return (
    <div className="steps" aria-label="مراحل کار">
      {steps.map((step, index) => (
        <div
          className={`step ${index <= active ? "is-active" : ""}`}
          key={step}
        >
          <span className="step__number">{`۰${faDigits(String(index + 1))}`}</span>
          <span>{step}</span>
        </div>
      ))}
    </div>
  )
}

function RangeControl({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commitDraft = () => {
    if (draft === null) return
    const v = Number(draft)
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
    setDraft(null)
  }
  const step = (d: number) =>
    onChange(Math.min(max, Math.max(min, Math.round(value) + d)))
  return (
    <label className="range-control">
      <span>
        <strong>{label}</strong>
        <span className="range-value">
          <input
            dir="ltr"
            type="number"
            aria-label={label}
            min={min}
            max={max}
            step={1}
            value={draft ?? String(Math.round(value))}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitDraft()
                event.currentTarget.blur()
              } else if (event.key === "Escape") {
                setDraft(null)
                event.currentTarget.blur()
              }
            }}
          />
          <span className="range-stepper" aria-hidden="true">
            <button type="button" tabIndex={-1} onClick={() => step(1)}>
              <ChevronUp size={12} />
            </button>
            <button type="button" tabIndex={-1} onClick={() => step(-1)}>
              <ChevronDown size={12} />
            </button>
          </span>
          <b>%</b>
        </span>
      </span>
      <input
        dir="ltr"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>
        <span>{min}%</span>
        <span>{max}%</span>
      </small>
    </label>
  )
}

function PositionGrid({
  value,
  onChange,
  customLabel,
  label = "موقعیت",
}: {
  value: number
  onChange: (value: number) => void
  customLabel?: string | null
  label?: string
}) {
  const names = [
    "بالا راست",
    "بالا وسط",
    "بالا چپ",
    "وسط راست",
    "مرکز",
    "وسط چپ",
    "پایین راست",
    "پایین وسط",
    "پایین چپ",
  ]
  return (
    <div className="position-control">
      <div className="setting-label">
        <strong>{label}</strong>
        <span>{customLabel ?? names[value]}</span>
      </div>
      <div className="position-row">
        <div className="position-grid">
          {names.map((name, index) => (
            <button
              key={name}
              className={
                index === value ? "position-cell is-active" : "position-cell"
              }
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
  )
}

function readImageFile(
  file: File,
): Promise<{ url: string; w: number; h: number }> {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.src = url
  return new Promise((resolve, reject) => {
    img.onload = () =>
      resolve({ url, w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => reject(new Error("failed to read image file"))
  })
}

/** Dimensions of an HEIC/HEIF file by scanning for the largest ispe box
 * (no decode — the browser often cannot preview HEIC, but the backend
 * decodes it fine, so dims are all the frontend needs). */
const heicDims = async (file: File): Promise<{ w: number; h: number } | null> => {
  try {
    const buf = await file.slice(0, 2 * 1024 * 1024).arrayBuffer()
    const bytes = new Uint8Array(buf)
    const dv = new DataView(buf)
    if (dv.byteLength < 12) return null
    const brand = String.fromCharCode(
      dv.getUint8(8),
      dv.getUint8(9),
      dv.getUint8(10),
      dv.getUint8(11),
    )
    if (!/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return null
    let best: { w: number; h: number } | null = null
    for (let i = 0; i + 16 <= bytes.length; i++) {
      if (
        bytes[i] === 0x69 &&
        bytes[i + 1] === 0x73 &&
        bytes[i + 2] === 0x70 &&
        bytes[i + 3] === 0x65
      ) {
        const w = dv.getUint32(i + 8)
        const h = dv.getUint32(i + 12)
        if (w > 0 && h > 0 && w < 100000 && h < 100000) {
          if (!best || w * h > best.w * best.h) best = { w, h }
        }
      }
    }
    return best
  } catch {
    return null
  }
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
  thumb: ReactNode
  children: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  active?: boolean
  dim?: boolean
  onClick?: () => void
  title?: string
  extra?: HTMLAttributes<HTMLDivElement>
}) {
  return (
    <div
      className={`list-row${active ? " is-active" : ""}${dim ? " is-dim" : ""}`}
      onClick={onClick}
      title={title}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      {...extra}
    >
      {thumb}
      <span className="list-row__main">{children}</span>
      {badges}
      {actions && (
        <span
          className="list-row__actions"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </div>
  )
}

function ViewToggle({
  value,
  onChange,
  show = true,
}: {
  value: boolean
  onChange: () => void
  show?: boolean
}) {
  if (!show) return null
  return (
    <div className="view-toggle" role="group" aria-label="نمایش برش">
      <button
        className={!value ? "is-active" : "is-inactive"}
        onClick={() => {
          if (value) onChange()
        }}
      >
        برش
      </button>
      <button
        className={value ? "is-active" : "is-inactive"}
        onClick={() => {
          if (!value) onChange()
        }}
      >
        روی اصلی
      </button>
    </div>
  )
}

interface AssetFile {
  url: string
  name: string
  w: number
  h: number
}

interface LogoCfg {
  scale: number
  opacity: number
  pos: number
  ox: number
  oy: number
  custom: boolean
  file: AssetFile | null
}

interface FrameCfg {
  layer: "under" | "over"
  scale: number
  opacity: number
  pos: number
  ox: number
  oy: number
  custom: boolean
  file: AssetFile | null
}

interface CustomCrop {
  url: string
  width: number
  height: number
  box: [number, number, number, number]
}

interface Rendered {
  url: string
  format: "jpg" | "png"
  width: number
  height: number
}

interface SubjCfg {
  logos: LogoCfg[]
  frame: FrameCfg
  /** Logos below the frame (0 = frame at the bottom). List order is
   * top-to-bottom: index 0 is the topmost layer. */
  frameRank: number
  rendered: Rendered | null
  rendering: boolean
  message: "success" | "error" | null
  errText: string
}

function defaultLogoCfg(): LogoCfg {
  return {
    scale: 25,
    opacity: 80,
    pos: 6,
    ox: 0,
    oy: 0,
    custom: false,
    file: null,
  }
}

function defaultSubjCfg(): SubjCfg {
  return {
    logos: [],
    frameRank: 0,
    frame: {
      layer: "under",
      scale: 95,
      opacity: 100,
      pos: 4,
      ox: 0,
      oy: 0,
      custom: false,
      file: null,
    },
    rendered: null,
    rendering: false,
    message: null,
    errText: "",
  }
}

function FinishStudio({
  items,
  customs,
  originKeys,
  onToggleOrigin,
  onCustomRequest,
  onPaneChange,
  onBack,
  onRemoveCrops,
  onDeleteSel,
  sel,
  onToggleSel,
}: {
  items: {
    photo: Original
    crop: Crop
  }[]
  customs: Record<number, CustomCrop>
  originKeys: Set<number>
  onToggleOrigin: (i: number) => void
  onCustomRequest: (i: number) => void
  onPaneChange: (pane: "studio" | "outputs") => void
  onBack: () => void
  onRemoveCrops: (indices: number[]) => void
  onDeleteSel: () => void
  sel: Set<number>
  onToggleSel: (i: number) => void
}) {
  const [subject, setSubject] = useState<number | null>(0)
  const [outFilter, setOutFilter] = useState<string | null>(null)
  const [studioFilter, setStudioFilter] = useState<string | null>(null)
  const [cfgs, setCfgs] = useState<Record<number, SubjCfg>>({})
  const cfgsRef = useRef(cfgs)
  cfgsRef.current = cfgs
  // Signature of the config the cached render was built from; download trusts
  // the cache only while the signature is unchanged (450ms auto-render window)
  const renderedSig = useRef<Record<number, string>>({})
  const [renderTick, setRenderTick] = useState(0)
  const bumpRender = () => setRenderTick((t) => t + 1)
  const sigOf = (i: number) => {
    const c = cfgsRef.current[i] ?? defaultSubjCfg()
    const b = customs[i]?.url ?? items[i]?.crop.url ?? ""
    return JSON.stringify({ l: c.logos, f: c.frame, r: c.frameRank ?? 0, b })
  }
  const [review, setReview] = useState<number | null>(null)
  // True when the review modal was opened from stage 4 (final viewing):
  // then the custom-crop button and the crop/origin switch stay hidden.
  const [reviewFinal, setReviewFinal] = useState(false)
  const [showOrigin, setShowOrigin] = useState(false)
  const [bareKeys, setBareKeys] = useState<Set<number>>(new Set())
  const toggleBare = (i: number) => {
    setBareKeys((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  // Inner view of stage 3/4: studio or outputs (only one is visible)
  const [pane, setPane] = useState<"studio" | "outputs">("studio")
  // Per-item download state + the "download all" summary
  const [busyDl, setBusyDl] = useState<Set<number>>(new Set())
  // Shared download format switch (PNG/JPG) for outputs rows + review modal.
  const [dlFormat, setDlFormat] = useState<"png" | "jpg">("jpg")
  const [dlSummary, setDlSummary] = useState<{
    ok: number
    fail: number
    failedNames: string[]
  } | null>(null)
  const switchPane = (p: "studio" | "outputs") => {
    setPane(p)
    onPaneChange(p)
  }
  const dragRef = useRef<{
    sx: number
    sy: number
    ox: number
    oy: number
    cw: number
    ch: number
    apply: (ox: number, oy: number) => void
  } | null>(null)

  const idx = subject === null ? -1 : subject < items.length ? subject : 0
  const item = idx >= 0 ? items[idx] : undefined
  const crop = item?.crop
  const original = item?.photo
  const cfg: SubjCfg =
    idx >= 0 ? (cfgs[idx] ?? defaultSubjCfg()) : defaultSubjCfg()
  // Visual layer stack top-to-bottom; DnD and paint order both use it.
  const stack = stackOf(cfg)
  const slotOfLogo = new Map<number, number>()
  stack.forEach((item, v) => {
    if (item.kind === "logo") slotOfLogo.set(item.k, v)
  })
  const frameSlot = stack.findIndex((item) => item.kind === "frame")

  const patch = (p: Partial<SubjCfg>) => {
    if (idx < 0) return
    setCfgs((m) => ({ ...m, [idx]: { ...(m[idx] ?? defaultSubjCfg()), ...p } }))
  }
  // Which layer is active in the monitor/panel: "frame" or a logo index
  const [layerSel, setLayerSel] = useState<"frame" | number>("frame")
  // Add menu in the panel header (frame | logo)
  const [addMenu, setAddMenu] = useState(false)
  const frameInputRef = useRef<HTMLInputElement | null>(null)
  const logoInputRef = useRef<HTMLInputElement | null>(null)
  const logoSel = typeof layerSel === "number" ? layerSel : 0
  const selLogo = cfg.logos[logoSel] ?? null
  // The layer selection must always point at a layer that actually exists
  useEffect(() => {
    if (layerSel === "frame" && !cfg.frame.file && cfg.logos.length > 0)
      setLayerSel(0)
    else if (
      typeof layerSel === "number" &&
      !cfg.logos[layerSel] &&
      cfg.frame.file
    )
      setLayerSel("frame")
  }, [layerSel, cfg.frame.file, cfg.logos])
  const patchLogoAt = (k: number, p: Partial<LogoCfg>) => {
    if (idx < 0) return
    setCfgs((m) => {
      const cur = m[idx] ?? defaultSubjCfg()
      if (!cur.logos[k]) return m
      return {
        ...m,
        [idx]: {
          ...cur,
          logos: cur.logos.map((l, i) => (i === k ? { ...l, ...p } : l)),
        },
      }
    })
  }
  const patchLogo = (p: Partial<LogoCfg>) => patchLogoAt(logoSel, p)
  const addLogo = (logo: LogoCfg) => {
    if (idx < 0) return
    setCfgs((m) => {
      const cur = m[idx] ?? defaultSubjCfg()
      // Newest logo lands on top (list head = topmost layer).
      return { ...m, [idx]: { ...cur, logos: [logo, ...cur.logos] } }
    })
    setLayerSel(0)
  }
  const removeLogo = (k: number) => {
    if (idx < 0) return
    const selUrl =
      typeof layerSel === "number"
        ? cfg.logos[layerSel]?.file?.url
        : undefined
    setCfgs((m) => {
      const cur = m[idx] ?? defaultSubjCfg()
      return {
        ...m,
        [idx]: { ...cur, logos: cur.logos.filter((_, i) => i !== k) },
      }
    })
    if (typeof layerSel === "number") {
      const rest = cfg.logos.filter((_, i) => i !== k)
      const ni = rest.findIndex((l) => l.file?.url === selUrl)
      setLayerSel(ni >= 0 ? ni : 0)
    }
  }
  // Drag-reorder of layers (logos + frame share one visual stack,
  // top-to-bottom). Positions are visual slots; the write-back keeps the
  // logo array in visual order and stores the frame's logos-below count.
  const [dragLogo, setDragLogo] = useState<number | null>(null)
  const [overLogo, setOverLogo] = useState<number | null>(null)
  // A drop is sometimes followed by a stray click: ignore selections
  // for a beat after any layer drop.
  const dropGuard = useRef(0)
  const moveLayer = (fromV: number, toV: number) => {
    if (idx < 0 || fromV === toV) return
    const items = stackOf(cfg)
    if (
      fromV < 0 ||
      toV < 0 ||
      fromV >= items.length ||
      toV >= items.length
    )
      return
    const next = [...items]
    const [moved] = next.splice(fromV, 1)
    next.splice(toV, 0, moved)
    const newLogos = next
      .filter(
        (x): x is { kind: "logo"; k: number } => x.kind === "logo",
      )
      .map((x) => cfg.logos[x.k])
    const framePos = next.findIndex((x) => x.kind === "frame")
    const rank = framePos === -1 ? 0 : next.length - 1 - framePos
    setCfgs((m) => {
      const cur = m[idx] ?? defaultSubjCfg()
      return { ...m, [idx]: { ...cur, logos: newLogos, frameRank: rank } }
    })
    // Follow the selection by identity.
    if (layerSel === "frame") {
      setLayerSel("frame")
    } else if (typeof layerSel === "number") {
      const url = cfg.logos[layerSel]?.file?.url
      const ni = newLogos.findIndex((l) => l.file?.url === url)
      setLayerSel(ni >= 0 ? ni : 0)
    }
  }
  const patchFrame = (p: Partial<FrameCfg>) =>
    patch({ frame: { ...cfg.frame, ...p } })
  // Close the add menu on outside click
  useEffect(() => {
    if (!addMenu) return
    const onDocClick = () => setAddMenu(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddMenu(false)
    }
    document.addEventListener("click", onDocClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("click", onDocClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [addMenu])
  const custom = idx >= 0 ? customs[idx] : undefined
  const base =
    custom ??
    (crop
      ? { url: crop.url, width: crop.width, height: crop.height }
      : { url: "", width: 1, height: 1 })
  const effBox: [number, number, number, number] | null =
    custom?.box ?? crop?.box ?? null
  const ratio = crop ? crop.width / crop.height : 1
  // Selected stage-4 outputs (same shared selection as the studio)
  const outItem = idx >= 0 ? items[idx] : undefined
  const outCc = idx >= 0 ? cfgs[idx] : undefined
  const outCustom = idx >= 0 ? customs[idx] : undefined
  const outSrc =
    outCc?.rendered?.url ?? outCustom?.url ?? outItem?.crop.url ?? ""
  const outW =
    outCc?.rendered?.width ?? outCustom?.width ?? outItem?.crop.width ?? 1
  const outH =
    outCc?.rendered?.height ?? outCustom?.height ?? outItem?.crop.height ?? 1

  const loadAsset = async (file: File, which: "logo" | "frame") => {
    const isPng = file.type === "image/png" || /\.png$/i.test(file.name)
    const isJpg =
      file.type === "image/jpeg" || /\.(jpe?g)$/i.test(file.name)
    if (which === "logo" ? !isPng : !(isPng || isJpg)) {
      patch({
        message: "error",
        errText:
          which === "logo"
            ? "ورودی این بخش فقط PNG است."
            : "ورودی این بخش فقط PNG یا JPG است.",
      })
      return null
    }
    try {
      const r = await readImageFile(file)
      return { url: r.url, name: file.name, w: r.w, h: r.h }
    } catch {
      patch({ message: "error", errText: "خواندن فایل ناموفق بود." })
      return null
    }
  }

  const takeFile = async (files: File[], which: "logo" | "frame") => {
    const list = which === "logo" ? files : files.slice(0, 1)
    let added = 0
    let bad = 0
    for (const file of list) {
      const asset = await loadAsset(file, which)
      if (!asset) {
        bad++
        continue
      }
      if (which === "logo") {
        const next = defaultLogoCfg()
        next.file = asset
        addLogo(next)
      } else {
        patchFrame({ file: asset })
      }
      added++
    }
    if (added > 0 && bad === 0) {
      patch({ message: null, errText: "" })
    } else if (added > 0) {
      patch({
        message: "error",
        errText: `${faDigits(String(bad))} فایل رد شد (فقط PNG).`,
      })
    }
    /* else: keep loadAsset's own error message */
  }

  const beginDrag = (
    event: PointerEvent<HTMLDivElement>,
    ox: number,
    oy: number,
    apply: (ox: number, oy: number) => void,
  ) => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      sx: event.clientX,
      sy: event.clientY,
      ox,
      oy,
      cw: rect.width,
      ch: rect.height,
      apply,
    }
  }

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    d.apply(
      d.ox + (event.clientX - d.sx) / d.cw,
      d.oy + (event.clientY - d.sy) / d.ch,
    )
  }

  const endDrag = () => {
    dragRef.current = null
  }

  /** Visual stack top-to-bottom (position 0 = topmost layer). The frame
   * sits frameRank logos from the bottom (0 = frame at the bottom). */
  function stackOf(c: SubjCfg) {
    const items: Array<{ kind: "logo"; k: number } | { kind: "frame" }> = []
    c.logos.forEach((l, k) => {
      if (l.file) items.push({ kind: "logo", k })
    })
    if (c.frame.file) {
      const rank = Math.max(0, Math.min(items.length, c.frameRank ?? 0))
      items.splice(items.length - rank, 0, { kind: "frame" })
    }
    return items
  }

  /** This config's overlays in paint order (bottom-to-top). */
  const layersOf = (c: SubjCfg) => {
    const out: {
      file: AssetFile
      params: Record<string, unknown>
      kind: "frame" | "logo"
    }[] = []
    for (const item of [...stackOf(c)].reverse()) {
      if (item.kind === "frame") {
        if (!c.frame.file) continue
        out.push({
          kind: "frame",
          file: c.frame.file,
          params: {
            mode: "frame",
            placement: c.frame.layer,
            photo_scale: c.frame.scale,
            position: toBackendPos(c.frame.pos),
            offsetX: c.frame.ox,
            offsetY: c.frame.oy,
            photo_opacity: c.frame.opacity,
          },
        })
        continue
      }
      const l = c.logos[item.k]
      if (!l.file) continue
      out.push({
        kind: "logo",
        file: l.file,
        params: {
          mode: "logo",
          scale: l.scale,
          opacity: l.opacity,
          position: toBackendPos(l.pos),
          offsetX: l.ox,
          offsetY: l.oy,
        },
      })
    }
    return out
  }

  const hasFinish = (c: SubjCfg) => layersOf(c).length > 0
  const countAssets = (c: SubjCfg) =>
    (c.frame.file ? 1 : 0) + c.logos.filter((l) => l.file).length

  const compositeSubject = async (i: number) => {
    const c = cfgsRef.current[i] ?? defaultSubjCfg()
    const cp = items[i].crop
    const b = customs[i] ?? { url: cp.url, width: cp.width, height: cp.height }
    const layers = layersOf(c)
    if (layers.length === 0)
      throw new Error("ابتدا فایل PNG را انتخاب کنید")
    const baseBlob = await (await fetch(b.url)).blob()
    // One request per layer: the previous stage's output becomes the next stage's input
    let blob: Blob = baseBlob
    let format = "jpg" as "jpg" | "png"
    let width = b.width
    let height = b.height
    for (let k = 0; k < layers.length; k++) {
      const l = layers[k]
      const overBytes = await (await fetch(l.file.url)).arrayBuffer()
      const out = await compositeBlob(blob, overBytes, l.file.name, l.params)
      blob = out.blob
      format = out.format
      width = out.width
      height = out.height
    }
    return { blob, format, width, height }
  }

  const renderFinalFor = async (i: number) => {
    const c0 = cfgsRef.current[i] ?? defaultSubjCfg()
    if (!items[i]) return
    if (!hasFinish(c0)) return
    setCfgs((m) => ({
      ...m,
      [i]: {
        ...(m[i] ?? defaultSubjCfg()),
        rendering: true,
        message: null,
        errText: "",
      },
    }))
    const startSig = sigOf(i)
    // Bump the counter here too so that if an earlier render is still in
    // flight, the effect re-runs once it finishes and these settings apply
    bumpRender()
    try {
      const out = await compositeSubject(i)
      const url = URL.createObjectURL(out.blob)
      renderedSig.current[i] = startSig
      setCfgs((m) => {
        const old = m[i]?.rendered?.url
        if (old) URL.revokeObjectURL(old)
        return {
          ...m,
          [i]: {
            ...(m[i] ?? defaultSubjCfg()),
            rendered: {
              url,
              format: out.format,
              width: out.width,
              height: out.height,
            },
            rendering: false,
            message: "success",
          },
        }
      })
    } catch (e) {
      renderedSig.current[i] = startSig
      setCfgs((m) => {
        const old = m[i]?.rendered?.url
        if (old) URL.revokeObjectURL(old)
        return {
          ...m,
          [i]: {
            ...(m[i] ?? defaultSubjCfg()),
            rendered: null,
            rendering: false,
            message: "error",
            errText: (e as Error).message || "خطا در پردازش نهایی",
          },
        }
      })
    }
    bumpRender()
  }

  // Auto-render (debounced) like the previous kit; only the active item, not all
  const cfgsSig = JSON.stringify({
    cfg: Object.fromEntries(
      Object.entries(cfgs).map(([k, c]) => [
        k,
        { l: c.logos, f: c.frame },
      ]),
    ),
    custom: customs,
  })
  useEffect(() => {
    const c = cfgs[idx]
    if (!c || !hasFinish(c)) return
    // If the previous render built exactly this config there is nothing to do (breaks the loop)
    if (renderedSig.current[idx] === sigOf(idx)) return
    // A render is in flight: wait for it to finish, then renderTick re-runs
    // the effect and, if the config changed, this renders again
    if (cfgsRef.current[idx]?.rendering) return
    const t = window.setTimeout(() => {
      void renderFinalFor(idx).catch(() => {
        /* errors are stored on the card */
      })
    }, 450)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgsSig, idx, renderTick])

  const applyToSel = () => {
    const src: SubjCfg = cfgs[idx] ?? defaultSubjCfg()
    if (!hasFinish(src)) {
      patch({
        message: "error",
        errText: "این تصویر قاب یا لوگو ندارد.",
      })
      return
    }
    const targets =
      sel.size > 0
        ? [...sel].filter((i) => i < items.length)
        : items.map((_, i) => i)
    if (targets.length === 0) return
    setCfgs((m) => {
      const next: Record<number, SubjCfg> = { ...m }
      for (const i of targets) {
        const cur = next[i] ?? defaultSubjCfg()
        next[i] = {
          ...cur,
          logos: src.logos.map((l) => ({ ...l })),
          frame: { ...src.frame },
          frameRank: src.frameRank ?? 0,
        }
      }
      return next
    })
    // Auto-render after apply - deferred so state flushes first
    window.setTimeout(() => void renderAll(new Set(targets)), 80)
  }

  const downloadUrl = (url: string, name: string) => {
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
  }

  /** Re-encode a finished tile to PNG or JPEG (white-backed for JPEG). */
  const convertTile = (url: string, format: "png" | "jpg"): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement("canvas")
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          reject(new Error("canvas unavailable"))
          return
        }
        if (format === "jpg") {
          ctx.fillStyle = "#ffffff"
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("encode failed")),
          format === "jpg" ? "image/jpeg" : "image/png",
          0.92,
        )
      }
      img.onerror = () => reject(new Error("tile unreadable"))
      img.src = url
    })

  const dlOne = async (i: number, format: "png" | "jpg"): Promise<boolean> => {
    if (busyDl.has(i)) return false
    const it = items[i]
    if (!it) return false
    const c = cfgs[i] ?? defaultSubjCfg()
    const cp = it.crop
    const baseName = it.photo.name.replace(/\.[^.]+$/, "") || "khabar"
    const safeSpec = cp.spec.replace(/:/g, "x")
    setBusyDl((prev) => new Set(prev).add(i))
    try {
      let tile: { url: string; format: "jpg" | "png" }
      if (c.rendered && renderedSig.current[i] === sigOf(i)) {
        tile = { url: c.rendered.url, format: c.rendered.format }
      } else if (hasFinish(c)) {
        const out = await compositeSubject(i)
        const url = URL.createObjectURL(out.blob)
        window.setTimeout(() => URL.revokeObjectURL(url), 60000)
        tile = { url, format: out.format }
      } else if (customs[i]) {
        tile = { url: customs[i].url, format: "jpg" }
      } else {
        tile = { url: cp.url, format: cp.format }
      }
      const fileName = `${baseName}-${safeSpec}.${format}`
      if (tile.format === format) {
        downloadUrl(tile.url, fileName)
      } else {
        const blob = await convertTile(tile.url, format)
        const url = URL.createObjectURL(blob)
        downloadUrl(url, fileName)
        window.setTimeout(() => URL.revokeObjectURL(url), 60000)
      }
      return true
    } catch {
      return false
    } finally {
      setBusyDl((prev) => {
        const next = new Set(prev)
        next.delete(i)
        return next
      })
    }
  }

  const downloadOutput = (i: number, format: "png" | "jpg") =>
    void dlOne(i, format)

  /** Shared PNG/JPG switch used by every download spot. */
  const dlSwitch = (
    <div className="view-toggle" role="group" aria-label="فرمت دانلود">
      <button
        className={dlFormat === "png" ? "is-active" : "is-inactive"}
        onClick={() => setDlFormat("png")}
      >
        PNG
      </button>
      <button
        className={dlFormat === "jpg" ? "is-active" : "is-inactive"}
        onClick={() => setDlFormat("jpg")}
      >
        JPG
      </button>
    </div>
  )

  // Downloads run sequentially (not on a staggered timer) + a result summary;
  const downloadAll = async () => {
    const targets =
      sel.size > 0
        ? [...sel].filter((i) => i < items.length).sort((a, b) => a - b)
        : items.map((_, i) => i)
    let ok = 0
    let fail = 0
    const failedNames: string[] = []
    for (const i of targets) {
      if (await dlOne(i, dlFormat)) ok++
      else {
        fail++
        failedNames.push(items[i]?.photo.name ?? "")
      }
      await new Promise((r) => window.setTimeout(r, 200))
    }
    setDlSummary({ ok, fail, failedNames })
  }

  // Manual render of all outputs (sequential so the backend is not overloaded, with real progress)
  const [renderingAll, setRenderingAll] = useState(false)
  const [renderAllStep, setRenderAllStep] = useState({ done: 0, total: 0 })
  const renderAll = async (only?: Set<number>) => {
    if (renderingAll) return
    const targets: number[] = []
    for (let i = 0; i < items.length; i++) {
      if (only && !only.has(i)) continue
      const c = cfgsRef.current[i] ?? defaultSubjCfg()
      if (hasFinish(c)) targets.push(i)
    }
    if (targets.length === 0) return
    setRenderingAll(true)
    setRenderAllStep({ done: 0, total: targets.length })
    for (let k = 0; k < targets.length; k++) {
      await renderFinalFor(targets[k])
      setRenderAllStep({ done: k + 1, total: targets.length })
    }
    setRenderingAll(false)
  }

  const resetSubject = (i: number) => {
    const old = cfgsRef.current[i]?.rendered?.url
    if (old) URL.revokeObjectURL(old)
    delete renderedSig.current[i]
    setCfgs((m) => ({ ...m, [i]: defaultSubjCfg() }))
  }

  // In-place delete: remaps the studio's local state, then delegates the rest to the parent
  const handleRemoveCrops = (indices: number[]) => {
    const gone = new Set(indices.filter((i) => i >= 0 && i < items.length))
    if (gone.size === 0) return
    const shiftOf = (oldIdx: number) => {
      let s = 0
      gone.forEach((g) => {
        if (g < oldIdx) s++
      })
      return oldIdx - s
    }
    const newLen = items.length - gone.size
    const clampIdx = (oldIdx: number | null): number | null => {
      if (oldIdx === null) return null
      if (gone.has(oldIdx))
        return newLen > 0 ? Math.min(oldIdx, newLen - 1) : null
      return shiftOf(oldIdx)
    }
    // If the selected layer was not deleted, its index must shift too
    const nextIdx = clampIdx(subject)
    if (typeof layerSel === "number")
      setLayerSel(
        subject === null || nextIdx === null
          ? 0
          : Math.max(
              0,
              Math.min(
                layerSel,
                (cfgsRef.current[nextIdx]?.logos.length ?? 1) - 1,
              ),
            ),
      )
    gone.forEach((k) => {
      const u = cfgsRef.current[k]?.rendered?.url
      if (u) {
        try {
          URL.revokeObjectURL(u)
        } catch {
          /* ignore */
        }
      }
      delete renderedSig.current[k]
    })
    const newSig: Record<number, string> = {}
    Object.entries(renderedSig.current).forEach(([ks, v]) => {
      const k = Number(ks)
      if (!gone.has(k)) newSig[shiftOf(k)] = v
    })
    renderedSig.current = newSig
    setCfgs((prev) => {
      const next: Record<number, SubjCfg> = {}
      Object.entries(prev).forEach(([ks, v]) => {
        const k = Number(ks)
        if (!gone.has(k)) next[shiftOf(k)] = v
      })
      return next
    })
    setBareKeys((prev) => {
      const next = new Set<number>()
      prev.forEach((k) => {
        if (!gone.has(k)) next.add(shiftOf(k))
      })
      return next
    })
    setReview((prev) => clampIdx(prev))
    setSubject((prev) => clampIdx(prev))
    onRemoveCrops([...gone].sort((a, b) => a - b))
  }

  return (
    <>
      {pane === "studio" ? (
        <>
          <div className="preview-panel">
            <div className="finish-preview">
              {crop && original ? (
                <>
                  <div className="finish-preview__top">
                    <span>
                      {original.name} · {crop.label}
                    </span>
                  </div>
                  <div className="finish-preview__stage">
                    <div
                      className={
                        hasFinish(cfg)
                          ? "final-canvas final-canvas--finish"
                          : "final-canvas final-canvas--none"
                      }
                      style={
                        {
                          aspectRatio: `${crop.width} / ${crop.height}`,
                          "--arw": crop.width,
                          "--arh": crop.height,
                        } as CSSProperties
                      }
                    >
                      {bareKeys.has(idx) ? (
                        <div className="draggable-photo">
                          <img
                            src={base.url}
                            alt="نمایش بدون قاب/لوگو"
                            draggable={false}
                          />
                        </div>
                      ) : (
                        <>
                          {cfg.frame.file && cfg.frame.layer === "under" && (
                            <img
                              src={cfg.frame.file.url}
                              alt="قاب"
                              draggable={false}
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                objectFit: "fill",
                                pointerEvents: "none",
                                zIndex: 0,
                              }}
                            />
                          )}
                          {!cfg.frame.file && layerSel === "frame" && (
                            <div className="demo-frame demo-frame--under" />
                          )}
                          {cfg.frame.file ? (
                            (() => {
                              const [fl, ft, fw] = framePhotoBox({
                                scale: cfg.frame.scale,
                                pos: toBackendPos(cfg.frame.pos),
                                ox: cfg.frame.ox,
                                oy: cfg.frame.oy,
                              })
                              return (
                                <div
                                  className="draggable-photo is-draggable"
                                  onPointerDown={(e) =>
                                    beginDrag(
                                      e,
                                      cfg.frame.ox,
                                      cfg.frame.oy,
                                      (ox, oy) => {
                                        setLayerSel("frame")
                                        patchFrame({
                                          ox,
                                          oy,
                                          custom: true,
                                        })
                                      },
                                    )
                                  }
                                  onPointerMove={moveDrag}
                                  onPointerUp={endDrag}
                                  onPointerCancel={endDrag}
                                  style={{
                                    position: "absolute",
                                    left: `${fl * 100}%`,
                                    top: `${ft * 100}%`,
                                    width: `${fw * 100}%`,
                                    height: `${fw * 100}%`,
                                    opacity: cfg.frame.opacity / 100,
                                    zIndex:
                                      frameSlot === -1
                                        ? 1
                                        : 2 + (stack.length - 1 - frameSlot),
                                  }}
                                >
                                  <img
                                    src={base.url}
                                    alt="پیش‌نمایش تصویر خبری"
                                    draggable={false}
                                  />
                                  {cfg.frame.layer === "under" &&
                                    cfg.logos.map((lg2, k2) => {
                                      const pos2 =
                                        slotOfLogo.get(k2) ?? k2
                                      if (
                                        !lg2.file ||
                                        frameSlot === -1 ||
                                        pos2 <= frameSlot
                                      )
                                        return null
                                      const [ll, lt, lw, lh] = logoBox({
                                        scale: lg2.scale,
                                        pos: toBackendPos(lg2.pos),
                                        ox: lg2.ox,
                                        oy: lg2.oy,
                                        natW: lg2.file.w,
                                        natH: lg2.file.h,
                                        canvasW: crop.width,
                                        canvasH: crop.height,
                                      })
                                      return (
                                        <img
                                          key={lg2.file.url + k2}
                                          src={lg2.file.url}
                                          alt={lg2.file.name}
                                          draggable={false}
                                          style={{
                                            position: "absolute",
                                            left: `${((ll - fl) / fw) * 100}%`,
                                            top: `${((lt - ft) / fw) * 100}%`,
                                            width: `${(lw / fw) * 100}%`,
                                            height: `${(lh / fw) * 100}%`,
                                            opacity: lg2.opacity / 100,
                                            pointerEvents: "none",
                                            zIndex: 1,
                                          }}
                                        />
                                      )
                                    })}
                                </div>
                              )
                            })()
                          ) : (
                            <div className="draggable-photo">
                              <img
                                src={base.url}
                                alt="پیش‌نمایش تصویر خبری"
                                draggable={false}
                              />
                            </div>
                          )}
                          {cfg.frame.file && cfg.frame.layer === "over" && (
                            <img
                              src={cfg.frame.file.url}
                              alt="قاب"
                              draggable={false}
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                objectFit: "fill",
                                pointerEvents: "none",
                                zIndex:
                                  frameSlot === -1
                                    ? 2
                                    : 2 + (stack.length - 1 - frameSlot),
                              }}
                            />
                          )}
                          {cfg.logos.map((lg, k) =>
                            !lg.file ||
                            (cfg.frame.file &&
                              cfg.frame.layer === "under" &&
                              frameSlot !== -1 &&
                              (slotOfLogo.get(k) ?? k) > frameSlot) ? null : (
                                (() => {
                                  const [ll, lt, lw, lh] = logoBox({
                                    scale: lg.scale,
                                    pos: toBackendPos(lg.pos),
                                    ox: lg.ox,
                                    oy: lg.oy,
                                    natW: lg.file.w,
                                    natH: lg.file.h,
                                    canvasW: crop.width,
                                    canvasH: crop.height,
                                  })
                                  return (
                                    <img
                                      key={lg.file.url + k}
                                      src={lg.file.url}
                                      alt={lg.file.name}
                                      draggable={false}
                                      onPointerDown={(e) => {
                                        setLayerSel(k)
                                        beginDrag(e, lg.ox, lg.oy, (ox, oy) =>
                                          patchLogo({
                                            ox,
                                            oy,
                                            custom: true,
                                          }),
                                        )
                                      }}
                                      onPointerMove={moveDrag}
                                      onPointerUp={endDrag}
                                      onPointerCancel={endDrag}
                                      style={{
                                        position: "absolute",
                                        left: `${ll * 100}%`,
                                        top: `${lt * 100}%`,
                                        width: `${lw * 100}%`,
                                        height: `${lh * 100}%`,
                                        opacity: lg.opacity / 100,
                                        cursor: "grab",
                                        touchAction: "none",
                                        userSelect: "none",
                                        zIndex:
                                          2 +
                                          (stack.length -
                                            1 -
                                            (slotOfLogo.get(k) ?? k)),
                                      }}
                                    />
                                  )
                                })()
                              )
                            )}
                          {!hasFinish(cfg) && (
                            <div className="empty-asset">
                              قاب یا لوگویی اضافه نشده است
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="finish-preview__top">
                    <span>صفحه نمایش خالی است</span>
                  </div>
                  <div className="finish-preview__stage">
                    <div className="empty-drop">
                      <Icon name="eye-off" size={40} />
                      <strong>تصویری در صفحه نمایش نیست</strong>
                      <small>
                        برای دیدن، «مشاهده در صفحه نمایش» را بزنید
                      </small>
                    </div>
                  </div>
                </>
              )}
              <div className="preview-hint">
                <span className="status-dot" />
                <span>{faDigits(String(items.length))} تصویر</span>
                  {crop && original ? (
                    <button
                      className="text-link"
                      onClick={() => {
                        setReview(idx)
                        setReviewFinal(false)
                      }}
                    >
                      بازبینی
                    </button>
                  ) : null}
              </div>
            </div>
          </div>
          <aside className="controls">
            <div className="panel panel--grow">
              <div className="control-title panel__head">
                <span>لیست تصاویر</span>
                <span className="panel__actions">
                  {sel.size > 0 ? (
                    <b>{faDigits(String(sel.size))} انتخاب‌شده</b>
                  ) : (
                    <b>{faDigits(String(items.length))} تصویر</b>
                  )}
                  <button
                    className="icon-button icon-button--danger"
                    onClick={onDeleteSel}
                    title={
                      sel.size > 0
                        ? `حذف ${faDigits(String(sel.size))} انتخاب‌شده`
                        : "حذف همه"
                    }
                    aria-label={
                      sel.size > 0
? `حذف ${faDigits(String(sel.size))} تصویر انتخاب‌شده`
                        : "حذف همهٔ تصاویر"
                    }
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </div>
              <div className="panel__body">
                <div className="panel__list">
                  {(() => {
                    const specGroups = groupBySpec(items)
                    const eff = specGroups.some((g) => g.spec === studioFilter)
                      ? studioFilter
                      : null
                    const photoGroups = groupByPhoto(items).filter(
                      (g) =>
                        !eff ||
                        g.indices.some((k) => items[k].crop.spec === eff),
                    )
                    const dimsOf = (index: number) => {
                      const it = items[index]
                      const cc = cfgs[index]
                      const custom = customs[index]
                      return cc?.rendered
                        ? `${cc.rendered.width} × ${cc.rendered.height}`
                        : custom
                          ? `${custom.width} × ${custom.height}`
                          : `${it.crop.width} × ${it.crop.height}`
                    }
                    const renderCropRow = (
                      index: number,
                      showPhotoName: boolean,
                      withTrash = false,
                    ) => {
                      const item = items[index]
                      const cc = cfgs[index]
                      const custom = customs[index]
                      const badges = [
                        cc &&
                          cc.logos.filter((l) => l.file).length > 0 &&
                          `${faDigits(String(cc.logos.filter((l) => l.file).length))} لوگو`,
                        cc?.frame.file && "قاب",
                        custom && "سفارشی",
                        cc?.rendered && "پردازش شده",
                      ].filter(Boolean)
                      const isShown = index === idx
                      const canBare = cc ? hasFinish(cc) : false
                      const isBare = bareKeys.has(index)
                      const checked = sel.has(index)
                      return (
                        <ListRow
                          key={item.photo.url + item.crop.spec}
                          active={checked}
                          dim={sel.size > 0 && !checked}
                          onClick={() => onToggleSel(index)}
                          title={checked ? "لغو انتخاب" : "انتخاب"}
                          thumb={
                            <img
                              className="list-row__thumb"
                              src={custom?.url ?? item.crop.url}
                              alt={item.photo.name}
                            />
                          }
                          badges={
                            badges.length > 0 ? (
                              <span className="list-row__badge">
                                {badges.join(" · ")}
                              </span>
                            ) : undefined
                          }
                          actions={
                            <>
                              <button
                                className="icon-button"
                                title="مشاهده در صفحه نمایش"
                                aria-label={`مشاهدهٔ ${item.photo.name} · ${item.crop.label} در صفحه نمایش`}
                                aria-pressed={isShown}
                                onClick={() =>
                                  setSubject(isShown ? null : index)
                                }
                              >
                                <Icon
                                  name={isShown ? "eye" : "eye-off"}
                                  size={14}
                                />
                              </button>
                              {withTrash ? (
                                <button
                                  className="icon-button icon-button--danger"
                                  title="حذف برش"
                                  aria-label={`حذف برش ${item.crop.label}`}
                                  onClick={() => handleRemoveCrops([index])}
                                >
                                  <Icon name="trash" size={13} />
                                </button>
                              ) : null}
                              {canBare ? (
                                <button
                                  className={`icon-button${
                                    isBare ? " is-active" : ""
                                  }`}
                                  title="نمایش بدون قاب/لوگو"
                                  aria-label={`نمایش بدون قاب/لوگو ${item.photo.name} · ${item.crop.label}`}
                                  aria-pressed={isBare}
                                  onClick={() => toggleBare(index)}
                                >
                                  <Icon name="image-off" size={14} />
                                </button>
                              ) : null}
                              {cc && hasFinish(cc) ? (
                                <button
                                  className="icon-button icon-button--danger"
                                  title="بازنشانی تنظیمات"
                                  aria-label={`بازنشانی تنظیمات ${item.photo.name} · ${item.crop.label}`}
                                  onClick={() => resetSubject(index)}
                                >
                                  <Icon name="reset" size={13} />
                                </button>
                              ) : null}
                            </>
                          }
                        >
                          {showPhotoName ? (
                            <>
                              {item.photo.name} · {dimsOf(index)}
                            </>
                          ) : (
                            <>
                              {item.crop.label} · {dimsOf(index)}
                            </>
                          )}
                        </ListRow>
                      )
                    }
                    return (
                      <>
                        <div
                          className="filter-row"
                          role="group"
                          aria-label="فیلتر نسبت"
                        >
                          <button
                            className={
                              eff === null
                                ? "filter-chip is-active"
                                : "filter-chip"
                            }
                            onClick={() => setStudioFilter(null)}
                          >
                            همه
                          </button>
                          {specGroups.map((g) => (
                            <button
                              key={g.spec}
                              className={
                                eff === g.spec
                                  ? "filter-chip is-active"
                                  : "filter-chip"
                              }
                              onClick={() =>
                                setStudioFilter(eff === g.spec ? null : g.spec)
                              }
                            >
                              {g.label}
                            </button>
                          ))}
                        </div>
                        {items.length === 0 ? (
                          <p className="warn-box">هیچ تصویر نهایی باقی نمانده است.</p>
                        ) : null}
                        {eff ? (
                          <div className="list-stack">
                            {items.map((item, index) => {
                              if (item.crop.spec !== eff) return null
                              return (
                                <div
                                  key={item.photo.url + item.crop.spec}
                                  style={{ display: "contents" }}
                                >
                                  {renderCropRow(index, true, true)}
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <>
                            {photoGroups.map((g) => (
                              <div key={g.url}>
                                <div className="control-title control-title--sub">
                                  <span>{g.name}</span>
                                  <span className="panel__actions">
<b>{faDigits(String(g.indices.length))} تصویر نهایی</b>
                                    <button
                                      className="icon-button icon-button--danger"
                                      title="حذف برش‌های این عکس"
                                      aria-label={`حذف برش‌های ${g.name}`}
                                      onClick={() =>
                                        handleRemoveCrops(g.indices)
                                      }
                                    >
                                      <Icon name="trash" size={13} />
                                    </button>
                                  </span>
                                </div>
                                <div className="list-stack">
                                  {g.indices.map((index) =>
                                    renderCropRow(index, false),
                                  )}
                                </div>
                              </div>
                            ))}
                          </>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            </div>
            <div className="panel">
              <div className="control-title panel__head panel__head--menu">
                <span>قاب و لوگو</span>
                <span className="panel__actions">
                  {hasFinish(cfg) && <b>{countAssets(cfg)} قاب و لوگو</b>}
                  {hasFinish(cfg) && (
                    <button
                      className="icon-button"
                      onClick={() => {
                        setAddMenu(false)
                        applyToSel()
                      }}
                      title={
                        sel.size > 0
                          ? `اعمال تنظیمات به ${faDigits(String(sel.size))} انتخاب‌شده`
                          : "اعمال تنظیمات به همهٔ تصاویر"
                      }
                      aria-label="اعمال تنظیمات به بقیهٔ تصاویر"
                    >
                      <Icon name="check" size={14} />
                    </button>
                  )}
                  {hasFinish(cfg) && (
                    <button
                      className="icon-button icon-button--danger"
                      onClick={() => {
                        setAddMenu(false)
                        setCfgs((m) => ({
                          ...m,
                          [idx]: {
                            ...(m[idx] ?? defaultSubjCfg()),
                            logos: [],
                            frame: defaultSubjCfg().frame,
                            rendered: null,
                          },
                        }))
                        setLayerSel("frame")
                      }}
                      title="حذف همهٔ قاب و لوگوها"
                      aria-label="حذف همهٔ قاب و لوگوها"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                  <button
                    className={`icon-button${addMenu ? " is-active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setAddMenu((v) => !v)
                    }}
                    title="افزودن قاب یا لوگو"
                    aria-label="افزودن قاب یا لوگو"
                    aria-expanded={addMenu}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                </span>

                {addMenu && (
                  <div
                    className="add-menu"
                    role="menu"
                    aria-label="افزودن قاب یا لوگو"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      role="menuitem"
                      onClick={() => {
                        setAddMenu(false)
                        setLayerSel("frame")
                        frameInputRef.current?.click()
                      }}
                    >
                      <FrameMark small />
                      <span>
                        <strong>افزودن قاب</strong>
                        <small>یک فایل PNG یا JPG</small>
                      </span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setAddMenu(false)
                        logoInputRef.current?.click()
                      }}
                    >
                      <Icon name="image" size={16} />
                      <span>
                        <strong>افزودن لوگو</strong>
                        <small>یک یا چند فایل PNG</small>
                      </span>
                    </button>
                  </div>
                )}
              </div>

              <input
                type="file"
                accept="image/png,image/jpeg"
                hidden
                ref={frameInputRef}
                onChange={(event) => {
                  const fs = Array.from(event.target.files ?? [])
                  event.target.value = ""
                  if (fs.length > 0) void takeFile(fs, "frame")
                }}
              />
              <input
                type="file"
                accept="image/png"
                hidden
                multiple
                ref={logoInputRef}
                onChange={(event) => {
                  const fs = Array.from(event.target.files ?? [])
                  event.target.value = ""
                  if (fs.length > 0) void takeFile(fs, "logo")
                }}
              />

              <div className="panel__body panel__body--scroll">
                {crop && original ? (
                  <>
                    {hasFinish(cfg) && (
                      <div className="list-stack">
                        {cfg.frame.file && (
                          <div
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(
                                "text/plain",
                                String(frameSlot),
                              )
                              e.dataTransfer.effectAllowed = "move"
                              setDragLogo(frameSlot)
                            }}
                            onDragEnd={() => {
                              setDragLogo(null)
                              setOverLogo(null)
                            }}
                            onDragOver={(e) => {
                              e.preventDefault()
                              e.dataTransfer.dropEffect = "move"
                              if (frameSlot !== dragLogo)
                                setOverLogo(frameSlot)
                            }}
                            onDragLeave={() =>
                              setOverLogo((v) =>
                                v === frameSlot ? null : v,
                              )
                            }
                            onDrop={(e) => {
                              e.preventDefault()
                              moveLayer(
                                Number(
                                  e.dataTransfer.getData("text/plain"),
                                ),
                                frameSlot,
                              )
                              dropGuard.current = Date.now()
                              setDragLogo(null)
                              setOverLogo(null)
                            }}
                            className={
                              overLogo === frameSlot
                                ? "logo-row--drop"
                                : undefined
                            }
                            style={
                              dragLogo === frameSlot
                                ? { opacity: 0.45 }
                                : undefined
                            }
                            title="بکشید تا ترتیب لایه عوض شود"
                          >
                            <ListRow
                              active={layerSel === "frame"}
                              onClick={() => {
                                if (Date.now() - dropGuard.current < 350)
                                  return
                                setLayerSel("frame")
                              }}
                              title="تنظیم قاب"
                              thumb={
                                <img
                                  className="list-row__thumb"
                                  src={cfg.frame.file.url}
                                  alt="قاب"
                                />
                              }
                              badges={
                                <span className="list-row__badge">قاب</span>
                              }
                              actions={
                                <>
                                  <button
                                    className="icon-button"
                                    title="بردن قاب به بالا"
                                    aria-label="بردن قاب به بالا"
                                    disabled={frameSlot <= 0}
                                    onClick={() =>
                                      moveLayer(frameSlot, frameSlot - 1)
                                    }
                                  >
                                    <ChevronUp size={13} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="بردن قاب به پایین"
                                    aria-label="بردن قاب به پایین"
                                    disabled={
                                      frameSlot >= stack.length - 1
                                    }
                                    onClick={() =>
                                      moveLayer(frameSlot, frameSlot + 1)
                                    }
                                  >
                                    <ChevronDown size={13} />
                                  </button>
                                  <button
                                    className="icon-button icon-button--danger"
                                    title="حذف قاب"
                                    aria-label="حذف قاب"
                                    onClick={() => {
                                      patchFrame({ file: null })
                                      patch({
                                        rendered: null,
                                        message: null,
                                        errText: "",
                                      })
                                    }}
                                  >
                                    <Icon name="trash" size={13} />
                                  </button>
                                </>
                              }
                            >
                              {cfg.frame.file.name}
                            </ListRow>
                          </div>
                        )}

                        {cfg.logos.map((l, k) => {
                          const v = slotOfLogo.get(k) ?? k
                          return l.file ? (
                            <div
                              key={l.file.url}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData("text/plain", String(v))
                                e.dataTransfer.effectAllowed = "move"
                                setDragLogo(v)
                              }}
                              onDragEnd={() => {
                                setDragLogo(null)
                                setOverLogo(null)
                              }}
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = "move"
                                if (v !== dragLogo) setOverLogo(v)
                              }}
                              onDragLeave={() =>
                                setOverLogo((cur) => (cur === v ? null : cur))
                              }
                              onDrop={(e) => {
                                e.preventDefault()
                                moveLayer(
                                  Number(e.dataTransfer.getData("text/plain")),
                                  v,
                                )
                                dropGuard.current = Date.now()
                                setDragLogo(null)
                                setOverLogo(null)
                              }}
                              className={
                                overLogo === v ? "logo-row--drop" : undefined
                              }
                              style={
                                dragLogo === v ? { opacity: 0.45 } : undefined
                              }
                              title="بکشید تا ترتیب لایه عوض شود"
                            >
                              <ListRow
                                active={layerSel === k}
                                onClick={() => {
                                  if (Date.now() - dropGuard.current < 350)
                                    return
                                  setLayerSel(k)
                                }}
                                title={`تنظیم ${l.file.name}`}
                                thumb={
                                  <img
                                    className="list-row__thumb"
                                    src={l.file.url}
                                    alt={l.file.name}
                                  />
                                }
                                badges={
                                  <span className="list-row__badge">
                                    لوگو {faDigits(String(k + 1))}
                                  </span>
                                }
                                actions={
                                  <>
                                    <button
                                      className="icon-button"
                                      title="بردن به بالا"
                                      aria-label={`بردن لوگو ${faDigits(String(k + 1))} به بالا`}
                                      disabled={v <= 0}
                                      onClick={() => moveLayer(v, v - 1)}
                                    >
                                      <ChevronUp size={13} />
                                    </button>
                                    <button
                                      className="icon-button"
                                      title="بردن به پایین"
                                      aria-label={`بردن لوگو ${faDigits(String(k + 1))} به پایین`}
                                      disabled={v >= stack.length - 1}
                                      onClick={() => moveLayer(v, v + 1)}
                                    >
                                      <ChevronDown size={13} />
                                    </button>
                                    <button
                                      className="icon-button icon-button--danger"
                                      title="حذف این لوگو"
                                      aria-label={`حذف لوگو ${faDigits(String(k + 1))}`}
                                      onClick={() => {
                                        removeLogo(k)
                                        patch({
                                          rendered: null,
                                          message: null,
                                          errText: "",
                                        })
                                      }}
                                    >
                                      <Icon name="trash" size={13} />
                                    </button>
                                  </>
                                }
                              >
                                {l.file.name}
                              </ListRow>
                            </div>
                          ) : null
                        })}
                      </div>
                    )}

                    {layerSel === "frame" && cfg.frame.file ? (
                      <div className="settings-panel">
                        <div
                          className="view-toggle"
                          role="group"
                          aria-label="قرارگیری"
                        >
                          <button
                            className={
                              cfg.frame.layer === "under" ? "is-active" : ""
                            }
                            aria-pressed={cfg.frame.layer === "under"}
                            onClick={() => patchFrame({ layer: "under" })}
                          >
                            زیر تصویر
                          </button>
                          <button
                            className={
                              cfg.frame.layer === "over" ? "is-active" : ""
                            }
                            aria-pressed={cfg.frame.layer === "over"}
                            onClick={() => patchFrame({ layer: "over" })}
                          >
                            روی تصویر
                          </button>
                        </div>
                        <p className="setting-help">
                          مشخص کنید قاب زیر تصویر باشد یا روی آن. لوگوها همیشه
                          روی قاب قرار می‌گیرند.
                        </p>
                        <RangeControl
                          label="اندازه تصویر در قاب"
                          value={cfg.frame.scale}
                          min={1}
                          max={100}
                          onChange={(v) => patchFrame({ scale: v })}
                        />
                        <RangeControl
                          label="شفافیت تصویر"
                          value={cfg.frame.opacity}
                          onChange={(v) => patchFrame({ opacity: v })}
                        />
                        <PositionGrid
                          value={cfg.frame.pos}
                          customLabel={
                            cfg.frame.custom ? "سفارشی (بکشید)" : undefined
                          }
                          label="موقعیت تصویر"
                          onChange={(v) =>
                            patchFrame({
                              pos: v,
                              ox: 0,
                              oy: 0,
                              custom: false,
                            })
                          }
                        />
                      </div>
                    ) : selLogo && selLogo.file ? (
                      <div className="settings-panel">
                        <RangeControl
                          label="اندازه"
                          value={selLogo.scale}
                          min={1}
                          max={1000}
                          onChange={(v) => patchLogo({ scale: v })}
                        />
                        <RangeControl
                          label="شفافیت"
                          value={selLogo.opacity}
                          onChange={(v) => patchLogo({ opacity: v })}
                        />
                        <PositionGrid
                          value={selLogo.pos}
                          customLabel={
                            selLogo.custom ? "سفارشی (بکشید)" : undefined
                          }
                          label="موقعیت لوگو"
                          onChange={(v) =>
                            patchLogo({ pos: v, ox: 0, oy: 0, custom: false })
                          }
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            <div className="controls__footer">
              <div className="finish-actions">
                {renderingAll && (
                  <p className="privacy">
                    پردازش {faDigits(String(renderAllStep.done))} از {faDigits(
                  String(renderAllStep.total),
                )}…
                  </p>
                )}
                {(cfg.rendering || renderingAll) && (
                  <div
                    className="render-message render-message--busy"
                    role="status"
                  >
                    <span className="spinner" />
                    در حال پردازش…
                  </div>
                )}
                {cfg.message === "error" && (
                  <div
                    className="render-message render-message--error"
                    role="alert"
                  >
                    <Icon name="alert" size={12} />
                    {cfg.errText || "خطا در پردازش نهایی"}
                  </div>
                )}
              </div>
              <div className="cta-row">
                <button
                  className="back-button"
                  onClick={onBack}
                  title="بازگشت به پیش‌نمایش‌ها"
                  aria-label="بازگشت به پیش‌نمایش‌ها"
                >
                  <Icon name="back" size={18} />
                </button>
                <Button onClick={() => switchPane("outputs")}>
                  مشاهدهٔ خروجی‌ها <ArrowIcon />
                </Button>
              </div>
            </div>
          </aside>
        </>
      ) : (
        <>
          <div className="preview-panel">
            <div className="finish-preview">
              {outItem ? (
                <>
                  <div className="finish-preview__top">
                    <span>
                      {outItem.photo.name} · {outItem.crop.label}
                    </span>
                  </div>
                  <div className="finish-preview__stage">
                    <div
                      className="final-canvas final-canvas--none is-zoomable"
                      style={
                        {
                          aspectRatio: `${outW} / ${outH}`,
                          "--arw": outW,
                          "--arh": outH,
                        } as CSSProperties
                      }
                      onClick={() => {
                        setReview(idx)
                        setReviewFinal(true)
                        setShowOrigin(false)
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          setReview(idx)
                          setReviewFinal(true)
                          setShowOrigin(false)
                        }
                      }}
                    >
                      <div className="draggable-photo">
                        <img
                          src={outSrc}
                          alt="پیش‌نمایش خروجی نهایی"
                          draggable={false}
                        />
                      </div>
                      <span className="final-canvas__zoom-hint">
                        برای بزرگ‌نمایی کلیک کنید
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="finish-preview__top">
                    <span>صفحه نمایش خالی است</span>
                  </div>
                  <div className="finish-preview__stage">
                    <div className="empty-drop">
                      <Icon name="eye-off" size={40} />
                      <strong>تصویری در صفحه نمایش نیست</strong>
                      <small>
                        برای دیدن، «مشاهده در صفحه نمایش» را بزنید
                      </small>
                    </div>
                  </div>
                </>
              )}
              <div className="preview-hint">
                <span className="status-dot" />
                <span>{faDigits(String(items.length))} تصویر نهایی</span>
                {idx >= 0 ? (
                  <button
                    className="text-link"
                    onClick={() => {
                      setReview(idx)
                      setReviewFinal(true)
                      setShowOrigin(false)
                    }}
                  >
                    بازبینی
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          <aside className="controls">
            <div className="controls__scroll">
              <div className="control-section">
                <div className="control-title">
                  <span>لیست تصاویر نهایی</span>
                  <span className="panel__actions">
                    <b>{faDigits(String(sel.size))} انتخاب‌شده</b>
                    <button
                      className="icon-button icon-button--danger"
                      onClick={onDeleteSel}
                      title={
                        sel.size > 0
                          ? `حذف ${faDigits(String(sel.size))} انتخاب‌شده`
                          : "حذف همه"
                      }
                      aria-label={
                        sel.size > 0
                          ? `حذف ${faDigits(String(sel.size))} تصویر نهایی انتخاب‌شده`
                          : "حذف همهٔ تصاویر نهایی"
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </div>
              </div>
              {(() => {
                const groups = groupBySpec(items)
                const eff = groups.some((g) => g.spec === outFilter)
                  ? outFilter
                  : null
                const visible = eff
                  ? groups.filter((g) => g.spec === eff)
                  : groups
                return (
                  <>
                    <div
                      className="filter-row"
                      role="group"
                      aria-label="فیلتر نسبت"
                    >
                      <button
                        className={
                          eff === null ? "filter-chip is-active" : "filter-chip"
                        }
                        onClick={() => setOutFilter(null)}
                      >
                        همه
                      </button>
                      {groups.map((g) => (
                        <button
                          key={g.spec}
                          className={
                            eff === g.spec
                              ? "filter-chip is-active"
                              : "filter-chip"
                          }
                          onClick={() =>
                            setOutFilter(eff === g.spec ? null : g.spec)
                          }
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                    {items.length === 0 ? (
                      <p className="warn-box">هیچ تصویر نهایی باقی نمانده است.</p>
                    ) : null}
                    {visible.map((g) => (
                      <div key={g.spec} className="control-section">
                        <div className="control-title control-title--sub">
                          <span>{g.label}</span>
                          <b>{faDigits(String(g.indices.length))} تصویر</b>
                        </div>
                        <div className="list-stack">
                          {g.indices.map((index) => {
                            const item = items[index]
                            const cc = cfgs[index]
                            const custom = customs[index]
                            const dims = cc?.rendered
                              ? `${cc.rendered.width} × ${cc.rendered.height}`
                              : custom
                                ? `${custom.width} × ${custom.height}`
                                : `${item.crop.width} × ${item.crop.height}`
                            const badges = [
                              custom ? "سفارشی" : null,
                              cc?.rendered ? "پردازش شده" : null,
                            ].filter(Boolean) as string[]
                            return (
                              <ListRow
                                key={item.photo.url + item.crop.spec}
                                active={sel.has(index)}
                                dim={sel.size > 0 && !sel.has(index)}
                                onClick={() => onToggleSel(index)}
                                title={sel.has(index) ? "لغو انتخاب" : "انتخاب"}
                                thumb={
                                  <button
                                    className="thumb-button"
                                    title="بزرگ‌نمایی"
                                    aria-label={`بزرگ‌نمایی ${item.photo.name} · ${item.crop.label}`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSubject(index)
                                      setReview(index)
                                      setReviewFinal(true)
                                      setShowOrigin(false)
                                    }}
                                  >
                                    <img
                                      className="list-row__thumb"
                                      src={
                                        cc?.rendered?.url ??
                                        custom?.url ??
                                        item.crop.url
                                      }
                                      alt={item.photo.name}
                                    />
                                  </button>
                                }
                                badges={
                                  badges.length > 0 ? (
                                    <span className="list-row__badge">
                                      {badges.join(" · ")}
                                    </span>
                                  ) : undefined
                                }
                                actions={
                                  <>
                                    <button
                                      className="icon-button"
                                      title="مشاهده در صفحه نمایش"
                                      aria-label={`مشاهدهٔ ${item.photo.name} در صفحه نمایش`}
                                      aria-pressed={index === idx}
                                      onClick={() =>
                                        setSubject(index === idx ? null : index)
                                      }
                                    >
                                      <Icon
                                        name={index === idx ? "eye" : "eye-off"}
                                        size={14}
                                      />
                                    </button>
                                    {dlSwitch}
                                    <button
                                      className="icon-button"
                                      title={
                                        busyDl.has(index)
                                          ? "در حال دانلود…"
                                          : "دانلود تصویر نهایی"
                                      }
                                      aria-label={`دانلود تصویر نهایی ${item.photo.name} · ${item.crop.label}`}
                                      disabled={busyDl.has(index)}
                                      onClick={() =>
                                        void downloadOutput(index, dlFormat)
                                      }
                                    >
                                      {busyDl.has(index) ? (
                                        <span className="spinner" />
                                      ) : (
                                        <Icon name="download" size={14} />
                                      )}
                                    </button>
                                  </>
                                }
                              >
                                {item.photo.name} · {dims}
                              </ListRow>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </>
                )
              })()}
            </div>
            <div className="controls__footer">
              {dlSummary && (
                <div
                  className={`render-message ${
                    dlSummary.fail === 0
                      ? "render-message--success"
                      : "render-message--error"
                  }`}
                  role={dlSummary.fail === 0 ? undefined : "alert"}
                >
                  {dlSummary.fail === 0 ? (
                    `${faDigits(String(dlSummary.ok))} تصویر نهایی دانلود شد.`
                  ) : (
                    <>
                      <Icon name="alert" size={12} />
                      {`${faDigits(String(dlSummary.ok))} تصویر نهایی دانلود شد، ${faDigits(
                        String(dlSummary.fail)
                      )} ناموفق.`}
                      {dlSummary.failedNames.length > 0 && (
                        <small className="render-message__detail">
                          {namesFa(dlSummary.failedNames)}
                        </small>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="cta-row">
                <button
                  className="back-button"
                  onClick={() => switchPane("studio")}
                  title="بازگشت به پیش‌نمایش"
                  aria-label="بازگشت به پیش‌نمایش"
                >
                  <Icon name="back" size={18} />
                </button>
                <Button
                  onClick={() => void downloadAll()}
                  disabled={busyDl.size > 0}
                >
                  {busyDl.size > 0
                    ? "در حال دانلود…"
                    : sel.size > 0
                      ? `دانلود ${faDigits(String(sel.size))} انتخاب‌شده`
                      : "دانلود همه"}
                </Button>
              </div>
            </div>
          </aside>
        </>
      )}

      {review !== null &&
        (() => {
          const rcp = items[review].crop
          const photo = items[review].photo
          const cc = cfgs[review] ?? defaultSubjCfg()
          const custom = customs[review]
          const viewSrc = cc.rendered?.url ?? custom?.url ?? rcp.url
          const viewDims = cc.rendered
            ? `${cc.rendered.width} × ${cc.rendered.height}`
            : custom
              ? `${custom.width} × ${custom.height}`
              : `${rcp.width} × ${rcp.height}`
          const vBox = custom?.box ?? rcp.box
          const ox1 = (vBox[0] / photo.w) * 100
          const oy1 = (vBox[1] / photo.h) * 100
          const ox2 = (vBox[2] / photo.w) * 100
          const oy2 = (vBox[3] / photo.h) * 100
          return (
            <div
              className="modal-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label="بازبینی تصویر نهایی"
              onClick={() => {
                setReview(null)
                setShowOrigin(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setReview(null)
                  setShowOrigin(false)
                }
              }}
            >
              <div
                className="review-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modal-header">
                  <div>
                    <strong>
                      {photo.name} · {rcp.label}
                    </strong>
                    <span>{viewDims}</span>
                  </div>
                  <div className="modal-actions">
                    {vBox && !reviewFinal && (
                      <ViewToggle
                        value={showOrigin}
                        onChange={() => setShowOrigin((v) => !v)}
                        show={!photo.broken}
                      />
                    )}
                    {!reviewFinal && (
                      <button
                        className="icon-button icon-button--lg"
                      title={
                        photo.broken
                          ? "برش سفارشی نیاز به اتصال سرور دارد"
                          : "برش سفارشی"
                      }
                      aria-label="برش سفارشی"
                      disabled={photo.broken}
                      onClick={() => onCustomRequest(review)}
                    >
                      <Icon name="crop" size={16} />
                    </button>
                    )}
                    {dlSwitch}
                    <button
                      className="icon-button icon-button--lg"
                      title="دانلود تصویر نهایی"
                      aria-label="دانلود تصویر نهایی"
                      onClick={() => void downloadOutput(review, dlFormat)}
                    >
                      <Icon name="download" size={16} />
                    </button>
                    <button
                      className="modal-close"
                      autoFocus
                      title="بستن"
                      aria-label="بستن"
                      onClick={() => {
                        setReview(null)
                        setShowOrigin(false)
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </div>
                <div className="review-modal__body">
                  {showOrigin && vBox ? (
                    <div
                      className="origin-stage"
                      style={{ aspectRatio: `${photo.w} / ${photo.h}` }}
                    >
                      <img
                        src={photo.url}
                        alt="عکس اصلی"
                        draggable={false}
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                        }}
                      />
                      <span className="origin-caption">تصویر اولیه</span>
                      <span
                        className="origin-shade"
                        aria-hidden="true"
                        style={{ left: 0, top: 0, width: "100%", height: `${oy1}%` }}
                      />
                      <span
                        className="origin-shade"
                        aria-hidden="true"
                        style={{ left: 0, top: `${oy2}%`, width: "100%", bottom: 0 }}
                      />
                      <span
                        className="origin-shade"
                        aria-hidden="true"
                        style={{
                          left: 0,
                          top: `${oy1}%`,
                          width: `${ox1}%`,
                          height: `${oy2 - oy1}%`,
                        }}
                      />
                      <span
                        className="origin-shade"
                        aria-hidden="true"
                        style={{
                          left: `${ox2}%`,
                          top: `${oy1}%`,
                          right: 0,
                          height: `${oy2 - oy1}%`,
                        }}
                      />
                      <img
                        src={viewSrc}
                        alt="برش"
                        draggable={false}
                        style={{
                          position: "absolute",
                          left: `${ox1}%`,
                          top: `${oy1}%`,
                          width: `${ox2 - ox1}%`,
                          height: `${oy2 - oy1}%`,
                          opacity: 1,
                          zIndex: 2,
                          pointerEvents: "none",
                        }}
                      />
                      <span
                        className="crop-mark"
                        aria-hidden="true"
                        style={{
                          left: `${ox1}%`,
                          top: `${oy1}%`,
                          width: `${ox2 - ox1}%`,
                          height: `${oy2 - oy1}%`,
                        }}
                      >
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  ) : (
                    <img src={viewSrc} alt="بازبینی خروجی نهایی" />
                  )}
                </div>
              </div>
            </div>
          )
        })()}
    </>
  )
}

interface Original {
  url: string
  w: number
  h: number
  file: File
  name: string
  /** Browser cannot preview (e.g. HEIC): tile/monitor show a placeholder,
   * but upload + backend crop work normally. */
  broken?: boolean
}

interface CustomCrop {
  url: string
  width: number
  height: number
  box: [number, number, number, number]
}

const MAX_PHOTOS = 20
const MAX_FILE_MB = 20

function Home() {
  const [photos, setPhotos] = useState<Original[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  // Multi-select of crops in stages 2-4 (results indices) for bulk actions
  const [sel, setSel] = useState<Set<number>>(new Set())
  const toggleSel = (i: number) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  // Image shown in the stage-1 monitor (eye open), independent of crop selection
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null)
  const [showCustom, setShowCustom] = useState(false)
  const [pickedRatios, setPickedRatios] = useState<{
    spec: string
    label: string
  }[]>([])
  const [orientation, setOrientation] = useState<"landscape" | "portrait">(
    "landscape",
  )
  const [results, setResults] = useState<{
    photo: Original
    crop: Crop
  }[] | null>(null)
  const [finalized, setFinalized] = useState(false)
  // Inner view of the studio (stage 3/4): studio or outputs panel
  const [finPane, setFinPane] = useState<"studio" | "outputs">("studio")
  const [dragging, setDragging] = useState(false)
  const [cropping, setCropping] = useState(false)
  const [progress, setProgress] = useState("")
  const [cropStep, setCropStep] = useState({ done: 0, total: 0, name: "" })
  const cancelCropRef = useRef(false)
  const cancelCrop = () => {
    cancelCropRef.current = true
  }
  const [cropError, setCropError] = useState("")
  // 4-stage wizard: only one stage is visible (hidden, not unmounted, so state persists)
  const [stage, setStage] = useState(1)
  // Stage-2 eye: which image is on the monitor (null = all closed)
  const [stage2Eye, setStage2Eye] = useState<number | null>(null)
  // Stage-2 ratio filter (null = all)
  const [stageFilter, setStageFilter] = useState<string | null>(null)
  const goStage = (n: number) => {
    setStage(n)
    const anchor = n === 3 ? "finish-studio" : "studio"
    window.setTimeout(
      () =>
        document
          .querySelector(`#${anchor}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      80,
    )
  }
  const [cusW, setCusW] = useState("4")
  const [cusH, setCusH] = useState("3")
  // Custom crop and the stage-2 crop slot (shared with the studio)
  const [customs, setCustoms] = useState<Record<number, CustomCrop>>({})
  const [originKeys, setOriginKeys] = useState<Set<number>>(new Set())
  const [modalTarget, setModalTarget] = useState<number | null>(null)
  const [rect, setRect] = useState({ x: 0, y: 0, w: 1 })
  const [cropBusy, setCropBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const cropDragRef = useRef<{
    sx: number
    sy: number
    r: { x: number; y: number; w: number }
    cw: number
    ch: number
    mode: "move" | "resize-tr" | "resize-tl" | "resize-br" | "resize-bl"
  } | null>(null)

  const resetBatch = () => {
    setSel(new Set())
    setResults(null)
    setFinalized(false)
    setFinPane("studio")
    setStage2Eye(null)
    setStage(1)
    setCustoms((prev) => {
      Object.values(prev).forEach((c) => URL.revokeObjectURL(c.url))
      return {}
    })
    setOriginKeys(new Set())
    setModalTarget(null)
  }

  const takeOriginals = async (files: File[]) => {
    // Some systems report an empty MIME type for HEIC/HEIF: trust the
    // extension as well, or the file never reaches the decoder.
    const looksImage = (f: File) =>
      f.type.startsWith("image/") || /\.(heic|heif|hif)$/i.test(f.name)
    const nonImage = files.filter((f) => !looksImage(f))
    const imgs = files.filter(looksImage)
    if (imgs.length === 0) {
      setCropError(
        nonImage.length > 0
          ? "فایل تصویری معتبر انتخاب کنید — فایل غیرتصویری نادیده گرفته شد."
          : "فایل تصویری معتبر انتخاب کنید.",
      )
      return
    }
    const tooBig = imgs.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024)
    const fits = imgs.filter((f) => f.size <= MAX_FILE_MB * 1024 * 1024)
    // New picks append to the current list (not replace); the cap applies to the whole list
    const room = Math.max(0, MAX_PHOTOS - photos.length)
    if (room === 0) {
      setCropError(
        `حداکثر ${MAX_PHOTOS} عکس — برای افزودن، ابتدا بعضی را حذف کنید.`,
      )
      return
    }
    const ok = fits.slice(0, room)
    if (ok.length === 0) {
      setCropError(`حجم هر عکس حداکثر ${MAX_FILE_MB} مگابایت.`)
      return
    }
    let brokenCount = 0
    setCropError(
      [
        tooBig.length > 0
          ? `${faDigits(String(tooBig.length))} فایل سنگین‌تر از حد نادیده گرفته شد.`
          : "",
        fits.length > room
          ? `فقط ${room} عکس جا شد (سقف ${MAX_PHOTOS} عکس).`
          : "",
        nonImage.length > 0
          ? `${faDigits(String(nonImage.length))} فایل غیرتصویری نادیده گرفته شد.`
          : "",
        brokenCount > 0
          ? `پیش‌نمایش ${faDigits(String(brokenCount))} عکس در مرورگر باز نشد، ولی برش انجام می‌شود.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    const out: Original[] = []
    for (const file of ok) {
      try {
        const r = await readImageFile(file)
        out.push({ url: r.url, w: r.w, h: r.h, file, name: file.name })
      } catch {
        // Browser preview failed (e.g. HEIC): convert server-side to JPEG
        // so the photo previews and crops like any other.
        const dims = await heicDims(file)
        if (!dims) continue
        try {
          const blob = await convertImage(file)
          const conv = new File(
            [blob],
            file.name.replace(/\.[^.]+$/, "") + ".jpg",
            { type: "image/jpeg" },
          )
          const r = await readImageFile(conv)
          out.push({ url: r.url, w: r.w, h: r.h, file: conv, name: file.name })
        } catch {
          // Backend unreachable or undecodable: keep header dims so at
          // least the crop (which the backend decodes) can still run.
          brokenCount++
          out.push({
            url: URL.createObjectURL(file),
            w: dims.w,
            h: dims.h,
            file,
            name: file.name,
            broken: true,
          })
        }
      }
    }
    if (out.length === 0) {
      setCropError("خواندن تصویر ناموفق بود.")
      return
    }
    const start = photos.length
    setPhotos((prev) => [...prev, ...out])
    setPicked((prev) => new Set([...prev, ...out.map((_, k) => start + k)]))
    setMonitorUrl((prev) => prev ?? out[0].url)
    resetBatch()
  }

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (files.length === 0) return
    void takeOriginals(files).catch(() =>
      setCropError("خواندن تصویر ناموفق بود."),
    )
  }

  const onDropFile = (files: File[]) => {
    void takeOriginals(files).catch(() =>
      setCropError("خواندن تصویر ناموفق بود."),
    )
  }

  const removePhoto = (index: number) => {
    const gone = photos[index]?.url
    setPhotos((prev) => {
      const gonePrev = prev[index]
      if (gonePrev) URL.revokeObjectURL(gonePrev.url)
      return prev.filter((_, i) => i !== index)
    })
    setPicked((prev) => {
      const next = new Set<number>()
      prev.forEach((i) => {
        if (i < index) next.add(i)
        else if (i > index) next.add(i - 1)
      })
      return next
    })
    setMonitorUrl((prevMon) => {
      if (prevMon !== gone) return prevMon
      const rest = photos.filter((_, i) => i !== index)
      return rest[0]?.url ?? null
    })
    resetBatch()
  }

  // In-place delete from results (without leaving the stage): removes the given crops
  // and remaps every index-keyed state.
  const removeCropsAt = (indices: number[]) => {
    if (!results || indices.length === 0) return
    const gone = new Set(indices.filter((i) => i >= 0 && i < results.length))
    if (gone.size === 0) return
    gone.forEach((k) => {
      const r = results[k]
      if (r) {
        if (r.crop.url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(r.crop.url)
          } catch {
            /* ignore */
          }
        }
        const cu = customs[k]?.url
        if (cu) {
          try {
            URL.revokeObjectURL(cu)
          } catch {
            /* ignore */
          }
        }
      }
    })
    const shiftOf = (oldIdx: number) => {
      let s = 0
      gone.forEach((g) => {
        if (g < oldIdx) s++
      })
      return oldIdx - s
    }
    const newLen = results.length - gone.size
    const clampIdx = (oldIdx: number | null): number | null => {
      if (oldIdx === null) return null
      if (gone.has(oldIdx))
        return newLen > 0 ? Math.min(oldIdx, newLen - 1) : null
      return shiftOf(oldIdx)
    }
    setResults((prev) => (prev ? prev.filter((_, i) => !gone.has(i)) : prev))
    setCustoms((prev) => {
      const next: Record<number, CustomCrop> = {}
      Object.entries(prev).forEach(([ks, v]) => {
        const k = Number(ks)
        if (!gone.has(k)) next[shiftOf(k)] = v
      })
      return next
    })
    setOriginKeys((prev) => {
      const next = new Set<number>()
      prev.forEach((k) => {
        if (!gone.has(k)) next.add(shiftOf(k))
      })
      return next
    })
    setSel((prev) => {
      const next = new Set<number>()
      prev.forEach((k) => {
        if (k < results.length && !gone.has(k)) next.add(shiftOf(k))
      })
      return next
    })
    setStage2Eye((prev) => clampIdx(prev))
    setModalTarget((prev) => clampIdx(prev))
  }

  // In-place delete of every crop of one image (for the sub-header buckets)
  const removePhotoCrops = (url: string) => {
    if (!results) return
    const idxs: number[] = []
    results.forEach((r, k) => {
      if (r.photo.url === url) idxs.push(k)
    })
    removeCropsAt(idxs)
  }

  // Stage 2-4 header bucket: in-place delete of the selected crops, or all crops when nothing is selected
  const deleteSelOrAllResults = () => {
    if (!results) return
    if (sel.size > 0) removeCropsAt([...sel])
    else removeCropsAt(results.map((_, i) => i))
  }

  const clearPhotos = () => {
    setPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url))
      return []
    })
    setPicked(new Set())
    setMonitorUrl(null)
    resetBatch()
  }

  // Stage-1 header bucket: delete the selected images, or all when nothing is selected
  const deleteSelOrAllPhotos = () => {
    if (picked.size === 0) {
      clearPhotos()
      return
    }
    const gone = new Set(picked)
    photos.forEach((p, i) => {
      if (gone.has(i)) URL.revokeObjectURL(p.url)
    })
    setPhotos((prev) => prev.filter((_, i) => !gone.has(i)))
    setPicked(new Set())
    setMonitorUrl((prev) => {
      const gonePhoto = photos.find((p) => p.url === prev)
      if (!gonePhoto || !gone.has(photos.indexOf(gonePhoto))) return prev
      const rest = photos.filter((_, i) => !gone.has(i))
      return rest[0]?.url ?? null
    })
    resetBatch()
  }

  const togglePhoto = (index: number) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
    resetBatch()
  }

  const dragPhotoFrom = useRef<number | null>(null)

  const movePhoto = (from: number, to: number) => {
    if (from === to || results) return // reorder only before cropping
    setPhotos((prev) => {
      const next = [...prev]
      const [m] = next.splice(from, 1)
      next.splice(to, 0, m)
      return next
    })
    setPicked((prev) => {
      // indices shift with the move; keep the same photos picked
      const ids = photos.map((p) => p.url)
      const moved = ids[from]
      const rest = ids.filter((_, i) => i !== from)
      rest.splice(to, 0, moved)
      const next = new Set<number>()
      prev.forEach((i) => {
        const id = ids[i]
        const ni = rest.indexOf(id)
        if (ni >= 0) next.add(ni)
      })
      return next
    })
  }

  // Orientation variant of a preset for the current toggle state (square is always fixed)
  const variantOf = (index: number): { spec: string; label: string } => {
    const base = ratios[index]
    if (base.spec === "1:1" || orientation === "landscape")
      return { spec: base.spec, label: base.value }
    return { spec: flipSpec(base.spec), label: flipSpec(base.value) }
  }

  // Tile click: add/remove that orientation variant (mixing orientations is allowed)
  const togglePreset = (index: number) => {
    const r = variantOf(index)
    setCropError("")
    setPickedRatios((prev) =>
      prev.some((x) => x.spec === r.spec)
        ? prev.filter((x) => x.spec !== r.spec)
        : [...prev, r],
    )
    resetBatch()
  }

  const confirmCustomRatio = () => {
    const spec = customSpec()
    if (pickedRatios.some((x) => x.spec === spec)) {
      setCropError(`نسبت ${faDigits(spec)} قبلاً اضافه شده است.`)
      return
    }
    setCropError("")
    setPickedRatios((prev) => [...prev, { spec, label: faDigits(spec) }])
    setShowCustom(false)
    resetBatch()
  }

  const clearRatios = () => {
    setPickedRatios([])
    resetBatch()
  }

  const removeRatio = (spec: string) => {
    setPickedRatios((prev) => prev.filter((x) => x.spec !== spec))
    resetBatch()
  }

  const customSpec = () => {
    const w = Math.max(1, parseInt(cusW, 10) || 4)
    const h = Math.max(1, parseInt(cusH, 10) || 3)
    return `${w}:${h}`
  }

  // User-selected ratios - each keeps its own independent orientation
  const wantedSpecs = () => pickedRatios

  const applyCrop = async () => {
    const targets = photos.filter((_, i) => picked.has(i))
    const specs = wantedSpecs()
    if (targets.length === 0) {
      setCropError("حداقل یک تصویر را انتخاب کنید.")
      return
    }
    if (specs.length === 0) {
      setCropError("حداقل یک نسبت را انتخاب کنید.")
      return
    }
    setCropping(true)
    setCropError("")
    setCropStep({ done: 0, total: targets.length, name: "" })
    cancelCropRef.current = false
    resetBatch()
    const noFaceNames: string[] = []
    const failNames: string[] = []
    try {
      const out: { photo: Original; crop: Crop }[] = []
      for (let i = 0; i < targets.length; i++) {
        if (cancelCropRef.current) break
        setProgress(
      `برش ${faDigits(String(i + 1))} از ${faDigits(String(targets.length))}…`,
    )
        setCropStep({ done: i, total: targets.length, name: targets[i].name })
        let crops: Crop[]
        try {
          crops = await cropImage(targets[i].file, specs)
        } catch (e) {
          if (e instanceof CropApiError && e.noFace) {
            noFaceNames.push(targets[i].name)
          } else {
            failNames.push(targets[i].name)
          }
          crops = []
        }
        for (const crop of crops) out.push({ photo: targets[i], crop })
        if (cancelCropRef.current) break
        setCropStep({ done: i + 1, total: targets.length, name: "" })
      }
      if (cancelCropRef.current) {
        setCropError("برش لغو شد — تصویر‌ها سر جایشان هستند.")
        return
      }
      // Stage 2 stays closed while a faceless image is still in the selection.
      if (noFaceNames.length > 0) {
        setCropError(
          `عکس‌های بی‌چهره را از انتخاب خارج کنید یا حذف کنید، سپس دوباره برش بگیرید — چهره در ${faDigits(
            String(noFaceNames.length)
          )} عکس پیدا نشد: ${namesFa(noFaceNames, "عکس")}.`
        )
        return
      }
      // A partial failure must not pass silently: the user needs to know which image did not crop.
      if (failNames.length > 0) {
        setCropError(
          `برش این عکس‌ها ناموفق بود — ${faDigits(String(failNames.length))} عکس: ${namesFa(
            failNames,
            "عکس"
          )}. آن‌ها را از انتخاب خارج کنید یا حذف کنید، سپس دوباره برش بگیرید.`
        )
        return
      }
      if (out.length === 0) throw new Error("برش هیچ تصویری موفق نبود.")
      setResults(out)
      setSel(new Set(out.map((_, k) => k)))
      setStage2Eye(out.length ? 0 : null)
      goStage(2)
    } catch (e) {
      setCropError((e as Error).message || "خطا در برش تصویر")
    } finally {
      setCropping(false)
      setProgress("")
      setCropStep({ done: 0, total: 0, name: "" })
    }
  }

  // The stage-1 preview is always the original size of the first selected image (no fake frame)
  const stagePhoto = monitorUrl
    ? (photos.find((p) => p.url === monitorUrl) ??
      photos.find((_, i) => picked.has(i)) ??
      photos[0])
    : undefined
  const stagePos = stagePhoto ? photos.indexOf(stagePhoto) + 1 : 0
  const stageOrd =
    stagePos >= 1 && stagePos <= FA_ORDINAL.length
      ? FA_ORDINAL[stagePos - 1]
      : `${faDigits(String(stagePos))}م`

  const toggleOrigin = (i: number) => {
    setOriginKeys((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const finalize = () => {
    setFinalized(true)
    goStage(3)
  }

  const clearPhotoCustoms = (url: string, onlyIdx?: number) => {
    if (!results) return
    setCustoms((prev) => {
      const next = { ...prev }
      results.forEach((r, k) => {
        if (
          r.photo.url === url &&
          next[k] &&
          (onlyIdx === undefined || onlyIdx === k)
        ) {
          URL.revokeObjectURL(next[k].url)
          delete next[k]
        }
      })
      return next
    })
  }

  const clearAllCustoms = () => {
    setCustoms((prev) => {
      Object.values(prev).forEach((c) => URL.revokeObjectURL(c.url))
      return {}
    })
  }

  const openCropFor = (i: number) => {
    if (!results || i < 0 || i >= results.length) return
    const { photo, crop } = results[i]
    const b = customs[i]?.box ?? crop.box
    if (b) {
      setRect({
        x: b[0] / photo.w,
        y: b[1] / photo.h,
        w: (b[2] - b[0]) / photo.w,
      })
    } else {
      const r = crop.width / crop.height
      const k0 = photo.w / photo.h / r
      let w = 1
      if (w * k0 > 1) w = 1 / k0
      setRect({ x: (1 - w) / 2, y: (1 - w * k0) / 2, w })
    }
    setModalTarget(i)
  }

  const confirmCrop = () => {
    if (cropBusy || modalTarget === null || !results) return
    const { photo } = results[modalTarget]
    const rcp = results[modalTarget].crop
    const kk = photo.w / photo.h / (rcp.width / rcp.height)
    setCropBusy(true)
    const img = new Image()
    img.src = photo.url
    img.onload = () => {
      const h = rect.w * kk
      const x1 = Math.round(rect.x * photo.w)
      const y1 = Math.round(rect.y * photo.h)
      const x2 = Math.round((rect.x + rect.w) * photo.w)
      const y2 = Math.round((rect.y + h) * photo.h)
      const cw = Math.max(1, x2 - x1)
      const ch = Math.max(1, y2 - y1)
      const canvas = document.createElement("canvas")
      canvas.width = cw
      canvas.height = ch
      canvas.getContext("2d")?.drawImage(img, x1, y1, cw, ch, 0, 0, cw, ch)
      canvas.toBlob(
        (blob) => {
          setCropBusy(false)
          if (!blob) return
          const url = URL.createObjectURL(blob)
          const i = modalTarget
          setCustoms((m) => {
            const prev = m[i]?.url
            if (prev) URL.revokeObjectURL(prev)
            return {
              ...m,
              [i]: { url, width: cw, height: ch, box: [x1, y1, x2, y2] },
            }
          })
          setModalTarget(null)
        },
        "image/jpeg",
        0.95,
      )
    }
    img.onerror = () => setCropBusy(false)
  }

  const clearCustom = () => {
    if (modalTarget === null) return
    const i = modalTarget
    setCustoms((m) => {
      const prev = m[i]?.url
      if (prev) URL.revokeObjectURL(prev)
      if (!m[i]) return m
      const next = { ...m }
      delete next[i]
      return next
    })
    setModalTarget(null)
  }

  return (
    <main>
      <section className="hero">
        <div className="hero__copy">
          <div className="eyebrow">
            <span /> برش هوشمند برای تحریریه‌های حرفه‌ای
          </div>
          <Heading level={1} className="hero__title">
            هر چهره،
            <br />
            در <span className="marked-word"><i /><i /><i /><i />چارچوب</span> درست.
          </Heading>
          <p className="hero__lead">
            برش هوشمند تصاویر خبری با اولویت تشخیص چهره، بدن و زاویه سوژه؛
            <br className="desktop-only" /> برای خروجی‌های دقیق و آماده انتشار در
            هر رسانه.
          </p>
          <div className="hero__actions">
            <Button
              onClick={() =>
                document
                  .querySelector("#studio")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              شروع برش تصویر <ArrowIcon down />
            </Button>
          </div>
        </div>
        <div
          className="hero__visual"
          aria-label="نمونه تشخیص چهره و ترکیب‌بندی تصویر خبری"
        >
          <div className="visual__index">تحلیل سوژه خبری</div>
          <div className="visual__image-wrap">
            <img
              src={sampleImage}
              alt="خبرنگار مقابل دوربین در یک گزارش میدانی"
            />
            <div className="composition-grid">
              <span />
              <span />
              <span />
              <span />
            </div>
            <FrameMark />
          </div>
        </div>
      </section>

      <section className="studio" id="studio">
        <div className="section-heading">
          <div>
            <Heading>کارگاه برش</Heading>
          </div>
          <p>
            تصویرها را اضافه کنید، نسبت را انتخاب کنید؛ چهره و سوژه در خروجی‌ها
            داخل قاب می‌مانند.
          </p>
        </div>
        <StepLine
          active={
            stage === 1 ? 0 : stage === 2 ? 1 : finPane === "outputs" ? 3 : 2
          }
        />

        <div className={stage === 3 ? "workspace hidden" : "workspace"}>
          <span className="workshop-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          {stage === 2 && results ? (
            (() => {
              const mi =
                stage2Eye !== null && stage2Eye < results.length
                  ? stage2Eye
                  : -1
              if (mi < 0) {
                return (
                  <div className="preview-panel">
                    <div className="panel-top">
                      <span>پیش‌نمایش برش</span>
                      <span className="file-info">تصویری در صفحه نمایش نیست</span>
                    </div>
                    <div className="crop-stage">
                      <div className="empty-drop">
                        <Icon name="eye-off" size={40} />
                        <strong>تصویری در صفحه نمایش نیست</strong>
                        <small>
                          برای دیدن، «مشاهده در صفحه نمایش» را بزنید
                        </small>
                      </div>
                    </div>
                    <div className="preview-hint">
                      <span className="status-dot" />
                      <span>{faDigits(String(results.length))} تصویر برش‌خورده</span>
                    </div>
                  </div>
                )
              }
              const i = mi
              const { photo, crop } = results[i]
              const custom = customs[i]
              const src = custom?.url ?? crop.url
              const box = custom?.box ?? crop.box
              const dims = custom
                ? `${custom.width} × ${custom.height}`
                : `${crop.width} × ${crop.height}`
              const showO = originKeys.has(i) && box
              return (
                <div className="preview-panel">
                  <div className="panel-top">
                    <span>پیش‌نمایش برش</span>
                    <span className="file-info">
                      {photo.name} · {crop.label} · {dims}
                    </span>
                  </div>
                  <div className="crop-stage">
                    <div
                      className="crop-frame"
                      style={{
                        position: "relative",
                        aspectRatio:
                          showO && box
                            ? `${photo.w} / ${photo.h}`
                            : `${crop.width} / ${crop.height}`,
                      }}
                    >
                      {showO && box ? (
                        <>
                          <img
                            src={photo.url}
                            alt="عکس اصلی"
                            draggable={false}
                          />
                          <span className="origin-caption">تصویر اولیه</span>
                          {(() => {
                            const l = (box[0] / photo.w) * 100
                            const t = (box[1] / photo.h) * 100
                            const r = (box[2] / photo.w) * 100
                            const b = (box[3] / photo.h) * 100
                            return (
                              <>
                                <span
                                  className="origin-shade"
                                  aria-hidden="true"
                                  style={{ left: 0, top: 0, width: "100%", height: `${t}%` }}
                                />
                                <span
                                  className="origin-shade"
                                  aria-hidden="true"
                                  style={{ left: 0, top: `${b}%`, width: "100%", bottom: 0 }}
                                />
                                <span
                                  className="origin-shade"
                                  aria-hidden="true"
                                  style={{
                                    left: 0,
                                    top: `${t}%`,
                                    width: `${l}%`,
                                    height: `${b - t}%`,
                                  }}
                                />
                                <span
                                  className="origin-shade"
                                  aria-hidden="true"
                                  style={{
                                    left: `${r}%`,
                                    top: `${t}%`,
                                    right: 0,
                                    height: `${b - t}%`,
                                  }}
                                />
                                <img
                                  src={src}
                                  alt="برش"
                                  draggable={false}
                                  style={{
                                    position: "absolute",
                                    left: `${l}%`,
                                    top: `${t}%`,
                                    width: `${r - l}%`,
                                    height: `${b - t}%`,
                                    opacity: 1,
                                    zIndex: 2,
                                    pointerEvents: "none",
                                  }}
                                />
                                <span
                                  className="crop-mark"
                                  aria-hidden="true"
                                  style={{
                                    left: `${l}%`,
                                    top: `${t}%`,
                                    width: `${r - l}%`,
                                    height: `${b - t}%`,
                                  }}
                                >
                                  <i />
                                  <i />
                                  <i />
                                  <i />
                                </span>
                              </>
                            )
                          })()}
                        </>
                      ) : (
                        <img src={src} alt="برش" />
                      )}
                    </div>
                      {box ? (
                        <div className="monitor-toggle">
                          <ViewToggle
                            value={originKeys.has(i)}
                            onChange={() => toggleOrigin(i)}
                            show={!photo.broken}
                          />
                      </div>
                    ) : null}
                  </div>
                  <div className="preview-hint">
                    <span className="status-dot" />
                    <span>{faDigits(String(results.length))} تصویر برش‌خورده</span>
                  </div>
                </div>
              )
            })()
          ) : (
            <div className="preview-panel">
              <div className="panel-top">
                <span>پیش‌نمایش تصویر</span>
                <span className="file-info">
                  {stagePhoto
                    ? stagePhoto.name
                    : photos.length > 0
                      ? "صفحه نمایش خالی است"
                      : "هنوز تصویری انتخاب نشده"}
                </span>
              </div>
              <div className="crop-stage">
                {stagePhoto ? (
                  stagePhoto.broken ? (
                    <div className="empty-drop">
                      <Icon name="image-off" size={40} />
                      <strong>پیش‌نمایش در مرورگر ممکن نیست</strong>
                      <small>برش از روی فایل اصلی انجام می‌شود</small>
                    </div>
                  ) : (
                    <div
                      className="crop-frame"
                      style={{
                        position: "relative",
                        aspectRatio: `${stagePhoto.w} / ${stagePhoto.h}`,
                      }}
                    >
                      <img src={stagePhoto.url} alt="تصویر آماده برای برش" />
                    </div>
                  )
                ) : (
                  <div
                    className={
                      dragging ? "empty-drop is-dragging" : "empty-drop"
                    }
                    role="button"
                    tabIndex={0}
                    title="انتخاب تصویر"
                    aria-label="انتخاب تصویر برای برش"
                    onClick={() => inputRef.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        inputRef.current?.click()
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setDragging(true)
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDragging(false)
                      onDropFile(Array.from(e.dataTransfer.files))
                    }}
                  >
                    {photos.length > 0 ? (
                      <Icon name="eye-off" size={40} />
                    ) : (
                      <ImagePlus
                        size={40}
                        strokeWidth={1.25}
                        aria-hidden="true"
                      />
                    )}
                    <strong>
                      {photos.length > 0
                        ? "تصویری باز نیست"
                        : "هنوز تصویری اضافه نشده است"}
                    </strong>
                    <small>
                      {photos.length > 0
                        ? "برای دیدن، «مشاهده در صفحه نمایش» را بزنید"
                        : "کلیک کنید یا تصویر را اینجا رها کنید · JPG، PNG، WEBP"}
                    </small>
                  </div>
                )}
              </div>
              <div className="preview-hint">
                <span className="status-dot" />
                {photos.length === 0
                  ? "تصویر را اضافه کنید"
                  : stagePhoto
                    ? `تصویر ${stageOrd} از ${faDigits(String(photos.length))}`
                    : "تصویری در صفحه نمایش نیست"}
              </div>
            </div>
          )}

          <aside className="controls">
            {stage === 2 && results ? (
              <>
                <div className="controls__scroll">
                  <div className="control-section">
                    <div className="control-title">
<span>لیست تصاویر برش‌خورده</span>
                      <span className="panel__actions">
                  {sel.size > 0 ? (
                      <b>{faDigits(String(sel.size))} انتخاب‌شده</b>
                    ) : null}
                        {Object.keys(customs).length > 0 ? (
                          <button
                            className="icon-button"
                            title="حذف برش سفارشی از همهٔ تصاویر"
                            aria-label="حذف برش سفارشی از همهٔ تصاویر"
                            onClick={clearAllCustoms}
                          >
                            <Icon name="reset" size={14} />
                          </button>
                        ) : null}
                        <button
                          className="icon-button icon-button--danger"
                          onClick={deleteSelOrAllResults}
title={
                              sel.size > 0
                                ? `حذف ${faDigits(String(sel.size))} انتخاب‌شده`
                                : "حذف همه"
                            }
                            aria-label={
                              sel.size > 0
                                ? `حذف ${faDigits(String(sel.size))} برش انتخاب‌شده`
                                 : "حذف همهٔ برش‌ها"
                            }
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </span>
                    </div>
                    {(() => {
                      const specGroups = groupBySpec(results)
                      const eff = specGroups.some((g) => g.spec === stageFilter)
                        ? stageFilter
                        : null
                      const photoGroups = groupByPhoto(results).filter(
                        (g) =>
                          !eff ||
                          g.indices.some((k) => results[k].crop.spec === eff),
                      )
                      return (
                        <>
                          <div
                            className="filter-row"
                            role="group"
                            aria-label="فیلتر نسبت"
                          >
                            <button
                              className={
                                eff === null
                                  ? "filter-chip is-active"
                                  : "filter-chip"
                              }
                              onClick={() => setStageFilter(null)}
                            >
                              همه
                            </button>
                            {specGroups.map((g) => (
                              <button
                                key={g.spec}
                                className={
                                  eff === g.spec
                                    ? "filter-chip is-active"
                                    : "filter-chip"
                                }
                                onClick={() =>
                                  setStageFilter(eff === g.spec ? null : g.spec)
                                }
                              >
                                {g.label}
                              </button>
                            ))}
                          </div>
                          {results.length === 0 ? (
                            <p className="warn-box">
                              هیچ تصویر برش‌خورده‌ای باقی نمانده است
                            </p>
                          ) : null}
                          {eff ? (
                            <div className="list-stack">
                              {results.map((r, k) => {
                                if (r.crop.spec !== eff) return null
                                const custom = customs[k]
                                const dims = custom
                                  ? `${custom.width} × ${custom.height}`
                                  : `${r.crop.width} × ${r.crop.height}`
                                const shown = stage2Eye === k
                                const checked = sel.has(k)
                                return (
                                  <ListRow
                                    key={r.photo.url + r.crop.spec}
                                    active={checked}
                                    dim={sel.size > 0 && !checked}
                                    onClick={() => toggleSel(k)}
                                    title={checked ? "لغو انتخاب" : "انتخاب"}
                                    thumb={
                                      <img
                                        className="list-row__thumb"
                                        src={custom?.url ?? r.crop.url}
                                        alt={r.photo.name}
                                      />
                                    }
                                    badges={
                                      custom ? (
                                        <span className="list-row__badge">
                                          سفارشی
                                        </span>
                                      ) : undefined
                                    }
                                    actions={
                                      <>
                                        <button
                                          className="icon-button"
                                          title="مشاهده در صفحه نمایش"
                                          aria-label={`مشاهدهٔ ${r.photo.name} در صفحه نمایش`}
                                          aria-pressed={shown}
                                          onClick={() =>
                                            setStage2Eye(shown ? null : k)
                                          }
                                        >
                                          <Icon
                                            name={shown ? "eye" : "eye-off"}
                                            size={14}
                                          />
                                        </button>
                                        {custom ? (
                                          <button
                                            className="icon-button"
                                            title="حذف برش سفارشی"
                                            aria-label={`حذف برش سفارشی ${r.photo.name}`}
                                            onClick={() =>
                                              clearPhotoCustoms(r.photo.url, k)
                                            }
                                          >
                                            <Icon name="reset" size={14} />
                                          </button>
                                        ) : (
                                          <button
                                            className="icon-button"
                                            title="برش سفارشی"
                                            aria-label={`برش سفارشی ${r.photo.name}`}
                                            onClick={() => openCropFor(k)}
                                          >
                                            <Icon name="crop" size={14} />
                                          </button>
                                        )}
                                        <button
                                          className="icon-button icon-button--danger"
                                          title="حذف برش"
                                          aria-label={`حذف برش ${r.crop.label}`}
                                          onClick={() => removeCropsAt([k])}
                                        >
                                          <Icon name="trash" size={13} />
                                        </button>
                                      </>
                                    }
                                  >
                                    {r.photo.name} · {dims}
                                  </ListRow>
                                )
                              })}
                            </div>
                          ) : (
                            <>
                              {photoGroups.map((g) => (
                                <div key={g.url}>
                                  <div className="control-title control-title--sub">
                                    <span>{g.name}</span>
                                    <span className="panel__actions">
<b>{faDigits(String(g.indices.length))} تصویر برش‌خورده</b>
                                      <button
                                        className="icon-button icon-button--danger"
                                        title="حذف برش‌های این عکس"
                                        aria-label={`حذف برش‌های ${g.name}`}
                                        onClick={() => removePhotoCrops(g.url)}
                                      >
                                        <Icon name="trash" size={13} />
                                      </button>
                                    </span>
                                  </div>
                                  <div className="list-stack">
                                    {g.indices.map((k) => {
                                      const r = results[k]
                                      const custom = customs[k]
                                      const dims = custom
                                        ? `${custom.width} × ${custom.height}`
                                        : `${r.crop.width} × ${r.crop.height}`
                                      const shown = stage2Eye === k
                                      const checked = sel.has(k)
                                      return (
                                        <ListRow
                                          key={r.photo.url + r.crop.spec}
                                          active={checked}
                                          dim={sel.size > 0 && !checked}
                                          onClick={() => toggleSel(k)}
                                          title={
                                            checked ? "لغو انتخاب" : "انتخاب"
                                          }
                                          thumb={
                                            <img
                                              className="list-row__thumb"
                                              src={custom?.url ?? r.crop.url}
                                              alt={r.photo.name}
                                            />
                                          }
                                          badges={
                                            custom ? (
                                              <span className="list-row__badge">
                                                سفارشی
                                              </span>
                                            ) : undefined
                                          }
                                          actions={
                                            <>
                                              <button
                                                className="icon-button"
                                                title="مشاهده در صفحه نمایش"
                                                aria-label={`مشاهدهٔ برش ${r.crop.label} در صفحه نمایش`}
                                                aria-pressed={shown}
                                                onClick={() =>
                                                  setStage2Eye(shown ? null : k)
                                                }
                                              >
                                                <Icon
                                                  name={
                                                    shown ? "eye" : "eye-off"
                                                  }
                                                  size={14}
                                                />
                                              </button>
                                              {custom ? (
                                                <button
                                                  className="icon-button"
                                                  title="حذف برش سفارشی"
                                                  aria-label={`حذف برش سفارشی ${r.photo.name}`}
                                                  onClick={() =>
                                                    clearPhotoCustoms(
                                                      r.photo.url,
                                                      k,
                                                    )
                                                  }
                                                >
                                                  <Icon
                                                    name="reset"
                                                    size={14}
                                                  />
                                                </button>
                                              ) : (
                                                <button
                                                  className="icon-button"
                                                  title="برش سفارشی"
                                                  aria-label={`برش سفارشی ${r.photo.name}`}
                                                  onClick={() => openCropFor(k)}
                                                >
                                                  <Icon name="crop" size={14} />
                                                </button>
                                              )}
                                              <button
                                                className="icon-button icon-button--danger"
                                                title="حذف برش"
                                                aria-label={`حذف برش ${r.crop.label}`}
                                                onClick={() =>
                                                  removeCropsAt([k])
                                                }
                                              >
                                                <Icon name="trash" size={13} />
                                              </button>
                                            </>
                                          }
                                        >
                                          {r.crop.label} · {dims}
                                        </ListRow>
                                      )
                                    })}
                                  </div>
                                </div>
                              ))}
                            </>
                          )}
                        </>
                      )
                    })()}
                  </div>
                </div>
                <div className="controls__footer">
                  <div className="cta-row">
                    <button
                      className="back-button"
                      onClick={() => goStage(1)}
                      title="بازگشت به مرحله ۱"
                      aria-label="بازگشت به مرحله ۱"
                    >
                      <Icon name="back" size={18} />
                    </button>
                    <Button onClick={finalize} disabled={results.length === 0}>
                      نهایی‌کردن برش‌ها <ArrowIcon />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div
                  className={
                    dragging
                      ? "panel panel--grow is-dragging"
                      : "panel panel--grow"
                  }
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    onDropFile(Array.from(e.dataTransfer.files))
                  }}
                >
<div className="control-title panel__head">
                <span>لیست تصاویر</span>
                    <span className="panel__actions">
                      {photos.length > 0 && (
                      <b>{faDigits(String(photos.length))} تصویر</b>
                    )}
                      <button
                        className="icon-button"
                        onClick={() => inputRef.current?.click()}
                        title="افزودن تصویر"
                        aria-label="افزودن تصویر"
                      >
                        <Icon name="plus" size={14} />
                      </button>
                      {photos.length > 0 && (
                        <button
                          className="icon-button icon-button--danger"
                          onClick={deleteSelOrAllPhotos}
                          title={
                            picked.size > 0
                                ? `حذف ${faDigits(String(picked.size))} انتخاب‌شده`
                                : "حذف همه"
                            }
                            aria-label={
                              picked.size > 0
                                ? `حذف ${faDigits(String(picked.size))} تصویر انتخاب‌شده`
                                 : "حذف همهٔ عکس‌ها"
                          }
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="panel__body">
                    {photos.length === 0 ? (
                      <>
                          <label
                            className={dragging ? "upload is-dragging" : "upload"}
                          >
                            <input
                              ref={inputRef}
                              type="file"
                              accept="image/*,.heic,.heif,.hif"
                              multiple
                              onChange={onFile}
                            />
                          <FrameMark small />
                          <span>
                            <strong>تصویر‌ها را انتخاب کنید</strong>
                            <small>
                              JPG، PNG، WEBP یا HEIC · هر فایل تا{" "}
                              {faDigits(String(MAX_FILE_MB))} مگابایت · حداکثر{" "}
                              {MAX_PHOTOS} عکس
                            </small>
                          </span>
                        </label>
                        <p className="warn-box">
                          <Icon name="alert" size={11} />
                          هنوز تصویری اضافه نشده است — از بالا انتخاب کنید.
                        </p>
                      </>
                    ) : (
                      <>
                          <input
                            ref={inputRef}
                            type="file"
                            accept="image/*,.heic,.heif,.hif"
                            multiple
                            onChange={onFile}
                            style={{ display: "none" }}
                          />
                        <div className="list-stack panel__list">
                          {photos.map((p, i) => {
                            const on = picked.has(i)
                            return (
                              <ListRow
                                key={p.url}
                                active={on}
                                dim={!on}
                                title={
                                  on
                                    ? "عدم انتخاب"
                                    : "انتخاب (برای جابه‌جایی بکشید)"
                                }
                                onClick={() => togglePhoto(i)}
                                thumb={
                                  p.broken ? (
                                    <span
                                      className="list-row__thumb list-row__thumb--broken"
                                      title="پیش‌نمایش در مرورگر ممکن نیست"
                                    >
                                      <Icon name="image-off" size={20} />
                                    </span>
                                  ) : (
                                    <img
                                      className="list-row__thumb"
                                      src={p.url}
                                      alt={p.name}
                                    />
                                  )
                                }
                                actions={
                                  <>
                                    <button
                                      className="icon-button"
                                      onClick={() =>
                                        setMonitorUrl((prev) =>
                                          prev === p.url ? null : p.url,
                                        )
                                      }
                                      title="مشاهده در صفحه نمایش"
                                      aria-label={`مشاهدهٔ ${p.name} در صفحه نمایش`}
                                      aria-pressed={monitorUrl === p.url}
                                    >
                                      <Icon
                                        name={
                                          monitorUrl === p.url
                                            ? "eye"
                                            : "eye-off"
                                        }
                                        size={14}
                                      />
                                    </button>
                                    <button
                                      className="icon-button icon-button--danger"
                                      onClick={() => removePhoto(i)}
                                      title="حذف کامل عکس"
                                      aria-label={`حذف کامل عکس ${p.name}`}
                                    >
                                      <Icon name="trash" size={13} />
                                    </button>
                                  </>
                                }
                                extra={{
                                  draggable: !results,
                                  onDragStart: () => {
                                    dragPhotoFrom.current = i
                                  },
                                  onDragOver: (e) => e.preventDefault(),
                                  onDrop: () => {
                                    if (dragPhotoFrom.current !== null) {
                                      movePhoto(dragPhotoFrom.current, i)
                                      dragPhotoFrom.current = null
                                    }
                                  },
                                }}
                              >
                                {p.name} · {p.w}×{p.h}
                              </ListRow>
                            )
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <div className="panel">
                  <div className="control-title panel__head">
                    <span>ابعاد برش</span>
                    <span className="panel__actions">
                      {pickedRatios.length > 0 && (
                        <b>{faDigits(String(pickedRatios.length))} نسبت</b>
                      )}
                      <button
                        className="icon-button"
                        onClick={() => {
                          setCropError("")
                          setShowCustom((v) => !v)
                        }}
                        title="افزودن نسبت سفارشی"
                        aria-label="افزودن نسبت سفارشی"
                      >
                        <Icon name="plus" size={14} />
                      </button>
                      {pickedRatios.length > 0 && (
                        <button
                          className="icon-button icon-button--danger"
                          onClick={clearRatios}
                          title="حذف همه نسبت‌ها"
                          aria-label="حذف همه نسبت‌ها"
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="panel__body">
                    <div
                      className="view-toggle orientation-toggle"
                      role="group"
                      aria-label="جهت نسبت"
                    >
                      <button
                        className={
                          orientation === "landscape"
                            ? "is-active"
                            : "is-inactive"
                        }
                        onClick={() => setOrientation("landscape")}
                      >
                        افقی
                      </button>
                      <button
                        className={
                          orientation === "portrait"
                            ? "is-active"
                            : "is-inactive"
                        }
                        onClick={() => setOrientation("portrait")}
                      >
                        عمودی
                      </button>
                    </div>
                    <div className="ratio-grid">
                      {ratios.map((ratio, index) => {
                        const flipped =
                          orientation === "portrait" && ratio.spec !== "1:1"
                        const shape =
                          flipped && ratio.ratio
                            ? 1 / ratio.ratio
                            : (ratio.ratio ?? 1.4)
                        // Fit inside a 22x18 box with exact fractional dimensions so the ratio matches the label
                        const fitW = 22,
                          fitH = 18
                        const wide = shape >= fitW / fitH
                        const shapeW = wide ? fitW : fitH * shape
                        const shapeH = wide ? fitW / shape : fitH
                        const vSpec = flipped
                          ? flipSpec(ratio.spec)
                          : ratio.spec
                        const isOn = pickedRatios.some((x) => x.spec === vSpec)
                        return (
                          <button
                            key={ratio.value}
                            className={isOn ? "ratio is-selected" : "ratio"}
                            aria-pressed={isOn}
                            onClick={() => togglePreset(index)}
                          >
                            <span
                              className="ratio__shape"
                              style={{ width: shapeW, height: shapeH }}
                            />
                            <strong>
                              {flipped ? flipSpec(ratio.value) : ratio.value}
                            </strong>
                            <small>{ratio.label}</small>
                          </button>
                        )
                      })}
                    </div>
                    {showCustom &&
                      (() => {
                        const w = parseInt(cusW, 10)
                        const h = parseInt(cusH, 10)
                        const valid =
                          Number.isInteger(w) &&
                          Number.isInteger(h) &&
                          w >= 1 &&
                          h >= 1
                        return (
                          <div className="custom-ratio">
                            <span>عرض</span>
                            <input
                              value={cusW}
                              onChange={(e) => {
                                setCusW(e.target.value)
                              }}
                              inputMode="numeric"
                              aria-label="عرض نسبت سفارشی"
                              aria-invalid={!valid}
                            />
                            <span>ارتفاع</span>
                            <input
                              value={cusH}
                              onChange={(e) => {
                                setCusH(e.target.value)
                              }}
                              inputMode="numeric"
                              aria-label="ارتفاع نسبت سفارشی"
                              aria-invalid={!valid}
                            />
                            <button
                              className="icon-button"
                              title="افزودن نسبت سفارشی"
                              aria-label="افزودن نسبت سفارشی"
                              disabled={!valid}
                              onClick={confirmCustomRatio}
                            >
                              <Icon name="check" size={14} />
                            </button>
                            {!valid && (
                              <span className="warn-box" role="alert">
                                <Icon name="alert" size={11} />
                                عدد معتبر وارد کنید.
                              </span>
                            )}
                          </div>
                        )
                      })()}
                    {pickedRatios.length > 0 && (
                      <div className="picked-list">
                        {pickedRatios.map((r) => (
                          <span key={r.spec} className="picked-chip">
                            {r.label}
                            <button
                              className="icon-button"
                              aria-label={`حذف نسبت ${r.label}`}
                              onClick={() => removeRatio(r.spec)}
                            >
                              <Icon name="close" size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="controls__footer">
                  <Button
                    onClick={() => void applyCrop()}
                    disabled={
                      cropping || picked.size === 0 || pickedRatios.length === 0
                    }
                  >
                    {cropping
                      ? progress || "در حال برش…"
                      : `نهایی‌کردن برش (${faDigits(String(picked.size))} تصویر × ${faDigits(
                      String(pickedRatios.length)
                    )} نسبت)`}{" "}
                    <ArrowIcon />
                  </Button>
                  {cropError && (
                    <p className="warn-box" role="alert">
                      <Icon name="alert" size={11} />
                      {cropError}
                    </p>
                  )}
                  {!cropping &&
                    (picked.size === 0 || pickedRatios.length === 0) && (
                      <p className="warn-box">
                        <Icon name="alert" size={11} />
                        {picked.size === 0
                          ? "برای شروع، حداقل یک تصویر را انتخاب کنید."
                          : "حداقل یک نسبت را انتخاب کنید."}
                      </p>
                    )}
                </div>
              </>
            )}
          </aside>
        </div>

        {results && finalized && (
          <div
            id="finish-studio"
            className={stage === 3 ? "workspace" : "workspace hidden"}
          >
            <FinishStudio
              items={results}
              customs={customs}
              originKeys={originKeys}
              onToggleOrigin={toggleOrigin}
              onCustomRequest={openCropFor}
              onPaneChange={(p) => setFinPane(p)}
              onBack={() => goStage(2)}
              onRemoveCrops={removeCropsAt}
              onDeleteSel={deleteSelOrAllResults}
              sel={sel}
              onToggleSel={toggleSel}
            />
          </div>
        )}

        {modalTarget !== null &&
          results &&
          (() => {
            const { photo, crop } = results[modalTarget]
            const kk = photo.w / photo.h / (crop.width / crop.height)
            const h = rect.w * kk
            const iw = Math.max(1, Math.round(rect.w * photo.w))
            const ih = Math.max(1, Math.round(h * photo.h))
            const minW = Math.min(64 / photo.w, 0.9)
            const beginCrop = (
              e: PointerEvent<HTMLDivElement>,
              mode: "move" | "resize-tr" | "resize-tl" | "resize-br" | "resize-bl",
            ) => {
              e.stopPropagation()
              e.currentTarget.setPointerCapture(e.pointerId)
              cropDragRef.current = {
                sx: e.clientX,
                sy: e.clientY,
                r: { ...rect },
                cw: 0,
                ch: 0,
                mode,
              }
              const stage = (e.currentTarget.closest(
                ".custom-crop-frame",
              ) as HTMLElement | null)?.getBoundingClientRect()
              if (cropDragRef.current && stage) {
                cropDragRef.current.cw = stage.width
                cropDragRef.current.ch = stage.height
              }
            }
            const moveCrop = (e: PointerEvent<HTMLDivElement>) => {
              const d = cropDragRef.current
              if (!d || d.cw === 0) return
              const dx = (e.clientX - d.sx) / d.cw
              const dy = (e.clientY - d.sy) / d.ch
              if (d.mode === "move") {
                const hh = d.r.w * kk
                setRect({
                  x: Math.min(Math.max(d.r.x + dx, 0), 1 - d.r.w),
                  y: Math.min(Math.max(d.r.y + dy, 0), 1 - hh),
                  w: d.r.w,
                })
              } else {
                // Corner-anchored uniform resize (aspect locked: h = w * kk).
                // Each mark corner scales the box around the opposite corner.
                const corner = d.mode.replace("resize-", "")
                const dirX = corner[1] === "r" ? 1 : -1
                const dirY = corner[0] === "b" ? 1 : -1
                const anchorX = dirX > 0 ? d.r.x : d.r.x + d.r.w
                const anchorY = dirY > 0 ? d.r.y : d.r.y + d.r.w * kk
                const delta = (dx * dirX + dy * dirY) / 2
                const maxW = Math.min(
                  dirX > 0 ? 1 - anchorX : anchorX,
                  (dirY > 0 ? 1 - anchorY : anchorY) / kk,
                )
                const newW = Math.min(Math.max(d.r.w + delta, minW), maxW)
                setRect({
                  x: dirX > 0 ? anchorX : anchorX - newW,
                  y: dirY > 0 ? anchorY : anchorY - newW * kk,
                  w: newW,
                })
              }
            }
            const endCrop = () => {
              cropDragRef.current = null
            }
            return (
              <div
                className="modal-backdrop modal-backdrop--top"
                role="dialog"
                aria-modal="true"
                aria-label="برش سفارشی"
                onClick={() => {
                  if (!cropBusy) setModalTarget(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !cropBusy) setModalTarget(null)
                }}
              >
                <div
                  className="crop-modal"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="modal-header">
                    <div>
                      <strong>تنظیم برش سفارشی · {photo.name}</strong>
                      <span>
                        ابعاد زنده: {iw} × {ih}
                      </span>
                    </div>
                  </div>
                  <div className="custom-crop-stage">
                    <div className="custom-crop-frame">
                      <img
                        src={photo.url}
                        alt="تصویر اصلی برای برش سفارشی"
                        draggable={false}
                      />
                      <div
                        className="custom-crop-box"
                      style={{
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.w * 100}%`,
                        height: `${h * 100}%`,
                        aspectRatio: "auto",
                      }}
                      onPointerDown={(e) => beginCrop(e, "move")}
                      onPointerMove={moveCrop}
                      onPointerUp={endCrop}
                      onPointerCancel={endCrop}
                    >
                      <span>
                        {iw} × {ih}
                      </span>
                      <div
                        className="custom-crop-box__handle custom-crop-box__handle--tr"
                        onPointerDown={(e) => beginCrop(e, "resize-tr")}
                        onPointerMove={moveCrop}
                        onPointerUp={endCrop}
                        onPointerCancel={endCrop}
                      />
                      <div
                        className="custom-crop-box__handle custom-crop-box__handle--tl"
                        onPointerDown={(e) => beginCrop(e, "resize-tl")}
                        onPointerMove={moveCrop}
                        onPointerUp={endCrop}
                        onPointerCancel={endCrop}
                      />
                      <div
                        className="custom-crop-box__handle custom-crop-box__handle--br"
                        onPointerDown={(e) => beginCrop(e, "resize-br")}
                        onPointerMove={moveCrop}
                        onPointerUp={endCrop}
                        onPointerCancel={endCrop}
                      />
                      <div
                        className="custom-crop-box__handle custom-crop-box__handle--bl"
                        onPointerDown={(e) => beginCrop(e, "resize-bl")}
                        onPointerMove={moveCrop}
                        onPointerUp={endCrop}
                        onPointerCancel={endCrop}
                      />
                    </div>
                  </div>
                  </div>
                  <div className="crop-modal__actions">
                    <Button
                      size="sm"
                      onClick={() => void confirmCrop()}
                      disabled={cropBusy}
                    >
                      {cropBusy ? "در حال برش…" : "تأیید برش"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => clearCustom()}
                    >
                      بازگشت به خودکار
                    </Button>
                    <button
                      className="icon-button"
                      autoFocus
                      title="انصراف"
                      aria-label="انصراف"
                      onClick={() => {
                        if (!cropBusy) setModalTarget(null)
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
      </section>

      {cropping && (
        <div className="processing-overlay" role="status" aria-live="polite">
          <div className="processing-card">
            <span className="spinner" />
            <p className="processing-card__title">در حال برش هوشمند…</p>
            <p className="processing-card__text">
              چهره، نیم‌تنه و جهت نگاه تحلیل می‌شود تا سوژه در هر نسبت درست بماند.
            </p>
            <div className="processing-card__track">
              <div
                className="processing-card__fill"
                style={{
                  width: `${
                    cropStep.total ? (cropStep.done / cropStep.total) * 100 : 0
                  }%`,
                }}
              />
            </div>
            <p className="processing-card__pct">
              {cropStep.total
                ? `${faDigits(
                    String(Math.round((cropStep.done / cropStep.total) * 100))
                  )}٪ · ${faDigits(String(cropStep.done))} از ${faDigits(
                    String(cropStep.total)
                  )} تصویر`
                : "آماده‌سازی…"}
            </p>
            {cropStep.name && (
              <p className="processing-card__file">{cropStep.name}</p>
            )}
            <button className="reset-link" onClick={cancelCrop}>
              انصراف
            </button>
          </div>
        </div>
      )}

      <section className="principles">
        <div className="principle-intro">
          <span className="section-number">چرا چارچوب؟</span>
          <Heading>هوشمندی، بدون دخالت در نگاه شما.</Heading>
        </div>
        {[
          [
            "اولویت با چهره",
            "چهره، نیم‌تنه، جهت نگاه و زاویه بدن پیش از هر برش تحلیل می‌شوند.",
          ],
          [
            "خروجی برای هر رسانه",
            "از کارت خبر تا کاور و استوری؛ سوژه در تمام نسبت‌ها درست می‌ماند.",
          ],
          [
            "آماده انتشار",
            "قاب و لوگو را پیش از دانلود نهایی اضافه کنید.",
          ],
        ].map((item, i) => (
          <article className="principle" key={item[0]}>
            <span>{`۰${faDigits(String(i + 1))}`}</span>
            <FrameMark small />
            <Heading level={3}>{item[0]}</Heading>
            <p>{item[1]}</p>
          </article>
        ))}
      </section>
    </main>
  )
}

function About({ onStart }: { onStart: () => void }) {
  return (
    <main className="about">
      <div className="about__intro">
        <span className="section-number">درباره چارچوب / ۱۴۰۵</span>
        <Heading level={1}>
          تصویر با چارچوب
          <br />
          قابل انتشار خواهد شد.
        </Heading>
        <p>
          چارچوب یک ابزار فارسی برای آماده‌سازی تصاویر خبری است؛ سامانه‌ای که با
          اولویت تشخیص چهره، بدن و زاویه سوژه، هر تصویر را برای رسانه‌های مختلف
          آماده می‌کند.
        </p>
        <div className="hero__actions">
          <Button onClick={onStart}>
            شروع برش تصویر <ArrowIcon down />
          </Button>
        </div>
      </div>
      <div className="about__story">
        <FrameMark small />
        <span className="section-number">داستان پروژه</span>
        <Heading level={3}>
          پروژه‌ای دانشگاهی در حوزه هوش مصنوعی و پردازش تصویر
        </Heading>
        <p>
          «چارچوب» به‌عنوان یک پروژه دانشگاهی در حوزه هوش مصنوعی و پردازش تصویر
          توسعه داده شده است. ایده اصلی، ساده‌تر و هوشمندتر کردن فرایند
          آماده‌سازی تصاویر خبری و کاهش نیاز به برش دستی آن‌ها بود. برای تحقق
          این هدف، سامانه‌ای طراحی شد که با استفاده از مدل‌های هوش مصنوعی و یک
          الگوریتم اختصاصی، تصاویر را تحلیل کرده و کادر مناسب را بر اساس نسبت
          ابعادی انتخاب‌شده توسط کاربر تعیین می‌کند.
        </p>
        <p>
          چارچوب فراتر از برش خودکار، امکاناتی مانند تولید خروجی در ابعاد
          مختلف، بازبینی و تنظیم برش، افزودن و تنظیم لوگو و واترمارک و استفاده
          از قاب و قالب تصویری را در اختیار کاربر قرار می‌دهد. هدف ما این است
          که مراحل آماده‌سازی تصاویر برای انتشار، در محیطی یکپارچه، ساده‌تر و
          سریع‌تر انجام شوند؛ با حفظ حداکثری سوژه‌های مهم و ترکیب‌بندی تصویر
          اصلی.
        </p>
        <div className="about__features">
          <span>خروجی در ابعاد مختلف</span>
          <span>بازبینی و تنظیم برش</span>
          <span>لوگو و واترمارک</span>
          <span>قاب و قالب تصویری</span>
        </div>
      </div>
      <div className="about__manifesto about__manifesto--wide">
        <FrameMark />
        <blockquote>
          «ما معتقدیم برش خوب، صرفاً حذف‌کردن بخشی از تصویر نیست؛
          <br /> بلکه پیدا کردن <span className="marked-word"><i /><i /><i /><i />چارچوب</span> درست برای روایت تصویر است.»
        </blockquote>
        <div className="about__details">
          <span>طراحی‌شده برای تحریریه‌ها، دبیران عکس و خبرنگاران</span>
        </div>
      </div>
    </main>
  )
}

export default function App() {
  const [page, setPage] = useState<"home" | "about">("home")
  return (
    <div className="app" dir="rtl">
      <Header page={page} setPage={setPage} />
      {page === "home" ? (
        <Home />
      ) : (
        <About
          onStart={() => {
            setPage("home")
            window.setTimeout(
              () =>
                document
                  .querySelector("#studio")
                  ?.scrollIntoView({ behavior: "smooth" }),
              120,
            )
          }}
        />
      )}
      <footer className="footer">
        <div className="brand brand--footer">
          <FrameMark small />
          <span className="brand__name">چارچوب</span>
        </div>
        <p>ابزار هوشمند برش و آماده‌سازی تصاویر خبری</p>
        <span>© ۱۴۰۵ — همه حقوق محفوظ است.</span>
      </footer>
    </div>
  )
}
