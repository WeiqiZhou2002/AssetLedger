export function BrandLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="64" height="64" rx="14" fill="#213e35" />
      <path
        d="M13 22Q23 17 32 24Q41 17 51 22V44Q41 40 32 48Q23 40 13 44ZM32 24V48"
        fill="none"
        stroke="#f6f5f1"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M39 36L46 29M40 29H46V35"
        fill="none"
        stroke="#b8cc9d"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
