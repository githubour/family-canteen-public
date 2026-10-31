import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: (string | false | null | undefined)[]): string {
  return twMerge(inputs.filter(Boolean).join(' '));
}

type ButtonVariant = 'primary' | 'soft' | 'ghost' | 'outline' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'warm-gradient text-white shadow-float hover:brightness-[1.04] active:brightness-95',
  soft: 'bg-brand-50 text-brand-600 hover:bg-brand-100',
  ghost: 'bg-transparent text-ink-600 hover:bg-cream-200',
  outline: 'border border-cream-400 bg-white text-ink-900 hover:border-brand-300 hover:text-brand-600',
  danger: 'bg-alert/10 text-alert hover:bg-alert/20',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-full',
  md: 'h-10 px-4 text-[15px] rounded-full',
  lg: 'h-12 px-6 text-base rounded-full',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  block,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'press inline-flex items-center justify-center gap-1.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'press inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-ink-600 shadow-card',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'fresh' | 'warn' | 'alert' | 'cool';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-cream-200 text-ink-600',
    brand: 'bg-brand-50 text-brand-600',
    fresh: 'bg-fresh/10 text-fresh',
    warn: 'bg-warn/15 text-[#B45309]',
    alert: 'bg-alert/10 text-alert',
    cool: 'bg-cool/10 text-cool',
  } as const;
  return <span className={cn('chip', tones[tone], className)}>{children}</span>;
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

type ChoiceChipSize = 'sm' | 'md';

const CHIP_SIZES: Record<ChoiceChipSize, string> = {
  sm: 'px-2.5 py-1 text-[11px]',
  md: 'px-3 py-1.5 text-[12px]',
};

/**
 * 圆形药丸选择按钮（单选 / 多选通用）：选中暖色渐变、未选中米色。
 * 尺寸之外的布局（flex-1、h-*、scroll 收起）由调用方用 className 补。
 */
export function ChoiceChip({
  active,
  size = 'md',
  activeClassName = 'warm-gradient text-white',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active: boolean;
  size?: ChoiceChipSize;
  /** 选中态皮肤：默认品牌暖渐变；备料的「调整」用实心蓝、餐别标签各用自己配色 */
  activeClassName?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        'press rounded-full font-medium transition disabled:opacity-50',
        CHIP_SIZES[size],
        active ? activeClassName : 'bg-cream-200 text-ink-600',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1 rounded-full bg-cream-200/80 p-1', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              'press flex flex-1 items-center justify-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-medium transition',
              active ? 'bg-white text-brand-600 shadow-card' : 'text-ink-600 hover:text-ink-900',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 20,
  size = 'md',
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  size?: 'sm' | 'md';
}) {
  const dim = size === 'sm' ? 'h-7 w-7 text-sm' : 'h-9 w-9 text-base';
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label="减少"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        className={cn(
          'press flex items-center justify-center rounded-full border border-cream-400 bg-white text-ink-600 disabled:opacity-40',
          dim,
        )}
      >
        −
      </button>
      <span className="min-w-[24px] text-center text-[15px] font-semibold tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="增加"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        className={cn('press flex items-center justify-center rounded-full warm-gradient text-white disabled:opacity-40', dim)}
      >
        ＋
      </button>
    </div>
  );
}
