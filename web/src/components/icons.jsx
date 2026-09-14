// One icon vocabulary: 24×24 viewBox, 2px strokes, mitred joins, no curves where a
// corner will do. Same rule as the rest of the house style.
const svg = (children, props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" {...props}>
    {children}
  </svg>
);

export const MapIcon = (p) => svg(<>
  <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
  <path d="M9 3v15M15 6v15" />
</>, p);

export const FeedIcon = (p) => svg(<>
  <rect x="3" y="4" width="18" height="16" />
  <path d="M3 10h18M9 10v10" />
</>, p);

export const CupIcon = (p) => svg(<>
  <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
  <path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" />
  <path d="M12 14v4M8 20h8" />
</>, p);

export const ChatIcon = (p) => svg(<>
  <path d="M3 4h18v13H8l-5 4z" />
  <path d="M7 9h10M7 12h6" />
</>, p);

export const CameraIcon = (p) => svg(<>
  <path d="M3 7h4l2-2h6l2 2h4v13H3z" />
  <rect x="9" y="10" width="6" height="6" />
</>, p);

// Scavenger Blitz: a checklist with a magnifier over it.
export const HuntIcon = (p) => svg(<>
  <path d="M3 5h2M3 11h2M3 17h2" />
  <path d="M8 5h12M8 11h4" />
  <circle cx="15" cy="15" r="3.5" />
  <path d="M17.5 17.5L21 21" />
</>, p);

export const FlagIcon = (p) => svg(<>
  <path d="M5 3v18" />
  <path d="M5 4h13l-3 4 3 4H5z" />
</>, p);

// Two cards passing each other: arrows out and back.
export const SwapIcon = (p) => svg(<>
  <path d="M4 8h13l-4-4M20 16H7l4 4" />
</>, p);

// A collectable card: a frame, a window for the photo, and a line of text under it.
export const CardIcon = (p) => svg(<>
  <rect x="4" y="3" width="16" height="18" />
  <rect x="7" y="6" width="10" height="8" />
  <path d="M7 17h7" />
</>, p);

// A car in profile, all corners: the body, the glasshouse line, two square wheels.
export const CarIcon = (p) => svg(<>
  <path d="M2 16v-4l3-5h14l3 5v4z" />
  <path d="M2 12h20" />
  <rect x="5" y="16" width="3" height="3" />
  <rect x="16" y="16" width="3" height="3" />
</>, p);

// Straight-edged, like everything else here: a nib, a shaft, and the line it leaves.
export const PencilIcon = (p) => svg(<>
  <path d="M4 20h4L20 8l-4-4L4 16z" />
  <path d="M14 6l4 4" />
</>, p);

// ── Items ─────────────────────────────────────────────────────────────────
// A bag: the inventory as a whole.
export const BagIcon = (p) => svg(<>
  <path d="M4 8h16l-1 13H5z" />
  <path d="M9 8V4h6v4" />
</>, p);

// A shield cut from straight lines, point down.
export const ShieldIcon = (p) => svg(<path d="M12 3l8 3v7l-8 8-8-8V6z" />, p);

// A lens in a diamond frame: looking before you go.
export const ReconIcon = (p) => svg(<>
  <path d="M2 12l5-6h10l5 6-5 6H7z" />
  <rect x="10" y="10" width="4" height="4" />
</>, p);

// A bar with a hooked end.
export const CrowbarIcon = (p) => svg(<>
  <path d="M19 5L5 19" />
  <path d="M15 5h4v4" />
</>, p);

export const SprintIcon = (p) => svg(<path d="M13 2L5 13h6l-1 9 9-12h-6z" />, p);

// An open-ended spanner, all corners.
export const TuneUpIcon = (p) => svg(<>
  <path d="M15 3h4l2 2v4l-3 3-2-2-9 9-3-3 9-9-2-2z" />
</>, p);

// Four square leaves and a stem.
export const CloverIcon = (p) => svg(<>
  <rect x="5" y="4" width="6" height="6" />
  <rect x="13" y="4" width="6" height="6" />
  <rect x="5" y="12" width="6" height="6" />
  <rect x="13" y="12" width="6" height="6" />
  <path d="M12 18v4" />
</>, p);

export const ITEM_ICON = {
  fortify: ShieldIcon,
  recon: ReconIcon,
  crowbar: CrowbarIcon,
  sprint: SprintIcon,
  tuneup: TuneUpIcon,
  clover: CloverIcon,
};

// ── Location and sound ────────────────────────────────────────────────────
// Crosshairs on a square: where am I.
export const LocateIcon = (p) => svg(<>
  <rect x="7" y="7" width="10" height="10" />
  <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
</>, p);

// A pin, square-shouldered.
export const PinIcon = (p) => svg(<>
  <path d="M5 3h14v11l-7 7-7-7z" />
  <rect x="10" y="7" width="4" height="4" />
</>, p);

export const PlayIcon = (p) => svg(<path d="M7 4l12 8-12 8z" />, p);

export const CloseIcon = (p) => svg(<path d="M5 5l14 14M19 5L5 19" />, p);
export const BackIcon = (p) => svg(<path d="M15 4l-8 8 8 8" />, p);
export const LockIcon = (p) => svg(<>
  <rect x="4" y="10" width="16" height="10" />
  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
</>, p);

// ── The three subjects ────────────────────────────────────────────────────
export const LandmarkIcon = (p) => svg(<>
  <path d="M3 21h18" />
  <path d="M5 21V9l7-5 7 5v12" />
  <path d="M10 21v-6h4v6" />
</>, p);

export const PersonIcon = (p) => svg(<>
  <rect x="8" y="3" width="8" height="8" />
  <path d="M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3" />
</>, p);

export const AnimalIcon = (p) => svg(<>
  <path d="M4 8V4l3 3M20 8V4l-3 3" />
  <path d="M4 8v6a8 8 0 0 0 16 0V8z" />
  <path d="M9 12h.01M15 12h.01" />
  <path d="M10 17h4" />
</>, p);

export const SUBJECT_ICON = {
  landmark: LandmarkIcon,
  person: PersonIcon,
  animal: AnimalIcon,
};
