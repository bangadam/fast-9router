import * as React from "react";
import { useEffect, useRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  Activity, ArrowLeft, ArrowRight, AtSign, Ban, BarChart3, Bot, Braces, Cable, Check,
  ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleCheck, CircleHelp, Copy,
  Download, ExternalLink, Eye, EyeOff, Gauge, History, Inbox, Info, KeyRound, ListPlus,
  LoaderCircle, Lock, LockOpen, LogIn, LogOut, Maximize, Menu, Minus, Monitor, Moon,
  Network, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Server, Settings,
  ShieldCheck, Square, Sun, SunMoon, Terminal, Trash2, TriangleAlert, Upload, X, Zap,
  type LucideIcon,
} from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const ICONS: Record<string, LucideIcon> = {
  add: Plus,
  alternate_email: AtSign,
  api: Braces,
  arrow_back: ArrowLeft,
  arrow_forward: ArrowRight,
  bar_chart: BarChart3,
  block: Ban,
  bolt: Zap,
  brightness_auto: SunMoon,
  check: Check,
  check_circle: CircleCheck,
  chevron_right: ChevronRight,
  close: X,
  computer: Monitor,
  content_copy: Copy,
  dark_mode: Moon,
  data_usage: Gauge,
  delete: Trash2,
  dns: Server,
  download: Download,
  edit: Pencil,
  error: CircleAlert,
  fullscreen: Maximize,
  hub: Network,
  inbox: Inbox,
  info: Info,
  key: KeyRound,
  keyboard_arrow_down: ChevronDown,
  keyboard_arrow_up: ChevronUp,
  lan: Cable,
  light_mode: Sun,
  lock: Lock,
  lock_open: LockOpen,
  login: LogIn,
  logout: LogOut,
  menu: Menu,
  network_check: Activity,
  open_in_new: ExternalLink,
  playlist_add: ListPlus,
  progress_activity: LoaderCircle,
  refresh: RefreshCw,
  remove: Minus,
  restart_alt: RotateCcw,
  restore: History,
  save: Save,
  search: Search,
  settings: Settings,
  shield_lock: ShieldCheck,
  smart_toy: Bot,
  stop: Square,
  sync: RefreshCw,
  terminal: Terminal,
  upload: Upload,
  visibility: Eye,
  visibility_off: EyeOff,
  warning: TriangleAlert,
};

export function Icon({ children, className = "" }: { children: string; className?: string }) {
  const Cmp = ICONS[children] ?? CircleHelp;
  return <Cmp className={cn("ui-icon", className)} aria-hidden="true" />;
}

type ProviderIconProps = { provider: string; alt?: string; size?: number; className?: string };
export function ProviderIcon({ provider, alt, size = 42, className = "" }: ProviderIconProps) {
  const [failed, setFailed] = React.useState(false);
  const slug = provider.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (failed) return <span className={cn("provider-icon provider-icon-fallback", className)} style={{ width: size, height: size }}>{(alt || provider).slice(0, 2).toUpperCase()}</span>;
  return <span className={cn("provider-icon", className)} style={{ width: size, height: size }}><img src={`./providers/${slug}.png`} alt={alt ?? provider} loading="lazy" onError={() => setFailed(true)} /></span>;
}

const buttonVariants = cva("button", {
  variants: {
    variant: {
      primary: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
    size: {
      sm: "button-sm",
      md: "button-md",
      icon: "button-icon",
    },
  },
  defaultVariants: { variant: "primary", size: "md" },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
  icon?: string;
}

export function Button({ variant, size, loading = false, icon, children, className, disabled, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Icon className="spin">progress_activity</Icon> : icon ? <Icon>{icon}</Icon> : null}
      {children}
    </button>
  );
}

export function Card({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props}>{children}</div>;
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  icon?: string;
}

export function Input({ label, hint, icon, className, id, name, ...props }: InputProps) {
  const inputId = id || `field-${String(name || label || "input").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label className={cn("field", className)} htmlFor={inputId}>
      {label && <span className="field-label">{label}</span>}
      <span className="input-shell">
        {icon && <Icon>{icon}</Icon>}
        <input id={inputId} name={name} className={icon ? "has-icon" : ""} {...props} />
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} className={cn("toggle", checked && "is-on")} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

const badgeVariants = cva("badge", {
  variants: {
    variant: {
      default: "",
      primary: "badge-primary",
      success: "badge-success",
      warning: "badge-warning",
      error: "badge-error",
      info: "badge-info",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: React.ReactNode;
  dot?: boolean;
}

export function Badge({ children, variant, dot = false }: BadgeProps) {
  return <span className={badgeVariants({ variant })}>{dot && <span className="badge-dot" />}{children}</span>;
}

export function Modal({ isOpen, onClose, title, children, footer, size = "md", closeOnOverlay = true }: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  closeOnOverlay?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = `modal-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? []);
    queueMicrotask(() => focusable()[0]?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div className="modal-layer" onMouseDown={(event) => {
      if (closeOnOverlay && event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div className="modal-traffic" aria-hidden="true"><span className="traffic-red" /><span className="traffic-yellow" /><span className="traffic-green" /></div>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><Icon>close</Icon></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmText = "Delete", loading = false, variant = "danger" }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  loading?: boolean;
  variant?: "danger" | "primary";
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm" closeOnOverlay={!loading} footer={<><Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button><Button variant={variant} loading={loading} onClick={onConfirm}>{confirmText}</Button></>}>
      <p className="confirm-message">{message}</p>
    </Modal>
  );
}

export interface ToastItem { id: number; kind: "success" | "error" | "info"; message: string }
export function ToastStack({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <Icon>{toast.kind === "success" ? "check_circle" : toast.kind === "error" ? "error" : "info"}</Icon>
          <span>{toast.message}</span>
          <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><Icon>close</Icon></button>
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <Card className="skeleton-card" aria-label="Loading"><span className="skeleton skeleton-title" />{Array.from({ length: rows }, (_, index) => <span key={index} className="skeleton" />)}</Card>;
}

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return <div className="section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
