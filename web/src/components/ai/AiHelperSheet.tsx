import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Mic, Refrigerator, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import type { AiIntent } from '../../api/types';
import type { VoiceRecorder } from '../../hooks/useVoiceRecorder';
import { runAction } from '../../lib/runAction';
import { MAX_VOICE_MS } from '../../lib/voice';
import { Button, cn } from '../ui/base';
import { Sheet } from '../ui/feedback';
import { AiDishPanel } from './AiDishPanel';
import { AiFridgeStockPanel } from './AiFridgeStockPanel';
import { AiIngredientDeletePanel } from './AiIngredientDeletePanel';

/** 三种说法的例子放在一起：不用先想「我该点哪个盒子」 */
const EXAMPLES = [
  '加个小炒肉',
  '来个水煮肉片，微辣',
  '我有西红柿、土豆、鸡蛋',
  '鸡蛋用完了',
  '把沙姜从食材库删掉',
];

const INTENT_LABEL: Record<AiIntent, string> = {
  dish: '加菜',
  fridge: '登记库存',
  ingredient: '删食材',
};

const INTENT_SWITCH_LABEL: Record<AiIntent, string> = {
  dish: '其实是加菜',
  fridge: '其实是登记库存',
  ingredient: '其实是删食材',
};

const INTENTS: AiIntent[] = ['dish', 'fridge', 'ingredient'];

/**
 * 首页唯一的 AI 入口：一句话 → 由模型分流到「加菜」「登记库存」「删除食材」→ 对应的草稿面板。
 *
 * 为什么不直接合成一个大提示词：三条流程的上下文完全不同（加菜要整张食材库 + 营养参考表，
 * 库存与删除只要食材名），分流单独一次调用只输出一个词，几十个 token 就够。
 *
 * 判错不是死路：顶部写着「按加菜处理 / 按登记库存 / 按删食材处理」，旁边就能改判，
 * 而且三条流程都只产草稿——写库仍然要人点确认，删除也只走既有的孤立食材删除接口。
 */
