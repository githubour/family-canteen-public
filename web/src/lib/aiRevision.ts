import type { AiRevisionChange, Dish } from '../api/types';
import type { DishFieldsPatch } from '../api/client';

/** 确认一次改菜要提交的东西：字段、整张配料表、以及「哪些反馈算被处理了」 */
export interface RevisionPlan {
  /** 只含与现状不同的字段；空对象表示字段没变 */
  fields: DishFieldsPatch;
  /** 完整的新配料表（服务端整表替换） */
  ingredients: { name: string; amount: number; required: boolean }[];
  /** 配料表是否真的变了：没变就不发 PUT（避免无意义地重建行） */
  bomChanged: boolean;
  /** 被勾选的改动覆盖到的反馈 id——**只有这些才能删** */
  handledFeedbackIds: number[];
  /** 整体有没有变化 */
  changed: boolean;
}

type BomRow = { ingredient_id: number; name: string; amount: number; required: boolean };

function toRows(dish: Dish): BomRow[] {
  return dish.ingredients.map((item) => ({
    ingredient_id: item.ingredient_id,
    name: item.name,
    amount: item.amount,
    required: item.required,
  }));
}

/**
 * 「现状 + 勾选的改动」→ 要提交的那份。
 *
 * 为什么按勾选重算而不是直接提交模型给的目标状态：改动是可逐条取消的，
 * 取消一条就得把它的影响从最终结果里拿掉。按**配料表 id**（而不是名字）匹配，
 * 是因为同一张表里名字可能被改过（别名归并），id 才是稳定身份。
 */
export function buildRevisionPlan(dish: Dish, changes: AiRevisionChange[]): RevisionPlan {
  const fields: DishFieldsPatch = {};
  let rows = toRows(dish);

  for (const change of changes) {
    if (change.field) {
      // steps 服务端字符串与数组都认，这里直接给数组（草稿里的值本来就是数组）
      fields[change.field] = change.value as never;
    }
    const op = change.bom;
    if (!op) continue;
    if (op.action === 'amount') {
      rows = rows.map((row) =>
        row.ingredient_id === op.ingredient_id ? { ...row, amount: op.amount ?? row.amount } : row,
      );
    } else if (op.action === 'remove') {
      rows = rows.filter((row) => row.ingredient_id !== op.ingredient_id);
    } else {
      // add：勾了就追加一行（服务端已保证它原本不在配料表里）
      rows = [
        ...rows,
        {
          ingredient_id: op.ingredient_id,
          name: op.name,
          amount: op.amount ?? 100,
          required: op.required !== false,
        },
      ];
    }
  }

  return {
    fields,
    ingredients: rows.map((row) => ({ name: row.name, amount: row.amount, required: row.required })),
    bomChanged: signature(rows) !== signature(toRows(dish)),
    handledFeedbackIds: handledFeedbackIds(changes),
    changed: Object.keys(fields).length > 0 || signature(rows) !== signature(toRows(dish)),
  };
}

/** 配料表的可比签名：只看身份 / 用量 / 必有可选（顺序也算——整表替换是按顺序落库的） */
function signature(rows: BomRow[]): string {
  return rows.map((row) => `${row.ingredient_id}:${row.amount}:${row.required ? 1 : 0}`).join('|');
}

/**
 * 被这批改动覆盖到的反馈 id。
 *
 * 这是「不丢线索」的执行点：确认后只删这些，unhandled 里的（模型说看不出要改什么的、
 * 以及模型压根没提到的）一条都不动，继续留在池里等下次。
 */
export function handledFeedbackIds(changes: AiRevisionChange[]): number[] {
  return [...new Set(changes.flatMap((change) => change.sources.map((source) => source.id)))];
}
