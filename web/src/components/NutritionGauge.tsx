import type { NutritionReference } from '../api/types';
import { cn } from './ui/base';

const TONE_STYLE = {
  low: { bar: 'bg-cool', text: 'text-cool', label: '偏低' },
  ok: { bar: 'bg-fresh', text: 'text-fresh', label: '达标' },
  high: { bar: 'bg-alert', text: 'text-alert', label: '偏高' },
} as const;

/** 环形进度：外圈为实际值占推荐区间上限的比例 */
export function NutritionRing({
  value,
  max,
  label,
  unit,
  caption,
}: {
  value: number;
  max: number;
  label: string;
  unit: string;
  caption?: string;
}) {
  const percent = max > 0 ? Math.min(1.25, value / max) : 0;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * Math.min(percent, 1);

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[124px] w-[124px]">
        <svg viewBox="0 0 124 124" className="h-full w-full -rotate-90">
          <circle cx="62" cy="62" r={radius} fill="none" stroke="#F5EDE6" strokeWidth="11" />
          <defs>
            <linearGradient id="ringGradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#FFB347" />
              <stop offset="100%" stopColor="#FF6B35" />
            </linearGradient>
          </defs>
          <circle
            cx="62"
            cy="62"
            r={radius}
            fill="none"
            stroke="url(#ringGradient)"
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[24px] font-semibold leading-none tabular-nums">{Math.round(value)}</span>
          <span className="mt-1 text-[11px] text-ink-400">{unit}</span>
        </div>
      </div>
      <p className="mt-2 text-[13px] font-medium">{label}</p>
      {caption ? <p className="text-[11px] text-ink-400">{caption}</p> : null}
    </div>
  );
}

/** 营养素对照条：把「推荐区间」画出来，一眼看出在不在区间内 */
export function ReferenceBar({ reference }: { reference: NutritionReference }) {
  const tone = TONE_STYLE[reference.status];
  const scaleMax = Math.max(reference.max * 1.5, reference.value, 1);
  const valuePercent = Math.min(100, (reference.value / scaleMax) * 100);
  const bandStart = (reference.min / scaleMax) * 100;
  const bandWidth = ((reference.max - reference.min) / scaleMax) * 100;

  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="font-medium">{reference.label}</span>
        <span className="tabular-nums text-ink-400">
          <span className={cn('font-semibold', tone.text)}>{reference.value}</span>
          {reference.unit} / 推荐 {reference.min}~{reference.max}
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-cream-200">
        <div
          className="absolute inset-y-0 rounded-full bg-fresh/25"
          style={{ left: `${bandStart}%`, width: `${Math.max(bandWidth, 2)}%` }}
        />
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full transition-all duration-700', tone.bar)}
          style={{ width: `${valuePercent}%`, opacity: 0.85 }}
        />
      </div>
    </div>
  );
}
