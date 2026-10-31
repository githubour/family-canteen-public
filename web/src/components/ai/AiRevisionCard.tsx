import { useState } from 'react';
import { AlertTriangle, ChevronDown, Check, X } from 'lucide-react';
import type { AiDishRevisionDraft } from '../../api/types';
import { Button, cn } from '../ui/base';

/** 超过这个长度的前后值默认折起来（做法整段改起来就是几十行，铺开没法看） */
const LONG_TEXT = 60;

/**
 * 改菜草稿卡片：一条改动一行，**逐条勾选**，显示「现在 → 建议」与依据的反馈。
 *
 * 这里刻意不做「一键全改」的默认自动确认：改的是别人家的菜谱，
 * 用量一动采购量与营养报告就跟着变。所以每条都要能单独取消，
 * 而且要能看见它的依据是哪句反馈——依据站不住时人才好把它划掉。
 */
export function AiRevisionCard({
  revision,
  notes,
  model,
  onDiscard,
  onConfirm,
  onRemoveFeedback,
  confirming,
}: {
  revision: AiDishRevisionDraft;
  notes: string[];
  model: string;
  onDiscard: () => void;
  onConfirm: (selectedIds: string[]) => void;
  /** 移除一条「看不出要改什么」的反馈：看过了、不打算改的给它一个出口，别永远卡在池里 */
  onRemoveFeedback: (feedbackId: number) => void;
  confirming: boolean;
}) {
  // 默认全选：草稿是给人「划掉不想要的」用的，默认空选会让人以为没提出改动
  const [selected, setSelected] = useState<string[]>(() => revision.changes.map((change) => change.id));
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));

  const dish = revision.dish;
  const selectedChanges = revision.changes.filter((change) => selected.includes(change.id));

  return (
    <section className="space-y-3">
      <div className="rounded-xl2 border border-cream-300 bg-white p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-[15px] font-semibold">
            {dish.emoji} {dish.name}
          </p>
          <p className="shrink-0 text-[11px] text-ink-400">由 {model} 起草</p>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-400">
          依据 {revision.changes.length + revision.unhandled.length} 条反馈提了 {revision.changes.length} 条改动；
          不想要的取消勾选即可，没勾的不会落库、对应的反馈也留在池里。
        </p>
      </div>

      {notes.length > 0 ? (
        <ul className="rounded-xl2 bg-warn/12 px-3 py-2.5">
          {notes.map((note) => (
            <li key={note} className="text-[11px] leading-5 text-[#B45309]">
              · {note}
            </li>
          ))}
        </ul>
      ) : null}

      {revision.effects.length > 0 ? (
        <div className="rounded-xl2 border border-cream-300 bg-cream-100 p-3">
          <p className="text-[12px] font-semibold text-ink-600">这次改动会连带影响</p>
          <ul className="mt-1 space-y-0.5">
            {revision.effects.map((effect) => (
              <li key={effect} className="text-[11px] leading-5 text-ink-400">
                · {effect}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {revision.changes.length === 0 ? (
        <p className="rounded-xl2 border border-dashed border-cream-400 bg-white/60 px-3 py-3 text-center text-[12px] text-ink-400">
          这次没有能落地的改动——反馈都还在池里，看过了不打算改的可以移除，或换个说法再提一次需求
        </p>
      ) : (
        <div className="space-y-2">
          {revision.changes.map((change) => {
            const on = selected.includes(change.id);
            const long = change.before.length > LONG_TEXT || change.after.length > LONG_TEXT;
            const open = expanded === change.id;
            return (
              <div
                key={change.id}
                className={cn(
                  'rounded-xl2 border p-2.5 transition',
                  on ? 'border-brand-300 bg-brand-50/40' : 'border-cream-300 bg-white',
                )}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    aria-label={on ? `取消「${change.label}」` : `采纳「${change.label}」`}
                    onClick={() => toggle(change.id)}
                    className={cn(
                      'press mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition',
                      on ? 'warm-gradient border-transparent text-white' : 'border-cream-400 bg-white',
                    )}
                  >
                    {on ? <Check size={10} strokeWidth={3} /> : null}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{change.label}</p>
                    <p className={cn('mt-0.5 text-[12px] leading-5 text-ink-600', !open && 'line-clamp-2')}>
                      <span className="text-ink-400 line-through decoration-ink-200">{change.before}</span>
                      <span className="mx-1 text-ink-400">→</span>
                      <span className="font-medium text-brand-700">{change.after}</span>
                    </p>
                    {long ? (
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : change.id)}
                        className="press mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-ink-400"
                      >
                        <ChevronDown size={12} className={cn('transition', open && 'rotate-180')} />
                        {open ? '收起' : '展开全文'}
                      </button>
                    ) : null}

                    <p className="mt-1 text-[11px] leading-4 text-ink-400">
                      {change.conflict ? (
                        <span className="mr-1 inline-flex items-center gap-0.5 font-medium text-[#B45309]">
                          <AlertTriangle size={11} />
                          依据互相矛盾
                        </span>
                      ) : (
                        '依据：'
                      )}
                      {change.sources.map((source) => `「${source.content}」`).join('、')}
                    </p>
                    {change.note !== '' ? (
                      <p className="mt-0.5 text-[11px] leading-4 text-[#B45309]">{change.note}</p>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {revision.unhandled.length > 0 ? (
        <div className="rounded-xl2 bg-cream-200/70 px-3 py-2.5">
          <p className="text-[12px] font-semibold text-ink-600">
            这 {revision.unhandled.length} 条看不出要改什么
          </p>
          <ul className="mt-1 space-y-0.5">
            {revision.unhandled.map((item) => (
              <li key={item.feedback_id} className="flex items-start gap-1 text-[11px] leading-5 text-ink-400">
                <span className="min-w-0 flex-1">
                  「{item.content}」—— {item.reason}
                </span>
                <button
                  type="button"
                  aria-label={`移除反馈：${item.content}`}
                  onClick={() => onRemoveFeedback(item.feedback_id)}
                  className="press flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-200 hover:text-alert"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] leading-4 text-ink-400">
            确认改菜后它们会留在池里；看过了不打算改的，点右边的 ✕ 移除。
          </p>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button variant="outline" block disabled={confirming} onClick={onDiscard}>
          取消
        </Button>
        <Button
          block
          disabled={confirming || selectedChanges.length === 0}
          onClick={() => onConfirm(selected)}
        >
          {confirming ? '改菜中…' : `确认改 ${selectedChanges.length} 条`}
        </Button>
      </div>
    </section>
  );
}
