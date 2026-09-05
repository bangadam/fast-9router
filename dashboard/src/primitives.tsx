import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const ICON_PATHS: Record<string, string> = {
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  arrow_back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  arrow_forward: "m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z",
  block: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 13.1-6.15L5.85 17.1A7.96 7.96 0 0 1 4 12zm8 8a7.96 7.96 0 0 1-4.9-1.85L18.15 7.1A8 8 0 0 1 12 20z",
  bolt: "M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.4 0 .62.19.5.5L11 21z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 20h14v-2H5v2z",
  fullscreen: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  remove: "M19 13H5v-2h14v2z",
  save: "M17 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z",
  keyboard_arrow_down: "m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
  keyboard_arrow_up: "m7.41 15.41 4.59-4.58 4.59 4.58L18 14l-6-6-6 6 1.41 1.41z",
  open_in_new: "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
  playlist_add: "M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm16-4v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z",
  restart_alt: "M12 5V2l-4 4 4 4V7a5 5 0 1 1-4.9 6H5.08A7 7 0 1 0 12 5z",
  smart_toy: "M20 9V7h-2V5h-5V2h-2v3H6v2H4v2H2v11h20V9h-2zm0 9H4V9h16v9zM8 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  stop: "M6 6h12v12H6z",
  alternate_email: "M12 4a8 8 0 1 0 5.66 13.66l-1.42-1.42A6 6 0 1 1 18 12v1.5a1.5 1.5 0 0 1-3 0V12a3 3 0 1 0-1.17 2.38A3.5 3.5 0 0 0 20 12a8 8 0 0 0-8-8zm0 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  api: "M7 7H5a2 2 0 0 0-2 2v2H1v2h2v2a2 2 0 0 0 2 2h2v-2H5V9h2V7zm6 4h-2V9H9v6h2v-2h2v2h2V9h-2v2zm8 0V9a2 2 0 0 0-2-2h-2v2h2v6h-2v2h2a2 2 0 0 0 2-2v-2h2v-2h-2z",
  bar_chart: "M5 9h3v10H5V9zm5-4h3v14h-3V5zm5 7h3v7h-3v-7z",
  brightness_auto: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm3.6 15-1.08-3H9.48L8.4 17H6.3l4.75-12h1.9L17.7 17h-2.1zM10.2 12h3.6L12 7l-1.8 5z",
  calendar_today: "M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z",
  check_circle: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  close: "M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.41 4.29 19.71 2.88 18.3 9.17 12 2.88 5.7 4.29 4.29 10.59 10.59 16.89 4.29z",
  computer: "M20 18c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 4h16v12H4V4z",
  content_copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z",
  dark_mode: "M9.37 5.51A7 7 0 0 0 18.49 14.63 7 7 0 1 1 9.37 5.51z",
  delete: "M6 19c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V7H6v12zm3.46-7.12 1.41-1.41L12 11.59l1.12-1.12 1.41 1.41L13.41 13l1.12 1.12-1.41 1.41L12 14.41l-1.12 1.12-1.41-1.41L10.59 13l-1.13-1.12zM15.5 4l-1-1h-5l-1 1H5v2h14V4z",
  dns: "M20 13H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2zM7 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM20 3H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM7 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  error: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
  hub: "M17 16c-.74 0-1.42.25-1.97.66L9.82 13.4c.11-.45.11-1.35 0-1.8l5.15-3.22A3.5 3.5 0 1 0 14 6c0 .16.01.31.03.46L8.88 9.68A3.5 3.5 0 1 0 8.88 15l5.18 3.24A3.5 3.5 0 1 0 17 16z",
  inbox: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z",
  info: "M11 17h2v-6h-2v6zm1-15a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-11h2V7h-2v2z",
  input: "M19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 4-1.41 1.41L13.17 11H3v2h10.17l-2.58 2.59L12 17l5-5-5-5z",
  key: "M7 14a5 5 0 1 1 4.9-6H22v4h-2v2h-2v2h-4.1A5 5 0 0 1 7 14zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  lan: "M4 21v-6h3v-2h4v-2H8V3h8v8h-3v2h4v2h3v6h-8v-6H9v6H4zm6-12h4V5h-4v4zm8 8h-4v2h4v-2zM7 17H6v2h4v-2H7z",
  light_mode: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-6h1v4h-2V2h1zm0 16h1v4h-2v-4h1zM4.22 5.64l1.42-1.42 2.83 2.83-1.42 1.42-2.83-2.83zm11.31 11.31 1.42-1.42 2.83 2.83-1.42 1.42-2.83-2.83zM2 11h4v2H2v-2zm16 0h4v2h-4v-2zM4.22 18.36l2.83-2.83 1.42 1.42-2.83 2.83-1.42-1.42zM15.53 7.05l2.83-2.83 1.42 1.42-2.83 2.83-1.42-1.42z",
  lock: "M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z",
  lock_open: "M18 8H8.9V6a3.1 3.1 0 0 1 5.42-2.06l1.42-1.42A5.1 5.1 0 0 0 6.9 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  login: "M11 7 9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-8v2h8v14z",
  memory: "M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z",
  menu: "M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z",
  model_training: "M12 2 1 7l11 5 9-4.09V15h2V7L12 2zm0 12L5 10.82V16l7 4 7-4v-5.18L12 14z",
  network_check: "M15.9 5C10.82 5 6.56 8.42 5.2 13.08l1.93.56A9.15 9.15 0 0 1 15.9 7c1.78 0 3.44.51 4.84 1.4l1.08-1.68A10.9 10.9 0 0 0 15.9 5zM1 18h2a13 13 0 0 1 .5-3.54l-1.92-.55A15 15 0 0 0 1 18zm4 0h2c0-1.26.26-2.46.73-3.55l-1.93-.56A11 11 0 0 0 5 18zm4 0h2a5 5 0 0 1 8.54-3.54l1.41-1.41A7 7 0 0 0 9 18zm8.5-1.5 4.5-6-6 4.5a2.5 2.5 0 1 0 1.5 1.5z",
  output: "M19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 4-1.41 1.41L13.17 11H7v2h6.17l-2.58 2.59L12 17l5-5-5-5z",
  progress_activity: "M12 2a10 10 0 0 0-9.95 9H4.1A8 8 0 0 1 12 4V2zm7.9 9A8 8 0 0 1 12 20v2a10 10 0 0 0 9.95-11H19.9z",
  receipt_long: "M19 2 17.5 3.5 16 2l-1.5 1.5L13 2l-1.5 1.5L10 2 8.5 3.5 7 2 5.5 3.5 4 2v20l1.5-1.5L7 22l1.5-1.5L10 22l1.5-1.5L13 22l1.5-1.5L16 22l1.5-1.5L19 22V2zm-2 15H7v-2h10v2zm0-4H7v-2h10v2zm0-4H7V7h10v2z",
  search: "M9.5 3a6.5 6.5 0 1 0 3.98 11.64L19.85 21 21 19.85l-6.36-6.37A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z",
  shield_lock: "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm4 16h-8v-6h1V9a3 3 0 0 1 6 0v2h1v6zm-3-6V9a1 1 0 0 0-2 0v2h2z",
  sync: "M12 4V1l-4 4 4 4V6a6 6 0 0 1 5.65 4H19.7A8 8 0 0 0 12 4zm0 14a6 6 0 0 1-5.65-4H4.3a8 8 0 0 0 7.7 6v3l4-4-4-4v3z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
};

