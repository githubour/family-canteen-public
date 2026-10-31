import { useEffect, useState } from 'react';
import { Refrigerator, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import { runAction } from '../../lib/runAction';
import { Button, cn } from '../ui/base';
import { Sheet } from '../ui/feedback';
import { AiDishPanel } from './AiDishPanel';
import { AiFridgeStockPanel } from './AiFridgeStockPanel';

/** 两种说法的例子放在一起：不用先想「我该点哪个盒子」 */
const EXAMPLES = [
  '加个小炒肉',
  '来个水煮肉片，微辣',
  '我有西红柿、土豆、鸡蛋',
  '鸡蛋用完了',
];

/**
 * 首页唯一的 AI 入口：一句话 → 由模型分流到「加菜」或「登记库存」→ 对应的草稿面板。
 *
 * 为什么不直接合成一个大提示词：两条流程的上下文完全不同（加菜要整张食材库 + 营养参考表，
 * 库存只要食材名），分流单独一次调用只输出一个词，几十个 token 就够。
 *
 * 判错不是死路：顶部写着「按加菜处理 / 按登记库存处理」，旁边就能改判，
 * 而且两条流程都只产草稿——写库仍然要人点确认。
 */
export function AiHelperSheet({
  open,
  onClose,
  onManualStock,
}: {
  open: boolean;
  onClose: () => void;
  /** 「手动勾选库存」的出口：首页不再单独占一张卡，改成这里的次要入口 */
  onManualStock?: () => void;
}) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<'dish' | 'fridge' | null>(null);
  const [reason, setReason] = useState('');
  const [routing, setRouting] = useState(false);

  // 每次打开都从空白开始：上一次的草稿与判断不带到下一次
  useEffect(() => {
    if (open) {
      setText('');
      setIntent(null);
      setReason('');
    }
  }, [open]);

  const route = async () => {
    const prompt = text.trim();
    if (prompt === '') return;
    setRouting(true);
    try {
      await runAction(async () => {
        const result = await api.ai.route(prompt);
        setText(prompt);
        setReason(result.reason);
        setIntent(result.intent);
      }, '没判断出这句话要做什么，下面直接选一个');
    } finally {
      setRouting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="AI 帮手" maxHeight="88vh">
      {intent === null ? (
        <div className="space-y-3 pb-4">
          <div className="rounded-xl2 border border-cream-300 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">加菜还是记冰箱，直接说</p>
                <p className="text-[11px] text-ink-400">AI 自己分辨 · 只产草稿，点了确认才写库</p>
              </div>
            </div>
            <textarea
              value={text}
              rows={3}
              maxLength={200}
              placeholder="例：加个小炒肉 / 我有西红柿、土豆、鸡蛋"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void route();
                }
              }}
              className="mt-3 w-full rounded-xl2 border border-cream-400 bg-white p-3 text-[14px] leading-6"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setText(example)}
                  className="press rounded-full bg-cream-200 px-2.5 py-1 text-[11px] text-ink-600"
                >
                  {example}
                </button>
              ))}
            </div>
            <Button
              block
              size="lg"
              className="mt-3"
              disabled={routing || text.trim() === ''}
              onClick={() => void route()}
            >
              {routing ? '正在判断…' : '交给 AI'}
            </Button>
          </div>

          {/* 分流失败或人不同意时的出口：不让人卡在「AI 没听懂」这一步 */}
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-[11px] text-ink-400">
            <span>不想让它判断？</span>
            <button type="button" onClick={() => setIntent('dish')} className="text-brand-500">
              直接加菜
            </button>
            <span>·</span>
            <button type="button" onClick={() => setIntent('fridge')} className="text-brand-500">
              直接登记库存
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-xl2 bg-cream-100 px-3 py-2">
            <p className="min-w-0 flex-1 text-[12px] leading-5 text-ink-600">
              <span className={cn('font-semibold', intent === 'dish' ? 'text-brand-700' : 'text-fresh')}>
                {intent === 'dish' ? '按「加菜」处理' : '按「登记库存」处理'}
              </span>
              {reason !== '' ? <span className="text-ink-400"> · {reason}</span> : null}
            </p>
            <div className="flex shrink-0 items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setIntent(intent === 'dish' ? 'fridge' : 'dish')}
                className="text-brand-500"
              >
                {intent === 'dish' ? '其实是登记库存' : '其实是加菜'}
              </button>
              <button type="button" onClick={() => setIntent(null)} className="text-ink-400">
                换一句
              </button>
            </div>
          </div>

          {intent === 'dish' ? (
            // key 带上意图与原话：改判或换一句都重挂面板，旧草稿不残留
            <AiDishPanel key={`dish-${text}`} initialText={text} autoRun />
          ) : (
            <>
              <AiFridgeStockPanel
                key={`fridge-${text}`}
                initialText={text}
                autoRun
                onApplied={() => {
                  // 首页不展示库存清单；点菜页 / 采购页各自打开时重新拉取
                }}
                onAddDish={(name) => {
                  setText(`加个${name}`);
                  setIntent('dish');
                }}
              />
              {onManualStock ? (
                <button
                  type="button"
                  onClick={onManualStock}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl2 border border-dashed border-cream-400 bg-white/60 py-2 text-[12px] text-ink-500"
                >
                  <Refrigerator size={13} />
                  不想说，手动勾选库存
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
