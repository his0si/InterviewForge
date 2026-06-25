// 공용 SVG 아이콘. currentColor 를 사용해 테마 색을 따른다.
type IconProps = { size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export function MoonIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

export function SunIcon({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

export function MenuIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  )
}

export function CloseIcon({ size = 22 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export function LogoutIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  )
}

// === 대시보드(홈) 아이콘 ===

export function HomeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    </svg>
  )
}

export function TrendIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 17l6-6 4 4 7-7M14 8h7v7" />
    </svg>
  )
}

export function NewspaperIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 4h13v16H6a2 2 0 0 1-2-2V4zM17 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h5" />
    </svg>
  )
}

export function NoteIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h6" />
    </svg>
  )
}

export function SettingsIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function ChevronLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export function ArrowUpIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  )
}

export function ArrowDownIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 7l10 10M17 9v8H9" />
    </svg>
  )
}

export function ExternalLinkIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function HeartIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  )
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function RotateIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
    </svg>
  )
}

export function UserIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5.5 20a7 7 0 0 1 13 0" />
    </svg>
  )
}

export function SparkleIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3z" />
      <path d="M19 14l.7 1.8 1.8.7-1.8.7L19 19l-.7-1.8-1.8-.7 1.8-.7L19 14z" />
    </svg>
  )
}

export function BotIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 8V4M12 4h-2M8 13h.01M16 13h.01M9 16.5h6" />
    </svg>
  )
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}
