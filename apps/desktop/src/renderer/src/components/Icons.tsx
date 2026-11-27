type IconProps = { size?: number; className?: string };

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function FolderIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

export function FolderOpenIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 11.5V4.5A1.5 1.5 0 0 1 3.5 3h3L8 5h4.5A1.5 1.5 0 0 1 14 6.5V8" />
      <path d="M2.2 12.8 4 8h10l-1.8 4.8z" />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
      <path d="M6.8 7v4M9.2 7v4" />
    </svg>
  );
}

export function BranchIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="4.5" cy="4" r="1.5" />
      <circle cx="4.5" cy="12" r="1.5" />
      <circle cx="11.5" cy="6" r="1.5" />
      <path d="M4.5 5.5v5M6 4h2.5A3 3 0 0 1 11.5 4.5" />
    </svg>
  );
}

export function TerminalIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m4.8 6.5 2 1.8-2 1.8M8.5 10.2h2.7" />
    </svg>
  );
}

export function PlayIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}

export function StopIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  );
}

export function SendIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5z" />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

export function RefreshIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1" />
      <path d="M13.5 2.5V5H11" />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function ChevronIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

export function SourceControlIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="5" cy="3.5" r="1.5" />
      <circle cx="5" cy="12.5" r="1.5" />
      <path d="M5 5v6" />
      <path d="M8.5 12.5h2A1.5 1.5 0 0 0 12 11V4.2" />
      <circle cx="12" cy="2.9" r="1.3" />
    </svg>
  );
}

export function PanelLeftCloseIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
      <path d="m10.5 6-2 2 2 2" />
    </svg>
  );
}

export function PanelLeftOpenIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
      <path d="m8.5 6 2 2-2 2" />
    </svg>
  );
}

export function SlidersIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 4.5h12M2 8h12M2 11.5h12" />
      <circle cx="6" cy="4.5" r="1.3" />
      <circle cx="10" cy="8" r="1.3" />
      <circle cx="5" cy="11.5" r="1.3" />
    </svg>
  );
}

export function SearchIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="7" cy="7" r="4" />
      <path d="m10.2 10.2 3.3 3.3" />
    </svg>
  );
}

export function PinIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 2.5h4l-.7 3.2 2.2 2.2H4.5l2.2-2.2z" />
      <path d="M8 7.9V13" />
    </svg>
  );
}

export function ArchiveIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3.2 6v5.8A1.2 1.2 0 0 0 4.4 13h7.2a1.2 1.2 0 0 0 1.2-1.2V6" />
      <path d="M6.5 8.5h3" />
    </svg>
  );
}

export function RestoreIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1" />
      <path d="M2.5 2.5V5H5" />
    </svg>
  );
}

export function MoreHorizontalIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

export function AlertCircleIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5" />
      <path d="M8 11h.01" />
    </svg>
  );
}

export function FileTextIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
      <path d="M6 8.5h4M6 10.8h4" />
    </svg>
  );
}

export function CircleIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

export function ClockIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function EyeIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M1.8 8s2.3-3.8 6.2-3.8S14.2 8 14.2 8s-2.3 3.8-6.2 3.8S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  );
}

export function CheckCircleIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8.2 1.8 1.8 3.4-3.6" />
    </svg>
  );
}

export function GearIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1" />
    </svg>
  );
}
