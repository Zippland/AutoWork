import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";

export function Button({ variant = "default", size = "default", className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "ghost" | "brandSubtle"; size?: "default" | "sm" | "xs" | "icon-sm" }) {
  return <button type={type} className={`button button-${variant} ${size === "default" ? "" : `button-${size}`} ${className}`} {...props} />;
}

export function Modal({ open, onClose, title, children, className = "" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = element.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={element} className={`modal ${className}`} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== element.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2><Button variant="ghost" size="icon-sm" aria-label="关闭窗口" onClick={onClose}><X size={18} /></Button></header>
    {children}
  </dialog>;
}

export function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}
