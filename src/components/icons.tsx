import {
  ArrowRight,
  Check,
  Crop,
  Download,
  Eye,
  EyeOff,
  ImageOff,
  Image,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"

export type IconName =
  | "download"
  | "crop"
  | "trash"
  | "reset"
  | "close"
  | "alert"
  | "back"
  | "plus"
  | "check"
  | "eye"
  | "eye-off"
  | "image-off"
  | "image"

const map: Record<IconName, LucideIcon> = {
  download: Download,
  crop: Crop,
  trash: Trash2,
  reset: RotateCcw,
  close: X,
  alert: TriangleAlert,
  back: ArrowRight,
  plus: Plus,
  check: Check,
  eye: Eye,
  "eye-off": EyeOff,
  "image-off": ImageOff,
  image: Image,
}

/** Kit icon set (lucide) — inherits text color. Decorative; label the button, not the icon. */
export default function Icon({
  name,
  size = 15,
}: {
  name: IconName
  size?: number
}) {
  const C = map[name]
  return (
    <C size={size} strokeWidth={1.5} aria-hidden="true" focusable="false" />
  )
}
