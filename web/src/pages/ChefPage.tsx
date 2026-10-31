import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { useServerEvents } from '../api/sse';
import {
  MEAL_LABEL,
  STATUS_LABEL,
  isValidISODate,
  type MealSummary,
  type MealType,
  type OrderStatus,
} from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { IdentityPickerSheet } from '../components/IdentityPickerSheet';
import { MemberPill } from '../components/MemberPill';
import { ChefFilterBar } from '../components/chef/ChefFilterBar';
import { OrderList } from '../components/chef/OrderList';
import { PrepSheet } from '../components/chef/PrepSheet';
import { PrepSummaryCard } from '../components/chef/PrepSummaryCard';
import type { Filter } from '../components/chef/types';
import type { SummaryDish } from '../components/DishRecipeDetail';
import { toast } from '../components/ui/toast';
import { useAsync } from '../hooks/useAsync';
import { useAskOnce } from '../hooks/useAskOnce';
import { useCurrentMember, useMembers } from '../hooks/useCurrentMember';
import { useDishFeedback } from '../hooks/useDishFeedback';
import { usePrepList } from '../hooks/usePrepList';
import { relativeDayLabel, todayISO } from '../lib/format';
import { buildPoster, downloadPoster } from '../lib/poster';
import { runAction } from '../lib/runAction';
import { useIdentity } from '../store/identity';

