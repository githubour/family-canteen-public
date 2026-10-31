import { useEffect, useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import type { AiFridgeCandidate, AiFridgeRow, FridgeStockItem } from '../../api/types';
import { useAsync } from '../../hooks/useAsync';
import { actionableCount, mergeUnknownRow, toBatchPayload } from '../../lib/aiFridge';
import { runAction } from '../../lib/runAction';
import { Button, ChoiceChip, cn } from '../ui/base';
import { toast } from '../ui/toast';

const EXAMPLES = ['我有西红柿、土豆、鸡蛋', '鸡蛋用完了', '今天买了排骨和西兰花', '买了个熟食烤鸡'];

/** 每种状态给一句人话，说明这一行为什么会被 / 不会被改动 */
const STATUS_HINT: Record<AiFridgeRow['status'], string> = {
  add: '会加进库存',
  remove: '会从库存撤掉',
  already: '已经在库存里，不用重复登记',
  pantry: '常备调料，按设计不用登记',
  unknown: '食材库里没有它——下面建为食材，或和疑似的已有食材对上',
  dish: '这是一道菜 / 净菜，不是食材，库存登记不了',
  make_pantry: '会把它标成常备调料——以后不用再登记库存',
};

/**
 * 一句话登记库存：输入 → 草稿 → 勾选确认 → 落库。
 *
 * 与 AI 加菜同一套原则，但这里「判定」的分工更干净：模型只提取「提到了哪些食材、
 * 分别是有的还是没的」，而「哪些已经在库存里 / 是常备调料 / 库里根本没有」全部由服务端
 * 查真实数据判定。所以草稿里那几行「已在库存」不是给模型看的，是给**你**看的——
 * 你才能明白「为什么这句话里只有两样被加进去」。
 *
 * 对不上库的名字也不再是死胡同：听着是菜（净菜 / 半成品）的行给「去加菜」（转交 AI 加菜，
 * 由 onAddDish 跳页并预填），是食材的行给「建为食材」（走采购页同一个建食材接口）和
 * 疑似候选（点一下按那样登记）——全程人拍板，模型与服务端都只出选项。
 */
export function AiFridgeStockPanel({
  onApplied,
  onAddDish,
  initialText = '',
  autoRun = false,
}: {
  onApplied: (items: FridgeStockItem[]) => void;
  onAddDish?: (name: string) => void;
  /** 首页「跟 AI 说一句」分流过来的那句话：直接进草稿，不再让人重说一遍 */
  initialText?: string;
  autoRun?: boolean;
}) {
  const status = useAsync(() => api.ai.status(), []);

  const [text, setText] = useState(initialText);
  const [rows, setRows] = useState<AiFridgeRow[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** 正在「建为食材」的行名：一次只建一样，防连点建出重复行 */
  const [creatingName, setCreatingName] = useState<string | null>(null);

  // 分流过来的那句话：挂载即整理，人只需要看结果（换一句话会换 key 重挂，见 AiHelperSheet）
  useEffect(() => {
    if (autoRun && initialText.trim() !== '') void generate();
    // 只在挂载时自动跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchRow = (ingredientId: number, status: AiFridgeRow['status']) =>
    setRows((previous) =>
      previous ? previous.map((row) => (row.ingredient_id === ingredientId ? { ...row, status } : row)) : previous,
    );

  // 按下标删行：unknown / dish 行的 ingredient_id 都是 null，按 id 删会把它们一起误删
  const dropRow = (index: number) =>
    setRows((previous) => (previous ? previous.filter((_, i) => i !== index) : previous));

  const mergeRow = (index: number, candidate: AiFridgeCandidate) =>
    setRows((previous) =>
      previous ? previous.map((row, i) => (i === index ? mergeUnknownRow(row, candidate) : row)) : previous,
    );

  const createIngredientForRow = async (row: AiFridgeRow) => {
    setCreatingName(row.name);
    try {
      await runAction(async () => {
        const { ingredient } = await api.purchase.addIngredient({
          name: row.name,
          category: '其他',
          // 这行带着「设为常备」的意图（用户说的是「把 X 设为常备」）：建成常备食材
          is_pantry: row.pantry_intent === true,
        });
        if (row.pantry_intent || row.want === 'missing') {
          // 常备与「没有了」的东西建库即可：都不该进库存
          setRows((previous) => (previous ? previous.filter((item) => item.name !== row.name) : previous));
          toast(
            `已把「${ingredient.name}」加进食材库${row.pantry_intent ? '（常备，以后不用登记）' : ''}`,
            'success',
          );
        } else {
          setRows((previous) =>
            previous
              ? previous.map((item) =>
                  item.name === row.name
                    ? { ...item, ingredient_id: ingredient.id, category: ingredient.category, status: 'add' as const }
                    : item,
                )
              : previous,
          );
          toast(`已建「${ingredient.name}」，点确认会一起登记进库存`, 'success');
        }
      }, '建食材没成，请重试');
    } finally {
      setCreatingName(null);
    }
  };

  const generate = async () => {
    setDrafting(true);
    try {
      await runAction(async () => {
        const result = await api.ai.fridgeDraft(text);
        setRows(result.rows);
        setNotes(result.notes);
        setModel(result.model);
      }, '没能整理出来');
    } finally {
      setDrafting(false);
    }
  };

  const confirm = async () => {
    if (!rows) return;
    setConfirming(true);
    try {
      await runAction(async () => {
        const payload = toBatchPayload(rows);
        // 「设为常备」是改食材属性，走设置接口（与库存写入是两件事，各自幂等、可安全重试）；
        // 它若已在库存里，顺手从库存撤掉——常备按设计不需要登记
        const pantryRows = rows.filter(
          (row) => row.status === 'make_pantry' && row.ingredient_id !== null,
        ) as (AiFridgeRow & { ingredient_id: number })[];
        for (const row of pantryRows) {
          await api.settings.updateIngredient(row.ingredient_id, { is_pantry: true });
          if (row.in_stock) payload.remove.push(row.ingredient_id);
        }
        if (payload.add.length > 0 || payload.remove.length > 0) {
          const result = await api.fridge.batch(payload);
          onApplied(result.items);
        }
        toast(
          `库存已更新：加 ${payload.add.length} 样、撤 ${payload.remove.length} 样` +
            (pantryRows.length > 0 ? `、设常备 ${pantryRows.length} 样` : ''),
          'success',
        );
        setRows(null);
        setNotes([]);
        setText('');
      }, '库存没改成，请重试');
    } finally {
      setConfirming(false);
    }
  };

  // 没开 AI 就当这个入口不存在，库存弹层与以前完全一样
  if (!status.data?.enabled) return null;

  if (rows === null) {
    return (
      <div className="rounded-xl2 border border-cream-300 bg-white p-3.5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">说一句话登记库存</p>
            <p className="truncate text-[11px] text-ink-400">{status.data.model} 整理 → 你过一眼 → 确认</p>
          </div>
        </div>
        <textarea
          value={text}
          rows={2}
          maxLength={200}
          placeholder="例：我有西红柿、土豆、鸡蛋"
          onChange={(event) => setText(event.target.value)}
          className="mt-2.5 w-full rounded-xl2 border border-cream-400 bg-white p-2.5 text-[14px] leading-6"
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
          className="mt-2.5"
          disabled={drafting || text.trim() === ''}
          onClick={() => void generate()}
        >
          {drafting ? '正在整理…' : '整理一批'}
        </Button>
      </div>
    );
  }

  const counts = {
    add: rows.filter((row) => row.status === 'add').length,
    remove: rows.filter((row) => row.status === 'remove').length,
    already: rows.filter((row) => row.status === 'already').length,
    pantry: rows.filter((row) => row.status === 'make_pantry').length,
  };
  // 「设为常备」也是待办（确认时动的是食材属性，不是库存）——没它按钮会被误灰掉
  const actionable = actionableCount(rows) + counts.pantry;

  return (
    <section className="space-y-2.5 rounded-xl2 border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold text-brand-700">
          要登记 {counts.add} 样 · 撤掉 {counts.remove} 样
          {counts.pantry > 0 ? ` · 设常备 ${counts.pantry} 样` : ''}
        </p>
        <p className="shrink-0 text-[11px] text-ink-400">由 {model} 整理</p>
      </div>

      {notes.length > 0 ? (
        <ul className="rounded-xl2 bg-warn/12 px-2.5 py-2">
          {notes.map((note) => (
            <li key={note} className="text-[11px] leading-5 text-[#B45309]">
              · {note}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-1.5">
        {rows.map((row, index) => {
          const editable = row.status === 'add' || row.status === 'remove';
          const isDish = row.status === 'dish';
          const isPantrySet = row.status === 'make_pantry';
          return (
            <div
              key={`${row.ingredient_id ?? 'x'}-${row.name}-${index}`}
              className={cn(
                'rounded-xl2 border px-2.5 py-2',
                editable ? 'border-cream-300 bg-white' : 'border-cream-200 bg-white/60',
              )}
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-[13px]', editable ? 'font-medium' : 'text-ink-600')}>{row.name}</p>
                  <p className="truncate text-[10px] text-ink-400">
                    {row.status === 'add' && row.said !== row.name ? `你说的「${row.said}」· ` : ''}
                    {STATUS_HINT[row.status]}
                  </p>
                </div>

                {editable ? (
                  <>
                    <ChoiceChip
                      active
                      size="sm"
                      className="shrink-0"
                      activeClassName={row.status === 'add' ? 'warm-gradient text-white' : 'bg-alert text-white'}
                      onClick={() => patchRow(row.ingredient_id as number, row.status === 'add' ? 'remove' : 'add')}
                    >
                      {row.status === 'add' ? '登记' : '撤掉'}
                    </ChoiceChip>
                    <button
                      type="button"
                      aria-label={`不处理 ${row.name}`}
                      onClick={() => dropRow(index)}
                      className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-400"
                    >
                      <X size={13} />
                    </button>
                  </>
                ) : isDish ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={creatingName !== null}
                      onClick={() => onAddDish?.(row.name)}
                    >
                      <Plus size={12} />
                      去加菜
                    </Button>
                    <button
                      type="button"
                      aria-label={`不处理 ${row.name}`}
                      onClick={() => dropRow(index)}
                      className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-400"
                    >
                      <X size={13} />
                    </button>
                  </>
                ) : isPantrySet ? (
                  <>
                    <span className="chip shrink-0 bg-cool/15 text-cool">设为常备</span>
                    <button
                      type="button"
                      aria-label={`不处理 ${row.name}`}
                      onClick={() => dropRow(index)}
                      className="press flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-400"
                    >
                      <X size={13} />
                    </button>
                  </>
                ) : (
                  <span
                    className={cn(
                      'chip shrink-0',
                      row.status === 'unknown' ? 'bg-warn/15 text-[#B45309]' : 'bg-cream-200 text-ink-400',
                    )}
                  >
                    {row.status === 'already' ? '已在库存' : row.status === 'pantry' ? '常备' : '库里没有'}
                  </span>
                )}
              </div>

              {row.status === 'unknown' ? (
                <div className="mt-1.5 space-y-1.5">
                  {row.candidates && row.candidates.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-ink-400">是不是它：</span>
                      {row.candidates.map((candidate) => (
                        <button
                          key={candidate.ingredient_id}
                          type="button"
                          disabled={creatingName !== null}
                          onClick={() => mergeRow(index, candidate)}
                          className="press rounded-full border border-brand-200 bg-white px-2 py-0.5 text-[11px] font-medium text-brand-700"
                        >
                          {candidate.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    disabled={creatingName !== null}
                    onClick={() => void createIngredientForRow(row)}
                    className="press inline-flex items-center gap-0.5 text-[11px] font-medium text-brand-700"
                  >
                    <Plus size={11} />
                    {creatingName === row.name
                      ? '正在建…'
                      : row.pantry_intent
                        ? '建为常备食材'
                        : row.want === 'missing'
                          ? '建为食材（不进库存）'
                          : '建为食材并登记'}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          block
          disabled={confirming}
          onClick={() => {
            setRows(null);
            setNotes([]);
          }}
        >
          取消
        </Button>
        <Button block disabled={confirming || actionable === 0} onClick={() => void confirm()}>
          {confirming ? '写入中…' : `确认（${actionable} 项）`}
        </Button>
      </div>

      <p className="text-center text-[11px] leading-4 text-ink-400">
        {actionable === 0
          ? counts.already > 0
            ? '这些都已经在库存里了，没有要改的'
            : '没有要改的，换个说法再试'
          : '确认后才写入库存；点右边芯片可以改成「撤掉」，或整行去掉'}
      </p>
    </section>
  );
}
