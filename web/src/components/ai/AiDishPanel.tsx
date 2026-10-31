import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import type { AiDishDraft } from '../../api/types';
import { useAsync } from '../../hooks/useAsync';
import { toCreatePayload } from '../../lib/aiDraft';
import { runAction } from '../../lib/runAction';
import { Button } from '../ui/base';
import { Skeleton } from '../ui/feedback';
import { toast } from '../ui/toast';
import { AiDishDraftCard } from './AiDishDraftCard';

/** 点一下就能填进输入框的例子：比一句「请输入描述」有用得多 */
const EXAMPLES = ['加个小炒肉', '来个水煮肉片，微辣', '加一道清炒时蔬，十分钟能做完的'];

/**
 * AI 加菜：一句话 → 草稿 → 人改 → 入库。
 *
 * 中间那道「人改」不是走形式：
 *   · 模型最不可靠的地方是营养数字（nutrition 页要跟膳食指南对照），所以新食材的营养一律标待复核；
 *   · 落库走的是与手工加菜同一个 api.dishes.create，AI 不留任何后门，出问题也只需查一条写入路径。
 */
export function AiDishPanel({
  initialText = '',
  autoRun = false,
}: {
  /** 外部跳转带来的预填（如库存弹层认出净菜后的「去加菜」），只吃第一次 */
  initialText?: string;
  /** 预填后立刻起草：首页「跟 AI 说一句」分流过来时，不再让人多点一次「生成草稿」 */
  autoRun?: boolean;
}) {
  const status = useAsync(() => api.ai.status(), []);
  // 食材库：用来判断手改的配料名是「复用已有」还是「新建」，避免把已有食材的营养覆盖成 0
  const ingredients = useAsync(() => api.settings.ingredients(), []);

  const [text, setText] = useState(initialText);
  // 预填只给第一次挂载：改判或换一句时由外部换 key 重挂，不再重复注入
  useEffect(() => {
    // 分流过来的那句话：挂载即起草，人只需要看结果
    if (autoRun && initialText.trim() !== '') void generate();
    // 只在挂载时消费一次页面传入的种子；后续输入变化不应重新触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [draft, setDraft] = useState<AiDishDraft | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [model, setModel] = useState('');
  // 草稿换代时给卡片换 key 重挂：把卡片里的本地编辑态（做法文本、营养输入框）一起清干净
  const [draftVersion, setDraftVersion] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const knownIngredients = useMemo(
    () => new Map((ingredients.data?.ingredients ?? []).map((item) => [item.name, item.category])),
    [ingredients.data],
  );

  const generate = async () => {
    setDrafting(true);
    try {
      await runAction(async () => {
        const result = await api.ai.draft(text);
        setDraft(result.draft);
        setNotes(result.notes);
        setModel(result.model);
        setDraftVersion((version) => version + 1);
      }, '没能生成草稿');
    } finally {
      setDrafting(false);
    }
  };

  const confirm = async () => {
    if (!draft) return;
    setConfirming(true);
    try {
      await runAction(async () => {
        const { dish } = await api.dishes.create(toCreatePayload(draft));
        toast(`已加入菜单：${dish.name}`, 'success');
        setDraft(null);
        setNotes([]);
        setText('');
      }, '入库失败');
    } finally {
      setConfirming(false);
    }
  };

  if (status.loading) return <Skeleton className="h-40 w-auto" />;

  if (!status.data?.enabled) {
    return (
      <div className="pb-2">
        <div className="rounded-xl2 border border-cream-300 bg-white p-4">
          <p className="text-[15px] font-semibold">AI 加菜没有开启</p>
          <p className="mt-1 text-[12px] leading-5 text-ink-400">
            服务端没配 DeepSeek 的 API Key，所以这个入口先关着——点菜、下单、采购一切照旧。
            开启方式是在 NAS 上给容器加一个环境变量 <code className="rounded bg-cream-200 px-1">DEEPSEEK_API_KEY</code>
            （见 README 的「AI 加菜」一节），重建容器后这里就会出现输入框。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-4">
      {draft ? (
        <AiDishDraftCard
          key={draftVersion}
          draft={draft}
          notes={notes}
          model={model || status.data.model}
          knownIngredients={knownIngredients}
          // 卡片传的是函数式更新：一次 tick 里连改多个输入框时不会互相覆盖（见卡片里的注释）
          onChange={(updater) => setDraft((previous) => (previous ? updater(previous) : previous))}
          onDiscard={() => {
            setDraft(null);
            setNotes([]);
          }}
          onConfirm={() => void confirm()}
          confirming={confirming}
        />
      ) : (
        <>
          <div className="rounded-xl2 border border-cream-300 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <Sparkles size={16} />
              </span>
              <div>
                <p className="text-[15px] font-semibold">说一句话就能加菜</p>
                <p className="text-[11px] text-ink-400">
                  {status.data.model} 起草 → 你过一眼、随手改 → 确认入库
                </p>
              </div>
            </div>
            <textarea
              value={text}
              rows={3}
              maxLength={200}
              placeholder="想吃什么就写，比如「加个小炒肉，不放辣」"
              onChange={(event) => setText(event.target.value)}
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
              disabled={drafting || text.trim() === ''}
              onClick={() => void generate()}
            >
              {drafting ? '正在起草…' : '生成草稿'}
            </Button>
          </div>

          <p className="text-[11px] leading-5 text-ink-400">
            AI 只会生成草稿，不会直接写库：菜单、营养、采购都等你点「确认入库」才动。
            库里已有的食材会自动复用，只有真的没有的才新建，并标成「待复核」（后台食材页会黄标提示）。
          </p>
        </>
      )}
    </div>
  );
}