const FALLBACK_ICON = "M11 18h2v2h-2v-2zm1-16a7 7 0 0 0-7 7h2a5 5 0 1 1 6.2 4.85C11.87 14.2 11 15.43 11 17h2c0-.76.43-1.45 1.1-1.78A7 7 0 0 0 12 2z";

export function Icon({ children, class: className = "" }: { children: string; class?: string }) {
  return <svg class={`ui-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={ICON_PATHS[children] ?? FALLBACK_ICON} /></svg>;
}
type ProviderIconProps = {
  provider: "codex" | "anthropic" | "openai";
  alt: string;
  size: number;
  class?: string;
};

export function ProviderIcon({ provider, alt, size, class: className = "" }: ProviderIconProps) {
  const [errored, setErrored] = useState(false);
  const fallback = provider.slice(0, 2).toUpperCase();

  return (
    <span class={`provider-icon ${className}`} style={{ width: size, height: size }}>
      {errored ? <span class="provider-icon-fallback" role="img" aria-label={alt}>{fallback}</span> : <img src={`/providers/${provider}.png`} alt={alt} width={size} height={size} loading="lazy" decoding="async" onError={() => setErrored(true)} />}
    </span>
  );
}

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
  loading?: boolean;
  icon?: string;
};

export function Button({ variant = "primary", size = "md", loading = false, icon, children, class: className = "", disabled, ...props }: ButtonProps) {
  return (
    <button class={`button button-${variant} button-${size} ${className}`} disabled={disabled || loading} {...props}>
      {loading ? <Icon class="spin">progress_activity</Icon> : icon ? <Icon>{icon}</Icon> : null}
      {children}
    </button>
  );
}

export function Card({ children, class: className = "", ...props }: JSX.HTMLAttributes<HTMLDivElement>) {
  return <div class={`card ${className}`} {...props}>{children}</div>;
}

type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; icon?: string };
export function Input({ label, hint, icon, class: className = "", id, name, ...props }: InputProps) {
  const inputId = id || `field-${String(name || label || "input").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label class={`field ${className}`} for={inputId}>
      {label && <span class="field-label">{label}</span>}
      <span class="input-shell">
        {icon && <Icon>{icon}</Icon>}
        <input id={inputId} name={name} class={icon ? "has-icon" : ""} {...props} />
      </span>
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} class={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

type BadgeVariant = "default" | "primary" | "success" | "warning" | "error" | "info";
export function Badge({ children, variant = "default", dot = false }: { children: ComponentChildren; variant?: BadgeVariant; dot?: boolean }) {
  return <span class={`badge badge-${variant}`}>{dot && <span class="badge-dot" />}{children}</span>;
}

export function Modal({ isOpen, onClose, title, children, footer, size = "md", closeOnOverlay = true }: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
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
    <div class="modal-layer" onMouseDown={(event) => {
      if (closeOnOverlay && event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} class={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div class="modal-head">
          <div class="modal-traffic" aria-hidden="true"><span class="traffic-red" /><span class="traffic-yellow" /><span class="traffic-green" /></div>
          <h2 id={titleId}>{title}</h2>
          <button type="button" class="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><Icon>close</Icon></button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmText = "Delete", loading = false, variant = "danger" }: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: ComponentChildren;
  confirmText?: string;
  loading?: boolean;
  variant?: "danger" | "primary";
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm" closeOnOverlay={!loading} footer={<><Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button><Button variant={variant} loading={loading} onClick={onConfirm}>{confirmText}</Button></>}>
      <p class="confirm-message">{message}</p>
    </Modal>
  );
}

export interface ToastItem { id: number; kind: "success" | "error" | "info"; message: string }
export function ToastStack({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((toast) => (
        <div key={toast.id} class={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <Icon>{toast.kind === "success" ? "check_circle" : toast.kind === "error" ? "error" : "info"}</Icon>
          <span>{toast.message}</span>
          <button type="button" class="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><Icon>close</Icon></button>
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <Card class="skeleton-card" aria-label="Loading"><span class="skeleton skeleton-title" />{Array.from({ length: rows }, (_, index) => <span key={index} class="skeleton" />)}</Card>;
}

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ComponentChildren }) {
  return <div class="section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
