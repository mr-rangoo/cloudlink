import { cn } from "@/lib/utils";

/** Original Cloudlink mark: two linked arcs forming a cloud-like loop. */
export function CloudlinkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <defs>
        <linearGradient id="cl-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b8bff" />
          <stop offset="1" stopColor="#22c3e6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#cl-grad)" />
      <path d="M10.5 20.5a4.5 4.5 0 0 1 0-9 5.5 5.5 0 0 1 10.3-1.6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M21.5 11.5a4.5 4.5 0 0 1 0 9 5.5 5.5 0 0 1-10.3 1.6" fill="none" stroke="#fff" strokeOpacity=".85" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function CloudlinkWordmark({ className, collapsed }: { className?: string; collapsed?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <CloudlinkMark />
      {collapsed ? <span className="sr-only">Cloudlink</span> : <span className="text-[15px] font-semibold tracking-tight text-white">Cloudlink</span>}
    </span>
  );
}