export function ChefPage() {
  const members = useMembers();
  const chefId = useIdentity((state) => state.chefId);
  const selectChef = useIdentity((state) => state.selectChef);
  const chef = members.find((member) => member.id === chefId) ?? null;
  // 反馈栏记名：优先大厨（做菜的人在记），没认过大厨就退回点菜身份，都没有则匿名
  const currentMember = useCurrentMember();
  const me = chef ?? currentMember;

  // 支持 /chef?date=YYYY-MM-DD：下单后跳到对应日期，提前点的单也能立刻看到
  const [searchParams] = useSearchParams();
  const [date, setDate] = useState(() => {
    const wanted = searchParams.get('date');
    return isValidISODate(wanted) ? wanted : todayISO();
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [chefPickerOpen, setChefPickerOpen] = useState(false);
  const [newIds, setNewIds] = useState<number[]>([]);
  const [prepOpen, setPrepOpen] = useState(false);
  // 备料清单的手动调整模式：去掉不需要的、补上系统没算到的（与采购页同源）
  const [prepAdjust, setPrepAdjust] = useState(false);
  // 备料弹层里展开做法的那道菜：做菜时点开对照，一次看一道
  // 展开标识是字符串键（dish_id 或快照菜名），见 RecipeList 的 dishRowKey
  const [openStepsId, setOpenStepsId] = useState<string | null>(null);

  // 全天订单一次拉齐：列表按「餐别 → 状态」两级分组
  const orders = useAsync(() => api.orders.list({ date }), [date]);
  const summary = useAsync(() => api.orders.summary(date), [date]);
  // 全天备料清单：'day' = 三餐合并，与「采购」页同一份勾选状态
  const prepState = usePrepList(date, 'day');
  const prep = prepState.list;

  // 按菜缓存的反馈：订单卡里展开某道菜时展示，提交/删除后只刷这一道
  const { feedbacksByDish, loadFeedback } = useDishFeedback();

  // 家人名单加载完还没认大厨：自动弹一次「今天谁做菜」，做菜记录才不会无主
  useAskOnce(members.length > 0 && !chef, () => setChefPickerOpen(true));

  const reload = useCallback(() => {
    orders.reload();
    summary.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.reload, summary.reload]);

  // 新订单高亮 6 秒后熄灭的定时器：在 SSE 回调里创建，没法就地清理，
  // 收进 ref 集合、卸载时统一 clear——避免离开大厨页后还触发一次
  // 对已卸载组件的 setState
  const highlightTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = highlightTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  useServerEvents({
    'order:created': (payload) => {
      const order = payload.order as { id?: number } | undefined;
      if (order?.id) {
        setNewIds((previous) => [...previous, order.id as number]);
        const timer = setTimeout(() => {
          highlightTimers.current.delete(timer);
          setNewIds((previous) => previous.filter((id) => id !== order.id));
        }, 6000);
        highlightTimers.current.add(timer);
      }
      // 先刷新列表拿到订单数据，再靠 newIds 做高亮，缺一不可
      reload();
    },
    'order:updated': reload,
    'order:deleted': reload,
    'purchase:updated': prepState.reload,
    // 改菜落库（含反馈栏里 AI 建议的确认）会改配料与做法，摘要里的菜谱要跟着换，否则下面显示的还是旧配方
    'dish:updated': reload,
    // 反馈在别处增删时刷新缓存，订单卡里正开着的下拉会跟着更新
    'dish-feedback:updated': (payload) => {
      const dishId = Number(payload.dishId);
      if (dishId) void loadFeedback(dishId);
    },
  });

  // 全天口径的合并摘要：备料卡与备料弹层共用（三餐数字相加，家人按订单去重）
  const daySummary = useMemo<MealSummary | null>(() => {
    const summaries = summary.data?.summaries ?? [];
    if (summaries.length === 0) return null;
    const add = (pick: (item: MealSummary) => number) =>
      summaries.reduce((sum, item) => sum + pick(item), 0);

    // 全天口径必须按菜合并：同一道菜午餐、晚餐都点时，flatMap 会让菜谱列表出现两行，
    // React key 也会重复，而“合并备料”的道数会被多算。这里按 dish_id / 快照菜名折叠，
    // 份数与订单数相加，展开的菜谱只留一份。
    const mergedDishes = new Map<string, MealSummary['dishes'][number]>();
    for (const dish of summaries.flatMap((item) => item.dishes)) {
      const key = dish.dish_id != null ? `d${dish.dish_id}` : `s${dish.name}`;
      const existing = mergedDishes.get(key);
      if (existing) {
        existing.servings += dish.servings;
        existing.order_count += dish.order_count;
      } else {
        mergedDishes.set(key, { ...dish });
      }
    }
    const dishes = Array.from(mergedDishes.values()).sort((a, b) => b.servings - a.servings);

    return {
      meal_date: date,
      // 类型必填的占位：展示与分组都不用单餐口径
      meal_type: 'dinner',
      order_count: add((item) => item.order_count),
      // 与 order_count / dish_count 同口径：已取消的单不算「家人」
      member_count: new Set(
        (orders.data?.orders ?? [])
          .filter((order) => order.status !== 'cancelled')
          .map((order) => order.member.id),
      ).size,
      // 人数不跨餐相加（同一家人会重复出现），取各餐最大值
      headcount: summaries.reduce((max, item) => Math.max(max, item.headcount), 0),
      dish_count: dishes.length,
      total_servings: add((item) => item.total_servings),
      status_count: {
        pending: add((item) => item.status_count.pending),
        cooking: add((item) => item.status_count.cooking),
        done: add((item) => item.status_count.done),
        cancelled: add((item) => item.status_count.cancelled),
      },
      dishes,
    };
  }, [summary.data, orders.data, date]);

  // dish_id → 菜谱摘要：订单卡里点菜名直接下拉看配料与做法，同菜多单共用一份
  const recipes = useMemo(() => {
    const map = new Map<number, SummaryDish>();
    for (const dish of daySummary?.dishes ?? []) {
      if (dish.dish_id != null && !map.has(dish.dish_id)) map.set(dish.dish_id, dish);
    }
    return map;
  }, [daySummary]);

  // 弹层每次打开都从普通勾选模式开始，别把上次的调整模式带进来
  useEffect(() => {
    if (!prepOpen) {
      setPrepAdjust(false);
      setOpenStepsId(null);
    }
  }, [prepOpen]);

  const list = useMemo(() => {
    const all = orders.data?.orders ?? [];
    return filter === 'all' ? all : all.filter((order) => order.status === filter);
  }, [orders.data, filter]);

  const changeStatus = async (id: number, status: OrderStatus) => {
    try {
      await runAction(async () => {
        // 带上做菜人：接单备料时记一笔做菜记录（谁做的这单），忘点「做好了」也不影响统计
        await api.orders.setStatus(id, status, chefId);
        toast(
          status === 'cooking'
            ? chef
              ? `已开工，这单记在 ${chef.name} 名下`
              : '已开工'
            : `已标记为「${STATUS_LABEL[status]}」`,
          'success',
        );
      }, '没改成，请重试');
    } finally {
      // 拿到 409 多半是别的端抢先改了状态：这里无条件把真实状态刷回来
      reload();
    }
  };

  const removeOrder = async (id: number) => {
    try {
      await runAction(async () => {
        await api.orders.remove(id);
        toast('订单已删除', 'success');
      }, '没删掉，请重试');
    } finally {
      reload();
    }
  };

  /** 顺延：今天来不及做的单整单挪到之后某天，餐次和菜品不变（点菜人那边 SSE 同步） */
  const deferOrderTo = async (id: number, orderMealType: MealType, mealDate: string) => {
    try {
      await runAction(async () => {
        await api.orders.defer(id, mealDate);
        toast(`已顺延到${relativeDayLabel(mealDate)}的${MEAL_LABEL[orderMealType]}`, 'success');
      }, '没顺延成，请重试');
    } finally {
      reload();
    }
  };

  const exportMenu = () => {
    const meals = (summary.data?.summaries ?? []).filter((item) => item.dishes.length > 0);
    if (meals.length === 0 || !daySummary) {
      toast('今天还没有订单', 'error');
      return;
    }
    const dataUrl = buildPoster({
      title: `${relativeDayLabel(date)} · 今日菜单`,
      subtitle: `${daySummary.member_count} 位家人 · 共 ${daySummary.total_servings} 份`,
      // 有几餐有单就出几段，段头即餐别
      sections: meals.map((item) => ({
        heading: MEAL_LABEL[item.meal_type],
        rows: item.dishes.map(
          (dish) => `${dish.emoji}  ${dish.name} × ${dish.servings}${dish.is_fried ? '（油炸）' : ''}`,
        ),
      })),
      footer: `由「今日菜单」生成 · ${date}`,
    });
    downloadPoster(dataUrl, `菜单-${date}.png`);
    toast('菜单图已保存', 'success');
  };

  return (
    <div className="pb-28 lg:pb-8">
      <PageHeader
        title="大厨看板"
        subtitle={`${relativeDayLabel(date)} · 全天`}
        action={
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 掌勺人常驻页头：与点菜页「谁在点菜」药丸同款（共用 MemberPill） */}
            {members.length > 0 ? (
              <MemberPill member={chef} placeholder="谁在掌勺？" onClick={() => setChefPickerOpen(true)} />
            ) : null}
            <button
              type="button"
              onClick={reload}
              aria-label="刷新"
              className="press flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink-600 shadow-card"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        }
      />

      <ChefFilterBar
        date={date}
        onChangeDate={setDate}
        filter={filter}
        onSelectFilter={setFilter}
      />

      {daySummary && daySummary.dishes.length > 0 ? (
        <PrepSummaryCard summary={daySummary} prep={prep} onOpen={() => setPrepOpen(true)} />
      ) : null}

      <OrderList
        orders={list}
        // 只在首次还没有任何数据时铺骨架：SSE 每次刷新都不该把整列表塌成骨架
        loading={orders.data === null}
        error={orders.error}
        onRetry={orders.reload}
        filter={filter}
        newIds={newIds}
        canViewPrep={Boolean(daySummary && daySummary.dish_count > 0)}
        statusLocked={!chef}
        recipes={recipes}
        me={me}
        feedbacksByDish={feedbacksByDish}
        onLoadFeedback={(dishId) => void loadFeedback(dishId)}
        onOpenPrep={() => setPrepOpen(true)}
        onStatusChange={(id, status) => void changeStatus(id, status)}
        onDefer={(id, orderMealType, mealDate) => void deferOrderTo(id, orderMealType, mealDate)}
        onDelete={(id) => void removeOrder(id)}
      />

      <PrepSheet
        open={prepOpen}
        onClose={() => setPrepOpen(false)}
        summary={daySummary}
        prep={prep}
        adjusting={prepAdjust}
        onToggleAdjust={() => setPrepAdjust((value) => !value)}
        onToggle={(item) => void prepState.toggle(item)}
        onRemove={(item) => void prepState.removeItem(item)}
        onAddCustom={prepState.addCustom}
        onRestore={(item) => void prepState.restore(item)}
        expandedStepsId={openStepsId}
        onToggleSteps={setOpenStepsId}
        onExportMenu={exportMenu}
      />

      {/* 「今天谁做菜」选人弹层：首次进页没认过大厨会自动弹一次（见上面的 effect），
          之后随时点页头的掌勺药丸换人 */}
      <IdentityPickerSheet
        open={chefPickerOpen}
        onClose={() => setChefPickerOpen(false)}
        members={members}
        currentId={chefId}
        onSelect={(member) => {
          selectChef(member.id);
          setChefPickerOpen(false);
          toast(`${member.avatar} 今天由 ${member.name} 掌勺`, 'success');
        }}
        title="今天谁做菜"
        description="开工前先认一下人：接单备料时会把这单的做菜记录记在这位家人名下。要添加或管理家人，去「看汇总」页的「家人」页签。"
      />
    </div>
  );
}