export function AiHelperSheet({
  open,
  onClose,
  onManualStock,
  voice,
  voiceText,
  onVoiceTextConsumed,
}: {
  open: boolean;
  onClose: () => void;
  /** 「手动勾选库存」的出口：首页不再单独占一张卡，改成这里的次要入口 */
  onManualStock?: () => void;
  /** 录音器由首页持有：长按页头 AI 按钮和面板里的「按住说话」共用同一路，
   *  同一时间只可能有一个录音在跑 */
  voice: VoiceRecorder;
  /** 首页长按录完的识别结果；面板打开后自动填回并分流 */
  voiceText: string | null;
  onVoiceTextConsumed: () => void;
}) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<AiIntent | null>(null);
  const [reason, setReason] = useState('');
  const [routing, setRouting] = useState(false);
  const [voicePressed, setVoicePressed] = useState(false);

  // 每次打开都从空白开始：上一次的草稿与判断不带到下一次
  useEffect(() => {
    if (open) {
      setText('');
      setIntent(null);
      setReason('');
    }
  }, [open]);

  const route = async (promptOverride?: string) => {
    const prompt = (promptOverride ?? text).trim();
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

  // 语音转写成功后：文字填回输入框，并直接复用现有的分流流程（不新增任何写库路径）。
  // 录音器在首页，这里只负责消费首页长按送进来的识别结果。
  const routeRef = useRef(route);
  routeRef.current = route;
  const consumedRef = useRef(onVoiceTextConsumed);
  consumedRef.current = onVoiceTextConsumed;

  useEffect(() => {
    if (!open || voiceText === null) return;
    setText(voiceText);
    void routeRef.current(voiceText);
    consumedRef.current();
  }, [open, voiceText]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="AI 帮手"
      maxHeight="88%"
      // 语音优先：打开面板不自动弹键盘，面板下边缘先贴住屏幕下边缘
      focusField={false}
      dock={
        intent === null ? (
          // 键盘弹出时停靠区只留输入框：说明、出口、两个主操作都标了 data-typing="hide"，
          // 键盘态收起，输入框下边缘直接落在键盘那条配件栏（^ v ✓）上沿；收起键盘它们再回来。
          <div>
            <textarea
              value={text}
              rows={3}
              maxLength={200}
              placeholder="例：加个小炒肉 / 我有西红柿、土豆、鸡蛋 / 把沙姜从食材库删掉"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void route();
                }
              }}
              className="glass-control block w-full rounded-xl2 p-3 text-[14px] leading-6"
            />
            {/* 说明与出口都排在输入框下面：先看这句话，再决定是说、是点、还是自己写 */}
            <p data-typing="hide" className="px-0.5 pb-1 pt-1.5 text-[11px] leading-4 text-ink-400">
              按住说话，松手自动识别（10 秒以内）；识别完会直接判断要做什么
            </p>
            <div
              data-typing="hide"
              className="flex flex-wrap items-center justify-center gap-1.5 pb-2 text-[11px] text-ink-400"
            >
              <span>不想让它判断？</span>
              <button type="button" onClick={() => setIntent('dish')} className="text-brand-500">
                直接加菜
              </button>
              <span>·</span>
              <button type="button" onClick={() => setIntent('fridge')} className="text-brand-500">
                直接登记库存
              </button>
              <span>·</span>
              <button type="button" onClick={() => setIntent('ingredient')} className="text-brand-500">
                直接删食材
              </button>
            </div>
            {/* 按住说话：pointerdown 开始、pointerup/离开/取消结束；满 10 秒自动停。
                touch-action:none 防止长按时触发页面滚动，select-none 防止选中文字。 */}
            <div data-typing="hide" className="grid grid-cols-2 items-stretch gap-2 pt-0.5">
              <button
                type="button"
                data-pressed={voicePressed}
                disabled={routing || voice.transcribing}
                onPointerDown={(event) => {
                  event.preventDefault();
                  setVoicePressed(true);
                  void voice.start();
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  setVoicePressed(false);
                  voice.stop();
                }}
                onPointerLeave={() => {
                  setVoicePressed(false);
                  voice.stop();
                }}
                onPointerCancel={() => {
                  setVoicePressed(false);
                  voice.stop();
                }}
                onContextMenu={(event) => event.preventDefault()}
                style={
                  {
                    touchAction: 'none',
                    WebkitTouchCallout: 'none',
                    '--voice-max': `${MAX_VOICE_MS}ms`,
                  } as CSSProperties
                }
                className={cn(
                  // 与「交给 AI」等宽（flex-1）、同高 48、同字号 16：两个主操作视觉同级，
                  // 不再出现语音按钮比旁边小一截。
                  'control-press relative flex h-control-primary min-w-0 select-none items-center justify-center gap-1.5 overflow-hidden rounded-full border px-4 text-base font-medium disabled:opacity-50',
                  voice.recording
                    ? 'border-brand-400 bg-brand-500 text-white'
                    : 'glass-control text-ink-600',
                )}
                aria-label="按住说话，松手自动识别"
              >
                <Mic size={18} />
                {voice.transcribing ? '正在识别…' : voice.recording ? '松手结束' : '按住说话'}
                {voice.recording ? <span aria-hidden className="voice-progress" /> : null}
              </button>
              <Button
                size="lg"
                className="min-w-0"
                disabled={routing || voice.recording || voice.transcribing || text.trim() === ''}
                onClick={() => void route()}
              >
                {routing ? '正在判断…' : '交给 AI'}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {intent === null ? (
        <div className="space-y-3 pb-4">
          <div className="glass-control rounded-xl2 p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">加菜、记冰箱还是删食材，直接说</p>
                <p className="text-[11px] text-ink-400">AI 自己分辨 · 只产草稿，点了确认才写库</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
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
          </div>
        </div>
      ) : (
        <div className="space-y-3 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-xl2 bg-cream-100 px-3 py-2">
            <p className="min-w-0 flex-1 text-[12px] leading-5 text-ink-600">
              <span
                className={cn(
                  'font-semibold',
                  intent === 'dish' ? 'text-brand-700' : intent === 'fridge' ? 'text-fresh' : 'text-ink-800',
                )}
              >
                按「{INTENT_LABEL[intent]}」处理
              </span>
              {reason !== '' ? <span className="text-ink-400"> · {reason}</span> : null}
            </p>
            <div className="flex shrink-0 items-center gap-2 text-[11px]">
              {INTENTS.filter((item) => item !== intent).map((item) => (
                <button key={item} type="button" onClick={() => setIntent(item)} className="text-brand-500">
                  {INTENT_SWITCH_LABEL[item]}
                </button>
              ))}
              <button type="button" onClick={() => setIntent(null)} className="text-ink-400">
                换一句
              </button>
            </div>
          </div>

          {intent === 'dish' ? (
            // key 带上意图与原话：改判或换一句都重挂面板，旧草稿不残留
            <AiDishPanel key={`dish-${text}`} initialText={text} autoRun />
          ) : intent === 'fridge' ? (
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
                  className="glass-control flex w-full items-center justify-center gap-1.5 rounded-xl2 border border-dashed border-cream-400 py-2 text-[12px] text-ink-500"
                >
                  <Refrigerator size={13} />
                  不想说，手动勾选库存
                </button>
              ) : null}
            </>
          ) : (
            <AiIngredientDeletePanel key={`ingredient-${text}`} initialText={text} autoRun />
          )}
        </div>
      )}
    </Sheet>
  );
}