import { useEffect, useState } from 'react';
import { MessageSquare, Send, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { AiDishRevisionResult, Dish, DishFeedback } from '../api/types';
import { useAsync } from '../hooks/useAsync';
import { buildRevisionPlan } from '../lib/aiRevision';
import { relativeDateTime } from '../lib/format';
import { runAction } from '../lib/runAction';
import { cn } from './ui/base';
import { toast } from './ui/toast';
import { AiRevisionCard } from './ai/AiRevisionCard';

type Me = { id: number; name: string; avatar: string; color: string } | null;

/**
 * 每道菜下方的反馈栏：家人用自然语言记一条反馈（偏咸、土豆没炖烂、火候不对…）。
 *
 * 反馈提交成功后**当场**让 AI 看一眼，几秒后把「现在 → 建议」的改动清单补在下面，
 * 人在这道菜上就地勾选确认。没有「攒一批再去另一个页面处理」这一步，
 * 但也没有让 AI 直接写库：确认按钮仍然走既有的 PATCH / PUT，只删被覆盖到的反馈。
 *
 * 自身不发起 SSE 连接，刷新由使用方（点菜页详情弹层 / 订单卡）在事件里触发。
 */
export function DishFeedbackBar({
  dishId,
  feedbacks,
  me,
  onChanged,
  onDishChanged,
}: {
  dishId: number;
  feedbacks: DishFeedback[];
  me: Me;
  onChanged: () => void;
  /** 改菜落库后把最新的菜回传，让正开着这道菜的页面立刻显示新配方 */
  onDishChanged?: (dish: Dish) => void;
}) {
  const ai = useAsync(() => api.ai.status(), []);

  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [result, setResult] = useState<AiDishRevisionResult | null>(null);
  // 换一份草稿就重挂卡片，把里面的勾选与展开状态一起清干净
  const [resultVersion, setResultVersion] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // 换一道菜就丢掉上一道的建议：这份草稿只属于当前 dishId
  useEffect(() => {
    setResult(null);
    setResultVersion((version) => version + 1);
  }, [dishId]);

  /**
   * 请求一份改菜建议。可以失败——反馈已经存好了，AI 只是看不了这一次；
   * 人随时能再点一次「让 AI 看看」。
   */
  const requestDraft = async () => {
    // 新反馈进来了，上一份建议就不再成立：先收起来，别让人对着旧清单点确认
    setResult(null);
    setDrafting(true);
    try {
      await runAction(async () => {
        const next = await api.ai.revisionDraft(dishId);
        setResult(next);
        setResultVersion((version) => version + 1);
      }, 'AI 这次没看成，反馈已经存好了');
    } finally {
      setDrafting(false);
    }
  };

  const submit = async () => {
    const content = draft.trim();
    if (!content) {
      toast('先写点反馈内容', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await runAction(async () => {
        await api.dishFeedback.create(dishId, content, me?.id ?? null);
        setDraft('');
        // 本端立即刷新；其他端由 SSE 的 dish-feedback:updated 带动
        onChanged();
        // 提交成功就顺手让 AI 看——不 await：建议晚几秒补上，不能拖慢「记一条反馈」
        if (ai.data?.enabled) void requestDraft();
      }, '没提交成功，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: number) => {
    await runAction(async () => {
      await api.dishFeedback.remove(dishId, id);
      onChanged();
    }, '没删掉，请重试');
  };

  /** 看过了、不打算改的反馈：删掉就是处理完（表没有已读状态），复用幂等的批量删除 */
  const removeFeedback = async (feedbackId: number) => {
    await runAction(async () => {
      await api.dishFeedback.removeMany([feedbackId]);
      setResult((previous) =>
        previous
          ? {
              ...previous,
              revision: {
                ...previous.revision,
                unhandled: previous.revision.unhandled.filter((item) => item.feedback_id !== feedbackId),
              },
            }
          : previous,
      );
      onChanged();
      toast('已移除这条反馈', 'success');
    }, '移除没成，请重试');
  };

  const confirm = async (selectedIds: string[]) => {
    if (!result) return;
    const selected = result.revision.changes.filter((change) => selectedIds.includes(change.id));
    const plan = buildRevisionPlan(result.revision.dish, selected);
    const dish = result.revision.dish;

    setConfirming(true);
    try {
      await runAction(async () => {
        // 顺序：字段 → 配料表 → 清反馈。前两步都是幂等的，最后一步失败时
        // 草稿还在屏上，直接再点一次确认就是完整的重试。
        let updated: Dish = dish;
        if (Object.keys(plan.fields).length > 0) {
          updated = (await api.dishes.updateFields(dish.id, plan.fields)).dish;
        }
        if (plan.bomChanged) {
          updated = (await api.dishes.replaceIngredients(dish.id, { ingredients: plan.ingredients })).dish;
        }
        if (plan.handledFeedbackIds.length > 0) await api.dishFeedback.removeMany(plan.handledFeedbackIds);

        toast(
          `已改「${dish.name}」：${selected.length} 条改动` +
            (plan.handledFeedbackIds.length > 0 ? `，清掉 ${plan.handledFeedbackIds.length} 条反馈` : ''),
          'success',
        );
        setResult(null);
        onChanged();
        onDishChanged?.(updated);
      }, '改菜没成，请重试');
    } finally {
      setConfirming(false);
    }
  };

  const aiEnabled = ai.data?.enabled === true;

  return (
    <div className="border-t border-cream-200 bg-cream-50/50 px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-ink-500">
        <MessageSquare size={12} className="text-brand-500" />
        反馈
        {feedbacks.length > 0 ? <span className="text-ink-400">（{feedbacks.length}）</span> : null}
      </div>

      {feedbacks.length > 0 ? (
        <ul className="space-y-1.5">
          {feedbacks.map((fb) => (
            <li
              key={fb.id}
              className="group flex items-start gap-2 rounded-lg bg-white px-2.5 py-1.5 shadow-card"
            >
              <span className="mt-0.5 text-[13px] leading-none">{fb.member?.avatar ?? '🙂'}</span>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-[12px] leading-5 text-ink-700">{fb.content}</p>
                <p className="mt-0.5 text-[10px] text-ink-400">
                  {fb.member ? fb.member.name : '匿名'} · {relativeDateTime(fb.created_at)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(fb.id)}
                aria-label="删除反馈"
                className="press mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-300 opacity-0 transition hover:bg-alert/10 hover:text-alert group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] leading-4 text-ink-400">
          还没有反馈，发现问题随时记下。提交后 AI 会顺手给出改法，确认了才会动配方。
        </p>
      )}

      {/* 有反馈但还没有建议时的入口：别人提的、或者刚才 AI 没看成，都能从这里再请它看一次 */}
      {aiEnabled && !result && (feedbacks.length > 0 || drafting) ? (
        <button
          type="button"
          disabled={drafting}
          onClick={() => void requestDraft()}
          className="press mt-2 inline-flex items-center gap-1 rounded-full bg-cream-200 px-2.5 py-1 text-[11px] text-brand-600 disabled:opacity-60"
        >
          <Sparkles size={11} className={cn(drafting && 'animate-pulse')} />
          {drafting ? 'AI 正在看这几条反馈…' : `让 AI 看看这 ${feedbacks.length} 条`}
        </button>
      ) : null}

      {result ? (
        <div className="mt-3">
          <AiRevisionCard
            key={resultVersion}
            revision={result.revision}
            notes={result.notes}
            model={result.model}
            onDiscard={() => setResult(null)}
            onConfirm={(ids) => void confirm(ids)}
            onRemoveFeedback={(feedbackId) => void removeFeedback(feedbackId)}
            confirming={confirming}
          />
        </div>
      ) : null}

      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder={me ? `${me.name} 记一条反馈…` : '记一条反馈（如：偏咸 / 土豆没炖烂）'}
          className={cn(
            'min-h-[34px] max-h-24 flex-1 resize-none rounded-lg border border-cream-400 bg-white px-2.5 py-1.5',
            'text-[12px] leading-5 placeholder:text-ink-200 focus:border-brand-400',
          )}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || draft.trim().length === 0}
          className="press flex h-[34px] shrink-0 items-center gap-1 rounded-lg bg-brand-500 px-3 text-[12px] font-medium text-white disabled:opacity-50"
        >
          <Send size={13} />
          提交
        </button>
      </div>
    </div>
  );
}
