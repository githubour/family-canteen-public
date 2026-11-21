import { useEffect, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import type { AiIngredientDraftRow } from '../../api/types';
import { useAsync } from '../../hooks/useAsync';
import { runAction } from '../../lib/runAction';
import { Button, cn } from '../ui/base';
import { toast } from '../ui/toast';

const EXAMPLES = ['把沙姜从食材库删掉', '删掉「鸡胸肉」'];

/**
 * 一句话删食材：输入 → 草稿 → 勾选确认 → 逐条走既有删除接口。
 *
 * 与 AI 加菜 / 登记库存同一套原则：模型只提取「要删哪些名字」，
 * 能不能删由服务端查菜谱引用判定；这里把不可删的行灰掉并说明原因，
 * 人只勾可删的，确认后仍然走 DELETE /api/purchase/ingredients/:id——只有这一条写入路径。
 */
export function AiIngredientDeletePanel({
  initialText = '',
  autoRun = false,
}: {
  /** 首页分流过来的那句话：直接进草稿，不再让人重说一遍 */
  initialText?: string;
  autoRun?: boolean;
}) {
  const status = useAsync(() => api.ai.status(), []);

  const [text, setText] = useState(initialText);
  const [rows, setRows] = useState<AiIngredientDraftRow[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // 分流过来的那句话：挂载即整理，人只需要看结果（换一句话会换 key 重挂，见 AiHelperSheet）
  useEffect(() => {
    if (autoRun && initialText.trim() !== '') void generate();
    // 只在挂载时自动跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = async () => {
    setDrafting(true);
    try {
      await runAction(async () => {
        const result = await api.ai.ingredientDraft(text);
        setRows(result.rows);
        setNotes(result.notes);
        setModel(result.model);
        // 默认勾上能删的；被菜谱引用的行本来就不可选，不会被误删
        setSelected(new Set(result.rows.filter((row) => row.deletable).map((row) => row.ingredient_id)));
      }, '没能整理出来');
    } finally {
      setDrafting(false);
    }
  };

  const toggle = (ingredientId: number) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(ingredientId)) next.delete(ingredientId);
      else next.add(ingredientId);
      return next;
    });

  const confirm = async () => {
    const targets = (rows ?? []).filter((row) => row.deletable && selected.has(row.ingredient_id));
    if (targets.length === 0 || deleting) return;
    setDeleting(true);
    try {
      await runAction(async () => {
        for (const row of targets) {
          // 逐条调既有接口：服务端仍然会再查一遍引用，草稿之后有人加过菜也会被 409 拦下
          await api.purchase.removeIngredient(row.ingredient_id);
        }
        setRows((previous) =>
          previous ? previous.filter((row) => !targets.some((target) => target.ingredient_id === row.ingredient_id)) : previous,
        );
        setSelected(new Set());
        toast(`已删除 ${targets.length} 样食材`, 'success');
      }, '食材没删掉，请重试');
    } finally {
      setDeleting(false);
    }
  };

  // 没开 AI 就当这个入口不存在
  if (!status.data?.enabled) return null;

  if (rows === null) {
    return (
      <div className="glass-control rounded-xl2 p-3.5">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">说一句话删食材</p>
            <p className="truncate text-[11px] text-ink-400">{status.data.model} 整理 → 你过一眼 → 确认</p>
          </div>
        </div>
        <textarea
          value={text}
          rows={2}
          maxLength={200}
          placeholder="例：把沙姜从食材库删掉"
          onChange={(event) => setText(event.target.value)}
          className="glass-control mt-2.5 w-full rounded-xl2 p-2.5 text-[14px] leading-6"
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
        <Button block className="mt-2.5" disabled={drafting || text.trim() === ''} onClick={() => void generate()}>
          {drafting ? '正在整理…' : '整理一批'}
        </Button>
      </div>
    );
  }

  const deletableCount = rows.filter((row) => row.deletable).length;
  const blockedCount = rows.length - deletableCount;

  return (
    <section className="space-y-2.5 rounded-xl2 border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold text-brand-700">
          可以删 {deletableCount} 样
          {blockedCount > 0 ? ` · ${blockedCount} 样还被菜谱用着` : ''}
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
        {rows.map((row) => {
          const checked = selected.has(row.ingredient_id);
          return (
            <button
              key={row.ingredient_id}
              type="button"
              disabled={!row.deletable}
              onClick={() => toggle(row.ingredient_id)}
              className={cn(
                'glass-control flex w-full items-center gap-2 rounded-xl2 px-2.5 py-2 text-left',
                row.deletable
                  ? checked
                    ? 'border-brand-300'
                    : undefined
                  : 'cursor-not-allowed border-cream-200 opacity-60',
              )}
            >
              <span
                className={cn(
                  'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border',
                  !row.deletable
                    ? 'border-cream-300 bg-cream-100 text-ink-300'
                    : checked
                      ? 'border-brand-400 bg-brand-500 text-white'
                      : 'glass-control text-transparent',
                )}
              >
                {row.deletable && checked ? <Check size={11} strokeWidth={3} /> : row.deletable ? null : <X size={10} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('flex items-baseline gap-1.5', row.deletable ? 'text-ink-800' : 'text-ink-400')}>
                  <span className="truncate text-[13px] font-medium">{row.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-400">{row.category}</span>
                  {row.is_pantry ? (
                    <span className="shrink-0 rounded-full bg-fresh/10 px-1.5 text-[10px] text-fresh">常备</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'mt-0.5 block truncate text-[10px]',
                    row.deletable ? 'text-ink-400' : 'text-alert',
                  )}
                >
                  {row.said !== row.name ? `你说的「${row.said}」· ` : ''}
                  {row.reason}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <Button block disabled={selected.size === 0 || deleting} onClick={() => void confirm()}>
        {deleting ? '正在删除…' : selected.size > 0 ? `删除选中的 ${selected.size} 样` : '没有可删的食材'}
      </Button>
      <p className="text-center text-[11px] text-ink-400">删除只影响食材库；被菜谱引用的食材会保留，需要先改菜谱。</p>
    </section>
  );
}
